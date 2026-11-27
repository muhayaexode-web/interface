import { STATUS_CODES } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { BizError } from './db.js';
import { userFromRequest } from './auth.js';

const CHANNEL = 'ludo_game_state';

function send(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    console.error('[ludo-realtime] Envoi WebSocket échoué', error);
    socket.close(1011, 'Unable to send game state');
  }
}

function recipientView(game, userId) {
  return {
    ...game,
    myPlayerId: userId,
    canRoll: game.status === 'active'
      && game.turnPlayerId === userId
      && game.lastRoll === null,
    canMovePieces: game.myPlayerId === userId ? game.canMovePieces : [],
  };
}

export function attachLudoRealtime(server, db, ludo) {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const rooms = new Map();
  const heartbeat = setInterval(() => {
    for (const client of webSockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, 25000);
  heartbeat.unref();
  let listenerClient = null;
  let listenerPromise = null;

  const broadcast = (game) => {
    const room = rooms.get(Number(game.id));
    if (!room) return;
    for (const socket of room) {
      send(socket, {
        type: 'game_state',
        game: recipientView(game, socket.userId),
      });
    }
  };

  const ensureListener = () => {
    if (listenerPromise) return listenerPromise;
    listenerPromise = db.pool.connect()
      .then(async (client) => {
        listenerClient = client;
        client.on('notification', (notification) => {
          if (notification.channel !== CHANNEL || !notification.payload) return;
          try {
            broadcast(JSON.parse(notification.payload));
          } catch (error) {
            console.error('[ludo-realtime] Événement PostgreSQL invalide', error);
          }
        });
        client.on('error', (error) => {
          console.error('[ludo-realtime] Connexion LISTEN perdue', error);
          if (listenerClient === client) {
            listenerClient = null;
            listenerPromise = null;
            client.release(true);
          }
        });
        try {
          await client.query(`LISTEN ${CHANNEL}`);
        } catch (error) {
          if (listenerClient === client) {
            listenerClient = null;
            client.release(true);
          }
          throw error;
        }
      })
      .catch((error) => {
        listenerClient = null;
        listenerPromise = null;
        throw error;
      });
    return listenerPromise;
  };

  const publish = async (game) => {
    const payload = JSON.stringify(game);
    try {
      await db.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
      if (!listenerClient) broadcast(game);
    } catch (error) {
      console.error('[ludo-realtime] Publication du coup échouée', error);
      broadcast(game);
    }
  };

  webSockets.on('connection', (socket, _request, user, game) => {
    socket.userId = user.id;
    socket.gameId = Number(game.id);
    socket.actionPending = false;
    const room = rooms.get(socket.gameId) ?? new Set();
    room.add(socket);
    rooms.set(socket.gameId, room);
    send(socket, { type: 'game_state', game: recipientView(game, user.id) });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: 'action_error', error: 'Message WebSocket invalide.' });
        return;
      }

      const requestId = Number.isSafeInteger(message?.requestId) ? message.requestId : null;
      const rejectAction = (error) => {
        const text = error instanceof BizError ? error.message : 'Action Ludo impossible.';
        if (!(error instanceof BizError)) console.error('[ludo-realtime] Action échouée', error);
        send(socket, { type: 'action_error', requestId, error: text });
      };

      if (!requestId || !['roll', 'move'].includes(message?.type)) {
        rejectAction(new BizError('Action WebSocket invalide.'));
        return;
      }
      if (message.type === 'move' && !Number.isSafeInteger(message.pieceIndex)) {
        rejectAction(new BizError('Pion invalide.'));
        return;
      }
      if (socket.actionPending) {
        rejectAction(new BizError('Un coup est déjà en cours.'));
        return;
      }

      socket.actionPending = true;
      const action = message.type === 'roll'
        ? ludo.roll(db, user.id, socket.gameId)
        : ludo.move(db, user.id, socket.gameId, message.pieceIndex);
      void action.then((updatedGame) => {
        send(socket, {
          type: 'action_result',
          requestId,
          game: recipientView(updatedGame, user.id),
        });
        void publish(updatedGame);
      }).catch(rejectAction).finally(() => {
        socket.actionPending = false;
      });
    });

    socket.on('close', () => {
      const currentRoom = rooms.get(socket.gameId);
      currentRoom?.delete(socket);
      if (currentRoom?.size === 0) rooms.delete(socket.gameId);
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/api/ludo/realtime') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const gameId = Number(url.searchParams.get('gameId'));
    if (!Number.isSafeInteger(gameId) || gameId < 1) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    void (async () => {
      const user = await userFromRequest(db, request);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const game = await ludo.get(db, user.id, gameId);
      if (!['open', 'active'].includes(game.status)) {
        socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      await ensureListener();
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit('connection', client, request, user, game);
      });
    })().catch((error) => {
      if (!(error instanceof BizError)) {
        console.error('[ludo-realtime] Connexion refusée', error);
      }
      if (!socket.destroyed) {
        const status = error instanceof BizError ? error.status : 503;
        const reason = STATUS_CODES[status] ?? 'Error';
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      }
    });
  });

  server.once('close', () => {
    clearInterval(heartbeat);
    for (const client of webSockets.clients) client.close(1001, 'Server shutting down');
    webSockets.close();
    if (listenerClient) {
      listenerClient.release(true);
      listenerClient = null;
      listenerPromise = null;
    }
  });

  return { publish };
}
