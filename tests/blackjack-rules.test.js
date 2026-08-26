/**
 * ManGo Blackjack deck, hand values, compare, bot policy.
 * Run: node tests/blackjack-rules.test.js
 */

const assert = require("assert");
const {
  SUITS,
  RANKS,
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
  formatHandWithTotal,
} = require("../services/blackjackRules");

function card(rank, suit = "spades") {
  return { rank, suit };
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("1. deck 52 unique cards", () => {
  const deck = createDeck();
  assert.strictEqual(deck.length, 52);
  assert.strictEqual(SUITS.length * RANKS.length, 52);
  const keys = new Set(deck.map(cardKey));
  assert.strictEqual(keys.size, 52);
});

runTest("2. values correct", () => {
  assert.strictEqual(rankValue("2"), 2);
  assert.strictEqual(rankValue("10"), 10);
  assert.strictEqual(handValue([card("2"), card("3", "hearts")]), 5);
});

runTest("3. ace 11", () => {
  assert.strictEqual(handValue([card("A"), card("9")]), 20);
  assert.strictEqual(evaluateHand([card("A"), card("9")]).soft, true);
});

runTest("4. ace reduces to 1", () => {
  assert.strictEqual(handValue([card("A"), card("9"), card("5", "hearts")]), 15);
  assert.strictEqual(isBust([card("A"), card("9"), card("5", "hearts")]), false);
});

runTest("5. multiple aces", () => {
  assert.strictEqual(handValue([card("A"), card("A", "hearts")]), 12);
  assert.strictEqual(
    handValue([card("A"), card("A", "hearts"), card("A", "diamonds"), card("9")]),
    12
  );
});

runTest("6. face cards = 10", () => {
  assert.strictEqual(rankValue("J"), 10);
  assert.strictEqual(rankValue("Q"), 10);
  assert.strictEqual(rankValue("K"), 10);
  assert.strictEqual(handValue([card("K"), card("Q", "hearts")]), 20);
});

runTest("7. blackjack natural recognized", () => {
  assert.strictEqual(isNaturalBlackjack([card("A"), card("K")]), true);
  assert.strictEqual(isNaturalBlackjack([card("A"), card("10", "hearts")]), true);
  assert.strictEqual(isNaturalBlackjack([card("A"), card("9"), card("A", "hearts")]), false);
});

runTest("8. bust recognized", () => {
  assert.strictEqual(isBust([card("K"), card("Q"), card("2", "hearts")]), true);
  assert.strictEqual(isBust([card("K"), card("7")]), false);
});

runTest("9. tie resolution", () => {
  assert.strictEqual(
    compareHands([card("K"), card("9")], [card("Q", "hearts"), card("9", "diamonds")]),
    "push"
  );
  assert.strictEqual(
    compareHands([card("K"), card("Q"), card("5")], [card("9"), card("8")]),
    "b"
  );
  assert.strictEqual(
    compareHands([card("9"), card("8")], [card("K"), card("Q"), card("5")]),
    "a"
  );
});

runTest("10. natural beats non-natural 21", () => {
  const natural = [card("A"), card("K")];
  const sixFiveTen = [card("6"), card("5", "hearts"), card("10", "diamonds")];
  assert.strictEqual(handValue(natural), 21);
  assert.strictEqual(handValue(sixFiveTen), 21);
  assert.strictEqual(compareHands(natural, sixFiveTen), "a");
  assert.strictEqual(compareHands(sixFiveTen, natural), "b");
  assert.strictEqual(compareHands(natural, [card("A", "hearts"), card("Q")]), "push");
});

runTest("bot hits below 17 and stands on 17+ including soft 17", () => {
  assert.strictEqual(botShouldHit([card("8"), card("8", "hearts")]), true);
  assert.strictEqual(botShouldHit([card("10"), card("7")]), false);
  assert.strictEqual(isSoft17([card("A"), card("6")]), true);
  assert.strictEqual(botShouldHit([card("A"), card("6")]), false);
  assert.strictEqual(botShouldHit([card("A"), card("5")]), true);
});

runTest("shuffle is deterministic with injected RNG and draw advances index", () => {
  const original = createDeck();
  const shuffled = shuffleDeck(original, () => 0);
  assert.strictEqual(shuffled.length, 52);
  const keys = new Set(shuffled.map(cardKey));
  assert.strictEqual(keys.size, 52);
  const again = shuffleDeck(original, () => 0);
  assert.deepStrictEqual(again, shuffled);
  const first = drawCard(shuffled, 0);
  const second = drawCard(shuffled, first.nextIndex);
  assert.ok(first.card);
  assert.ok(second.card);
  assert.strictEqual(first.nextIndex, 1);
  assert.strictEqual(second.nextIndex, 2);
});

runTest("card text rendering stays compact", () => {
  assert.strictEqual(formatCard(card("A", "spades")), "A♠️");
  assert.ok(formatHandWithTotal([card("K"), card("Q")]).includes("20"));
});

console.log("All blackjack rules tests passed.");
