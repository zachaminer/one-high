'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GameEngine } = require('./src/game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Lobby state ──────────────────────────────────────────────────────────────

const lobby = {
  players: [],   // [{id, name, seat}]  up to 4
};

const engine = new GameEngine();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lobbyPayload() {
  return {
    players: lobby.players.map(p => ({ name: p.name, seat: p.seat })),
    full: lobby.players.length === 4,
  };
}

function emitToSeat(seat, event, data) {
  const p = lobby.players.find(p => p.seat === seat);
  if (p) io.to(p.id).emit(event, data);
}

function broadcastGameState(extra = {}) {
  const pub = engine.getPublicState();
  for (const p of lobby.players) {
    io.to(p.id).emit('gameState', {
      ...pub,
      ...extra,
      yourSeat: p.seat,
      yourHand: engine.getHandFor(p.seat),
      playerNames: lobby.players.map(lp => ({ seat: lp.seat, name: lp.name })),
    });
  }
}

// ─── Socket events ────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── Join lobby ────────────────────────────────────────────────────────────

  socket.on('joinLobby', ({ name }) => {
    if (lobby.players.length >= 4) {
      socket.emit('error', 'Game is full');
      return;
    }
    if (lobby.players.find(p => p.id === socket.id)) {
      socket.emit('error', 'Already joined');
      return;
    }

    const seat = lobby.players.length;
    lobby.players.push({ id: socket.id, name: String(name).slice(0, 20), seat });
    io.emit('lobbyUpdate', lobbyPayload());

    // Auto-start when 4 players join
    if (lobby.players.length === 4) {
      const ids = lobby.players.map(p => p.id);
      const payload = engine.initGame(ids);
      broadcastGameState(payload);
    }
  });

  // ── Redeal request ────────────────────────────────────────────────────────

  socket.on('requestRedeal', () => {
    const seat = engine.seatOf(socket.id);
    if (seat === -1) return;
    const result = engine.requestRedeal(seat);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result.payload);
  });

  // ── Bid ───────────────────────────────────────────────────────────────────

  socket.on('placeBid', ({ amount }) => {
    const seat = engine.seatOf(socket.id);
    if (seat === -1) return;
    const result = engine.placeBid(seat, amount);
    if (result.error) { socket.emit('error', result.error); return; }
    if (result.autoRedeal) {
      broadcastGameState(result.payload);
    } else if (result.phase === 'kitty') {
      broadcastGameState(result);
    } else {
      broadcastGameState(result);
    }
  });

  // ── Kitty: discard + declare trump ────────────────────────────────────────

  socket.on('discardAndTrump', ({ cardId, trumpSuit }) => {
    const seat = engine.seatOf(socket.id);
    if (seat === -1) return;
    const result = engine.discardAndDeclareTrump(seat, cardId, trumpSuit);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result);
  });

  // ── Play card ─────────────────────────────────────────────────────────────

  socket.on('playCard', ({ cardId }) => {
    const seat = engine.seatOf(socket.id);
    if (seat === -1) return;
    const result = engine.playCard(seat, cardId);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result);
  });

  // ── Next round ────────────────────────────────────────────────────────────

  socket.on('nextRound', () => {
    const pub = engine.getPublicState();
    if (pub?.phase !== 'scoring') return;
    // Only bid winner's team or anyone can advance – just need one click
    const result = engine.startNextRound();
    if (result.error) return;
    broadcastGameState(result);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    const idx = lobby.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const name = lobby.players[idx].name;
      lobby.players.splice(idx, 1);
      // Reset game if it was in progress
      if (engine.game) {
        engine.game = null;
        // Re-seat remaining players
        lobby.players.forEach((p, i) => p.seat = i);
        io.emit('playerLeft', { name, lobby: lobbyPayload() });
      } else {
        io.emit('lobbyUpdate', lobbyPayload());
      }
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`One-High server running on port ${PORT}`));
