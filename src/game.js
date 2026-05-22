'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUITS = ['Red', 'Black', 'Yellow', 'Green'];
const POINTER_VALUES = { 5: 5, 10: 10, 14: 10, 1: 15 };
const ROOK_POINTS = 20;
const TRICKS_BONUS = 20;
const WIN_SCORE = 500;
const MIN_BID = 75;

// ─── Deck helpers ─────────────────────────────────────────────────────────────

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let n = 1; n <= 14; n++) {
      deck.push({ suit, number: n, id: `${suit}-${n}` });
    }
  }
  deck.push({ suit: 'Rook', number: 0, id: 'Rook' });
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deal(deck) {
  // 57 cards: 14 each + 1 kitty
  const shuffled = shuffle(deck);
  return {
    hands: [
      shuffled.slice(0, 14),
      shuffled.slice(14, 28),
      shuffled.slice(28, 42),
      shuffled.slice(42, 56),
    ],
    kitty: shuffled[56],
  };
}

// ─── Point helpers ────────────────────────────────────────────────────────────

function isPointer(card) {
  if (card.id === 'Rook') return true;
  return POINTER_VALUES[card.number] !== undefined;
}

function cardPoints(card) {
  if (card.id === 'Rook') return ROOK_POINTS;
  return POINTER_VALUES[card.number] || 0;
}

function countPoints(cards) {
  return cards.reduce((sum, c) => sum + cardPoints(c), 0);
}

// ─── Trump / ranking helpers ──────────────────────────────────────────────────

function isTrump(card, trumpSuit) {
  if (card.id === 'Rook') return true;
  if (trumpSuit === 'NoTrump') return false;
  return card.suit === trumpSuit;
}

/**
 * Returns a numeric rank for comparing cards within a trick.
 * Higher = stronger.
 *
 * Tiers:
 *  0–14   : non-trump non-lead cards (irrelevant, won't win)
 *  100–114: lead-suit non-trump cards (1 maps to 114 for highest)
 *  200    : Rook
 *  301–314: trump colored cards (1 maps to 314)
 */
function cardRank(card, leadSuit, trumpSuit) {
  const trump = isTrump(card, trumpSuit);

  if (card.id === 'Rook') return 200;

  const num = card.number === 1 ? 14.5 : card.number; // 1 beats 14

  if (trump) return 300 + num;

  if (card.suit === leadSuit) return 100 + num;

  return num; // off-suit, off-trump – can't win
}

// ─── Trick winner ─────────────────────────────────────────────────────────────

function trickWinner(plays, leadSuit, trumpSuit) {
  // plays: [{playerIndex, card}, ...]
  let best = plays[0];
  for (let i = 1; i < plays.length; i++) {
    const r1 = cardRank(best.card, leadSuit, trumpSuit);
    const r2 = cardRank(plays[i].card, leadSuit, trumpSuit);
    if (r2 > r1) best = plays[i];
  }
  return best.playerIndex;
}

// ─── Redeal check ─────────────────────────────────────────────────────────────

function qualifiesForRedeal(hand) {
  for (const card of hand) {
    if (card.id === 'Rook') return false;
    if (isPointer(card)) return false;
    if (card.number > 10) return false;
  }
  return true;
}

// ─── Follow-suit validation ───────────────────────────────────────────────────

function canFollow(hand, leadSuit, trumpSuit) {
  // Returns cards the player MUST choose from, or null if they can play anything
  if (!leadSuit) return null; // leading

  const isLeadTrump = leadSuit === '_TRUMP_';

  if (isLeadTrump) {
    // Rook led (or trump suit led and Rook is only trump) = trump led
    const trumpCards = hand.filter(c => isTrump(c, trumpSuit));
    return trumpCards.length > 0 ? trumpCards : null;
  }

  // Normal lead suit — cards that match lead suit
  // If lead suit IS trump suit, trump colored cards count (but Rook is handled separately)
  let suitCards;
  if (leadSuit === trumpSuit) {
    // Lead is trump suit: must play trump (including Rook)
    suitCards = hand.filter(c => isTrump(c, trumpSuit));
  } else {
    // Lead is a non-trump suit: must play that suit's non-trump cards
    suitCards = hand.filter(c => c.suit === leadSuit && c.id !== 'Rook');
  }
  return suitCards.length > 0 ? suitCards : null;
}

