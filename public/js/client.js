'use strict';

// ─── Socket & state ──────────────────────────────────────────────────────────

const socket = io();

let myName = '';
let mySeat = null;
let gameState = null;
let selectedCard = null;  // card id selected for discard
let selectedTrump = null; // suit selected during kitty phase
let currentBid = 75;
let highBid = 0;

// ─── Suit helpers ────────────────────────────────────────────────────────────

const SUIT_ICONS = {
  Red: '♥',
  Black: '♠',
  Yellow: '★',
  Green: '♣',
  Rook: 'R',
};

const SUIT_CLASS = {
  Red: 'suit-red',
  Black: 'suit-black',
  Yellow: 'suit-yellow',
  Green: 'suit-green',
  Rook: 'suit-rook',
};

const POINTER_NUMBERS = new Set([1, 5, 10, 14]);
function isPointer(card) {
  if (card.id === 'Rook') return true;
  return POINTER_NUMBERS.has(card.number);
}

function cardLabel(card) {
  if (card.id === 'Rook') return 'Rook';
  return `${card.number} ${card.suit}`;
}

// ─── Sort state & logic ───────────────────────────────────────────────────────

// numDir: 'asc' = low→high (2s left, 14s/1s right), 'desc' = high→low
// suitDir: 'asc' = fewest cards left, 'desc' = most cards left
let sortNumDir  = 'asc';
let sortSuitDir = 'asc';

// Card rank within a suit: 2 is lowest, then 3..13, then 14, then 1 (highest)
function cardRank(card) {
  if (card.id === 'Rook') return 0; // Rook sorts to very bottom with 2s
  if (card.number === 1)  return 15; // Ace is highest
  if (card.number === 14) return 14;
  return card.number; // 2–13 map directly
}

function sortHand(hand) {
  // Count cards per suit so we can order suits by size
  const suitCounts = {};
  for (const card of hand) {
    suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
  }

  // Suit order: sort suit names by their card count, then alphabetically to break ties
  const SUIT_ORDER = ['Red', 'Black', 'Yellow', 'Green', 'Rook'];
  const suits = [...new Set(hand.map(c => c.suit))].sort((a, b) => {
    const diff = (suitCounts[a] || 0) - (suitCounts[b] || 0);
    if (diff !== 0) return sortSuitDir === 'asc' ? diff : -diff;
    return SUIT_ORDER.indexOf(a) - SUIT_ORDER.indexOf(b);
  });

  const suitIndex = Object.fromEntries(suits.map((s, i) => [s, i]));

  return [...hand].sort((a, b) => {
    // Primary: suit group
    const si = suitIndex[a.suit] - suitIndex[b.suit];
    if (si !== 0) return si;
    // Secondary: rank within suit
    const ri = cardRank(a) - cardRank(b);
    return sortNumDir === 'asc' ? ri : -ri;
  });
}

function applySortButtons() {
  document.getElementById('sort-num-asc').classList.toggle('active', sortNumDir === 'asc');
  document.getElementById('sort-num-desc').classList.toggle('active', sortNumDir === 'desc');
  document.getElementById('sort-suit-asc').classList.toggle('active', sortSuitDir === 'asc');
  document.getElementById('sort-suit-desc').classList.toggle('active', sortSuitDir === 'desc');
}

// ─── Card DOM builder ────────────────────────────────────────────────────────

function buildCard(card, opts = {}) {
  const el = document.createElement('div');
  el.className = `card ${SUIT_CLASS[card.suit]}`;
  if (card.id === 'Rook') el.className = 'card suit-rook';
  if (isPointer(card)) el.classList.add('is-pointer');
  if (opts.playable) el.classList.add('playable');
  if (opts.selected) el.classList.add('selected');
  el.dataset.cardId = card.id;

  if (card.id === 'Rook') {
    el.innerHTML = `<div class="card-number">ROOK</div>`;
  } else {
    el.innerHTML = `
      <div class="card-corner">${card.number}</div>
      <div class="card-number">${card.number}</div>
    `;
  }
  return el;
}

function buildCardBack(vertical = false) {
  const el = document.createElement('div');
  el.className = `card-back${vertical ? ' vertical' : ''}`;
  return el;
}

// ─── Lobby UI ────────────────────────────────────────────────────────────────

const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen  = document.getElementById('game-screen');
const joinBtn     = document.getElementById('join-btn');
const nameInput   = document.getElementById('name-input');

joinBtn.addEventListener('click', joinGame);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });

// ─── Reconnection via stored token ───────────────────────────────────────────

