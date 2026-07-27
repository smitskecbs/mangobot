/**
 * Focused tests for Snake score leaderboard logic.
 * Uses a temporary file — never touches snake-highscores.json.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  migrateInMemory,
  readScoresFile,
  submitScore,
  getDisplayLeaderboard,
  normalizeNameKey,
  syncGlobalFields,
} = require("../services/snakeScores");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-snake-test-"));
const testFile = path.join(tempDir, "snake-highscores.json");

function resetFile(contents = null) {
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }

  if (contents !== null) {
    fs.writeFileSync(testFile, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  }
}

function runTest(name, fn) {
  try {
    resetFile();
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("migrate old single-record format", () => {
  const migrated = migrateInMemory({
    globalHighScore: 730,
    name: "Kevin",
    updatedAt: "2026-07-27T10:00:00.000Z",
  });

  assert.strictEqual(migrated.globalHighScore, 730);
  assert.strictEqual(migrated.globalHighScoreName, "Kevin");
  assert.strictEqual(migrated.leaderboard.length, 1);
  assert.strictEqual(migrated.leaderboard[0].name, "Kevin");
  assert.strictEqual(migrated.leaderboard[0].score, 730);
});

runTest("add first player", () => {
  const { data, result } = submitScore(testFile, "Kevin", 730);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(result.rank, 1);
  assert.strictEqual(data.leaderboard.length, 1);
  assert.strictEqual(data.globalHighScore, 730);
  assert.strictEqual(data.globalHighScoreName, "Kevin");
});

runTest("add second player", () => {
  submitScore(testFile, "Kevin", 730);
  const { data, result } = submitScore(testFile, "Alice", 690);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(result.rank, 2);
  assert.strictEqual(data.leaderboard.length, 2);
  assert.strictEqual(data.leaderboard[0].name, "Kevin");
  assert.strictEqual(data.leaderboard[1].name, "Alice");
});

runTest("update personal best", () => {
  submitScore(testFile, "Kevin", 730);
  const { data, result } = submitScore(testFile, "Alice", 710);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(result.rank, 2);
  assert.strictEqual(data.leaderboard[1].score, 710);
});

runTest("reject lower score as new personal best", () => {
  submitScore(testFile, "Alice", 710);
  const { data, result } = submitScore(testFile, "Alice", 600);

  assert.strictEqual(result.personalBest, false);
  assert.strictEqual(data.leaderboard.find((e) => e.name === "Alice").score, 710);
});

runTest("case-insensitive duplicate player", () => {
  submitScore(testFile, "Kevin", 730);
  const { data, result } = submitScore(testFile, " kevin ", 760);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(data.leaderboard.length, 1);
  assert.strictEqual(data.leaderboard[0].name, "kevin");
  assert.strictEqual(data.leaderboard[0].score, 760);
  assert.strictEqual(normalizeNameKey(" Kevin "), normalizeNameKey("KEVIN"));
});

runTest("top 10 trimming", () => {
  for (let i = 1; i <= 11; i += 1) {
    submitScore(testFile, `Player${i}`, i * 10);
  }

  const data = readScoresFile(testFile);
  assert.strictEqual(data.leaderboard.length, 10);
  assert.strictEqual(data.leaderboard[0].score, 110);
  assert.strictEqual(data.leaderboard[9].score, 20);
  assert.ok(!data.leaderboard.some((entry) => entry.name === "Player1"));
});

runTest("equal scores ordered by newest updatedAt", () => {
  resetFile({
    globalHighScore: 500,
    globalHighScoreName: "Older",
    updatedAt: "2026-07-27T10:00:00.000Z",
    leaderboard: [
      {
        name: "Older",
        score: 500,
        updatedAt: "2026-07-27T10:00:00.000Z",
      },
      {
        name: "Newer",
        score: 500,
        updatedAt: "2026-07-27T12:00:00.000Z",
      },
    ],
  });

  const data = readScoresFile(testFile);
  assert.strictEqual(data.leaderboard[0].name, "Newer");
  assert.strictEqual(data.leaderboard[1].name, "Older");
});

runTest("invalid or missing score file recovery", () => {
  resetFile();
  assert.deepStrictEqual(getDisplayLeaderboard(testFile), []);

  resetFile("{ invalid json");
  assert.deepStrictEqual(getDisplayLeaderboard(testFile), []);

  resetFile("");
  assert.deepStrictEqual(getDisplayLeaderboard(testFile), []);
});

runTest("globalHighScore fields match leaderboard[0]", () => {
  submitScore(testFile, "Kevin", 760);
  submitScore(testFile, "Alice", 710);

  const data = readScoresFile(testFile);
  syncGlobalFields(data);

  assert.strictEqual(data.globalHighScore, data.leaderboard[0].score);
  assert.strictEqual(data.globalHighScoreName, data.leaderboard[0].name);
  assert.strictEqual(data.updatedAt, data.leaderboard[0].updatedAt);
});

runTest("old format migrates on next successful submission", () => {
  resetFile({
    globalHighScore: 730,
    name: "Kevin",
    updatedAt: "2026-07-27T10:00:00.000Z",
  });

  submitScore(testFile, "Alice", 690);
  const saved = JSON.parse(fs.readFileSync(testFile, "utf8"));

  assert.ok(Array.isArray(saved.leaderboard));
  assert.strictEqual(saved.globalHighScoreName, "Kevin");
  assert.strictEqual(saved.leaderboard.length, 2);
});

runTest("api response fields for lower score submission", () => {
  const { buildApiResponse } = require("../services/snakeScores");

  submitScore(testFile, "Kevin", 760);
  submitScore(testFile, "Alice", 730);
  const { data, result } = submitScore(testFile, "Alice", 520);

  const response = buildApiResponse(data, {
    posted: false,
    personalBest: result.personalBest,
    personalBestImproved: result.personalBest,
    score: result.score,
    personalBestScore: result.personalBestScore,
    isNewGlobal: result.isNewGlobal,
    rank: result.rank,
    reason: "not_personal_best",
  });

  assert.strictEqual(response.score, 520);
  assert.strictEqual(response.personalBestScore, 730);
  assert.strictEqual(response.personalBestImproved, false);
  assert.strictEqual(response.personalBest, false);
  assert.strictEqual(response.rank, 2);
  assert.strictEqual(response.globalHighScore, 760);
  assert.strictEqual(response.globalHighScoreName, "Kevin");
});

runTest("api response fields for new global highscore", () => {
  const { buildApiResponse } = require("../services/snakeScores");

  submitScore(testFile, "Kevin", 730);
  const { data, result } = submitScore(testFile, "Alice", 760);

  const response = buildApiResponse(data, {
    posted: true,
    personalBest: true,
    personalBestImproved: true,
    score: result.score,
    personalBestScore: result.personalBestScore,
    isNewGlobal: result.isNewGlobal,
    rank: result.rank,
  });

  assert.strictEqual(response.isNewGlobal, true);
  assert.strictEqual(response.rank, 1);
  assert.strictEqual(response.globalHighScore, 760);
  assert.strictEqual(response.globalHighScoreName, "Alice");
});

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll snake score tests passed.");