// ─── Game state factory ───────────────────────────────────────────────────────

function createGame(playerIds) {
  // playerIds: array of 4 socket ids in seat order (0-3)
  // Teams: seats 0&2 vs 1&3
  return {
    playerIds,           // [id, id, id, id]
    scores: [0, 0],      // [team0, team1]
    dealerIndex: Math.floor(Math.random() * 4),
    phase: 'waiting',    // waiting | dealing | bidding | kitty | playing | scoring
    round: null,
  };
}

function startRound(game) {
  const deck = buildDeck();
  const { hands, kitty } = deal(deck);
  const firstBidder = (game.dealerIndex + 1) % 4;

  game.round = {
    hands,               // hands[playerIndex] = [card, ...]
    kitty,
    bids: [null, null, null, null],   // null = not yet bid, 'pass' = passed
    bidLog: [],              // [{seat, amount}] in chronological order
    highBid: 0,
    highBidder: null,
    currentBidder: firstBidder,
    firstBidder,
    trumpSuit: null,     // set after bid won
    bidWinner: null,
    tricks: [],          // completed tricks
    currentTrick: [],    // [{playerIndex, card}, ...]
    currentLeader: null, // set after kitty phase
    capturedCards: [[], []], // team 0 & 1 captured pointer cards
    trickCounts: [0, 0],
    discarded: null,
  };

  game.phase = 'bidding';
}

// ─── Exported game engine ─────────────────────────────────────────────────────

class GameEngine {
  constructor() {
    this.game = null;
    this.playerNames = {};
  }

  // Seat index for a socket id
  seatOf(id) {
    return this.game ? this.game.playerIds.indexOf(id) : -1;
  }