// On load, try to rejoin with a saved token before showing the join form
const savedToken = localStorage.getItem('oneHighToken');
if (savedToken) {
  joinBtn.disabled = true;
  nameInput.disabled = true;
  nameInput.placeholder = 'Reconnecting…';
  socket.emit('rejoinLobby', { token: savedToken });
}

socket.on('joinedAs', ({ token, seat }) => {
  localStorage.setItem('oneHighToken', token);
  mySeat = seat;
});

socket.on('rejoinFailed', () => {
  // Token expired or invalid — clear it and let the user join fresh
  localStorage.removeItem('oneHighToken');
  joinBtn.disabled = false;
  nameInput.disabled = false;
  nameInput.placeholder = 'Your name';
});

function joinGame() {
  const name = nameInput.value.trim();
  if (!name) { toast('Enter your name first'); return; }
  myName = name;
  socket.emit('joinLobby', { name });
  joinBtn.disabled = true;
}

socket.on('lobbyUpdate', ({ players, full }) => {
  for (let i = 0; i < 4; i++) {
    const p = players.find(p => p.seat === i);
    const el = document.getElementById(`seat-${i}`);
    const nameEl = el.querySelector('.seat-name');
    if (p) {
      nameEl.textContent = p.connected ? p.name : `${p.name} (away)`;
    } else {
      nameEl.textContent = '—';
    }
    el.classList.toggle('filled', !!p);
    el.classList.toggle('disconnected', !!(p && !p.connected));
  }
});

// ─── Transition to game ───────────────────────────────────────────────────────

function showGame() {
  lobbyScreen.classList.remove('active');
  gameScreen.classList.add('active');
}

// ─── Game state handler ───────────────────────────────────────────────────────

socket.on('gameState', (state) => {
  if (mySeat === null && state.yourSeat !== undefined) {
    mySeat = state.yourSeat;
  }
  gameState = state;
  // Clear play-phase selection when a new state arrives (e.g. another player just went)
  if (state.phase !== 'playing' || !isMyTurnToPlay(state)) selectedCard = null;
  showGame();
  render(state);
});

socket.on('playerLeft', ({ name, lobby }) => {
  localStorage.removeItem('oneHighToken');
  showOverlay('Game Reset', `${name} was away too long. The game has been reset.`, 'Back to Lobby', () => {
    location.reload();
  });
});

socket.on('error', (msg) => toast('⚠ ' + msg));

// ─── Main render ─────────────────────────────────────────────────────────────

function render(state) {
  updateScorebar(state);
  updatePlayerNames(state);
  updateTrumpIndicator(state);
  updateTrickCounts(state);
  renderTrick(state);
  renderKittyCard(state);
  renderOpponentHands(state);
  renderMyHand(state);
  renderActionPanel(state);
}

function updateScorebar(state) {
  document.getElementById('score-a').textContent = state.scores[0];
  document.getElementById('score-b').textContent = state.scores[1];

  // Team labels: show "Name1 & Name2" when players are known
  if (state.playerNames) {
    const nameOf = seat => state.playerNames.find(p => p.seat === seat)?.name;
    // Seats 0 & 2 = Team A, seats 1 & 3 = Team B
    const a0 = nameOf(0), a2 = nameOf(2);
    const b1 = nameOf(1), b3 = nameOf(3);
    document.getElementById('label-a').textContent =
      (a0 && a2) ? `${a0} & ${a2}` : (a0 || a2 || 'Team A');
    document.getElementById('label-b').textContent =
      (b1 && b3) ? `${b1} & ${b3}` : (b1 || b3 || 'Team B');
  }

  const phases = { bidding: 'BIDDING', kitty: 'KITTY', playing: 'PLAYING', scoring: 'SCORING', gameover: 'GAME OVER' };
  document.getElementById('phase-label').textContent = phases[state.phase] || state.phase?.toUpperCase() || '';

  const r = state.round;
  if (r && r.highBid > 0) {
    const bidderName = nameForSeat(r.highBidder, state);
    document.getElementById('bid-label').textContent = `Bid: ${r.highBid} (${bidderName})`;
  } else {
    document.getElementById('bid-label').textContent = '';
  }
}

function nameForSeat(seat, state) {
  if (seat === null || seat === undefined) return '?';
  const p = state.playerNames?.find(p => p.seat === seat);
  return p ? p.name : `Seat ${seat + 1}`;
}

