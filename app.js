import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { AGO, BizError } from './db.js';
import { clearCookie, login, makeToken, register, sessionCookie, throttle, userFromRequest } from './auth.js';
import { acceptOffer, cancelOffer, commissionOn, createOffer, opposite, voidMatch } from './bets.js';
import { reconcile, startDeposit, startWithdrawal } from './wallet.js';
import { dateOffset, syncDate } from './sportapi.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://sportapi.ai; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const maskEmail = (e) => {
  const [local, domain] = e.split('@');
  return `${local}....${domain.slice(-3)}`;
};

async function readJson(req) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) throw new BizError('Content-Type JSON requis', 415);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 10_000) throw new BizError('Requête trop volumineuse', 413);
    chunks.push(c);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new BizError('JSON invalide');
  }
}

export function createApp(db, sas, { syncFn = syncDate } = {}) {
  const requireUser = async (req) => {
    const u = await userFromRequest(db, req);
    if (!u) throw new BizError('Connexion requise', 401);
    return u;
  };
  const requireAdmin = async (req) => {
    const u = await requireUser(req);
    if (u.role !== 'admin') throw new BizError('Accès réservé aux administrateurs', 403);
    return u;
  };

  const matchRow = (m) => ({
    id: m.id, league: m.league_name, home: m.home_team, away: m.away_team, kickoff: m.kickoff_utc,
    status: m.status, minute: m.minute, homeScore: m.home_score, awayScore: m.away_score,
    homeLogo: m.home_logo ? `https://sportapi.ai/logos/${m.home_logo}` : null,
    awayLogo: m.away_logo ? `https://sportapi.ai/logos/${m.away_logo}` : null,
    open_offers: m.open_offers,
  });

  const routes = [];
  const route = (method, pattern, handler) =>
    routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('POST', '/api/auth/register', async (req, res, { body, ip }) => {
    throttle(`reg:${ip}`, 10);
    const id = await register(db, body);
    return { status: 201, data: { ok: true }, cookie: sessionCookie(makeToken(id)) };
  });
  route('POST', '/api/auth/login', async (req, res, { body, ip }) => {
    throttle(`login:${ip}:${String(body.email).toLowerCase()}`, 10);
    const id = await login(db, body);
    return { data: { ok: true }, cookie: sessionCookie(makeToken(id)) };
  });
  route('POST', '/api/auth/logout', async () => ({ data: { ok: true }, cookie: clearCookie() }));
  route('GET', '/api/me', async (req) => {
    const u = await userFromRequest(db, req);
    return { data: { user: u, config: u ? publicConfig() : undefined } };
  });

  const publicConfig = () => ({
    commissionPercent: config.commissionPercent, odds: 2 - config.commissionPercent / 100,
    minStake: config.minStake, maxStake: config.maxStake,
    minDeposit: config.minDeposit, minWithdrawal: config.minWithdrawal, currency: config.currency,
    networks: config.networks,
  });

  route('GET', '/api/matches', async (req, res, { query }) => {
    await requireUser(req);
    const tab = query.get('tab') ?? 'upcoming';
    const q = `%${(query.get('q') ?? '').toLowerCase().slice(0, 50)}%`;
    const where = { live: "m.status = 'LIVE'", finished: "m.status IN ('FT','AET','PENS')", upcoming: "m.status = 'Scheduled'" }[tab];
    if (!where) throw new BizError('Onglet invalide');
    const order = tab === 'finished' ? 'm.kickoff_utc DESC' : 'm.kickoff_utc ASC';
    const staleCut = new Date(Date.now() - 4 * 3600_000).toISOString();
    const rows = await db.all(
      `SELECT m.*, (SELECT COUNT(*) FROM bets b WHERE b.match_id = m.id AND b.status = 'open') AS open_offers
       FROM matches m
       WHERE ${where} AND m.date >= ? AND (m.status <> 'Scheduled' OR m.kickoff_utc >= ?)
         AND lower(m.home_team || ' ' || m.away_team || ' ' || COALESCE(m.league_name, '')) LIKE ?
       ORDER BY ${order} LIMIT 300`,
      dateOffset(tab === 'finished' ? -2 : -1), staleCut, q,
    );
    return { data: { matches: rows.map(matchRow) } };
  });

  route('GET', '/api/activity', async (req) => {
    await requireUser(req);
    const rows = await db.all(
      `SELECT b.id, b.stake, b.status, m.home_team, m.away_team
       FROM bets b JOIN matches m ON m.id = b.match_id
       WHERE (b.status = 'open' AND m.status IN ('Scheduled','LIVE'))
          OR (b.status = 'matched' AND b.matched_at >= ${AGO('1 day')})
       ORDER BY b.id DESC LIMIT 30`,
    );
    return {
      data: {
        items: rows.map((r) => ({
          id: r.id, match: `${r.home_team} vs ${r.away_team}`, stake: r.stake,
          state: r.status === 'open' ? 'waiting' : 'matched',
        })),
      },
    };
  });

  route('GET', '/api/matches/:id', async (req, res, { params }) => {
    const user = await requireUser(req);
    const id = Number(params.id);
    const m = Number.isSafeInteger(id) ? await db.get('SELECT * FROM matches WHERE id = ?', id) : null;
    if (!m) throw new BizError('Match introuvable', 404);
    const offers = (
      await db.all(
        `SELECT b.id, b.creator_side, b.stake, b.creator_id, u.email FROM bets b JOIN users u ON u.id = b.creator_id
         WHERE b.match_id = ? AND b.status = 'open' ORDER BY b.stake DESC, b.id LIMIT 100`,
        m.id,
      )
    ).map((o) => ({
      id: o.id, stake: o.stake, by: maskEmail(o.email), mine: o.creator_id === user.id,
      creatorSide: o.creator_side, takeSide: opposite(o.creator_side),
      winGross: 2 * o.stake, winNet: 2 * o.stake - commissionOn(o.stake),
    }));
    return { data: { match: matchRow({ ...m, open_offers: offers.length }), offers } };
  });

  route('POST', '/api/bets', async (req, res, { body }) => {
    const u = await requireUser(req);
    const id = await createOffer(db, u.id, { matchId: Number(body.matchId), side: body.side, stake: Number(body.stake) });
    return { status: 201, data: { id } };
  });
  route('POST', '/api/bets/:id/accept', async (req, res, { params }) => {
    const u = await requireUser(req);
    await acceptOffer(db, u.id, Number(params.id));
    return { data: { ok: true } };
  });
  route('POST', '/api/bets/:id/cancel', async (req, res, { params }) => {
    const u = await requireUser(req);
    await cancelOffer(db, u.id, Number(params.id));
    return { data: { ok: true } };
  });
  route('GET', '/api/bets/mine', async (req) => {
    const u = await requireUser(req);
    const rows = await db.all(
      `SELECT b.*, m.home_team, m.away_team, m.status AS match_status, m.home_score, m.away_score, m.kickoff_utc
       FROM bets b JOIN matches m ON m.id = b.match_id
       WHERE b.creator_id = ? OR b.taker_id = ? ORDER BY b.id DESC LIMIT 200`,
      u.id, u.id,
    );
    const bets = rows.map((b) => {
      const mine = b.creator_id === u.id;
      const side = mine ? b.creator_side : opposite(b.creator_side);
      return {
        id: b.id, home: b.home_team, away: b.away_team, matchStatus: b.match_status,
        homeScore: b.home_score, awayScore: b.away_score, kickoff: b.kickoff_utc,
        side, stake: b.stake, status: b.status, createdByMe: mine,
        result: b.status === 'settled' ? (b.winner_id === u.id ? 'won' : 'lost') : null,
        payout: b.winner_id === u.id ? b.payout : 0,
      };
    });
    return { data: { bets } };
  });

  route('GET', '/api/wallet', async (req) => {
    const u = await requireUser(req);
    const ledger = await db.all(
      'SELECT type, amount, balance_after, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50',
      u.id,
    );
    const payments = await db.all(
      'SELECT id, kind, amount, network, status, checkout_url, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      u.id,
    );
    return { data: { balance: u.balance, ledger, payments } };
  });
  const paymentView = (p) => ({ id: p.id, status: p.status, checkoutUrl: p.checkout_url, kind: p.kind, amount: p.amount });
  route('POST', '/api/wallet/deposit', async (req, res, { body }) => {
    const u = await requireUser(req);
    const p = await startDeposit(db, sas, u, { amount: Number(body.amount), network: body.network, phone: body.phone });
    return { status: 201, data: paymentView(p) };
  });
  route('POST', '/api/wallet/withdraw', async (req, res, { body }) => {
    const u = await requireUser(req);
    const p = await startWithdrawal(db, sas, u, { amount: Number(body.amount), network: body.network, phone: body.phone });
    return { status: 201, data: paymentView(p) };
  });
  route('GET', '/api/wallet/payments/:id', async (req, res, { params }) => {
    const u = await requireUser(req);
    let p = await db.get('SELECT * FROM payments WHERE id = ? AND user_id = ?', params.id, u.id);
    if (!p) throw new BizError('Paiement introuvable', 404);
    p = await reconcile(db, sas, p);
    return { data: paymentView(p) };
  });

  route('GET', '/api/admin/stats', async (req) => {
    await requireAdmin(req);
    const n = async (sql) => (await db.get(sql)).n;
    const [
      users, walletTotal, commission, matchedStakes, openBets, matchedBets, lockedStakes, matches,
      pendingPayments, betRows, withdrawalHistory,
    ] = await Promise.all([
      n('SELECT COUNT(*) AS n FROM users'),
      n('SELECT COALESCE(SUM(balance),0) AS n FROM users'),
      n("SELECT COALESCE(SUM(amount),0) AS n FROM ledger WHERE type = 'commission'"),
      db.all("SELECT stake FROM bets WHERE status = 'matched'"),
      n("SELECT COUNT(*) AS n FROM bets WHERE status = 'open'"),
      n("SELECT COUNT(*) AS n FROM bets WHERE status = 'matched'"),
      n("SELECT COALESCE(SUM(stake * (CASE status WHEN 'matched' THEN 2 ELSE 1 END)),0) AS n FROM bets WHERE status IN ('open','matched')"),
      n('SELECT COUNT(*) AS n FROM matches'),
      db.all("SELECT id, kind, amount, network, status, created_at FROM payments WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50"),
      db.all(
        `SELECT b.id, b.stake, b.status, b.creator_side, b.payout, b.commission, b.created_at,
                m.home_team, m.away_team, c.email AS creator_email, t.email AS taker_email, w.email AS winner_email
         FROM bets b JOIN matches m ON m.id = b.match_id
         JOIN users c ON c.id = b.creator_id
         LEFT JOIN users t ON t.id = b.taker_id
         LEFT JOIN users w ON w.id = b.winner_id
         ORDER BY b.id DESC LIMIT 200`,
      ),
      db.all(
        `SELECT p.id, p.amount, p.network, p.phone, p.status, p.created_at, p.updated_at, u.email
         FROM payments p JOIN users u ON u.id = p.user_id
         WHERE p.kind = 'withdrawal' ORDER BY p.created_at DESC LIMIT 200`,
      ),
    ]);
    const betHistory = betRows.map((b) => {
      const takerSide = b.creator_side === 'home' ? 'away' : 'home';
      const team = (s) => (s === 'home' ? b.home_team : b.away_team);
      return {
        id: b.id, match: `${b.home_team} vs ${b.away_team}`, stake: b.stake, status: b.status,
        created_at: b.created_at, payout: b.payout, commission: b.commission,
        creator: b.creator_email, creatorTeam: team(b.creator_side),
        taker: b.taker_email, takerTeam: b.taker_email ? team(takerSide) : null,
        winner: b.winner_email,
      };
    });
    return {
      data: {
        users, walletTotal, commission, openBets, matchedBets, lockedStakes, matches, pendingPayments,
        pendingCommission: matchedStakes.reduce((t, b) => t + commissionOn(b.stake), 0),
        betHistory, withdrawalHistory,
      },
    };
  });
  route('POST', '/api/admin/matches/:id/void', async (req, res, { params }) => {
    await requireAdmin(req);
    return { data: { refunded: await voidMatch(db, Number(params.id)) } };
  });
  route('POST', '/api/admin/sync', async (req) => {
    await requireAdmin(req);
    const count = await syncFn(db, dateOffset(0));
    return { data: { fixtures: count } };
  });

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(config.publicDir, rel);
    if (!file.startsWith(path.resolve(config.publicDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, SECURITY_HEADERS).end('Not found');
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return void res.writeHead(405).end();
      try {
        return serveStatic(req, res, url.pathname);
      } catch {
        return void res.writeHead(400).end();
      }
    }
    const send = (status, data, cookie) => {
      const headers = { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (cookie) headers['Set-Cookie'] = cookie;
      res.writeHead(status, headers).end(JSON.stringify(data));
    };
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new BizError('Route inconnue', 404);
      let body = {};
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host && !config.allowedOrigins.includes(origin)) throw new BizError('Origine refusée', 403);
        body = await readJson(req);
      }
      const out = await r.handler(req, res, {
        body, query: url.searchParams, params: r.re.exec(url.pathname).groups ?? {}, ip: req.socket.remoteAddress,
      });
      send(out.status ?? 200, out.data, out.cookie);
    } catch (err) {
      if (err instanceof BizError) return send(err.status, { error: err.message });
      console.error('[error]', err);
      send(500, { error: 'Erreur interne' });
    }
  });
}
