import { config } from './config.js';
import { selectFeaturedMatch } from './featured.js';
import { settleMatch } from './bets.js';
import { NOW, tx } from './db.js';

const BASE = 'https://sportapi.ai/api';

const parisDate = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d); // YYYY-MM-DD

export const dateOffset = (days) => parisDate(new Date(Date.now() + days * 86_400_000));

export async function fetchFixtures(date) {
  const res = await fetch(`${BASE}/fixtures/date/${date}`, {
    headers: { 'X-Api-Key': config.sportApiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`SportAPI ${res.status}`);
  const body = await res.json();
  if (!body.success || !Array.isArray(body.data)) throw new Error('Réponse SportAPI invalide');
  return body.data;
}

const num = (v) => (Number.isInteger(v) ? v : null);
const logoOf = (v) => (typeof v === 'string' && /^[\w.-]+$/.test(v) ? v : null);

const COLS = [
  'id', 'date', 'kickoff_utc', 'league_id', 'league_name', 'home_team', 'away_team', 'status', 'minute',
  'home_score', 'away_score', 'result', 'penalty_home', 'penalty_away', 'home_logo', 'away_logo',
];

// Insertion par lots (un seul aller-retour par lot vers la base distante).
export async function upsertFixtures(db, fixtures) {
  const rows = new Map();
  for (const f of fixtures) {
    if (!Number.isInteger(f.id) || !f.home_team || !f.away_team) continue;
    rows.set(f.id, [
      f.id, String(f.date), f.kickoff_utc ?? null, num(f.league_id), f.league_name ?? null,
      String(f.home_team), String(f.away_team), String(f.status ?? 'Scheduled'),
      f.minute == null ? null : String(f.minute), num(f.home_score), num(f.away_score),
      num(f.result), num(f.penalty_home), num(f.penalty_away),
      logoOf(f.home_logo), logoOf(f.away_logo),
    ]);
  }
  const list = [...rows.values()];
  await tx(db, async (t) => {
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      const values = chunk.map(() => `(${COLS.map(() => '?').join(', ')}, ${NOW})`).join(', ');
      await t.run(
        `INSERT INTO matches (${COLS.join(', ')}, updated_at) VALUES ${values}
         ON CONFLICT (id) DO UPDATE SET
           date = excluded.date, kickoff_utc = excluded.kickoff_utc, league_name = excluded.league_name,
           home_team = excluded.home_team, away_team = excluded.away_team, status = excluded.status,
           minute = excluded.minute, home_score = excluded.home_score, away_score = excluded.away_score,
           result = excluded.result, penalty_home = excluded.penalty_home, penalty_away = excluded.penalty_away,
           home_logo = excluded.home_logo, away_logo = excluded.away_logo, updated_at = excluded.updated_at
         WHERE matches.voided = 0`,
        ...chunk.flat(),
      );
    }
  });
  return [...rows.keys()];
}

export async function settleFinished(db) {
  const rows = await db.all(
    `SELECT DISTINCT m.id FROM matches m JOIN bets b ON b.match_id = m.id
     WHERE b.status IN ('open','matched')
       AND m.status IN ('FT','AET','PENS','Cancelled','Postponed')`,
  );
  let n = 0;
  for (const r of rows) n += await settleMatch(db, r.id);
  return n;
}

export async function notifyFeaturedMatch(db, date) {
  const staleCut = new Date(Date.now() - 4 * 3600_000).toISOString();
  const matches = await db.all(
    `SELECT m.home_team, m.away_team, m.league_name, m.kickoff_utc,
       (SELECT COUNT(*) FROM bets b WHERE b.match_id = m.id AND b.status = 'open') AS open_offers
     FROM matches m
     WHERE m.date = ? AND m.status = 'Scheduled' AND m.kickoff_utc >= ?
     ORDER BY m.kickoff_utc ASC`,
    date, staleCut,
  );
  const match = selectFeaturedMatch(matches);
  if (!match) return;

  const kickoff = match.kickoff_utc
    ? new Date(match.kickoff_utc).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Kinshasa', hour: '2-digit', minute: '2-digit' })
    : null;
  const body = `${match.home_team} vs ${match.away_team}${match.league_name ? ` · ${match.league_name}` : ''}${kickoff ? ` · ${kickoff}` : ''}`;
  await db.run(
    `INSERT INTO notifications (user_id, title, body, event_key)
     SELECT id, ?, ?, ? FROM users
     ON CONFLICT (user_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    '🔥 Match à la une aujourd’hui', body, `featured:${date}`,
  );
}

export async function syncDate(db, date, fetcher = fetchFixtures) {
  const fixtures = await fetcher(date);
  await upsertFixtures(db, fixtures);
  await settleFinished(db);
  if (date === dateOffset(0)) await notifyFeaturedMatch(db, date);
  return fixtures.length;
}

// Planificateur : aujourd'hui / hier / jours avec paris en cours souvent, jours à venir rarement
// (reste largement sous le quota gratuit de 2000 requêtes par jour).
export function startSyncLoop(db, log = console) {
  const last = new Map();
  const due = (date, everyMs) => Date.now() - (last.get(date) ?? 0) >= everyMs;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const today = dateOffset(0);
      const targets = new Map([
        [today, 150_000],
        [dateOffset(-1), 300_000],
        [dateOffset(1), 1_800_000],
        [dateOffset(2), 1_800_000],
        [dateOffset(3), 1_800_000],
      ]);
      const betDates = await db.all(
        `SELECT DISTINCT m.date FROM matches m JOIN bets b ON b.match_id = m.id
         WHERE b.status IN ('open','matched') AND m.date < ?`,
        dateOffset(-1),
      );
      for (const r of betDates) targets.set(r.date, 300_000);

      for (const [date, every] of targets) {
        if (!due(date, every)) continue;
        last.set(date, Date.now());
        try {
          await syncDate(db, date);
        } catch (err) {
          log.error(`[sync ${date}]`, err.message);
        }
      }
    } catch (err) {
      log.error('[sync]', err.message);
    } finally {
      running = false;
    }
  }
  tick();
  return setInterval(tick, 30_000);
}
