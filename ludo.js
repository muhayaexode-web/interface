import { randomInt } from 'node:crypto';
import { adjustBalance, AGO, BizError, NOW, notify, tx } from './db.js';
import { config } from './config.js';

const TRACK_LENGTH = 52;
const FINISH_POSITION = 57;
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const STARTS = { host: 0, opponent: 26 };

export const ludoCommissionOn = (stake) =>
  Math.floor((stake * config.commissionPercent) / 100);

export function legalPieceMoves(pieces, die) {
  if (!Number.isSafeInteger(die) || die < 1 || die > 6) return [];
  return pieces.flatMap((position, index) => (
    (position === -1 && die === 6)
      || (position >= 0 && position < FINISH_POSITION && position + die <= FINISH_POSITION)
      ? [index]
      : []
  ));
}

function globalSquare(position, start) {
  return (position + start) % TRACK_LENGTH;
}

export function moveLudoPiece(pieces, opponentPieces, pieceIndex, die, playerStart, opponentStart) {
  if (!Number.isSafeInteger(pieceIndex) || pieceIndex < 0 || pieceIndex >= pieces.length) {
    throw new BizError('Pion invalide');
  }
  if (!legalPieceMoves(pieces, die).includes(pieceIndex)) {
    throw new BizError('Ce pion ne peut pas avancer avec ce dé');
  }

  const nextPieces = [...pieces];
  const nextOpponentPieces = [...opponentPieces];
  const from = nextPieces[pieceIndex];
  const to = from === -1 ? 0 : from + die;
  nextPieces[pieceIndex] = to;
  let captured = 0;

  if (to < TRACK_LENGTH) {
    const square = globalSquare(to, playerStart);
    if (!SAFE_SQUARES.has(square)) {
      nextOpponentPieces.forEach((position, index) => {
        if (position >= 0 && position < TRACK_LENGTH
          && globalSquare(position, opponentStart) === square) {
          nextOpponentPieces[index] = -1;
          captured += 1;
        }
      });
    }
  }

  return { pieces: nextPieces, opponentPieces: nextOpponentPieces, captured };
}

function assertStake(stake) {
  if (!Number.isSafeInteger(stake) || stake < config.minStake || stake > config.maxStake) {
    throw new BizError(`La mise doit être entre ${config.minStake} et ${config.maxStake} CDF`);
  }
}

const playerLabel = (playerId) => `Joueur ${playerId}`;

function displayGame(game, userId) {
  const fee = ludoCommissionOn(game.stake);
  return {
    id: game.id,
    status: game.status,
    stake: game.stake,
    pot: game.stake * 2,
    commission: game.commission || fee,
    payout: game.payout || game.stake * 2 - fee,
    winnerId: game.winner_id,
    host: {
      id: game.host_id,
      label: playerLabel(game.host_id),
      color: 'rouge',
      pieces: game.host_pieces,
    },
    opponent: game.opponent_id === null ? null : {
      id: game.opponent_id,
      label: playerLabel(game.opponent_id),
      color: 'jaune',
      pieces: game.opponent_pieces,
    },
    turnPlayerId: game.turn_player_id,
    lastRoll: game.last_roll,
    myPlayerId: userId,
    canRoll: game.status === 'active'
      && game.turn_player_id === userId
      && game.last_roll === null,
    canMovePieces: game.status === 'active'
      && game.turn_player_id === userId
      && game.last_roll !== null
      ? legalPieceMoves(
        game.turn_player_id === game.host_id ? game.host_pieces : game.opponent_pieces,
        game.last_roll,
      )
      : [],
    createdAt: game.created_at,
    updatedAt: game.updated_at,
  };
}

async function loadGame(db, userId, gameId) {
  const game = await db.get('SELECT * FROM ludo_games WHERE id = ?', gameId);
  if (!game) throw new BizError('Partie introuvable', 404);
  if (game.host_id !== userId && game.opponent_id !== userId) {
    throw new BizError('Cette partie ne vous appartient pas', 403);
  }
  return displayGame(game, userId);
}

async function expireStaleGames(db) {
  await tx(db, async (t) => {
    const games = await t.all(
      `SELECT * FROM ludo_games
       WHERE status = 'active' AND updated_at < ${AGO('24 hours')}
       FOR UPDATE SKIP LOCKED`,
    );
    for (const game of games) {
      await adjustBalance(t, game.host_id, game.stake, 'ludo_refund', `ludo:${game.id}`);
      if (game.opponent_id !== null) {
        await adjustBalance(t, game.opponent_id, game.stake, 'ludo_refund', `ludo:${game.id}`);
      }
      await t.run(
        `UPDATE ludo_games SET status = 'refunded', last_roll = NULL, turn_player_id = NULL,
         updated_at = ${NOW}, settled_at = ${NOW} WHERE id = ? AND status IN ('open','active')`,
        game.id,
      );
      await notify(t, game.host_id, 'Mise Ludo remboursée', 'La partie a expiré et votre mise a été remboursée.');
      await notify(t, game.opponent_id, 'Mise Ludo remboursée', 'La partie a expiré et votre mise a été remboursée.');
    }
  });
}

