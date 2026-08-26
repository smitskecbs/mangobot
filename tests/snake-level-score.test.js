/**
 * Snake difficulty score formula + submission recompute.
 * Uses no production highscore files.
 * Run with: node tests/snake-level-score.test.js
 */

const assert = require("assert");
const {
  BASE_BONUS_POINTS,
  BASE_MANGO_POINTS,
  BONUS_EVERY,
  calculateSnakeScore,
  maxBonusMangoesForCount,
  normalizeSnakeLevel,
  parseSnakeLevel,
  resolveSnakeScoreSubmission,
  scoreForFiveMangoBonus,
  scoreForMango,
} = require("../services/snakeLevelScore");

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("historic Level 1 mango and bonus values", () => {
  assert.strictEqual(BASE_MANGO_POINTS, 10);
  assert.strictEqual(BASE_BONUS_POINTS, 50);
  assert.strictEqual(BONUS_EVERY, 5);
  assert.strictEqual(scoreForMango(1), 10);
  assert.strictEqual(scoreForFiveMangoBonus(1), 50);
});

runTest("multipliers 1-4", () => {
  assert.strictEqual(scoreForMango(2), 20);
  assert.strictEqual(scoreForMango(3), 30);
  assert.strictEqual(scoreForMango(4), 40);
  assert.strictEqual(scoreForFiveMangoBonus(2), 100);
  assert.strictEqual(scoreForFiveMangoBonus(3), 150);
  assert.strictEqual(scoreForFiveMangoBonus(4), 200);
});

runTest("4 mangoes do not earn a bonus slot", () => {
  assert.strictEqual(maxBonusMangoesForCount(4), 0);
  assert.strictEqual(
    calculateSnakeScore({ mangoCount: 4, level: 1, bonusMangoesEaten: 0 }),
    40
  );
});

runTest("5 mangoes allow exactly one bonus; 10 mangoes allow two", () => {
  assert.strictEqual(maxBonusMangoesForCount(5), 1);
  assert.strictEqual(
    calculateSnakeScore({ mangoCount: 5, level: 1, bonusMangoesEaten: 1 }),
    100
  );
  assert.strictEqual(maxBonusMangoesForCount(10), 2);
  assert.strictEqual(
    calculateSnakeScore({ mangoCount: 10, level: 1, bonusMangoesEaten: 2 }),
    200
  );
  assert.strictEqual(
    calculateSnakeScore({ mangoCount: 5, level: 2, bonusMangoesEaten: 1 }),
    200
  );
  assert.strictEqual(
    calculateSnakeScore({ mangoCount: 5, level: 3, bonusMangoesEaten: 1 }),
    300
  );
  assert.strictEqual(
    calculateSnakeScore({ mangoCount: 5, level: 4, bonusMangoesEaten: 1 }),
    400
  );
});

runTest("score is deterministic", () => {
  const a = calculateSnakeScore({ mangoCount: 12, level: 4, bonusMangoesEaten: 2 });
  const b = calculateSnakeScore({ mangoCount: 12, level: 4, bonusMangoesEaten: 2 });
  assert.strictEqual(a, 880);
  assert.strictEqual(a, b);
});

runTest("invalid level parse vs client default", () => {
  assert.strictEqual(parseSnakeLevel(5), null);
  assert.strictEqual(parseSnakeLevel("nope"), null);
  assert.strictEqual(parseSnakeLevel(NaN), null);
  assert.strictEqual(parseSnakeLevel(Infinity), null);
  assert.strictEqual(normalizeSnakeLevel(undefined), 1);
  assert.strictEqual(parseSnakeLevel("3"), 3);
});

runTest("legacy score-only body is accepted", () => {
  const resolved = resolveSnakeScoreSubmission({ name: "Ada", score: 120 });
  assert.strictEqual(resolved.error, undefined);
  assert.strictEqual(resolved.score, 120);
  assert.strictEqual(resolved.recomputed, false);
  assert.strictEqual(resolved.level, null);
});

runTest("new format recomputes score from mangoCount + level + bonus", () => {
  const resolved = resolveSnakeScoreSubmission({
    name: "Ada",
    score: 400,
    mangoCount: 5,
    bonusMangoesEaten: 1,
    level: 4,
  });
  assert.strictEqual(resolved.error, undefined);
  assert.strictEqual(resolved.recomputed, true);
  assert.strictEqual(resolved.score, 400);
  assert.strictEqual(resolved.level, 4);
  assert.strictEqual(resolved.mangoCount, 5);
});

runTest("tampered score is rejected when mangoCount is present", () => {
  const resolved = resolveSnakeScoreSubmission({
    score: 9999,
    mangoCount: 5,
    bonusMangoesEaten: 1,
    level: 1,
  });
  assert.strictEqual(resolved.error, "Invalid score.");
});

runTest("invalid level / mangoCount / NaN rejected", () => {
  assert.strictEqual(resolveSnakeScoreSubmission({ score: 10, level: 9 }).error, "Invalid level.");
  assert.strictEqual(
    resolveSnakeScoreSubmission({ mangoCount: -1, level: 1, bonusMangoesEaten: 0 }).error,
    "Invalid mango count."
  );
  assert.strictEqual(
    resolveSnakeScoreSubmission({ mangoCount: 5, level: 1, bonusMangoesEaten: 3 }).error,
    "Invalid bonus count."
  );
  assert.strictEqual(resolveSnakeScoreSubmission({ score: Number.NaN }).error, "Invalid score.");
  assert.strictEqual(
    resolveSnakeScoreSubmission({ score: Number.POSITIVE_INFINITY }).error,
    "Invalid score."
  );
});

console.log("\nAll snake level-score tests passed.");
