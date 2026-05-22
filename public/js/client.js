'use strict';

// ─── Socket & state ──────────────────────────────────────────────────────────

const socket = io();

let myName = '';
let mySeat = null;
let gameState = null;
let selectedCard = null;
let currentBid = 75;
let highBid = 0;

// Trick animation state
let prevTrickCards = [];
let trickAnimating = false;
let pendingFly = null;

// Prevent duplicate scoring/gameover overlays
let overlayShownForPhase = null;

// Undo state
let undoPending = false;  // I sent an undo request, waiting on opponents

// Redeal vote state
let myRedealVoteCast = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SUIT_CLASS = {
  Red: 'suit-red', Black: 'suit-black',
  Yellow: 'suit-yellow', Green: 'suit-green', Rook: 'suit-rook',
};

const POINTER_NUMBERS = new Set([1, 5, 10, 14]);

function isPointerCard(card) {
  return card.id === 'Rook' || POINTER_NUMBERS.has(card.number);
}

function nameForSeat(seat, state) {
  if (seat == null) return '?';
  return state.playerNames?.find(p => p.seat === seat)?.name ?? `Seat ${seat + 1}`;
}

function relativePosition(seat) {
  return ['self', 'left', 'across', 'right'][((seat - mySeat) + 4) % 4];
}