function updatePlayerNames(state) {
  if (!state.playerNames) return;

  // Relative seat positions: self, across(+2), left(+1), right(+3)
  const rel = [
    { offset: 0, zoneSuffix: 'self' },
    { offset: 2, zoneSuffix: 'across' },
    { offset: 1, zoneSuffix: 'left' },
    { offset: 3, zoneSuffix: 'right' },
  ];

  rel.forEach(({ offset, zoneSuffix }) => {
    const seat = (mySeat + offset) % 4;
    const p = state.playerNames.find(p => p.seat === seat);
    const name = p ? p.name : '—';
    const teamLetter = seat % 2 === 0 ? 'A' : 'B';

    const nameEl = document.getElementById(`${zoneSuffix}-name`);
    const tagEl  = document.getElementById(`${zoneSuffix}-tag`);
    const connected = p ? p.connected !== false : false;
    if (nameEl) {
      if (zoneSuffix === 'self') {
        nameEl.textContent = `${name} (you)`;
      } else {
        nameEl.textContent = connected ? name : `${name} ↻`;
        nameEl.title = connected ? '' : 'Reconnecting…';
      }
    }
    if (tagEl) tagEl.textContent = `Team ${teamLetter}`;

    // Active turn indicator
    const zone = document.querySelector(`.${zoneSuffix}-zone`);
    if (zone) {
      zone.classList.remove('active-turn');
      if (isThisPlayersTurn(seat, state)) zone.classList.add('active-turn');
    }
  });
}

function isThisPlayersTurn(seat, state) {
  const r = state.round;
  if (!r) return false;
  if (state.phase === 'bidding') return r.currentBidder === seat;
  if (state.phase === 'playing') {
    const expected = r.currentTrick?.length === 0
      ? r.currentLeader
      : (r.currentLeader + r.currentTrick.length) % 4;
    return expected === seat;
  }
  return false;
}

function updateTrumpIndicator(state) {
  const el = document.getElementById('trump-indicator');
  const r = state.round;
  if (r?.trumpSuit) {
    el.textContent = r.trumpSuit === 'NoTrump' ? 'No Trump' : `Trump: ${r.trumpSuit}`;
  } else {
    el.textContent = '';
  }
}

function updateTrickCounts(state) {
  const r = state.round;
  if (!r) return;
  document.getElementById('trick-count-a').textContent = `A: ${r.trickCounts?.[0] ?? 0}`;
  document.getElementById('trick-count-b').textContent = `B: ${r.trickCounts?.[1] ?? 0}`;
}

// ─── Trick rendering ──────────────────────────────────────────────────────────

function renderTrick(state) {
  const r = state.round;
  const slots = {
    self:   document.getElementById('trick-self'),
    across: document.getElementById('trick-across'),
    left:   document.getElementById('trick-left'),
    right:  document.getElementById('trick-right'),
  };

  // Clear
  Object.values(slots).forEach(s => s.innerHTML = '');

  if (!r?.currentTrick) return;

  r.currentTrick.forEach(({ playerIndex, card }) => {
    const slotKey = relativePosition(playerIndex);
    const el = slots[slotKey];
    if (el) el.appendChild(buildCard(card));
  });
}

function relativePosition(seat) {
  const offset = ((seat - mySeat) + 4) % 4;
  return ['self', 'left', 'across', 'right'][offset];
}

// ─── Kitty card display ───────────────────────────────────────────────────────

function renderKittyCard(state) {
  const el = document.getElementById('kitty-display');
  if (state.phase !== 'kitty' || !state.round?.kitty) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'kitty-label';
  label.textContent = 'Kitty';
  el.appendChild(label);

  el.appendChild(buildCard(state.round.kitty));
}

// ─── Opponent hands ───────────────────────────────────────────────────────────

function renderOpponentHands(state) {
  const opponents = [
    { offset: 2, id: 'across-hand',  vertical: false },
    { offset: 1, id: 'left-hand',    vertical: true  },
    { offset: 3, id: 'right-hand',   vertical: true  },
  ];

  const r = state.round;

  opponents.forEach(({ offset, id, vertical }) => {
    const el = document.getElementById(id);
    el.innerHTML = '';
    // Show card backs — count from hands if available (server sends all hands)
    const seat = (mySeat + offset) % 4;
    // state.hands may be present in some phases
    const handSize = r ? (14 - (r.tricks || 0)) : 14;
    const count = Math.max(0, handSize - (r?.currentTrick?.filter(p => p.playerIndex === seat).length ?? 0));
    const actualCount = r ? countHandSize(seat, state) : 14;
    for (let i = 0; i < actualCount; i++) {
      el.appendChild(buildCardBack(vertical));
    }
  });
}