async function assertNoOpenGame(t, userId) {
  const existing = await t.get(
    `SELECT id FROM ludo_games
     WHERE status IN ('open','active') AND (host_id = ? OR opponent_id = ?) LIMIT 1`,
    userId, userId,
  );
  if (existing) throw new BizError('Terminez ou annulez votre partie Ludo en cours avant d’en créer une autre', 409);
}

async function settle(t, game, winnerId) {
  const fee = ludoCommissionOn(game.stake);
  const payout = 2 * game.stake - fee;
  await adjustBalance(t, winnerId, payout, 'ludo_win', `ludo:${game.id}`);
  await adjustBalance(t, null, fee, 'commission', `ludo:${game.id}`);
  await t.run(
    `UPDATE ludo_games SET status = 'settled', winner_id = ?, payout = ?, commission = ?,
     last_roll = NULL, turn_player_id = NULL, updated_at = ${NOW}, settled_at = ${NOW}
     WHERE id = ? AND status = 'active'`,
    winnerId, payout, fee, game.id,
  );
  const loserId = winnerId === game.host_id ? game.opponent_id : game.host_id;
  await notify(t, winnerId, 'Partie Ludo gagnée', `Vous recevez ${payout} CDF après commission.`);
  await notify(t, loserId, 'Partie Ludo terminée', 'Votre adversaire a gagné. Votre mise a été utilisée pour le pot.');
  return { winnerId, payout, commission: fee };
}