function isMyTurnToPlay(state) {
  const r = state.round;
  if (!r) return false;
  const expected = r.currentTrick?.length === 0
    ? r.currentLeader
    : (r.currentLeader + r.currentTrick.length) % 4;
  return expected === mySeat;
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

// ─── Card DOM builder ─────────────────────────────────────────────────────────

function buildCard(card, opts = {}) {
  const el = document.createElement('div');
  el.className = `card ${card.id === 'Rook' ? 'suit-rook' : SUIT_CLASS[card.suit]}`;
  if (isPointerCard(card)) el.classList.add('is-pointer');
  if (opts.playable) el.classList.add('playable');
  if (opts.selected) el.classList.add('selected');
  el.dataset.cardId = card.id;

  el.innerHTML = card.id === 'Rook'
    ? `<div class="card-number">ROOK</div>`
    : `<div class="card-corner">${card.number}</div><div class="card-number">${card.number}</div>`;

  return el;
}

function buildCardBack(vertical = false) {
  const el = document.createElement('div');
  el.className = `card-back${vertical ? ' vertical' : ''}`;
  return el;
}

// ─── Sort state & logic ───────────────────────────────────────────────────────

let sortNumDir  = 'asc';
let sortSuitDir = 'asc';

function cardRank(card) {
  if (card.id === 'Rook') return 0;
  if (card.number === 1)  return 15;
  if (card.number === 14) return 14;
  return card.number;
}

function sortHand(hand) {
  const trumpSuit = gameState?.round?.trumpSuit;

  const suitCounts = {};
  for (const card of hand) {
    const bucket = (trumpSuit && trumpSuit !== 'NoTrump' && card.id === 'Rook')
      ? trumpSuit : card.suit;
    suitCounts[bucket] = (suitCounts[bucket] || 0) + 1;
  }

  const SUIT_ORDER = ['Red', 'Black', 'Yellow', 'Green'];
  const nonRookSuits = [...new Set(hand.map(c => c.suit).filter(s => s !== 'Rook'))];
  nonRookSuits.sort((a, b) => {
    const diff = (suitCounts[a] || 0) - (suitCounts[b] || 0);
    return diff !== 0 ? (sortSuitDir === 'asc' ? diff : -diff)
                      : SUIT_ORDER.indexOf(a) - SUIT_ORDER.indexOf(b);
  });

  function cardSuitIndex(card) {
    if (card.id === 'Rook') {
      if (trumpSuit && trumpSuit !== 'NoTrump') return nonRookSuits.indexOf(trumpSuit);
      return sortSuitDir === 'asc' ? -1 : nonRookSuits.length;
    }
    return nonRookSuits.indexOf(card.suit);
  }

  return [...hand].sort((a, b) => {
    const si = cardSuitIndex(a) - cardSuitIndex(b);
    if (si !== 0) return si;
    if (a.id === 'Rook') return sortNumDir === 'asc' ? -1 : 1;
    if (b.id === 'Rook') return sortNumDir === 'asc' ? 1 : -1;
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

// ─── Lobby ────────────────────────────────────────────────────────────────────

const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen  = document.getElementById('game-screen');
const joinBtn     = document.getElementById('join-btn');
const nameInput   = document.getElementById('name-input');

joinBtn.addEventListener('click', joinGame);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });

const savedToken = sessionStorage.getItem('oneHighToken');
if (savedToken) {
  joinBtn.disabled = true;
  nameInput.disabled = true;
  nameInput.placeholder = 'Reconnecting…';
  socket.emit('rejoinLobby', { token: savedToken });
}

function joinGame() {
  const name = nameInput.value.trim();
  if (!name) { toast('Enter your name first'); return; }
  myName = name;
  socket.emit('joinLobby', { name });
  joinBtn.disabled = true;
}

socket.on('joinedAs', ({ token, seat }) => {
  sessionStorage.setItem('oneHighToken', token);
  mySeat = seat;
});

socket.on('rejoinFailed', () => {
  sessionStorage.removeItem('oneHighToken');
  joinBtn.disabled = false;
  nameInput.disabled = false;
  nameInput.placeholder = 'Your name';
});

socket.on('lobbyUpdate', ({ players }) => {
  for (let i = 0; i < 4; i++) {
    const p = players.find(p => p.seat === i);
    const el = document.getElementById(`seat-${i}`);
    el.querySelector('.seat-name').textContent = p
      ? (p.connected ? p.name : `${p.name} (away)`)
      : '—';
    el.classList.toggle('filled', !!p);
    el.classList.toggle('disconnected', !!(p && !p.connected));
  }
  closeSeatPopover();
});

// ─── Seat popover ─────────────────────────────────────────────────────────────

let seatPopoverTarget = null;

function closeSeatPopover() {
  document.getElementById('seat-popover').classList.add('hidden');
  seatPopoverTarget = null;
}

function openSeatPopover(seatIndex, playerName, anchorEl) {
  seatPopoverTarget = seatIndex;
  document.getElementById('seat-popover-name').textContent = playerName;
  document.getElementById('seat-popover-remove').onclick = () => {
    socket.emit('removeSeat', { seatIndex });
    closeSeatPopover();
  };

  const popover = document.getElementById('seat-popover');
  popover.classList.remove('hidden');

  const rect = anchorEl.getBoundingClientRect();
  const pw = popover.offsetWidth || 160;
  const ph = popover.offsetHeight || 90;
  let left = rect.left + rect.width / 2 - pw / 2;
  let top  = rect.bottom + 6;
  left = Math.max(8, Math.min(left, window.innerWidth  - pw - 8));
  top  = Math.max(8, Math.min(top,  window.innerHeight - ph - 8));
  popover.style.left = `${left}px`;
  popover.style.top  = `${top}px`;
}

for (let i = 0; i < 4; i++) {
  document.getElementById(`seat-${i}`).addEventListener('click', function () {
    if (!this.classList.contains('filled')) return;
    if (seatPopoverTarget === i) { closeSeatPopover(); return; }
    openSeatPopover(i, this.querySelector('.seat-name').textContent, this);
  });
}

document.addEventListener('click', (e) => {
  const popover = document.getElementById('seat-popover');
  if (popover.classList.contains('hidden')) return;
  if (popover.contains(e.target) || e.target.closest('.seat')) return;
  closeSeatPopover();
}, { capture: true });

socket.on('seatRemoved', () => {
  sessionStorage.removeItem('oneHighToken');
  mySeat = null;
  joinBtn.disabled = false;
  nameInput.disabled = false;
  nameInput.placeholder = 'Your name';
  nameInput.value = '';
  toast('You were removed from your seat');
});

// ─── Game state handler ───────────────────────────────────────────────────────

function showGame() {
  lobbyScreen.classList.remove('active');
  gameScreen.classList.add('active');
}

socket.on('gameState', (state) => {
  if (mySeat === null && state.yourSeat !== undefined) mySeat = state.yourSeat;
  gameState = state;
  if (state.phase !== 'playing' || !isMyTurnToPlay(state)) selectedCard = null;
  showGame();

  if (state.undone) {
    undoPending = false;
    removeUndoBanner();
    pendingFly = null;
    trickAnimating = false;
    document.querySelectorAll('.trick-win-flash').forEach(o => o.remove());
    removeTricksBonusBanner();
    render(state);
    return;
  }

  const lastPlays = state.lastTrickPlays;
  const trickJustCompleted = Array.isArray(lastPlays) && lastPlays.length === 4;

  if (trickJustCompleted && !trickAnimating && !pendingFly) {
    const winTeam = (state.lastTrickWinner ?? 0) % 2;
    pendingFly = { winTeam };
    prevTrickCards = lastPlays;

    renderTrickCards(lastPlays);
    updatePlayerNames(state);
    updateTrumpIndicator(state);
    renderKittyCard(state);
    renderOpponentHands(state);
    renderMyHand(state);
    updateUndoButton(state);
    document.getElementById('trick-area').classList.remove('trick-area-hidden');

    // Flash the winning team color over each card at 0.5s, fade out by 2s
    const flashColor = winTeam === 0 ? '#6fa3e0' : '#e06f6f';
    const slots = getTrickSlots();
    Object.values(slots).forEach(slot => {
      const overlay = document.createElement('div');
      overlay.className = 'trick-win-flash';
      overlay.style.background = flashColor;
      slot.appendChild(overlay);
    });
    setTimeout(() => {
      document.querySelectorAll('.trick-win-flash').forEach(o => o.classList.add('flash-in'));
      if (state.tricksBonus != null) showTricksBonusBanner(state.tricksBonus);
    }, 500);
    setTimeout(() => {
      document.querySelectorAll('.trick-win-flash').forEach(o => {
        o.classList.remove('flash-in');
        o.classList.add('flash-out');
      });
      hideTricksBonusBanner();
    }, 2000);

    setTimeout(() => {
      if (!pendingFly) return;
      pendingFly = null;
      trickAnimating = true;
      removeTricksBonusBanner();
      animateTrickToPile(winTeam, state, () => {
        trickAnimating = false;
        const prev = state.prevRoundPoints;
        const rp = state.round?.roundPoints;
        render(state);
        if (prev && rp) animateRoundScore(String(prev[0]), String(prev[1]), String(rp[0]), String(rp[1]));
      });
    }, 2500);

  } else if (pendingFly && state.phase === 'playing' && (state.round?.currentTrick?.length ?? 0) >= 1) {
    // A new card was played before the 2.5s timer fired — skip straight to pile immediately
    const { winTeam } = pendingFly;
    pendingFly = null;
    trickAnimating = true;
    renderTrick(state);
    animateTrickToPile(winTeam, state, () => {
      trickAnimating = false;
      const prev = state.prevRoundPoints;
      const rp = state.round?.roundPoints;
      render(state);
      if (prev && rp) animateRoundScore(String(prev[0]), String(prev[1]), String(rp[0]), String(rp[1]));
    });

  } else if (!trickAnimating) {
    render(state);
  }
});

socket.on('playerLeft', ({ name }) => {
  sessionStorage.removeItem('oneHighToken');
  showOverlay('Game Reset', `${name} was away too long. The game has been reset.`, 'Back to Lobby', () => {
    location.reload();
  });
});

socket.on('error', msg => toast('⚠ ' + msg));

// ─── Main render ──────────────────────────────────────────────────────────────

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
  updateUndoButton(state);

  const hideTricks = ['bidding', 'kitty', 'redeal-vote'].includes(state.phase);
  document.getElementById('trick-area').classList.toggle('trick-area-hidden', hideTricks);
  document.body.classList.toggle('phase-redeal-vote', state.phase === 'redeal-vote');
  if (state.phase !== 'redeal-vote') {
    document.documentElement.style.removeProperty('--rv-side-col-w');
  }
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function updateScorebar(state) {
  document.getElementById('score-a').textContent = state.scores[0];
  document.getElementById('score-b').textContent = state.scores[1];

  const rp = state.round?.roundPoints;
  const inPlay = ['playing', 'scoring', 'gameover'].includes(state.phase);
  document.getElementById('round-score-a').textContent = (inPlay && rp) ? rp[0] : '—';
  document.getElementById('round-score-b').textContent = (inPlay && rp) ? rp[1] : '—';

  if (state.playerNames) {
    const nameOf = seat => state.playerNames.find(p => p.seat === seat)?.name;
    document.getElementById('label-a').textContent =
      [nameOf(0), nameOf(2)].filter(Boolean).join(' & ') || 'Team A';
    document.getElementById('label-b').textContent =
      [nameOf(1), nameOf(3)].filter(Boolean).join(' & ') || 'Team B';
  }

  ['self', 'across', 'left', 'right'].forEach(zone => {
    document.getElementById(`${zone}-bid`)?.classList.add('hidden');
  });
  const r = state.round;
  if (r?.highBid > 0 && r.highBidder !== null) {
    const pos = relativePosition(r.highBidder);
    const el = document.getElementById(`${pos}-bid`);
    if (el) { el.textContent = `Bid: ${r.highBid}`; el.classList.remove('hidden'); }
  }
}

function updatePlayerNames(state) {
  if (!state.playerNames) return;

  [
    { offset: 0, zone: 'self' },
    { offset: 2, zone: 'across' },
    { offset: 1, zone: 'left' },
    { offset: 3, zone: 'right' },
  ].forEach(({ offset, zone }) => {
    const seat = (mySeat + offset) % 4;
    const p = state.playerNames.find(p => p.seat === seat);
    const name = p?.name ?? '—';
    const connected = p?.connected !== false;
    const teamLetter = seat % 2 === 0 ? 'A' : 'B';

    const nameEl = document.getElementById(`${zone}-name`);
    const tagEl  = document.getElementById(`${zone}-tag`);
    if (nameEl) {
      nameEl.textContent = zone === 'self'
        ? `${name} (you)`
        : connected ? name : `${name} ↻`;
      if (zone !== 'self') nameEl.title = connected ? '' : 'Reconnecting…';
    }
    if (tagEl) {
      tagEl.textContent = `Team ${teamLetter}`;
      tagEl.className = `player-tag team-tag-${teamLetter.toLowerCase()}`;
    }

    document.querySelector(`.${zone}-zone`)
      ?.classList.toggle('active-turn', isThisPlayersTurn(seat, state));
  });
}

const TRUMP_SUIT_CLASS = {
  Red: 'trump-red', Black: 'trump-black',
  Yellow: 'trump-yellow', Green: 'trump-green', NoTrump: 'trump-none',
};

function updateTrumpIndicator(state) {
  const el = document.getElementById('trump-indicator');
  el.className = 'trump-indicator';
  const ts = state.round?.trumpSuit;
  if (ts) {
    el.textContent = ts === 'NoTrump' ? 'No Trump' : `Trump: ${ts}`;
    el.classList.add(TRUMP_SUIT_CLASS[ts] ?? '');
  } else {
    el.textContent = '';
  }
}

function updateTrickCounts(state) {
  const r = state.round;
  if (!r) return;
  const ca = r.trickCounts?.[0] ?? 0;
  const cb = r.trickCounts?.[1] ?? 0;
  document.getElementById('trick-pile-badge-a').textContent = ca;
  document.getElementById('trick-pile-badge-b').textContent = cb;
  document.getElementById('trick-pile-a').classList.toggle('empty', ca === 0);
  document.getElementById('trick-pile-b').classList.toggle('empty', cb === 0);
}

// ─── Trick rendering ──────────────────────────────────────────────────────────

function getTrickSlots() {
  return {
    self:   document.getElementById('trick-self'),
    across: document.getElementById('trick-across'),
    left:   document.getElementById('trick-left'),
    right:  document.getElementById('trick-right'),
  };
}

function renderTrickCards(plays) {
  const slots = getTrickSlots();
  Object.values(slots).forEach(s => { s.innerHTML = ''; });
  plays.forEach(({ playerIndex, card }) => {
    const el = slots[relativePosition(playerIndex)];
    if (el) el.appendChild(buildCard(card));
  });
}

function renderTrick(state) {
  const slots = getTrickSlots();
  Object.values(slots).forEach(s => { s.innerHTML = ''; });
  state.round?.currentTrick?.forEach(({ playerIndex, card }) => {
    const el = slots[relativePosition(playerIndex)];
    if (el) el.appendChild(buildCard(card));
  });
}

// ─── Tricks bonus banner ──────────────────────────────────────────────────────

function showTricksBonusBanner(winTeam) {
  removeTricksBonusBanner();
  const banner = document.createElement('div');
  banner.id = 'tricks-bonus-banner';
  banner.className = 'tricks-bonus-banner';

  const color = winTeam === 0 ? '#6fa3e0' : '#e06f6f';
  const label = winTeam === 0 ? 'Team A' : 'Team B';
  banner.innerHTML = `<div class="tricks-bonus-title" style="color:${color}">Tricks! +20</div><div class="tricks-bonus-sub">${label} clinched the tricks bonus</div>`;

  const confettiColors = ['#6fa3e0', '#e06f6f', '#c9a84c', '#4caf50', '#f5eed8', '#a78bfa'];
  for (let i = 0; i < 24; i++) {
    const p = document.createElement('div');
    p.className = 'tricks-confetti';
    const angle = (i / 24) * 360;
    const dist  = 50 + Math.random() * 45;
    const tx = Math.round(Math.cos(angle * Math.PI / 180) * dist);
    const ty = Math.round(Math.sin(angle * Math.PI / 180) * dist);
    p.style.cssText = `--tx:${tx}px;--ty:${ty}px;--rot:${Math.round(Math.random()*540)}deg;background:${confettiColors[i % confettiColors.length]};animation-delay:${(Math.random()*0.15).toFixed(2)}s`;
    banner.appendChild(p);
  }

  document.body.appendChild(banner);
  requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add('show')));
}

