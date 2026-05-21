'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { GameEngine } = require('./src/game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────────────────

// Each seat slot: { token, name, seat, id (current socket id or null) }
const seats = [];   // up to 4 entries, persisted across disconnects

const engine = new GameEngine();

// Per-seat reconnect timers: if a player doesn't come back within TIMEOUT_MS
// we free their seat so someone else can join.
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const disconnectTimers = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seatByToken(token) {
  return seats.find(s => s.token === token);
}

function seatBySocketId(id) {
  return seats.find(s => s.id === id);
}

function lobbyPayload() {
  return {
    players: seats.map(s => ({ name: s.name, seat: s.seat, connected: s.id !== null })),
    full: seats.length === 4,
  };
}

function emitToSeat(seatIndex, event, data) {
  const s = seats.find(s => s.seat === seatIndex);
  if (s && s.id) io.to(s.id).emit(event, data);
}

function broadcastGameState(extra = {}) {
  const pub = engine.getPublicState();
  for (const s of seats) {
    if (!s.id) continue;
    io.to(s.id).emit('gameState', {
      ...pub,
      ...extra,
      yourSeat: s.seat,
      yourHand: engine.getHandFor(s.seat),
      playerNames: seats.map(sl => ({ seat: sl.seat, name: sl.name, connected: sl.id !== null })),
    });
  }
}

// ─── Socket events ────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── Rejoin with saved token ───────────────────────────────────────────────

  socket.on('rejoinLobby', ({ token }) => {
    const slot = seatByToken(token);
    if (!slot) {
      // Token no longer valid (seat was freed) — tell client to join fresh
      socket.emit('rejoinFailed');
      return;
    }

    // Cancel any pending eviction timer
    if (disconnectTimers[slot.seat]) {
      clearTimeout(disconnectTimers[slot.seat]);
      delete disconnectTimers[slot.seat];
    }

    // Swap in the new socket id
    slot.id = socket.id;
    console.log(`seat ${slot.seat} (${slot.name}) reconnected`);

    // Tell everyone this player is back
    io.emit('lobbyUpdate', lobbyPayload());

    // If a game is running, send the full state back to this player
    if (engine.game) {
      // Update the socket id in the engine too
      engine.game.playerIds[slot.seat] = socket.id;

      const pub = engine.getPublicState();
      socket.emit('gameState', {
        ...pub,
        yourSeat: slot.seat,
        yourHand: engine.getHandFor(slot.seat),
        playerNames: seats.map(sl => ({ seat: sl.seat, name: sl.name, connected: sl.id !== null })),
      });

      // Notify everyone else that the player is back
      broadcastGameState();
    }
  });

  // ── Fresh join ────────────────────────────────────────────────────────────

  socket.on('joinLobby', ({ name }) => {
    if (seats.length >= 4) {
      socket.emit('error', 'Game is full');
      return;
    }
    if (seatBySocketId(socket.id)) {
      socket.emit('error', 'Already joined');
      return;
    }

    const token = crypto.randomBytes(16).toString('hex');
    const seat = seats.length;
    seats.push({ token, name: String(name).slice(0, 20), seat, id: socket.id });

    // Send the token back so the client can store it
    socket.emit('joinedAs', { token, seat });

    io.emit('lobbyUpdate', lobbyPayload());

    // Auto-start when 4 players have joined
    if (seats.length === 4) {
      const ids = seats.map(s => s.id);
      const payload = engine.initGame(ids);
      broadcastGameState(payload);
    }
  });

  // ── Redeal request ────────────────────────────────────────────────────────

  socket.on('requestRedeal', () => {
    const slot = seatBySocketId(socket.id);
    if (!slot) return;
    const result = engine.requestRedeal(slot.seat);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result.payload);
  });

  // ── Bid ───────────────────────────────────────────────────────────────────

  socket.on('placeBid', ({ amount }) => {
    const slot = seatBySocketId(socket.id);
    if (!slot) return;
    const result = engine.placeBid(slot.seat, amount);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result);
  });

  // ── Kitty: discard + declare trump ────────────────────────────────────────

  socket.on('discardAndTrump', ({ cardId, trumpSuit }) => {
    const slot = seatBySocketId(socket.id);
    if (!slot) return;
    const result = engine.discardAndDeclareTrump(slot.seat, cardId, trumpSuit);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result);
  });

  // ── Play card ─────────────────────────────────────────────────────────────

  socket.on('playCard', ({ cardId }) => {
    const slot = seatBySocketId(socket.id);
    if (!slot) return;
    const result = engine.playCard(slot.seat, cardId);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result);
  });

  // ── Next round ────────────────────────────────────────────────────────────

  socket.on('nextRound', () => {
    const pub = engine.getPublicState();
    if (pub?.phase !== 'scoring') return;
    const result = engine.startNextRound();
    if (result.error) return;
    broadcastGameState(result);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    const slot = seatBySocketId(socket.id);
    if (!slot) return;

    // Mark as disconnected but keep the seat reserved
    slot.id = null;
    console.log(`seat ${slot.seat} (${slot.name}) disconnected — reserved for ${TIMEOUT_MS / 1000}s`);

    // Notify others the player is temporarily gone
    io.emit('lobbyUpdate', lobbyPayload());
    if (engine.game) {
      broadcastGameState();
    }

    // Start an eviction timer — if they don't come back, free the seat
    disconnectTimers[slot.seat] = setTimeout(() => {
      const idx = seats.indexOf(slot);
      if (idx !== -1) {
        console.log(`seat ${slot.seat} (${slot.name}) evicted after timeout`);
        seats.splice(idx, 1);
        // Re-index remaining seats so they stay 0-based
        seats.forEach((s, i) => s.seat = i);
        delete disconnectTimers[slot.seat];

        if (engine.game) {
          engine.game = null;
          io.emit('playerLeft', { name: slot.name, lobby: lobbyPayload() });
        } else {
          io.emit('lobbyUpdate', lobbyPayload());
        }
      }
    }, TIMEOUT_MS);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`One-High server running on port ${PORT}`));
