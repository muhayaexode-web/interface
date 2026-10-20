import { adjustBalance, BizError, NOW, tx } from './db.js';
import { config } from './config.js';

const BETTABLE = new Set(['Scheduled', 'LIVE']);
const FINISHED = new Set(['FT', 'AET', 'PENS']);
const VOID = new Set(['Cancelled', 'Postponed']);

export const opposite = (side) => (side === 'home' ? 'away' : 'home');

// 'home' | 'away' | 'draw' | null (résultat pas encore exploitable)
export function outcomeOf(m) {
  if (!FINISHED.has(m.status) || m.result === null || m.result === undefined) return null;
  if (m.result === 1) return 'home';
  if (m.result === -1) return 'away';
  if (m.penalty_home !== null && m.penalty_away !== null && m.penalty_home !== m.penalty_away) {
    return m.penalty_home > m.penalty_away ? 'home' : 'away';
  }
  return 'draw';
}

export const commissionOn = (stake) => Math.floor((stake * config.commissionPercent) / 100);

async function getMatch(t, id) {
  const m = await t.get('SELECT * FROM matches WHERE id = ?', id);
  if (!m) throw new BizError('Match introuvable', 404);
  return m;
}

export async function createOffer(db, userId, { matchId, side, stake }) {
  if (side !== 'home' && side !== 'away') throw new BizError('Équipe invalide');
  if (!Number.isSafeInteger(stake) || stake < config.minStake || stake > config.maxStake) {
    throw new BizError(`La mise doit être entre ${config.minStake} et ${config.maxStake} CDF`);
  }
  return tx(db, async (t) => {
    const m = await getMatch(t, matchId);
    if (!BETTABLE.has(m.status)) throw new BizError('Les paris sont fermés pour ce match');
    const { rows } = await t.run(
      'INSERT INTO bets (match_id, creator_id, creator_side, stake) VALUES (?, ?, ?, ?) RETURNING id',
      matchId, userId, side, stake,
    );
    await adjustBalance(t, userId, -stake, 'bet_stake', `bet:${rows[0].id}`);
    return rows[0].id;
  });
}

export async function acceptOffer(db, userId, betId) {
  await tx(db, async (t) => {
    // FOR UPDATE : deux joueurs ne peuvent pas accepter le même pari en même temps.
    const bet = await t.get('SELECT * FROM bets WHERE id = ? FOR UPDATE', betId);
    if (!bet) throw new BizError('Pari introuvable', 404);
    if (bet.status !== 'open') throw new BizError('Ce pari n\'est plus disponible', 409);
    if (bet.creator_id === userId) throw new BizError('Vous ne pouvez pas accepter votre propre pari');
    const m = await getMatch(t, bet.match_id);
    if (!BETTABLE.has(m.status)) throw new BizError('Les paris sont fermés pour ce match');
    await adjustBalance(t, userId, -bet.stake, 'bet_stake', `bet:${bet.id}`);
    await t.run(`UPDATE bets SET taker_id = ?, status = 'matched', matched_at = ${NOW} WHERE id = ?`, userId, bet.id);
  });
}

// Une offre non acceptée peut être retirée ; une fois acceptée, la mise est verrouillée jusqu'à la fin du match.
export async function cancelOffer(db, userId, betId) {
  await tx(db, async (t) => {
    const bet = await t.get('SELECT * FROM bets WHERE id = ? FOR UPDATE', betId);
    if (!bet || bet.creator_id !== userId) throw new BizError('Pari introuvable', 404);
    if (bet.status !== 'open') throw new BizError('Ce pari a déjà été accepté : annulation impossible', 409);
    await t.run(`UPDATE bets SET status = 'cancelled', settled_at = ${NOW} WHERE id = ?`, bet.id);
    await adjustBalance(t, userId, bet.stake, 'bet_refund', `bet:${bet.id}`);
  });
}

async function refundBet(t, bet) {
  await adjustBalance(t, bet.creator_id, bet.stake, 'bet_refund', `bet:${bet.id}`);
  if (bet.taker_id) await adjustBalance(t, bet.taker_id, bet.stake, 'bet_refund', `bet:${bet.id}`);
  await t.run(`UPDATE bets SET status = 'refunded', settled_at = ${NOW} WHERE id = ?`, bet.id);
}

// Règle les paris d'un match terminé ou annulé. Idempotent : ne traite que les paris open/matched.
export async function settleMatch(db, matchId) {
  return tx(db, async (t) => {
    const m = await t.get('SELECT * FROM matches WHERE id = ?', matchId);
    if (!m) return 0;
    const bets = await t.all(
      "SELECT * FROM bets WHERE match_id = ? AND status IN ('open','matched') ORDER BY id FOR UPDATE",
      matchId,
    );
    if (bets.length === 0) return 0;

    if (VOID.has(m.status)) {
      for (const b of bets) await refundBet(t, b);
      return bets.length;
    }
    const outcome = outcomeOf(m);
    if (outcome === null) return 0;

    for (const b of bets) {
      if (b.status === 'open' || outcome === 'draw') {
        await refundBet(t, b);
        continue;
      }
      const winnerId = b.creator_side === outcome ? b.creator_id : b.taker_id;
      const commission = commissionOn(b.stake);
      const payout = 2 * b.stake - commission;
      await adjustBalance(t, winnerId, payout, 'bet_win', `bet:${b.id}`);
      await adjustBalance(t, null, commission, 'commission', `bet:${b.id}`);
      await t.run(
        `UPDATE bets SET status = 'settled', winner_id = ?, payout = ?, commission = ?, settled_at = ${NOW} WHERE id = ?`,
        winnerId, payout, commission, b.id,
      );
    }
    return bets.length;
  });
}

// Annulation manuelle par un admin : rembourse tout le monde.
export async function voidMatch(db, matchId) {
  await tx(db, async (t) => {
    await getMatch(t, matchId);
    await t.run("UPDATE matches SET status = 'Cancelled', voided = 1 WHERE id = ?", matchId);
  });
  return settleMatch(db, matchId);
}