function hideTricksBonusBanner() {
  const banner = document.getElementById('tricks-bonus-banner');
  if (banner) { banner.classList.remove('show'); banner.classList.add('hide'); }
}

function removeTricksBonusBanner() {
  document.getElementById('tricks-bonus-banner')?.remove();
}

// ─── Round score wheel animation ─────────────────────────────────────────────

function animateRoundScore(oldA, oldB, newA, newB) {
  [
    { id: 'round-score-a', oldVal: oldA, newVal: newA },
    { id: 'round-score-b', oldVal: oldB, newVal: newB },
  ].forEach(({ id, oldVal, newVal }) => {
    const el = document.getElementById(id);
    if (!el || oldVal === newVal) return;

    const outgoing = document.createElement('span');
    outgoing.className = 'score-round-wheel-out';
    outgoing.textContent = oldVal;

    const incoming = document.createElement('span');
    incoming.className = 'score-round-wheel-in';
    incoming.textContent = newVal;

    el.innerHTML = '';
    el.appendChild(outgoing);
    el.appendChild(incoming);

    setTimeout(() => { el.textContent = newVal; }, 400);
  });
}

// ─── Trick animation ──────────────────────────────────────────────────────────

function animateTrickToPile(winTeam, state, onDone) {
  const pileEl   = document.getElementById(winTeam === 0 ? 'trick-pile-a' : 'trick-pile-b');
  const pileRect = pileEl.getBoundingClientRect();
  const slots    = getTrickSlots();

  const flyCards = [];
  prevTrickCards.forEach(({ playerIndex, card }) => {
    const pos    = relativePosition(playerIndex);
    const cardEl = slots[pos]?.querySelector('.card');
    if (!cardEl) return;
    const rect = cardEl.getBoundingClientRect();
    const fly  = document.createElement('div');
    fly.className = `trick-fly-card ${cardEl.className}`;
    fly.style.cssText = `width:${rect.width}px;height:${rect.height}px;left:${rect.left}px;top:${rect.top}px`;
    fly.innerHTML = cardEl.innerHTML;
    document.body.appendChild(fly);
    flyCards.push(fly);
  });

  Object.values(slots).forEach(s => { s.innerHTML = ''; });

  const fw = parseFloat(flyCards[0]?.style.width  || 40);
  const fh = parseFloat(flyCards[0]?.style.height || 56);
  const targetX = pileRect.left + pileRect.width  / 2 - fw / 2;
  const targetY = pileRect.top  + pileRect.height / 2 - fh / 2;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    flyCards.forEach((fly, i) => {
      fly.classList.add('flying');
      fly.style.left = `${targetX}px`;
      fly.style.top  = `${targetY}px`;
      fly.style.transitionDelay = `${i * 20}ms`;
    });

    setTimeout(() => {
      flyCards.forEach(f => f.remove());
      const count  = state.round?.trickCounts?.[winTeam] ?? 0;
      const suffix = winTeam === 0 ? 'a' : 'b';
      document.getElementById(`trick-pile-badge-${suffix}`).textContent = count;
      document.getElementById(`trick-pile-${suffix}`).classList.remove('empty');
      onDone();
    }, 500);
  }));
}

