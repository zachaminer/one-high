'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { GameEngine } = require('./src/game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.sendStatus(200));

// ─── State ────────────────────────────────────────────────────────────────────

// Each seat slot: { token, name, seat, id (current socket id or null) }
const seats = [];   // up to 4 entries, persisted across disconnects

const engine = new GameEngine();

// Pending undo request: { requestingSeat, approvals: Set of seat indices }
let pendingUndo = null;

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

  // ── Redeal request (during bidding, for qualifying hands) ────────────────

  socket.on('requestRedeal', () => {
    const slot = seatBySocketId(socket.id);
    if (!slot) return;
    const result = engine.requestRedeal(slot.seat);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result.payload);
  });

  // ── Redeal vote (75/pass/pass/pass scenario) ──────────────────────────────

  socket.on('voteRedeal', () => {
    const slot = seatBySocketId(socket.id);
    if (!slot) return;
    const result = engine.voteRedeal(slot.seat);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState();
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
    if (pendingUndo) {
      // Cancel any pending undo when a new card is played
      for (const oppSeat of pendingUndo.opposingSeats) {
        emitToSeat(oppSeat, 'undoCancelled', {});
      }
      pendingUndo = null;
    }
    const result = engine.playCard(slot.seat, cardId);
    if (result.error) { socket.emit('error', result.error); return; }
    broadcastGameState(result);
  });

  // ── Undo request ─────────────────────────────────────────────────────────

  socket.on('requestUndo', () => {
    const slot = seatBySocketId(socket.id);
    if (!slot) return;

    if (pendingUndo) { socket.emit('error', 'An undo request is already pending'); return; }

    const pub = engine.getPublicState();
    if (pub?.phase !== 'playing') { socket.emit('error', 'Can only undo during play'); return; }

    const r = engine.game.round;

    // Determine who played last: either from current in-progress trick or the just-completed snapshot
    let lastPlaySeat = null;
    let lastPlayCard = null;
    if (r.currentTrick.length > 0) {
      const lp = r.currentTrick[r.currentTrick.length - 1];
      lastPlaySeat = lp.playerIndex;
      lastPlayCard = lp.card;
    } else if (r.lastTrickSnapshot) {
      const snap = r.lastTrickSnapshot;
      lastPlaySeat = snap.lastPlaySeat;
      lastPlayCard = snap.trick[snap.trick.length - 1].card;
    }

    if (lastPlaySeat === null) { socket.emit('error', 'No card to undo'); return; }
    if (lastPlaySeat !== slot.seat) {
      socket.emit('error', 'You can only undo your own last play');
      return;
    }

    // Opposing team seats
    const opposingSeats = [1, 3].includes(slot.seat) ? [0, 2] : [1, 3];
    pendingUndo = { requestingSeat: slot.seat, approvals: new Set(), opposingSeats };

    const requesterName = slot.name;
    const cardPlayed = lastPlayCard;

    for (const oppSeat of opposingSeats) {
      emitToSeat(oppSeat, 'undoRequest', {
        requesterName,
        card: cardPlayed,
        requestingSeat: slot.seat,
      });
    }

    socket.emit('undoPending', { message: 'Undo request sent — waiting for opponents to approve' });
  });

  // ── Undo response (approve or deny) ──────────────────────────────────────

  socket.on('respondUndo', ({ approve }) => {
    const slot = seatBySocketId(socket.id);
    if (!slot || !pendingUndo) return;

    if (!pendingUndo.opposingSeats.includes(slot.seat)) {
      socket.emit('error', 'You are not a reviewer for this undo request');
      return;
    }

    if (!approve) {
      // Denied — cancel and notify everyone involved
      const requesterSlot = seats.find(s => s.seat === pendingUndo.requestingSeat);
      if (requesterSlot?.id) {
        io.to(requesterSlot.id).emit('undoDenied', { denierName: slot.name });
      }
      for (const oppSeat of pendingUndo.opposingSeats) {
        emitToSeat(oppSeat, 'undoCancelled', {});
      }
      pendingUndo = null;
      return;
    }

    pendingUndo.approvals.add(slot.seat);

    if (pendingUndo.approvals.size === pendingUndo.opposingSeats.length) {
      // Both approved — apply undo
      const result = engine.undoLastPlay(pendingUndo.requestingSeat);
      pendingUndo = null;
      if (result.error) { socket.emit('error', result.error); return; }
      broadcastGameState(result);
    } else {
      // Still waiting for the other opponent
      emitToSeat(slot.seat, 'undoApprovedWaiting', {});
    }
  });

  // ── Remove a player from their seat (lobby only) ─────────────────────────

  socket.on('removeSeat', ({ seatIndex }) => {
    // Only allowed before a game starts
    if (engine.game) { socket.emit('error', 'Cannot remove a player mid-game'); return; }
    const idx = seats.findIndex(s => s.seat === seatIndex);
    if (idx === -1) return;
    const slot = seats[idx];

    // Cancel any pending eviction timer for this seat
    if (disconnectTimers[slot.seat]) {
      clearTimeout(disconnectTimers[slot.seat]);
      delete disconnectTimers[slot.seat];
    }

    // Tell the removed player's socket to reset (if still connected)
    if (slot.id) io.to(slot.id).emit('seatRemoved');

    seats.splice(idx, 1);
    // Re-index remaining seats so they stay 0-based and contiguous
    seats.forEach((s, i) => { s.seat = i; });

    io.emit('lobbyUpdate', lobbyPayload());
  });

  // ── Reset game (return everyone to empty lobby) ───────────────────────────

  socket.on('resetGame', () => {
    // Allow any socket that currently holds a seat (matched by id or by token
    // stored on the socket from a recent rejoin) to trigger a reset.
    // We intentionally do NOT guard here — if someone somehow sends this event
    // without a seat, the worst outcome is a no-op on an already-empty game.

    // Cancel all reconnect timers
    for (const t of Object.values(disconnectTimers)) clearTimeout(t);
    for (const k of Object.keys(disconnectTimers)) delete disconnectTimers[k];

    // Clear seats and engine
    seats.splice(0, seats.length);
    engine.game = null;
    pendingUndo = null;

    io.emit('gameReset');
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