function countHandSize(seat, state) {
  // Approximate: starts at 14, decreases with tricks played
  const r = state.round;
  if (!r) return 14;
  const tricksPlayed = r.tricks ?? 0;
  const inCurrentTrick = r.currentTrick?.filter(p => p.playerIndex === seat).length ?? 0;
  return Math.max(0, 14 - tricksPlayed - inCurrentTrick);
}

// ─── My hand ─────────────────────────────────────────────────────────────────

function renderMyHand(state) {
  const container = document.getElementById('my-hand');
  container.innerHTML = '';

  const hand = sortHand(state.yourHand || []);
  const phase = state.phase;
  const r = state.round;

  applySortButtons();

  hand.forEach(card => {
    const isKittyPhase = phase === 'kitty' && r?.bidWinner === mySeat;
    const isPlayPhase  = phase === 'playing' && isMyTurnToPlay(state);

    let playable = false;
    if (isKittyPhase) playable = !isPointerCard(card);
    if (isPlayPhase)  playable = true;

    const isSelected = card.id === selectedCard;
    const el = buildCard(card, { playable, selected: isSelected });

    if (isKittyPhase) {
      el.addEventListener('click', () => {
        if (isPointerCard(card)) { toast('Cannot discard a pointer card'); return; }
        selectedCard = card.id;
        renderMyHand(state);
        updateKittyConfirmButton();
      });
    }

    if (isPlayPhase) {
      el.addEventListener('click', () => {
        if (selectedCard === card.id) {
          // Second tap on the same card — play it
          socket.emit('playCard', { cardId: card.id });
          selectedCard = null;
        } else {
          // First tap — select (lift) this card, deselect any other
          selectedCard = card.id;
          renderMyHand(state);
        }
      });
    }

    container.appendChild(el);
  });
}

function isPointerCard(card) {
  if (card.id === 'Rook') return true;
  return [1, 5, 10, 14].includes(card.number);
}

function isMyTurnToPlay(state) {
  const r = state.round;
  if (!r) return false;
  const expected = r.currentTrick?.length === 0
    ? r.currentLeader
    : (r.currentLeader + r.currentTrick.length) % 4;
  return expected === mySeat;
}

// ─── Action panel ─────────────────────────────────────────────────────────────

function renderActionPanel(state) {
  const bidControls   = document.getElementById('bid-controls');
  const kittyControls = document.getElementById('kitty-controls');
  const statusMsg     = document.getElementById('status-msg');

  bidControls.style.display   = 'none';
  kittyControls.style.display = 'none';
  statusMsg.style.display     = 'none';

  const r = state.round;

  if (state.phase === 'bidding') {
    if (r.currentBidder === mySeat && r.bids?.[mySeat] !== 'pass') {
      bidControls.style.display = 'flex';
      highBid = r.highBid || 0;
      currentBid = Math.max(75, highBid + 5);
      // First bidder minimum is 75
      if (r.currentBidder === r.firstBidder && r.bids?.[mySeat] === null) {
        currentBid = Math.max(75, highBid + 5);
      }
      document.getElementById('bid-amount').textContent = currentBid;
      // Show/hide pass button
      const passBtn = document.getElementById('bid-pass');
      const isFirstBidFirstTurn = mySeat === r.firstBidder && r.bids?.[mySeat] === null;
      passBtn.style.display = isFirstBidFirstTurn ? 'none' : '';
    } else {
      statusMsg.style.display = 'flex';
      const bidder = nameForSeat(r.currentBidder, state);
      const passed = r.bids?.[mySeat] === 'pass';
      document.getElementById('status-text').textContent =
        passed ? `You passed. Waiting for ${bidder}…` : `${bidder} is bidding…`;
    }
  }

  else if (state.phase === 'kitty') {
    if (r.bidWinner === mySeat) {
      kittyControls.style.display = 'flex';
      updateKittyConfirmButton();
    } else {
      statusMsg.style.display = 'flex';
      const winner = nameForSeat(r.bidWinner, state);
      document.getElementById('status-text').textContent = `${winner} won the bid (${r.highBid}). Waiting for trump declaration…`;
    }
  }

  else if (state.phase === 'playing') {
    statusMsg.style.display = 'flex';
    if (isMyTurnToPlay(state)) {
      document.getElementById('status-text').textContent = 'Your turn — click a card to play';
    } else {
      const expected = r.currentTrick?.length === 0
        ? r.currentLeader
        : (r.currentLeader + r.currentTrick.length) % 4;
      const who = nameForSeat(expected, state);
      document.getElementById('status-text').textContent = `Waiting for ${who} to play…`;
    }
  }

  else if (state.phase === 'scoring') {
    handleScoring(state);
  }

  else if (state.phase === 'gameover') {
    handleGameOver(state);
  }
}