// ─── Kitty card display ───────────────────────────────────────────────────────

function renderKittyCard(state) {
  const el = document.getElementById('kitty-display');
  const showKitty = ['kitty', 'redeal-vote'].includes(state.phase) && state.round?.kitty;
  el.classList.toggle('hidden', !showKitty);
  el.innerHTML = '';
  if (!showKitty) return;

  const label = document.createElement('div');
  label.className = 'kitty-label';
  label.textContent = 'Kitty';
  el.appendChild(label);
  el.appendChild(buildCard(state.round.kitty));
}

// ─── Opponent hands ───────────────────────────────────────────────────────────

function renderOpponentHands(state) {
  const r = state.round;
  const isRedealVote = state.phase === 'redeal-vote';

  let sideHandCols = 2;
  if (isRedealVote) {
    const cs        = getComputedStyle(document.documentElement);
    const cardWSmPx = parseFloat(cs.getPropertyValue('--card-w-sm')) || 46;
    const cardHSmPx = parseFloat(cs.getPropertyValue('--card-h-sm')) || 66;
    const scorebarH = parseFloat(cs.getPropertyValue('--scorebar-h')) || 48;
    const handStripH = parseFloat(cs.getPropertyValue('--hand-strip-h')) || 145;
    const acrossZoneH = 44 + cardHSmPx + 8;
    const availH = Math.max(cardHSmPx,
      window.innerHeight - scorebarH - handStripH - acrossZoneH - 16 - 44);
    const sevenRowH = 7 * cardHSmPx + 6 * 2;
    if (availH < sevenRowH - cardHSmPx) {
      const perCol = Math.max(1, Math.floor((availH + 2) / (cardHSmPx + 2)));
      sideHandCols = Math.max(2, Math.ceil(14 / perCol));
    }
    const sideColW = sideHandCols * cardWSmPx + (sideHandCols - 1) * 2;
    document.documentElement.style.setProperty('--rv-side-col-w', `${sideColW}px`);
  }

  [
    { offset: 2, id: 'across-hand', vertical: false },
    { offset: 1, id: 'left-hand',   vertical: true  },
    { offset: 3, id: 'right-hand',  vertical: true  },
  ].forEach(({ offset, id, vertical }) => {
    const el   = document.getElementById(id);
    el.innerHTML = '';
    const seat = (mySeat + offset) % 4;

    if (isRedealVote && r?.allHands?.[seat]) {
      if (vertical) { el.classList.add('vertical'); el.style.setProperty('--rv-cols', sideHandCols); }
      else          { el.classList.remove('vertical'); el.style.removeProperty('--rv-cols'); }
      sortHand(r.allHands[seat]).forEach(card => el.appendChild(buildCard(card)));
    } else {
      el.style.removeProperty('--rv-cols');
      const tricksPlayed = r?.tricks ?? 0;
      const inCurrentTrick = r?.currentTrick?.filter(p => p.playerIndex === seat).length ?? 0;
      const count = Math.max(0, 14 - tricksPlayed - inCurrentTrick);
      if (vertical) el.classList.add('vertical'); else el.classList.remove('vertical');
      for (let i = 0; i < count; i++) el.appendChild(buildCardBack(vertical));
    }
  });
}

