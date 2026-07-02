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
let undoPending = false;    // I sent an undo request, waiting on opponents
let undoBidPending = false; // I sent a bid undo request, waiting on opponents

// Last card attempted (for invalid-play shake feedback)
let lastAttemptedCard = null;

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
let fixedSuitOrder = null; // locked suit order; null means recompute on next sort

function cardRank(card) {
  if (card.id === 'Rook') return 0;
  if (card.number === 1)  return 15;
  if (card.number === 14) return 14;
  return card.number;
}

function computeSuitOrder(hand) {
  const suitCounts = {};
  for (const card of hand) {
    if (card.suit !== 'Rook') suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
  }
  const SUIT_ORDER = ['Red', 'Black', 'Yellow', 'Green'];
  const suits = [...new Set(hand.map(c => c.suit).filter(s => s !== 'Rook'))];
  suits.sort((a, b) => {
    const diff = (suitCounts[a] || 0) - (suitCounts[b] || 0);
    return diff !== 0 ? (sortSuitDir === 'asc' ? diff : -diff)
                      : SUIT_ORDER.indexOf(a) - SUIT_ORDER.indexOf(b);
  });
  return suits;
}

function sortHand(hand) {
  const trumpSuit = gameState?.round?.trumpSuit;

  if (!fixedSuitOrder) fixedSuitOrder = computeSuitOrder(hand);
  const nonRookSuits = fixedSuitOrder;

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
const nameInput   = document.getElementById('name-input');

const savedToken = sessionStorage.getItem('oneHighToken');
if (savedToken) {
  nameInput.disabled = true;
  nameInput.placeholder = 'Reconnecting…';
  socket.emit('rejoinLobby', { token: savedToken });
}

function joinSeat(preferredSeat) {
  const name = nameInput.value.trim();
  if (!name) { toast('Enter your name first'); return; }
  myName = name;
  nameInput.disabled = true;
  socket.emit('joinLobby', { name, preferredSeat });
}

for (let i = 0; i < 4; i++) {
  document.getElementById(`seat-${i}`).addEventListener('click', function () {
    if (this.classList.contains('filled')) {
      if (seatPopoverTarget === i) { closeSeatPopover(); return; }
      openSeatPopover(i, this.querySelector('.seat-name').textContent, this);
    } else if (this.classList.contains('available')) {
      if (mySeat !== null) {
        // Already seated — move to empty seat
        socket.emit('moveSeat', { newSeat: i });
      } else {
        joinSeat(i);
      }
    }
  });
}

socket.on('joinedAs', ({ token, seat }) => {
  sessionStorage.setItem('oneHighToken', token);
  mySeat = seat;
  updateReadyBtn(false);
});

function updateReadyBtn(isReady) {
  const btn = document.getElementById('ready-btn');
  const hasName = !!(nameInput.value.trim() || myName);
  btn.textContent = isReady ? 'Ready ✓' : 'Ready';
  btn.classList.toggle('is-ready', isReady);
  btn.disabled = !hasName || mySeat === null;
}

nameInput.addEventListener('input', () => updateReadyBtn(false));

socket.on('rejoinFailed', () => {
  sessionStorage.removeItem('oneHighToken');
  nameInput.disabled = false;
  nameInput.placeholder = 'Your name';
});

socket.on('lobbyUpdate', ({ players }) => {
  const alreadySeated = !!sessionStorage.getItem('oneHighToken');
  for (let i = 0; i < 4; i++) {
    const p = players.find(p => p.seat === i);
    const el = document.getElementById(`seat-${i}`);
    const isMyOwnSeat = alreadySeated && mySeat === i;
    const isAvailable = !p && !isMyOwnSeat;
    el.querySelector('.seat-name').textContent = p
      ? (p.connected ? p.name : `${p.name} (away)`)
      : '';
    const hint = el.querySelector('.seat-join-hint');
    if (hint) hint.textContent = alreadySeated ? 'Switch seat' : 'Click to join';
    el.classList.toggle('filled', !!p);
    el.classList.toggle('ready', !!(p && p.ready));
    el.classList.toggle('disconnected', !!(p && !p.connected));
    el.classList.toggle('available', isAvailable);
  }

  // Sync ready button state with server (e.g. after swap resets ready)
  if (alreadySeated) {
    const me = players.find(p => p.seat === mySeat);
    updateReadyBtn(!!(me && me.ready));
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
  const removeBtn = document.getElementById('seat-popover-remove');
  removeBtn.textContent = seatIndex === mySeat ? 'Leave seat' : 'Remove player';
  removeBtn.onclick = () => {
    socket.emit('removeSeat', { seatIndex });
    closeSeatPopover();
  };

  const swapBtn = document.getElementById('seat-popover-swap');
  if (mySeat !== null && mySeat !== seatIndex) {
    swapBtn.style.display = '';
    swapBtn.onclick = () => {
      socket.emit('requestSwap', { targetSeat: seatIndex });
      closeSeatPopover();
      toast('Swap request sent — waiting for approval…');
    };
  } else {
    swapBtn.style.display = 'none';
  }

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

document.addEventListener('click', (e) => {
  const popover = document.getElementById('seat-popover');
  if (popover.classList.contains('hidden')) return;
  if (popover.contains(e.target) || e.target.closest('.seat')) return;
  closeSeatPopover();
}, { capture: true });

document.getElementById('ready-btn').addEventListener('click', () => {
  const btn = document.getElementById('ready-btn');
  const nowReady = !btn.classList.contains('is-ready');
  socket.emit('setReady', { ready: nowReady });
});

socket.on('seatRemoved', ({ self } = {}) => {
  sessionStorage.removeItem('oneHighToken');
  mySeat = null;
  nameInput.disabled = false;
  nameInput.placeholder = 'Your name';
  nameInput.value = '';
  updateReadyBtn(false);
  toast(self ? 'You left your seat' : 'You were removed from your seat');
});

// Incoming swap request — show compact bar (keeps seats visible)
socket.on('swapRequest', ({ fromName, fromSeat }) => {
  const bar = document.getElementById('swap-request-bar');
  document.getElementById('swap-request-label').textContent = `${fromName} wants to swap seats`;
  document.getElementById('swap-accept-btn').onclick = () => {
    socket.emit('respondSwap', { accept: true });
    bar.classList.add('hidden');
  };
  document.getElementById('swap-decline-btn').onclick = () => {
    socket.emit('respondSwap', { accept: false });
    bar.classList.add('hidden');
  };
  bar.classList.remove('hidden');
});

socket.on('swapDenied', ({ targetName }) => {
  toast(`${targetName} declined the seat swap`);
});

socket.on('swapDone', ({ newSeat }) => {
  mySeat = newSeat;
  document.getElementById('swap-request-bar').classList.add('hidden');
  toast('Seats swapped!');
});

// ─── Nudge popover ───────────────────────────────────────────────────────────

let nudgePopoverTarget = null;

function closeNudgePopover() {
  document.getElementById('nudge-popover').classList.add('hidden');
  nudgePopoverTarget = null;
}

function openNudgePopover(seat, name, anchorEl) {
  nudgePopoverTarget = seat;
  document.getElementById('nudge-popover-name').textContent = name;

  const isTheirTurn = gameState ? isThisPlayersTurn(seat, gameState) : false;
  const btn = document.getElementById('nudge-popover-btn');
  btn.disabled = !isTheirTurn;
  btn.title = isTheirTurn ? '' : 'Only available on their turn';
  btn.onclick = () => {
    socket.emit('nudge', { targetSeat: seat });
    closeNudgePopover();
    toast('Nudge sent!');
  };

  const popover = document.getElementById('nudge-popover');
  popover.classList.remove('hidden');

  const rect = anchorEl.getBoundingClientRect();
  const pw = popover.offsetWidth || 140;
  const ph = popover.offsetHeight || 80;
  let left = rect.left + rect.width / 2 - pw / 2;
  let top  = rect.bottom + 6;
  left = Math.max(8, Math.min(left, window.innerWidth  - pw - 8));
  top  = Math.max(8, Math.min(top,  window.innerHeight - ph - 8));
  popover.style.left = `${left}px`;
  popover.style.top  = `${top}px`;
}

['across', 'left', 'right'].forEach(zone => {
  document.getElementById(`${zone}-name`).addEventListener('click', function (e) {
    if (!gameState) return;
    const seat = ['across', 'left', 'right'].indexOf(zone);
    // Convert zone offset to absolute seat
    const offsets = { across: 2, left: 1, right: 3 };
    const absSeat = (mySeat + offsets[zone]) % 4;
    if (nudgePopoverTarget === absSeat) { closeNudgePopover(); return; }
    openNudgePopover(absSeat, this.textContent, this);
  });
});

document.addEventListener('click', (e) => {
  const popover = document.getElementById('nudge-popover');
  if (popover.classList.contains('hidden')) return;
  if (popover.contains(e.target)) return;
  if (['across-name', 'left-name', 'right-name'].includes(e.target.id)) return;
  closeNudgePopover();
}, { capture: true });

socket.on('nudged', ({ fromName }) => {
  toast(`${fromName} is nudging you — it's your turn!`);
  // Flash the self-name element
  const el = document.getElementById('self-name');
  if (el) {
    el.classList.remove('nudge-flash');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('nudge-flash');
    el.addEventListener('animationend', () => el.classList.remove('nudge-flash'), { once: true });
  }
});

// ─── Game state handler ───────────────────────────────────────────────────────

function showGame() {
  lobbyScreen.classList.remove('active');
  gameScreen.classList.add('active');
}

socket.on('gameState', (state) => {
  if (mySeat === null && state.yourSeat !== undefined) mySeat = state.yourSeat;
  if (state.phase === 'bidding' && gameState?.phase !== 'bidding') fixedSuitOrder = null;

  // Bid winner animation: bidding → kitty transition
  if (state.phase === 'kitty' && gameState?.phase === 'bidding' && state.round?.bidWinner != null) {
    const name = nameForSeat(state.round.bidWinner, state);
    const amount = state.round.highBid;
    showBidWonBanner(name, amount, state.round.bidWinner);
  }

  gameState = state;
  if (state.phase !== 'playing' || !isMyTurnToPlay(state)) selectedCard = null;
  showGame();

  if (state.undone) {
    undoPending = false;
    undoBidPending = false;
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
    updateBidWinnerIndicator(state);
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
        if (state.sweep) {
          animateSweep(state, () => {
            const prev = state.prevRoundPoints;
            const rp = state.round?.roundPoints;
            render(state);
            if (prev && rp) animateRoundScore(String(prev[0]), String(prev[1]), String(rp[0]), String(rp[1]));
          });
        } else {
          const prev = state.prevRoundPoints;
          const rp = state.round?.roundPoints;
          render(state);
          if (prev && rp) animateRoundScore(String(prev[0]), String(prev[1]), String(rp[0]), String(rp[1]));
        }
      });
    }, 2500);

  } else if (pendingFly && (state.round?.currentTrick?.length ?? 0) >= 1) {
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

const PLAY_ERRORS = new Set(['You must follow suit', 'Not your turn', 'Card not in your hand']);

socket.on('error', msg => {
  toast('⚠ ' + msg);
  if (PLAY_ERRORS.has(msg) && lastAttemptedCard) {
    const el = document.querySelector(`#my-hand [data-card-id="${lastAttemptedCard}"]`);
    if (el) {
      el.classList.remove('invalid-play');
      void el.offsetWidth; // force reflow so animation restarts if triggered twice
      el.classList.add('invalid-play');
      el.addEventListener('animationend', () => el.classList.remove('invalid-play'), { once: true });
    }
    selectedCard = lastAttemptedCard; // re-select so they can try again
    if (gameState) renderMyHand(gameState);
  }
  lastAttemptedCard = null;
});

// ─── Main render ──────────────────────────────────────────────────────────────

function render(state) {
  updateScorebar(state);
  updatePlayerNames(state);
  updateTrumpIndicator(state);
  updateBidWinnerIndicator(state);
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

function showBidWonBanner(name, amount, seat) {
  const existing = document.getElementById('bid-won-banner');
  if (existing) existing.remove();

  const teamClass = (seat % 2 === 0) ? 'bid-won-team-a' : 'bid-won-team-b';
  const banner = document.createElement('div');
  banner.id = 'bid-won-banner';
  banner.className = `bid-won-banner ${teamClass}`;
  banner.innerHTML = `
    <div class="bid-won-name">${name}</div>
    <div class="bid-won-label">took the bid</div>
    <div class="bid-won-amount">${amount}</div>
  `;

  // Disable transitions for initial placement
  banner.style.transition = 'none';
  banner.style.opacity = '0';
  banner.style.transform = 'scale(0.75)';
  document.body.appendChild(banner);

  // Measure and center after append so offsetWidth/Height are real
  const bw = banner.offsetWidth;
  const bh = banner.offsetHeight;
  banner.style.left = (window.innerWidth  / 2 - bw / 2) + 'px';
  banner.style.top  = (window.innerHeight / 2 - bh / 2) + 'px';

  // Reflow, then animate in
  void banner.offsetWidth;
  banner.style.transition = '';  // restore CSS transitions
  banner.style.opacity = '1';
  banner.style.transform = 'scale(1)';

  // After hold, fly to pill by animating center-to-center + scale
  setTimeout(() => {
    const pill = document.getElementById('bid-winner-indicator');
    if (!pill) { banner.remove(); return; }

    const pillRect   = pill.getBoundingClientRect();
    const bannerRect = banner.getBoundingClientRect();

    // Centers
    const bannerCX = bannerRect.left + bannerRect.width  / 2;
    const bannerCY = bannerRect.top  + bannerRect.height / 2;
    const pillCX   = pillRect.left   + pillRect.width    / 2;
    const pillCY   = pillRect.top    + pillRect.height   / 2;

    const dx = pillCX - bannerCX;
    const dy = pillCY - bannerCY;
    const scaleX = pillRect.width  / bannerRect.width;
    const scaleY = pillRect.height / bannerRect.height;

    banner.style.transition = 'transform 0.45s cubic-bezier(0.4,0,0.2,1), opacity 0.35s ease';
    banner.style.transformOrigin = '50% 50%';
    banner.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
    banner.style.opacity = '0';

    setTimeout(() => banner.remove(), 500);
  }, 1600);
}

function updateBidWinnerIndicator(state) {
  const el = document.getElementById('bid-winner-indicator');
  const r = state.round;
  const showPhases = ['kitty', 'playing', 'scoring'];
  if (showPhases.includes(state.phase) && r?.bidWinner != null && r?.highBid) {
    const name = nameForSeat(r.bidWinner, state);
    el.textContent = `Bid: ${name} — ${r.highBid}`;
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

// ─── Sweep animation ─────────────────────────────────────────────────────────

function animateSweep(state, onDone) {
  const sweepTeam = state.sweepTeam;
  const sweepHands = state.sweepHands; // array of 4 hand arrays, indexed by seat
  const teamLabel = sweepTeam === 0 ? 'Team A' : 'Team B';
  const color = sweepTeam === 0 ? '#6fa3e0' : '#e06f6f';

  // Show sweep banner
  const banner = document.createElement('div');
  banner.id = 'sweep-banner';
  banner.className = 'sweep-banner';
  banner.innerHTML = `<div class="sweep-title" style="color:${color}">${teamLabel} Sweeps!</div>`;
  document.body.appendChild(banner);
  requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add('show')));

  // Determine the destination pile element
  const pileEl = document.getElementById(sweepTeam === 0 ? 'trick-pile-a' : 'trick-pile-b');

  // For each player position render their remaining cards face-up in a temp container,
  // then fly each card to the pile
  const zoneIds = { self: 'my-hand', across: 'across-hand', left: 'left-hand', right: 'right-hand' };

  // Build fly cards after a short delay so the banner is visible first
  setTimeout(() => {
    const flyCards = [];

    for (let seat = 0; seat < 4; seat++) {
      const hand = sweepHands[seat];
      if (!hand || hand.length === 0) continue;

      const pos = relativePosition(seat);
      const anchorEl = document.getElementById(zoneIds[pos]);
      if (!anchorEl) continue;
      const anchorRect = anchorEl.getBoundingClientRect();

      hand.forEach((card, i) => {
        const cardEl = buildCard(card);
        // Position the fly card at the player's hand zone, offset slightly per card
        const fly = document.createElement('div');
        fly.className = `trick-fly-card ${cardEl.className}`;
        const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 52;
        const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-h')) || 74;
        fly.style.cssText = `width:${w}px;height:${h}px;left:${anchorRect.left + i * 4}px;top:${anchorRect.top + i * 4}px`;
        fly.innerHTML = cardEl.innerHTML;
        document.body.appendChild(fly);
        flyCards.push(fly);
      });
    }

    // Fly all cards to pile after a brief moment
    const pileRect = pileEl.getBoundingClientRect();
    const fw = parseFloat(flyCards[0]?.style.width || 40);
    const fh = parseFloat(flyCards[0]?.style.height || 56);
    const targetX = pileRect.left + pileRect.width  / 2 - fw / 2;
    const targetY = pileRect.top  + pileRect.height / 2 - fh / 2;

    requestAnimationFrame(() => requestAnimationFrame(() => {
      flyCards.forEach((fly, i) => {
        fly.classList.add('flying');
        fly.style.left = `${targetX}px`;
        fly.style.top  = `${targetY}px`;
        fly.style.transitionDelay = `${i * 30}ms`;
      });

      setTimeout(() => {
        flyCards.forEach(f => f.remove());
        banner.classList.remove('show');
        banner.classList.add('hide');
        setTimeout(() => {
          banner.remove();
          // Update pile badge with final trick count
          const suffix = sweepTeam === 0 ? 'a' : 'b';
          document.getElementById(`trick-pile-badge-${suffix}`).textContent =
            (state.trickCounts ?? state.round?.trickCounts)?.[sweepTeam] ?? 0;
          document.getElementById(`trick-pile-${suffix}`).classList.remove('empty');
          onDone();
        }, 400);
      }, 500 + flyCards.length * 30);
    }));
  }, 800);
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
          lastAttemptedCard = card.id;
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

    updateUndoButton(state);

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

  const nameOf = seat => state.playerNames?.find(p => p.seat === seat)?.name ?? `Seat ${seat + 1}`;
  const teamNames = [
    [nameOf(0), nameOf(2)].join(' & '),
    [nameOf(1), nameOf(3)].join(' & '),
  ];

  const body = `
    <div style="display:flex;gap:0.5rem;margin-bottom:0.6rem;font-family:'DM Sans',sans-serif;font-size:0.82rem">
      <div style="flex:1;text-align:center;padding:4px 8px;border-radius:4px;background:rgba(111,163,224,0.12);border:1px solid rgba(111,163,224,0.3)">
        <span style="color:#6fa3e0;font-weight:700;display:block;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase">Team A</span>
        <span style="color:var(--cream);opacity:0.9">${teamNames[0]}</span>
      </div>
      <div style="flex:1;text-align:center;padding:4px 8px;border-radius:4px;background:rgba(224,111,111,0.12);border:1px solid rgba(224,111,111,0.3)">
        <span style="color:#e06f6f;font-weight:700;display:block;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase">Team B</span>
        <span style="color:var(--cream);opacity:0.9">${teamNames[1]}</span>
      </div>
    </div>
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
  undoBidPending = false;
  fixedSuitOrder = null;
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
  mySeat = null;
  updateReadyBtn(false);

  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`seat-${i}`);
    el.querySelector('.seat-name').textContent = '';
    el.classList.remove('filled', 'disconnected', 'ready');
    el.classList.add('available');
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

  if (state?.phase === 'bidding') {
    const r = state.round;
    const lastEntry = r?.bidLog?.[r.bidLog.length - 1];
    const iLastBidder = lastEntry?.seat === mySeat && lastEntry?.amount !== 'pass';
    const canUndo = !undoBidPending && iLastBidder;
    row.style.display = canUndo ? '' : 'none';
    btn.disabled = undoBidPending;
    return;
  }

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
  if (gameState?.phase === 'bidding') {
    undoBidPending = true;
    updateUndoButton(gameState);
    socket.emit('requestUndoBid');
  } else {
    undoPending = true;
    updateUndoButton(gameState);
    socket.emit('requestUndo');
  }
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

// ─── Bid undo socket events ───────────────────────────────────────────────────

socket.on('undoBidPending', ({ message }) => {
  toast(message);
});

socket.on('undoBidDenied', ({ denierName }) => {
  undoBidPending = false;
  updateUndoButton(gameState);
  toast(`⚠ ${denierName} denied the undo request`);
});

socket.on('undoBidCancelled', () => {
  removeUndoBanner();
});

socket.on('undoBidRequest', ({ requesterName, bidAmount, requestingSeat }) => {
  showUndoBidBanner(requesterName, bidAmount, requestingSeat);
});

function showUndoBidBanner(requesterName, bidAmount, requestingSeat) {
  removeUndoBanner();
  const banner = document.createElement('div');
  banner.className = 'undo-request-banner';
  banner.id = 'undo-request-banner';

  banner.innerHTML = `
    <p><strong>${requesterName}</strong> wants to undo their bid of <strong>${bidAmount}</strong>.</p>
    <div class="undo-banner-btns">
      <button class="btn-primary" id="undo-approve-btn">Approve</button>
      <button class="btn-ghost" id="undo-deny-btn">Deny</button>
    </div>
  `;
  document.body.appendChild(banner);

  document.getElementById('undo-approve-btn').addEventListener('click', () => {
    socket.emit('respondUndoBid', { approve: true });
    removeUndoBanner();
    toast('Undo approved — waiting for other opponent…');
  });
  document.getElementById('undo-deny-btn').addEventListener('click', () => {
    socket.emit('respondUndoBid', { approve: false });
    removeUndoBanner();
  });
}

// ─── Sort controls ────────────────────────────────────────────────────────────

document.getElementById('sort-num-asc').addEventListener('click', () => {
  sortNumDir = 'asc'; if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-num-desc').addEventListener('click', () => {
  sortNumDir = 'desc'; if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-suit-asc').addEventListener('click', () => {
  sortSuitDir = 'asc'; fixedSuitOrder = null; if (gameState) renderMyHand(gameState);
});
document.getElementById('sort-suit-desc').addEventListener('click', () => {
  sortSuitDir = 'desc'; fixedSuitOrder = null; if (gameState) renderMyHand(gameState);
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

// ─── Chat & Emoji ─────────────────────────────────────────────────────────────

const EMOJI_LIST = ['😂','❤️','👍','🔥','😭','🤦','😤','🎉','👀','💀'];

// Populate all emoji grids
['lobby-emoji-grid','game-emoji-grid'].forEach(id => {
  const grid = document.getElementById(id);
  const isGame = id.startsWith('game');
  EMOJI_LIST.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      socket.emit('sendEmoji', { emoji });
      // Panel stays open after sending in both lobby and game
    });
    grid.appendChild(btn);
  });
});

// ─── Chat overlay ────────────────────────────────────────────────────────────
const chatOverlay = document.getElementById('chat-overlay');

function openChatOverlay(triggerBtnId) {
  closeAllCePanels();
  chatOverlay.classList.remove('hidden');
  // Mark the triggering button active for unread cleanup
  if (triggerBtnId) document.getElementById(triggerBtnId)?.classList.add('active');
  ['lobby-chat-btn','game-chat-btn'].forEach(id => document.getElementById(id)?.classList.remove('has-unread'));
  const msgs = document.getElementById('overlay-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  setTimeout(() => document.getElementById('overlay-chat-input')?.focus(), 50);
}

function closeChatOverlay() {
  chatOverlay.classList.add('hidden');
  ['lobby-chat-btn','game-chat-btn'].forEach(id => document.getElementById(id)?.classList.remove('active'));
}

// Close on backdrop click (not on card click)
chatOverlay.addEventListener('click', e => {
  if (e.target === chatOverlay) closeChatOverlay();
});
document.getElementById('chat-overlay-close').addEventListener('click', closeChatOverlay);

// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !chatOverlay.classList.contains('hidden')) closeChatOverlay();
});

function closeAllCePanels() {
  ['lobby-emoji-panel','game-emoji-panel']
    .forEach(id => document.getElementById(id)?.classList.add('hidden'));
  ['lobby-chat-btn','lobby-emoji-btn','game-chat-btn','game-emoji-btn']
    .forEach(id => document.getElementById(id)?.classList.remove('active'));
}

function toggleCePanel(panelId, btnId) {
  const panel = document.getElementById(panelId);
  const btn   = document.getElementById(btnId);
  const wasHidden = panel.classList.contains('hidden');
  closeAllCePanels();
  if (wasHidden) {
    panel.classList.remove('hidden');
    btn.classList.add('active');
  }
}

// Lobby toggles — chat opens overlay, emoji stays inline
document.getElementById('lobby-chat-btn').addEventListener('click', () => {
  if (chatOverlay.classList.contains('hidden')) {
    openChatOverlay('lobby-chat-btn');
  } else {
    closeChatOverlay();
  }
});
document.getElementById('lobby-emoji-btn').addEventListener('click', () => {
  const panel = document.getElementById('lobby-emoji-panel');
  const btn   = document.getElementById('lobby-emoji-btn');
  const wasHidden = panel.classList.contains('hidden');
  closeAllCePanels();
  if (wasHidden) {
    // Position overlay just above the button
    const rect = btn.getBoundingClientRect();
    panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    panel.classList.remove('hidden');
    btn.classList.add('active');
  }
});

// Close emoji panels when clicking outside them — capture phase so nothing else fires
document.addEventListener('click', e => {
  for (const [panelId, btnId] of [
    ['lobby-emoji-panel', 'lobby-emoji-btn'],
    ['game-emoji-panel',  'game-emoji-btn'],
  ]) {
    const panel = document.getElementById(panelId);
    const btn   = document.getElementById(btnId);
    if (!panel.classList.contains('hidden') &&
        !panel.contains(e.target) &&
        e.target !== btn && !btn.contains(e.target)) {
      panel.classList.add('hidden');
      btn.classList.remove('active');
      e.stopPropagation();
    }
  }
}, true);

// Game toggles — chat opens overlay, emoji stays inline
document.getElementById('game-chat-btn').addEventListener('click', () => {
  if (chatOverlay.classList.contains('hidden')) {
    openChatOverlay('game-chat-btn');
  } else {
    closeChatOverlay();
  }
});
document.getElementById('game-emoji-btn').addEventListener('click', () => toggleCePanel('game-emoji-panel','game-emoji-btn'));

// Send chat — overlay input
function sendChat() {
  const input = document.getElementById('overlay-chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!myName || mySeat === null) { toast('Join a seat first to chat'); return; }
  socket.emit('chatMessage', { text });
  input.value = '';
}

document.getElementById('overlay-chat-send').addEventListener('click', sendChat);
document.getElementById('overlay-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// ─── Chat bubble helper ───────────────────────────────────────────────────────
function showChatBubble(anchorEl, text) {
  // Boundary = the seat element itself (or its closest .seat ancestor in game, the player-info)
  const seatEl = anchorEl.closest('.seat') || anchorEl.closest('.player-info') || anchorEl;
  const boundary = seatEl.getBoundingClientRect();
  const bubbleW = boundary.width;
  const bubbleLeft = boundary.left;

  // Assign stable ID to anchor for finding its existing bubbles
  if (!anchorEl.dataset.bubbleId) anchorEl.dataset.bubbleId = Math.random().toString(36).slice(2);

  // Measure height with a hidden probe that matches the final width
  const probe = document.createElement('div');
  probe.className = 'chat-bubble';
  probe.textContent = text;
  probe.style.visibility = 'hidden';
  probe.style.maxWidth = bubbleW + 'px';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  document.body.appendChild(probe);
  const probeH = probe.offsetHeight;
  const probeW = probe.offsetWidth;
  probe.remove();

  // Push existing bubbles upward
  document.querySelectorAll('.chat-bubble[data-anchor-id="' + anchorEl.dataset.bubbleId + '"]').forEach(b => {
    const cur = parseFloat(b.dataset.bubbleTop || '0');
    const next = cur - probeH - 6;
    b.style.top = next + 'px';
    b.dataset.bubbleTop = String(next);
  });

  const anchorRect = anchorEl.getBoundingClientRect();
  const topPx = anchorRect.top - probeH - 8;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = text;
  bubble.dataset.anchorId = anchorEl.dataset.bubbleId;
  bubble.dataset.bubbleTop = String(topPx);
  // Center within the seat: seat center minus half the bubble's actual width
  const seatCenterX = bubbleLeft + bubbleW / 2;
  const leftPx = seatCenterX - probeW / 2;
  bubble.style.maxWidth = bubbleW + 'px';
  bubble.style.left = leftPx + 'px';
  bubble.style.top = topPx + 'px';

  document.body.appendChild(bubble);
  setTimeout(() => bubble.remove(), 4100);
}

// Find the anchor element for a given sender's seat number
function bubbleAnchorForSeat(senderSeat) {
  if (!gameScreen.classList.contains('active')) {
    // In lobby: use the seat div
    return document.getElementById(`seat-${senderSeat}`);
  }
  if (mySeat === null) return null;
  const pos = relativePosition(senderSeat); // 'self','left','across','right'
  const zoneId = { self: 'self-name', left: 'left-name', across: 'across-name', right: 'right-name' }[pos];
  const nameEl = document.getElementById(zoneId);
  // Return the player-info parent so bubble positions above the name
  return nameEl?.closest('.player-info') ?? nameEl;
}

// Receive chat — append to overlay panel, show bubble on sender
socket.on('chatMessage', ({ name, text, seat }) => {
  const teamClass = seat % 2 === 0 ? 'team-a' : 'team-b';
  const container = document.getElementById('overlay-chat-messages');
  const msg = document.createElement('div');
  msg.className = 'chat-msg';
  const nameEl = document.createElement('span');
  nameEl.className = `chat-msg-name ${teamClass}`;
  nameEl.textContent = name + ':';
  const textEl = document.createElement('span');
  textEl.className = 'chat-msg-text';
  textEl.textContent = text;
  msg.appendChild(nameEl);
  msg.appendChild(textEl);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;

  // Show unread dot on chat buttons if overlay is closed
  if (chatOverlay.classList.contains('hidden')) {
    ['lobby-chat-btn','game-chat-btn'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.add('has-unread');
    });
  }

  // In-game: show message in the floating feed (only if chat overlay is closed)
  if (gameScreen.classList.contains('active') && chatOverlay.classList.contains('hidden')) {
    const feed = document.getElementById('game-msg-feed');
    const item = document.createElement('div');
    item.className = 'game-msg-item';
    const nameSpan = document.createElement('span');
    nameSpan.className = `chat-msg-name ${teamClass}`;
    nameSpan.textContent = name + ':';
    const textSpan = document.createElement('span');
    textSpan.textContent = ' ' + text;
    item.appendChild(nameSpan);
    item.appendChild(textSpan);
    feed.appendChild(item);
    // Remove after fade completes
    setTimeout(() => item.remove(), 4500);
  }
});

// Receive emoji — smooth balloon-float via requestAnimationFrame
socket.on('floatEmoji', ({ emoji }) => {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  document.body.appendChild(el);

  // Starting position: random x across 10–82% vw, near bottom
  const startXvw = 10 + Math.random() * 72;
  const startYpx = window.innerHeight * 0.12; // 12vh from bottom = near bottom of screen
  const totalRise = window.innerHeight * 1.05; // float past top of screen

  // Sine wave parameters for side drift
  const amp    = 28 + Math.random() * 32;   // px left/right amplitude
  const period = 2.2 + Math.random() * 1.4; // seconds per full side-to-side cycle
  const phase  = Math.random() * Math.PI * 2; // random start phase

  const duration = 3200 + Math.random() * 1000; // 3.2–4.2s total
  let startTime = null;

  function frame(ts) {
    if (!startTime) startTime = ts;
    const elapsed = ts - startTime;
    const t = Math.min(elapsed / duration, 1); // 0→1

    // Vertical: rise linearly (ease-in-out via smoothstep feels natural)
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const y = startYpx + ease * totalRise;

    // Horizontal: continuous sine wave
    const secs = elapsed / 1000;
    const x = (startXvw / 100) * window.innerWidth + Math.sin(phase + (secs / period) * Math.PI * 2) * amp;

    // Opacity: fade in over first 8%, fade out over last 18%
    let opacity = 1;
    if (t < 0.08) opacity = t / 0.08;
    else if (t > 0.82) opacity = (1 - t) / 0.18;

    el.style.transform = `translate(${x}px, ${-y}px)`;
    el.style.opacity = opacity;
    el.style.left = '0';
    el.style.bottom = '0';

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      el.remove();
    }
  }

  requestAnimationFrame(frame);
});