function updateKittyConfirmButton() {
  // Trump buttons fire the action directly when both discard+trump selected
}

// ─── Trump selection + discard confirm ───────────────────────────────────────

document.querySelectorAll('.trump-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!selectedCard) { toast('Select a card to discard first'); return; }
    const trumpSuit = btn.dataset.suit;
    socket.emit('discardAndTrump', { cardId: selectedCard, trumpSuit });
    selectedCard = null;
    selectedTrump = null;
  });
});

// ─── Bid controls ─────────────────────────────────────────────────────────────

document.getElementById('bid-minus').addEventListener('click', () => {
  currentBid = Math.max(Math.max(75, highBid + 5), currentBid - 5);
  document.getElementById('bid-amount').textContent = currentBid;
});

document.getElementById('bid-plus').addEventListener('click', () => {
  currentBid = Math.min(200, currentBid + 5);
  document.getElementById('bid-amount').textContent = currentBid;
});

document.getElementById('bid-submit').addEventListener('click', () => {
  socket.emit('placeBid', { amount: currentBid });
});

document.getElementById('bid-pass').addEventListener('click', () => {
  socket.emit('placeBid', { amount: 'pass' });
});

document.getElementById('redeal-btn').addEventListener('click', () => {
  socket.emit('requestRedeal');
});

// ─── Scoring overlay ──────────────────────────────────────────────────────────

function handleScoring(state) {
  const r = state.round;
  if (!r) return;

  const bidTeam   = r.bidWinner % 2;
  const nonBidTeam = 1 - bidTeam;
  const teamLabels = ['A', 'B'];

  // Reconstruct scoring from state
  const s0 = state.scores[0];
  const s1 = state.scores[1];

  const body = `
    <table style="width:100%;border-collapse:collapse;font-family:'DM Mono',monospace;font-size:0.82rem">
      <tr><td style="padding:4px 8px;opacity:.6">Bid Team</td><td>Team ${teamLabels[bidTeam]} (bid ${r.highBid})</td></tr>
      <tr><td style="padding:4px 8px;opacity:.6">Tricks</td><td>A: ${r.trickCounts?.[0] ?? 0} &nbsp;·&nbsp; B: ${r.trickCounts?.[1] ?? 0}</td></tr>
    </table>
    <p style="margin-top:1rem;font-family:'DM Mono',monospace;font-size:0.85rem">
      Running score: &nbsp;<span style="color:#6fa3e0">A: ${s0}</span> &nbsp;·&nbsp; <span style="color:#e06f6f">B: ${s1}</span>
    </p>
  `;

  showOverlay('Round Over', body, 'Next Round', () => {
    socket.emit('nextRound');
  });
}

function handleGameOver(state) {
  const winner = state.winner;
  const teamLabel = winner === 0 ? 'Team A' : 'Team B';
  const s = state.scores;
  showOverlay(
    `🏆 ${teamLabel} Wins!`,
    `<p style="font-family:'DM Mono',monospace">Final scores:<br/>Team A: ${s[0]} &nbsp;·&nbsp; Team B: ${s[1]}</p><p style="margin-top:1rem;opacity:.7;font-size:.85rem">Refresh the page to play again.</p>`,
    null, null
  );
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

function showOverlay(title, bodyHtml, btnText, onBtn) {
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-body').innerHTML = bodyHtml;
  const btn = document.getElementById('overlay-btn');
  if (btnText) {
    btn.style.display = '';
    btn.textContent = btnText;
    btn.onclick = () => { hideOverlay(); onBtn && onBtn(); };
  } else {
    btn.style.display = 'none';
  }
  document.getElementById('overlay').classList.remove('hidden');
}

function hideOverlay() {
  document.getElementById('overlay').classList.add('hidden');
}

// ─── Sort controls ───────────────────────────────────────────────────────────

document.getElementById('sort-num-asc').addEventListener('click', () => {
  sortNumDir = 'asc';
  if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-num-desc').addEventListener('click', () => {
  sortNumDir = 'desc';
  if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-suit-asc').addEventListener('click', () => {
  sortSuitDir = 'asc';
  if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-suit-desc').addEventListener('click', () => {
  sortSuitDir = 'desc';
  if (gameState) renderMyHand(gameState);
});

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