// ─── My hand ──────────────────────────────────────────────────────────────────

function renderMyHand(state) {
  const container = document.getElementById('my-hand');
  container.innerHTML = '';
  applySortButtons();

  const hand = sortHand(state.yourHand || []);
  const isKittyPhase = state.phase === 'kitty' && state.round?.bidWinner === mySeat;
  const isPlayPhase  = state.phase === 'playing' && isMyTurnToPlay(state);

  hand.forEach(card => {
    const playable = (isKittyPhase && !isPointerCard(card)) || isPlayPhase;
    const el = buildCard(card, { playable, selected: card.id === selectedCard });

    if (isKittyPhase) {
      el.addEventListener('click', () => {
        if (isPointerCard(card)) { toast('Cannot discard a pointer card'); return; }
        selectedCard = card.id;
        renderMyHand(state);
      });
    }

    if (isPlayPhase) {
      el.addEventListener('click', () => {
        if (selectedCard === card.id) {
          socket.emit('playCard', { cardId: card.id });
          selectedCard = null;
        } else {
          selectedCard = card.id;
          renderMyHand(state);
        }
      });
    }

    container.appendChild(el);
  });
}

// ─── Bid history ──────────────────────────────────────────────────────────────

function renderBidHistory(state) {
  const el = document.getElementById('bid-history');
  el.innerHTML = '';
  const log = state.round?.bidLog ?? [];

  if (log.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bid-log-empty';
    empty.textContent = 'No bids yet';
    el.appendChild(empty);
    return;
  }

  log.forEach(({ seat, amount }, i) => {
    const isPass = amount === 'pass';
    const isHigh = !isPass && amount === state.round.highBid && seat === state.round.highBidder;
    const row = document.createElement('div');
    row.className = 'bid-log-row';
    if (isPass)         row.classList.add('is-pass');
    if (isHigh)         row.classList.add('is-high');
    if (i === log.length - 1) row.classList.add('is-latest');
    const nameText = nameForSeat(seat, state) + (seat === mySeat ? ' (you)' : '');
    row.innerHTML = `<span class="bid-log-name">${nameText}</span><span class="bid-log-val">${isPass ? 'Pass' : amount}</span>`;
    el.appendChild(row);
  });

  el.scrollTop = el.scrollHeight;
}