  teamOf(seatIndex) {
    return seatIndex % 2; // 0&2 = team 0, 1&3 = team 1
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  initGame(playerIds) {
    this.game = createGame(playerIds);
    this.game.phase = 'dealing';
    startRound(this.game);
    return this._roundStartPayload();
  }

  _roundStartPayload() {
    const g = this.game;
    const r = g.round;
    return {
      phase: g.phase,
      scores: g.scores,
      dealerIndex: g.dealerIndex,
      currentBidder: r.currentBidder,
      firstBidder: r.firstBidder,
      hands: r.hands,
      bids: r.bids,
      highBid: r.highBid,
      highBidder: r.highBidder,
    };
  }

  // ── Redeal request ───────────────────────────────────────────────────────

  requestRedeal(seatIndex) {
    const g = this.game;
    const r = g.round;

    if (g.phase !== 'bidding') return { error: 'Not in bidding phase' };
    if (r.bids[seatIndex] !== null) return { error: 'You have already bid or passed' };

    const hand = r.hands[seatIndex];
    if (!qualifiesForRedeal(hand)) return { error: 'Hand does not qualify for a redeal' };

    // Redeal
    startRound(g);
    return { redealt: true, payload: this._roundStartPayload() };
  }

  // ── Redeal vote ──────────────────────────────────────────────────────────

  voteRedeal(seatIndex) {
    const g = this.game;
    if (g.phase !== 'redeal-vote') return { error: 'Not in redeal-vote phase' };
    g.round.redealVotes[seatIndex] = true;
    const allVoted = g.round.redealVotes.every(v => v);
    if (allVoted) {
      g.dealerIndex = (g.dealerIndex + 1) % 4;
      startRound(g);
      return { redealt: true };
    }
    return { voted: true };
  }

  // ── Bidding ──────────────────────────────────────────────────────────────

  placeBid(seatIndex, amount) {
    const g = this.game;
    const r = g.round;

    if (g.phase !== 'bidding') return { error: 'Not in bidding phase' };
    if (r.currentBidder !== seatIndex) return { error: 'Not your turn to bid' };
    if (r.bids[seatIndex] === 'pass') return { error: 'You have already passed' };

    // Pass
    if (amount === 'pass') {
      // First bidder cannot pass on first turn
      if (seatIndex === r.firstBidder && r.bids[seatIndex] === null) {
        return { error: 'The first bidder must bid at least 75' };
      }
      r.bids[seatIndex] = 'pass';
      r.bidLog.push({ seat: seatIndex, amount: 'pass' });
      return this._advanceBidding();
    }

    // Numeric bid
    if (typeof amount !== 'number') return { error: 'Invalid bid' };
    if (amount < MIN_BID) return { error: `Minimum bid is ${MIN_BID}` };
    if (amount % 5 !== 0) return { error: 'Bids must be multiples of 5' };
    if (amount <= r.highBid) return { error: `Bid must be higher than ${r.highBid}` };

    r.bids[seatIndex] = amount;
    r.highBid = amount;
    r.highBidder = seatIndex;
    r.bidLog.push({ seat: seatIndex, amount });

    return this._advanceBidding();
  }

  _advanceBidding() {
    const g = this.game;
    const r = g.round;

    // Count active bidders (not passed, not null-first-turn)
    const passed = r.bids.filter(b => b === 'pass').length;
    const active = 4 - passed;

    // Special: first bid was 75 and all others pass — enter redeal-vote phase
    if (
      r.highBid === MIN_BID &&
      r.highBidder === r.firstBidder &&
      passed === 3
    ) {
      g.phase = 'redeal-vote';
      r.redealVotes = [false, false, false, false];
      return { redealVote: true };
    }

    if (active === 1) {
      // Bidding over
      return this._openKitty();
    }

    // Advance to next non-passed bidder
    let next = (r.currentBidder + 1) % 4;
    while (r.bids[next] === 'pass') {
      next = (next + 1) % 4;
    }
    r.currentBidder = next;

    return {
      phase: 'bidding',
      bids: r.bids,
      highBid: r.highBid,
      highBidder: r.highBidder,
      currentBidder: r.currentBidder,
    };
  }

  _openKitty() {
    const g = this.game;
    const r = g.round;

    r.bidWinner = r.highBidder;
    // Add kitty to winner's hand
    r.hands[r.bidWinner].push(r.kitty);
    g.phase = 'kitty';

    return {
      phase: 'kitty',
      kitty: r.kitty,
      bidWinner: r.bidWinner,
      highBid: r.highBid,
      hands: r.hands,
    };
  }

  // ── Kitty phase ──────────────────────────────────────────────────────────

  discardAndDeclareTrump(seatIndex, discardCardId, trumpSuit) {
    const g = this.game;
    const r = g.round;

    if (g.phase !== 'kitty') return { error: 'Not in kitty phase' };
    if (seatIndex !== r.bidWinner) return { error: 'Only the bid winner can discard' };

    // Validate trump suit
    const validTrumps = [...SUITS, 'NoTrump'];
    if (!validTrumps.includes(trumpSuit)) return { error: 'Invalid trump declaration' };

    // Find and validate discard
    const hand = r.hands[seatIndex];
    const cardIdx = hand.findIndex(c => c.id === discardCardId);
    if (cardIdx === -1) return { error: 'Card not in your hand' };

    const card = hand[cardIdx];
    if (isPointer(card)) return { error: 'Cannot discard a pointer card' };

    // Discard
    hand.splice(cardIdx, 1);
    r.discarded = card;
    r.trumpSuit = trumpSuit;

    // First leader = player left of bid winner
    r.currentLeader = (r.bidWinner + 1) % 4;
    g.phase = 'playing';

    return {
      phase: 'playing',
      trumpSuit,
      bidWinner: r.bidWinner,
      highBid: r.highBid,
      currentLeader: r.currentLeader,
      hands: r.hands,
      discarded: card,
    };
  }

  // ── Undo last card played in current trick ───────────────────────────────

  undoLastPlay(requestingSeat) {
    const g = this.game;
    const r = g.round;

    if (g.phase !== 'playing') return { error: 'Not in playing phase' };

    // Case 1: trick still in progress — last play is still in currentTrick
    if (r.currentTrick.length > 0) {
      const lastPlay = r.currentTrick[r.currentTrick.length - 1];
      if (lastPlay.playerIndex !== requestingSeat) {
        return { error: 'You can only undo your own last play' };
      }
      r.hands[requestingSeat].push(lastPlay.card);
      r.currentTrick.pop();

      return {
        phase: 'playing',
        currentTrick: r.currentTrick,
        hands: r.hands,
        currentLeader: r.currentLeader,
        undone: true,
      };
    }

    // Case 2: trick was just completed — restore from snapshot
    const snap = r.lastTrickSnapshot;
    if (!snap) return { error: 'No card to undo' };
    if (snap.lastPlaySeat !== requestingSeat) {
      return { error: 'You can only undo your own last play' };
    }

    // Reverse _completeTrick: restore the trick, captured cards, trick counts, and leader
    r.hands[requestingSeat].push(snap.trick[snap.trick.length - 1].card);
    r.currentTrick = snap.trick.slice(0, 3); // 3 plays remain after removing the 4th
    r.capturedCards = snap.capturedCards;
    r.trickCounts = snap.trickCounts;
    // Undo the winner assignment — leader reverts to whoever led this trick
    r.currentLeader = snap.trick[0].playerIndex;
    r.tricks.pop();
    r.lastTrickSnapshot = null;

    return {
      phase: 'playing',
      currentTrick: r.currentTrick,
      hands: r.hands,
      currentLeader: r.currentLeader,
      trickCounts: r.trickCounts,
      undone: true,
    };
  }

  // ── Playing ──────────────────────────────────────────────────────────────

  playCard(seatIndex, cardId) {
    const g = this.game;
    const r = g.round;

    if (g.phase !== 'playing') return { error: 'Not in playing phase' };

    // Determine whose turn it is
    const expectedPlayer = r.currentTrick.length === 0
      ? r.currentLeader
      : (r.currentLeader + r.currentTrick.length) % 4;

    if (seatIndex !== expectedPlayer) return { error: 'Not your turn' };

    const hand = r.hands[seatIndex];
    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return { error: 'Card not in your hand' };
    const card = hand[cardIdx];

    // Follow-suit validation
    if (r.currentTrick.length > 0) {
      const leadCard = r.currentTrick[0].card;
      const leadSuit = leadCard.id === 'Rook' ? '_TRUMP_' : leadCard.suit;
      const mustPlay = canFollow(hand, leadSuit, r.trumpSuit);
      if (mustPlay && !mustPlay.find(c => c.id === cardId)) {
        return { error: 'You must follow suit' };
      }
    }

    // Play the card — new play invalidates any prior completed-trick snapshot
    r.lastTrickSnapshot = null;
    hand.splice(cardIdx, 1);
    r.currentTrick.push({ playerIndex: seatIndex, card });

    // Trick complete?
    if (r.currentTrick.length === 4) {
      // Save snapshot before resolving so undo can reverse the 4th play
      r.lastTrickSnapshot = {
        trick: r.currentTrick.map(p => ({ ...p, card: { ...p.card } })),
        capturedCards: [r.capturedCards[0].map(c => ({ ...c })), r.capturedCards[1].map(c => ({ ...c }))],
        trickCounts: [...r.trickCounts],
        lastPlaySeat: seatIndex,
      };
      return this._completeTrick();
    }

    return {
      phase: 'playing',
      currentTrick: r.currentTrick,
      hands: r.hands,
      currentLeader: r.currentLeader,
    };
  }

  _completeTrick() {
    const g = this.game;
    const r = g.round;

    const leadCard = r.currentTrick[0].card;
    const leadSuit = leadCard.id === 'Rook' ? '_TRUMP_' : leadCard.suit;
    const winner = trickWinner(r.currentTrick, leadSuit, r.trumpSuit);
    const winTeam = this.teamOf(winner);

    // Snapshot points before collecting so client can animate from old → new
    const prevRoundPoints = [countPoints(r.capturedCards[0]), countPoints(r.capturedCards[1])];

    // Collect pointers
    for (const { card } of r.currentTrick) {
      if (isPointer(card)) r.capturedCards[winTeam].push(card);
    }
    r.trickCounts[winTeam]++;

    // Detect the exact trick that clinches the tricks bonus
    // Bid team needs 8, non-bid team needs 7 (14 - 8 + 1)
    const bidTeam = this.teamOf(r.bidWinner);
    const threshold = winTeam === bidTeam ? 8 : 7;
    const tricksBonus = r.trickCounts[winTeam] === threshold ? winTeam : null;

    r.tricks.push({ plays: [...r.currentTrick], winner });
    r.currentTrick = [];
    r.currentLeader = winner;

    // Round over?
    if (r.tricks.length === 14) {
      return this._scoreRound();
    }

    return {
      phase: 'playing',
      lastTrickWinner: winner,
      lastTrickPlays: r.tricks[r.tricks.length - 1].plays,
      trickCounts: r.trickCounts,
      currentLeader: r.currentLeader,
      currentTrick: [],
      hands: r.hands,
      prevRoundPoints,
      tricksBonus,
    };
  }

  _scoreRound() {
    const g = this.game;
    const r = g.round;

    // Count pointer points per team
    const pts = [countPoints(r.capturedCards[0]), countPoints(r.capturedCards[1])];

    // Bid team needs 8 tricks for bonus; non-bid team needs 7
    const bidTeam = this.teamOf(r.bidWinner);
    const nonBidTeam = 1 - bidTeam;

    if (r.trickCounts[bidTeam] >= 8) pts[bidTeam] += TRICKS_BONUS;
    else pts[nonBidTeam] += TRICKS_BONUS;

    // Apply scores
    const scored = [0, 0];
    if (pts[bidTeam] >= r.highBid) {
      scored[bidTeam] = pts[bidTeam];
    } else {
      scored[bidTeam] = -r.highBid; // set-back
    }
    scored[nonBidTeam] = pts[nonBidTeam];

    g.scores[0] += scored[0];
    g.scores[1] += scored[1];

    // Persist so getPublicState can expose it during scoring/gameover phase
    r.roundScored = scored;

    // Check win
    let winner = null;
    if (g.scores[0] >= WIN_SCORE || g.scores[1] >= WIN_SCORE) {
      if (g.scores[0] >= WIN_SCORE && g.scores[1] >= WIN_SCORE) {
        winner = bidTeam; // both reach 500 → bid team wins
      } else if (g.scores[0] >= WIN_SCORE) {
        winner = 0;
      } else {
        winner = 1;
      }
    }

    g.phase = winner !== null ? 'gameover' : 'scoring';

    const result = {
      phase: g.phase,
      scores: g.scores,
      roundPoints: pts,
      roundScored: scored,
      bidTeam,
      highBid: r.highBid,
      trickCounts: r.trickCounts,
      capturedCards: r.capturedCards,
      winner,
      lastTrickWinner: r.tricks[r.tricks.length - 1]?.winner,
      lastTrickPlays:  r.tricks[r.tricks.length - 1]?.plays ?? [],
    };

    if (winner === null) {
      // Prep next round
      g.dealerIndex = (g.dealerIndex + 1) % 4;
    }

    return result;
  }

  // ── Start next round ─────────────────────────────────────────────────────

  startNextRound() {
    const g = this.game;
    if (g.phase !== 'scoring') return { error: 'Not in scoring phase' };
    startRound(g);
    return this._roundStartPayload();
  }

  // ── Public state helpers ─────────────────────────────────────────────────

  getPublicState() {
    const g = this.game;
    if (!g) return null;
    const r = g.round;
    return {
      phase: g.phase,
      scores: g.scores,
      dealerIndex: g.dealerIndex,
      playerIds: g.playerIds,
      round: r ? {
        bids: r.bids,
        highBid: r.highBid,
        highBidder: r.highBidder,
        currentBidder: r.currentBidder,
        trumpSuit: r.trumpSuit,
        bidWinner: r.bidWinner,
        currentTrick: r.currentTrick,
        currentLeader: r.currentLeader,
        trickCounts: r.trickCounts,
        tricks: r.tricks.length,
        lastTrickUndoableBySeat: r.lastTrickSnapshot?.lastPlaySeat ?? null,
        kitty: r.kitty,
        roundPoints: [countPoints(r.capturedCards[0]), countPoints(r.capturedCards[1])],
        roundScored: r.roundScored ?? null,
        bidLog: r.bidLog ?? [],
        // Exposed only during redeal-vote so all players can see all hands
        allHands: g.phase === 'redeal-vote' ? r.hands : null,
        redealVotes: r.redealVotes ?? null,
        firstBidder: r.firstBidder,
      } : null,
    };
  }

  getHandFor(seatIndex) {
    return this.game?.round?.hands[seatIndex] || [];
  }
}

module.exports = { GameEngine, SUITS, isPointer, cardPoints };
