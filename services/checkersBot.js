/**
 * Server-side Checkers bot: legal moves only, cheap capture/promotion preference.
 * No search / minimax.
 */

const crypto = require("crypto");
const { legalMoves, isLegalMove } = require("./checkersRules");

function defaultRandomInt(minInclusive, maxExclusive) {
  return crypto.randomInt(minInclusive, maxExclusive);
}

function pickRandom(items, randomIntFn) {
  if (!items.length) {
    return null;
  }
  return items[randomIntFn(0, items.length)];
}

/**
 * @param {{ board: Array, current: string, pendingFrom: number|null }} state
 * @param {(min: number, max: number) => number} [randomIntFn]
 * @returns {{ from: number, to: number }|null}
 */
function chooseCheckersBotMove(state, randomIntFn = defaultRandomInt) {
  const rng = typeof randomIntFn === "function" ? randomIntFn : defaultRandomInt;
  const moves = legalMoves(state);
  if (!moves.length) {
    return null;
  }

  const captures = moves.filter((m) => m.captured != null);
  const pool = captures.length ? captures : moves;
  const promotions = pool.filter((m) => m.promoted);
  const chosen = pickRandom(promotions.length ? promotions : pool, rng);
  if (!chosen) {
    return null;
  }
  return { from: chosen.from, to: chosen.to };
}

function isLegalCheckersBotMove(state, from, to) {
  return isLegalMove(state, from, to);
}

module.exports = {
  chooseCheckersBotMove,
  isLegalCheckersBotMove,
};