// ─── Action panel ─────────────────────────────────────────────────────────────

function renderActionPanel(state) {
  const panel         = document.getElementById('action-panel');
  const bidControls   = document.getElementById('bid-controls');
  const kittyControls = document.getElementById('kitty-controls');
  const statusMsg     = document.getElementById('status-msg');

  bidControls.style.display   = 'none';
  kittyControls.style.display = 'none';
  statusMsg.style.display     = 'none';

  const statusTextEl = document.getElementById('status-text');
  if (statusTextEl) statusTextEl.style.display = '';
  statusMsg.querySelector('.redeal-vote-panel')?.remove();

  panel.classList.toggle('panel-playing', state.phase === 'playing');
  panel.classList.toggle('panel-kitty', state.phase === 'kitty');

  const r = state.round;

  if (state.phase === 'bidding') {
    overlayShownForPhase = null;
    myRedealVoteCast = false;
    document.body.classList.remove('phase-redeal-vote');
    document.getElementById('trick-holding-a').classList.add('hidden');
    document.getElementById('trick-holding-b').classList.add('hidden');

    bidControls.style.display = 'flex';
    renderBidHistory(state);
    highBid = r.highBid || 0;

    const myTurn = r.currentBidder === mySeat && r.bids?.[mySeat] !== 'pass';
    document.getElementById('bid-current').textContent = r.highBid > 0
      ? `Current high bid: ${r.highBid} — ${nameForSeat(r.highBidder, state)}`
      : 'No bids yet — minimum 75';

    const bidInputRow = document.getElementById('bid-input-row');
    const bidSubmit   = document.getElementById('bid-submit');
    const passBtn     = document.getElementById('bid-pass');
    const redealBtn   = document.getElementById('redeal-btn');

    if (myTurn) {
      bidInputRow.style.display = 'flex';
      bidSubmit.style.display   = '';
      redealBtn.style.display   = '';
      currentBid = Math.max(75, highBid + 5);
      document.getElementById('bid-amount').textContent = currentBid;
      passBtn.style.display = (mySeat === r.firstBidder && r.bids?.[mySeat] === null) ? 'none' : '';
      document.getElementById('bid-waiting-msg').style.display = 'none';
    } else {
      bidInputRow.style.display = 'none';
      bidSubmit.style.display   = 'none';
      passBtn.style.display     = 'none';
      redealBtn.style.display   = 'none';
      const waitingEl = document.getElementById('bid-waiting-msg');
      waitingEl.style.display = '';
      waitingEl.textContent = `Waiting for ${nameForSeat(r.currentBidder, state)} to bid…`;
    }

  } else if (state.phase === 'redeal-vote') {
    panel.classList.add('panel-kitty');
    statusMsg.style.display = 'flex';
    renderRedealVotePanel(state);

  } else if (state.phase === 'kitty') {
    if (r.bidWinner === mySeat) {
      kittyControls.style.display = 'flex';
    } else {
      statusMsg.style.display = 'flex';
      document.getElementById('status-text').textContent =
        `${nameForSeat(r.bidWinner, state)} won the bid (${r.highBid}). Waiting for trump declaration…`;
    }

  } else if (state.phase === 'playing') {
    statusMsg.style.display = 'flex';
    if (isMyTurnToPlay(state)) {
      document.getElementById('status-text').textContent = 'Your turn — click a card to play';
    } else {
      const expected = r.currentTrick?.length === 0
        ? r.currentLeader
        : (r.currentLeader + r.currentTrick.length) % 4;
      document.getElementById('status-text').textContent =
        `Waiting for ${nameForSeat(expected, state)} to play…`;
    }

  } else if (state.phase === 'scoring' && overlayShownForPhase !== 'scoring') {
    overlayShownForPhase = 'scoring';
    handleScoring(state);

  } else if (state.phase === 'gameover' && overlayShownForPhase !== 'gameover') {
    overlayShownForPhase = 'gameover';
    handleGameOver(state);
  }
}

// ─── Redeal vote panel ────────────────────────────────────────────────────────

