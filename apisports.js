import { config } from './config.js';

const BASE = 'https://v3.football.api-sports.io';
// Évite toute collision avec les identifiants de sportapi.ai dans la même base.
export const ID_OFFSET = 10_000_000_000;

const STATUS = {
  TBD: 'Scheduled', NS: 'Scheduled',
  '1H': 'LIVE', HT: 'LIVE', '2H': 'LIVE', ET: 'LIVE', BT: 'LIVE', P: 'LIVE', SUSP: 'LIVE', INT: 'LIVE', LIVE: 'LIVE',
  FT: 'FT', AET: 'AET', PEN: 'PENS',
  PST: 'Postponed', CANC: 'Cancelled', ABD: 'Cancelled', AWD: 'Cancelled', WO: 'Cancelled',
};

export function mapFixture(item) {
  const { fixture, league, teams, goals, score } = item;
  const status = STATUS[fixture.status?.short] ?? 'Scheduled';
  const finished = ['FT', 'AET', 'PENS'].includes(status);
  const home = goals?.home ?? null;
  const away = goals?.away ?? null;
  let result = null;
  if (finished && home !== null && away !== null) result = home === away ? 0 : home > away ? 1 : -1;
  return {
    id: ID_OFFSET + fixture.id,
    date: String(fixture.date).slice(0, 10),
    kickoff_utc: new Date(fixture.date).toISOString(),
    league_id: league?.id ?? null,
    league_name: league?.country && league.country !== 'World' ? `${league.name} (${league.country})` : league?.name ?? null,
    home_team: teams?.home?.name,
    away_team: teams?.away?.name,
    status,
    minute: status === 'LIVE' && fixture.status.elapsed != null ? String(fixture.status.elapsed) : null,
    home_score: home,
    away_score: away,
    result,
    penalty_home: score?.penalty?.home ?? null,
    penalty_away: score?.penalty?.away ?? null,
    home_logo: teams?.home?.id ? `ap-${teams.home.id}` : null,
    away_logo: teams?.away?.id ? `ap-${teams.away.id}` : null,
  };
}

const SKIP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'fk', 'club', 'de', 'la', 'the']);
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter((w) => w && !SKIP.has(w)).join('');

// Écarte les matchs déjà fournis par l'autre API (même date, mêmes équipes).
export async function dropDuplicates(db, fixtures) {
  if (!fixtures.length) return fixtures;
  const dates = [...new Set(fixtures.map((f) => f.date))];
  const existing = await db.all(
    `SELECT date, home_team, away_team FROM matches WHERE id < ${ID_OFFSET} AND date IN (${dates.map(() => '?').join(',')})`,
    ...dates,
  );
  const seen = new Set(existing.map((m) => `${m.date}|${norm(m.home_team)}|${norm(m.away_team)}`));
  return fixtures.filter((f) => !seen.has(`${f.date}|${norm(f.home_team)}|${norm(f.away_team)}`));
}

export async function fetchApiSportsFixtures(date) {
  const res = await fetch(`${BASE}/fixtures?date=${date}&timezone=Europe/Paris`, {
    headers: { 'x-apisports-key': config.newApiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  const body = await res.json();
  const errors = body.errors && !Array.isArray(body.errors) ? Object.values(body.errors) : [];
  if (errors.length) throw new Error(`API-Football : ${errors.join(' ')}`);
  if (!Array.isArray(body.response)) throw new Error('Réponse API-Football invalide');
  return body.response.map(mapFixture);
}
