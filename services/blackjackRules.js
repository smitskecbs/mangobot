/**
 * ManGo Blackjack — pure deck, hand value, compare, and bot policy.
 * RNG is injected; production uses crypto.randomInt.
 */

const crypto = require("crypto");

const SUITS = Object.freeze(["spades", "hearts", "diamonds", "clubs"]);
const SUIT_EMOJI = Object.freeze({
  spades: "♠️",
  hearts: "♥️",
  diamonds: "♦️",
  clubs: "♣️",
});
const RANKS = Object.freeze([
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
]);

const BOT_STAND_AT = 17;
const BLACKJACK_TARGET = 21;

function defaultRandomInt(n) {
  const max = Number(n);
  if (!Number.isInteger(max) || max <= 0) {
    return 0;
  }
  return crypto.randomInt(0, max);
}

function createCard(rank, suit) {
  return { rank, suit };
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(createCard(rank, suit));
    }
  }
  return deck;
}

function cardKey(card) {
  return `${card.rank}:${card.suit}`;
}

function shuffleDeck(deck, randomIntFn = defaultRandomInt) {
  const shuffled = Array.isArray(deck) ? deck.slice() : [];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = randomIntFn(i + 1);
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return shuffled;
}

function drawCard(deck, index = 0) {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  if (!Array.isArray(deck) || i >= deck.length) {
    return { card: null, nextIndex: i };
  }
  return { card: deck[i], nextIndex: i + 1 };
}

function rankValue(rank) {
  if (rank === "A") {
    return 11;
  }
  if (rank === "J" || rank === "Q" || rank === "K") {
    return 10;
  }
  const n = Number(rank);
  return Number.isInteger(n) ? n : 0;
}

/**
 * Soft/hard total: aces start at 11 and reduce to 1 until <= 21.
 * @returns {{ total: number, soft: boolean, aceCount: number }}
 */
function evaluateHand(cards) {
  const hand = Array.isArray(cards) ? cards : [];
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (!card || !card.rank) {
      continue;
    }
    if (card.rank === "A") {
      aces += 1;
      total += 11;
    } else {
      total += rankValue(card.rank);
    }
  }
  let remainingAces = aces;
  while (total > BLACKJACK_TARGET && remainingAces > 0) {
    total -= 10;
    remainingAces -= 1;
  }
  return {
    total,
    soft: remainingAces > 0 && total <= BLACKJACK_TARGET,
    aceCount: aces,
  };
}

function handValue(cards) {
  return evaluateHand(cards).total;
}

function isBust(cards) {
  return handValue(cards) > BLACKJACK_TARGET;
}

function isNaturalBlackjack(cards) {
  const hand = Array.isArray(cards) ? cards : [];
  return hand.length === 2 && handValue(hand) === BLACKJACK_TARGET;
}

function isSoft17(cards) {
  const info = evaluateHand(cards);
  return info.total === BOT_STAND_AT && info.soft;
}

/**
 * v1 dealer-style: hit below 17, stand on 17+ including soft 17.
 */
function botShouldHit(cards) {
  return handValue(cards) < BOT_STAND_AT;
}

/**
 * @returns {"a"|"b"|"push"}
 */
function compareHands(handA, handB) {
  const aBust = isBust(handA);
  const bBust = isBust(handB);
  if (aBust && bBust) {
    return "push";
  }
  if (aBust) {
    return "b";
  }
  if (bBust) {
    return "a";
  }
  const aVal = handValue(handA);
  const bVal = handValue(handB);
  if (aVal !== bVal) {
    return aVal > bVal ? "a" : "b";
  }
  const aNat = isNaturalBlackjack(handA);
  const bNat = isNaturalBlackjack(handB);
  if (aNat && !bNat) {
    return "a";
  }
  if (bNat && !aNat) {
    return "b";
  }
  return "push";
}

function formatCard(card) {
  if (!card || !card.rank) {
    return "?";
  }
  const emoji = SUIT_EMOJI[card.suit] || "";
  return `${card.rank}${emoji}`;
}

function formatHand(cards) {
  const hand = Array.isArray(cards) ? cards : [];
  if (!hand.length) {
    return "—";
  }
  return hand.map(formatCard).join("  ");
}

function formatHandWithTotal(cards) {
  if (isBust(cards)) {
    return `${formatHand(cards)}  (Bust)`;
  }
  if (isNaturalBlackjack(cards)) {
    return `${formatHand(cards)}  (Blackjack ${handValue(cards)})`;
  }
  return `${formatHand(cards)}  (${handValue(cards)})`;
}

module.exports = {
  SUITS,
  SUIT_EMOJI,
  RANKS,
  BOT_STAND_AT,
  BLACKJACK_TARGET,
  defaultRandomInt,
  createCard,
  createDeck,
  cardKey,
  shuffleDeck,
  drawCard,
  rankValue,
  evaluateHand,
  handValue,
  isBust,
  isNaturalBlackjack,
  isSoft17,
  botShouldHit,
  compareHands,
  formatCard,
  formatHand,
  formatHandWithTotal,
};