function renderRedealVotePanel(state) {
  const statusMsg = document.getElementById('status-msg');
  statusMsg.querySelector('.redeal-vote-panel')?.remove();

  const votes = state.round?.redealVotes ?? [false, false, false, false];
  const myVote = votes[mySeat];

  const panel = document.createElement('div');
  panel.className = 'redeal-vote-panel';

  const msg = document.createElement('p');
  msg.className = 'redeal-vote-msg';
  msg.innerHTML = '75 &mdash; pass, pass, pass.<br>All 4 players must confirm to redeal.';
  panel.appendChild(msg);

  const tally = document.createElement('p');
  tally.className = 'redeal-vote-tally';
  tally.textContent = `${votes.filter(Boolean).length} / 4 confirmed`;
  panel.appendChild(tally);

  if (!myVote) {
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = 'Confirm Redeal';
    btn.addEventListener('click', () => {
      socket.emit('voteRedeal');
      myRedealVoteCast = true;
    });
    panel.appendChild(btn);
  } else {
    const confirmed = document.createElement('p');
    confirmed.className = 'redeal-vote-confirmed';
    confirmed.textContent = '✓ You confirmed — waiting for others…';
    panel.appendChild(confirmed);
  }

  statusMsg.appendChild(panel);
  document.getElementById('status-text')?.style.setProperty('display', 'none');
}

// ─── Scoring & game over overlays ─────────────────────────────────────────────

function handleScoring(state) {
  const r = state.round;
  if (!r) return;

  const bidTeam    = r.bidWinner % 2;
  const nonBidTeam = 1 - bidTeam;
  const TL = ['A', 'B'];
  const rp = state.roundPoints ?? r.roundPoints ?? [0, 0];
  const rs = state.roundScored ?? r.roundScored ?? [0, 0];
  const tc = r.trickCounts ?? [0, 0];
  const bidWon = rs[bidTeam] >= 0;

  function scoreLine(team) {
    const delta = rs[team];
    const sign  = delta >= 0 ? '+' : '';
    const color = team === 0 ? '#6fa3e0' : '#e06f6f';
    const setback = (team === bidTeam && !bidWon)
      ? ' <span style="color:#e06f6f;font-size:0.75em">(set back)</span>' : '';
    return `<span style="color:${color}">Team ${TL[team]}: ${sign}${delta}${setback}</span>`;
  }

  const body = `
    <table style="width:100%;border-collapse:collapse;font-family:'DM Mono',monospace;font-size:0.8rem;text-align:left">
      <tr><td style="padding:3px 8px;opacity:.55;white-space:nowrap">Bid</td>
          <td>Team ${TL[bidTeam]} — ${r.highBid} ${bidWon ? '✓' : '✗'}</td></tr>
      <tr><td style="padding:3px 8px;opacity:.55;white-space:nowrap">Tricks</td>
          <td>A: ${tc[0]} &nbsp;·&nbsp; B: ${tc[1]}</td></tr>
      <tr><td style="padding:3px 8px;opacity:.55;white-space:nowrap">Points</td>
          <td>A: ${rp[0]} &nbsp;·&nbsp; B: ${rp[1]}</td></tr>
    </table>
    <div style="margin-top:0.75rem;font-family:'DM Mono',monospace;font-size:0.82rem;display:flex;flex-direction:column;gap:0.15rem">
      <div>${scoreLine(0)} &nbsp;·&nbsp; ${scoreLine(1)}</div>
      <div style="opacity:.55;font-size:0.75rem">Running total: A: ${state.scores[0]} &nbsp;·&nbsp; B: ${state.scores[1]}</div>
    </div>
  `;

  showOverlay('Round Over', body, 'Next Round', () => {
    overlayShownForPhase = null;
    socket.emit('nextRound');
  });
}

function handleGameOver(state) {
  const teamLabel = state.winner === 0 ? 'Team A' : 'Team B';
  const s = state.scores;
  showOverlay(
    `${teamLabel} Wins!`,
    `<p style="font-family:'DM Mono',monospace">Final scores:<br/><span style="color:#6fa3e0">Team A: ${s[0]}</span> &nbsp;·&nbsp; <span style="color:#e06f6f">Team B: ${s[1]}</span></p>`,
    'Play Again',
    () => { overlayShownForPhase = null; socket.emit('resetGame'); }
  );
}

// ─── Game reset ───────────────────────────────────────────────────────────────

socket.on('gameReset', () => {
  sessionStorage.removeItem('oneHighToken');
  myName = ''; mySeat = null; gameState = null; selectedCard = null;
  currentBid = 75; highBid = 0;
  prevTrickCards = []; trickAnimating = false; pendingFly = null;
  overlayShownForPhase = null; myRedealVoteCast = false;
  undoPending = false;
  removeUndoBanner();
  removeTricksBonusBanner();

  document.body.classList.remove('phase-redeal-vote');
  document.getElementById('settings-panel').classList.add('hidden');
  document.getElementById('settings-btn').classList.remove('open');
  ['a', 'b'].forEach(t => {
    document.getElementById(`trick-pile-${t}`).classList.add('empty');
    document.getElementById(`trick-pile-badge-${t}`).textContent = '0';
    document.getElementById(`trick-holding-${t}`).classList.add('hidden');
  });

  gameScreen.classList.remove('active');
  lobbyScreen.classList.add('active');
  nameInput.value = '';
  nameInput.disabled = false;
  nameInput.placeholder = 'Your name';
  joinBtn.disabled = false;

  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`seat-${i}`);
    el.querySelector('.seat-name').textContent = '—';
    el.classList.remove('filled', 'disconnected');
  }

  hideOverlay();
});

// ─── Click trick area to confirm card play ────────────────────────────────────