export function createLudoService({ rollDie = () => randomInt(1, 7) } = {}) {
  return {
    async list(db, userId) {
      await expireStaleGames(db);
      const openRows = await db.all(
        `SELECT g.*
         FROM ludo_games g
         WHERE g.status = 'open' AND g.host_id <> ?
         ORDER BY g.created_at DESC LIMIT 50`,
        userId,
      );
      const myRows = await db.all(
        `SELECT g.*
         FROM ludo_games g
         WHERE (g.host_id = ? OR g.opponent_id = ?)
         ORDER BY CASE WHEN g.status IN ('open','active') THEN 0 ELSE 1 END, g.id DESC
         LIMIT 20`,
        userId, userId,
      );
      return {
        openGames: openRows.map((game) => ({
          id: game.id,
          stake: game.stake,
          hostLabel: playerLabel(game.host_id),
          createdAt: game.created_at,
        })),
        myGames: myRows.map((game) => displayGame(game, userId)),
      };
    },

    async get(db, userId, gameId) {
      await expireStaleGames(db);
      return loadGame(db, userId, gameId);
    },

    async create(db, userId, stake) {
      assertStake(stake);
      await expireStaleGames(db);
      const id = await tx(db, async (t) => {
        await t.get('SELECT id FROM users WHERE id = ? FOR UPDATE', userId);
        await assertNoOpenGame(t, userId);
        const { rows } = await t.run(
          'INSERT INTO ludo_games (host_id, stake) VALUES (?, ?) RETURNING id',
          userId, stake,
        );
        const gameId = rows[0].id;
        await adjustBalance(t, userId, -stake, 'ludo_stake', `ludo:${gameId}`);
        await t.run(
          `INSERT INTO notifications (user_id, title, body, event_key)
           SELECT id, ?, ?, ? FROM users WHERE id <> ?
           ON CONFLICT (user_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
          'Défi Ludo disponible',
          `Un joueur propose une partie avec une mise de ${stake} CDF (pot de ${2 * stake} CDF). Ouvrez le menu Jeu de 6 pour rejoindre.`,
          `ludo_offer:${gameId}`,
          userId,
        );
        return gameId;
      });
      return loadGame(db, userId, id);
    },

    async join(db, userId, gameId) {
      await expireStaleGames(db);
      await tx(db, async (t) => {
        await t.get('SELECT id FROM users WHERE id = ? FOR UPDATE', userId);
        await assertNoOpenGame(t, userId);
        const game = await t.get('SELECT * FROM ludo_games WHERE id = ? FOR UPDATE', gameId);
        if (!game || game.status !== 'open') throw new BizError('Cette partie n’est plus disponible', 409);
        if (game.host_id === userId) throw new BizError('Vous ne pouvez pas rejoindre votre propre partie');
        await adjustBalance(t, userId, -game.stake, 'ludo_stake', `ludo:${game.id}`);
        await t.run(
          `UPDATE ludo_games SET opponent_id = ?, status = 'active', turn_player_id = host_id,
           updated_at = ${NOW} WHERE id = ? AND status = 'open'`,
          userId, game.id,
        );
        await notify(t, game.host_id, 'Adversaire trouvé', 'Votre partie de Ludo peut commencer.');
      });
      return loadGame(db, userId, gameId);
    },

    async roll(db, userId, gameId) {
      await expireStaleGames(db);
      await tx(db, async (t) => {
        const game = await t.get('SELECT * FROM ludo_games WHERE id = ? FOR UPDATE', gameId);
        if (!game || game.status !== 'active') throw new BizError('La partie n’est pas active', 409);
        if (game.turn_player_id !== userId) throw new BizError('Ce n’est pas votre tour', 409);
        if (game.last_roll !== null) throw new BizError('Déplacez un pion avant de relancer', 409);
        const die = rollDie();
        if (!Number.isSafeInteger(die) || die < 1 || die > 6) throw new Error('Le dé a produit une valeur invalide');
        const pieces = game.host_id === userId ? game.host_pieces : game.opponent_pieces;
        if (legalPieceMoves(pieces, die).length === 0) {
          const nextPlayer = game.host_id === userId ? game.opponent_id : game.host_id;
          await t.run(
            `UPDATE ludo_games SET turn_player_id = ?, updated_at = ${NOW} WHERE id = ?`,
            nextPlayer, game.id,
          );
          return;
        }
        await t.run(
          `UPDATE ludo_games SET last_roll = ?, updated_at = ${NOW} WHERE id = ?`,
          die, game.id,
        );
      });
      return loadGame(db, userId, gameId);
    },

    async move(db, userId, gameId, pieceIndex) {
      await expireStaleGames(db);
      await tx(db, async (t) => {
        const game = await t.get('SELECT * FROM ludo_games WHERE id = ? FOR UPDATE', gameId);
        if (!game || game.status !== 'active') throw new BizError('La partie n’est pas active', 409);
        if (game.turn_player_id !== userId) throw new BizError('Ce n’est pas votre tour', 409);
        if (game.last_roll === null) throw new BizError('Lancez le dé avant de déplacer un pion', 409);

        const isHost = game.host_id === userId;
        const pieces = isHost ? game.host_pieces : game.opponent_pieces;
        const otherPieces = isHost ? game.opponent_pieces : game.host_pieces;
        const moved = moveLudoPiece(
          pieces,
          otherPieces,
          pieceIndex,
          game.last_roll,
          isHost ? STARTS.host : STARTS.opponent,
          isHost ? STARTS.opponent : STARTS.host,
        );
        const finished = moved.pieces.every((position) => position === FINISH_POSITION);

        if (finished) {
          await t.run(
            `UPDATE ludo_games SET ${isHost ? 'host_pieces' : 'opponent_pieces'} = ?,
             updated_at = ${NOW} WHERE id = ?`,
            JSON.stringify(moved.pieces), game.id,
          );
          await settle(t, game, userId);
          return;
        }

        const nextPlayer = game.last_roll === 6
          ? userId
          : (isHost ? game.opponent_id : game.host_id);
        await t.run(
          `UPDATE ludo_games SET host_pieces = ?, opponent_pieces = ?, turn_player_id = ?,
           last_roll = NULL, updated_at = ${NOW} WHERE id = ?`,
          JSON.stringify(isHost ? moved.pieces : moved.opponentPieces),
          JSON.stringify(isHost ? moved.opponentPieces : moved.pieces),
          nextPlayer,
          game.id,
        );
      });
      return loadGame(db, userId, gameId);
    },

    async cancel(db, userId, gameId) {
      await expireStaleGames(db);
      await tx(db, async (t) => {
        const game = await t.get('SELECT * FROM ludo_games WHERE id = ? FOR UPDATE', gameId);
        if (!game || game.host_id !== userId || !['open', 'refunded'].includes(game.status)) {
          throw new BizError('Seule une partie en attente créée par vous peut être annulée', 409);
        }
        if (game.status === 'refunded') return;
        await adjustBalance(t, userId, game.stake, 'ludo_refund', `ludo:${game.id}`);
        await t.run(
          `UPDATE ludo_games SET status = 'refunded', updated_at = ${NOW}, settled_at = ${NOW}
           WHERE id = ? AND status = 'open'`,
          game.id,
        );
      });
      return loadGame(db, userId, gameId);
    },

    async resign(db, userId, gameId) {
      await expireStaleGames(db);
      await tx(db, async (t) => {
        const game = await t.get('SELECT * FROM ludo_games WHERE id = ? FOR UPDATE', gameId);
        if (!game || game.status !== 'active'
          || (game.host_id !== userId && game.opponent_id !== userId)) {
          throw new BizError('La partie active est introuvable', 404);
        }
        const winnerId = game.host_id === userId ? game.opponent_id : game.host_id;
        await settle(t, game, winnerId);
      });
      return loadGame(db, userId, gameId);
    },
  };
}