document.getElementById('trick-area').addEventListener('click', (e) => {
  if (!selectedCard || e.target.closest('.card')) return;
  if (!gameState || gameState.phase !== 'playing' || !isMyTurnToPlay(gameState)) return;
  socket.emit('playCard', { cardId: selectedCard });
  selectedCard = null;
});

// ─── Trump selection ──────────────────────────────────────────────────────────

document.querySelectorAll('.trump-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!selectedCard) { toast('Select a card to discard first'); return; }
    socket.emit('discardAndTrump', { cardId: selectedCard, trumpSuit: btn.dataset.suit });
    selectedCard = null;
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

// ─── Undo button visibility ───────────────────────────────────────────────────

function updateUndoButton(state) {
  const row = document.getElementById('undo-row');
  const btn = document.getElementById('undo-btn');
  if (!state || state.phase !== 'playing') {
    row.style.display = 'none';
    return;
  }
  const r = state.round;
  const lastInTrick = r?.currentTrick?.[r.currentTrick.length - 1];
  const iLastInTrick = lastInTrick?.playerIndex === mySeat;
  const iJustCompletedTrick = r?.lastTrickUndoableBySeat === mySeat;
  const canUndo = !undoPending && (iLastInTrick || iJustCompletedTrick);
  row.style.display = canUndo ? '' : 'none';
  btn.disabled = undoPending;
}

// ─── Settings panel ───────────────────────────────────────────────────────────

document.getElementById('settings-btn').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  const isOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', isOpen);
  document.getElementById('settings-btn').classList.toggle('open', !isOpen);
});

document.addEventListener('click', (e) => {
  const panel = document.getElementById('settings-panel');
  const btn   = document.getElementById('settings-btn');
  if (!panel.classList.contains('hidden') &&
      !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.add('hidden');
    btn.classList.remove('open');
  }
});

document.getElementById('reset-btn').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
  document.getElementById('settings-btn').classList.remove('open');
  showOverlay(
    'End Game?',
    '<p style="font-family:\'DM Mono\',monospace;opacity:.8">This will end the current game and send everyone back to the lobby.</p>',
    'Yes, End Game',
    () => socket.emit('resetGame'),
    { cancellable: true }
  );
});

document.getElementById('undo-btn').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
  document.getElementById('settings-btn').classList.remove('open');
  undoPending = true;
  updateUndoButton(gameState);
  socket.emit('requestUndo');
});

// ─── Undo socket events ───────────────────────────────────────────────────────

socket.on('undoPending', ({ message }) => {
  toast(message);
});

socket.on('undoDenied', ({ denierName }) => {
  undoPending = false;
  updateUndoButton(gameState);
  toast(`⚠ ${denierName} denied the undo request`);
});

socket.on('undoCancelled', () => {
  removeUndoBanner();
});

socket.on('undoRequest', ({ requesterName, card, requestingSeat }) => {
  showUndoBanner(requesterName, card, requestingSeat);
});

function showUndoBanner(requesterName, card, requestingSeat) {
  removeUndoBanner();
  const banner = document.createElement('div');
  banner.className = 'undo-request-banner';
  banner.id = 'undo-request-banner';

  const suitLabel = card.id === 'Rook' ? 'Rook' : `${card.suit} ${card.number}`;
  banner.innerHTML = `
    <p><strong>${requesterName}</strong> wants to undo playing <strong>${suitLabel}</strong>.</p>
    <div class="undo-banner-btns">
      <button class="btn-primary" id="undo-approve-btn">Approve</button>
      <button class="btn-ghost" id="undo-deny-btn">Deny</button>
    </div>
  `;
  document.body.appendChild(banner);

  document.getElementById('undo-approve-btn').addEventListener('click', () => {
    socket.emit('respondUndo', { approve: true });
    removeUndoBanner();
    toast('Undo approved — waiting for other opponent…');
  });
  document.getElementById('undo-deny-btn').addEventListener('click', () => {
    socket.emit('respondUndo', { approve: false });
    removeUndoBanner();
  });
}

function removeUndoBanner() {
  document.getElementById('undo-request-banner')?.remove();
}


// ─── Sort controls ────────────────────────────────────────────────────────────

document.getElementById('sort-num-asc').addEventListener('click', () => {
  sortNumDir = 'asc'; if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-num-desc').addEventListener('click', () => {
  sortNumDir = 'desc'; if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-suit-asc').addEventListener('click', () => {
  sortSuitDir = 'asc'; if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-suit-desc').addEventListener('click', () => {
  sortSuitDir = 'desc'; if (gameState) renderMyHand(gameState);
});

// ─── Overlay ──────────────────────────────────────────────────────────────────

function showOverlay(title, bodyHtml, btnText, onBtn, { cancellable = false } = {}) {
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-body').innerHTML = bodyHtml;
  const btn = document.getElementById('overlay-btn');
  const cancelBtn = document.getElementById('overlay-cancel');
  btn.style.display = btnText ? '' : 'none';
  btn.textContent = btnText || '';
  btn.onclick = () => { hideOverlay(); onBtn?.(); };
  cancelBtn.style.display = cancellable ? '' : 'none';
  cancelBtn.onclick = hideOverlay;
  document.getElementById('overlay').classList.remove('hidden');
}

function hideOverlay() {
  document.getElementById('overlay').classList.add('hidden');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
