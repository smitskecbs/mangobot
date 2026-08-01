/**
 * Focused tests for Bounch level leaderboard logic.
 * Uses a temporary file — never touches bounch-highscores.json.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  migrateInMemory,
  readScoresFile,
  submitLevel,
  getDisplayLeaderboard,
  normalizeNameKey,
  syncGlobalFields,
  buildApiResponse,
  parseLevel,
  writeScoresFile,
} = require("../services/bounchScores");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-bounch-test-"));
const testFile = path.join(tempDir, "bounch-highscores.json");

function resetFile(contents = null) {
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }

  const tmpPath = `${testFile}.tmp`;
  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  if (contents !== null) {
    if (typeof contents === "string") {
      fs.writeFileSync(testFile, contents, "utf8");
      return;
    }

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

runTest("first player Level 1", () => {
  const { data, result } = submitLevel(testFile, "Kevin", 1);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(result.rank, 1);
  assert.strictEqual(result.level, 1);
  assert.strictEqual(result.bestLevel, 1);
  assert.strictEqual(data.leaderboard.length, 1);
  assert.strictEqual(data.globalBestLevel, 1);
  assert.strictEqual(data.globalBestLevelName, "Kevin");
});

runTest("bestLevel rises", () => {
  submitLevel(testFile, "Kevin", 1);
  const { data, result } = submitLevel(testFile, "Kevin", 3);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(result.bestLevel, 3);
  assert.strictEqual(data.leaderboard[0].bestLevel, 3);
});

runTest("lower level does not lower bestLevel", () => {
  submitLevel(testFile, "Alice", 4);
  const { data, result } = submitLevel(testFile, "Alice", 2);

  assert.strictEqual(result.personalBest, false);
  assert.strictEqual(result.bestLevel, 4);
  assert.strictEqual(data.leaderboard.find((e) => e.name === "Alice").bestLevel, 4);
});

runTest("equal level does not lower bestLevel", () => {
  submitLevel(testFile, "Alice", 4);
  const { result } = submitLevel(testFile, "Alice", 4);

  assert.strictEqual(result.personalBest, false);
  assert.strictEqual(result.bestLevel, 4);
});

runTest("gamesPlayed rises on every valid submit", () => {
  submitLevel(testFile, "Kevin", 1);
  const { result } = submitLevel(testFile, "Kevin", 1);

  assert.strictEqual(result.gamesPlayed, 2);
});

runTest("lastLevel is updated", () => {
  submitLevel(testFile, "Kevin", 3);
  const { result } = submitLevel(testFile, "Kevin", 2);

  assert.strictEqual(result.lastLevel, 2);
  assert.strictEqual(result.bestLevel, 3);
});

runTest("lastPlayedAt is updated", () => {
  submitLevel(testFile, "Kevin", 1);
  const first = readScoresFile(testFile).leaderboard[0].lastPlayedAt;
  submitLevel(testFile, "Kevin", 1);
  const second = readScoresFile(testFile).leaderboard[0].lastPlayedAt;

  assert.notStrictEqual(second, first);
});

runTest("case-insensitive name matching", () => {
  submitLevel(testFile, "Kevin", 2);
  const { data, result } = submitLevel(testFile, " kevin ", 4);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(data.leaderboard.length, 1);
  assert.strictEqual(data.leaderboard[0].name, "kevin");
  assert.strictEqual(data.leaderboard[0].bestLevel, 4);
  assert.strictEqual(normalizeNameKey(" Kevin "), normalizeNameKey("KEVIN"));
});

runTest("second player", () => {
  submitLevel(testFile, "Kevin", 3);
  const { data, result } = submitLevel(testFile, "Alice", 2);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(result.rank, 2);
  assert.strictEqual(data.leaderboard.length, 2);
  assert.strictEqual(data.leaderboard[0].name, "Kevin");
  assert.strictEqual(data.leaderboard[1].name, "Alice");
});

runTest("leaderboard sorts highest bestLevel first", () => {
  submitLevel(testFile, "Tom", 2);
  submitLevel(testFile, "Eva", 4);
  submitLevel(testFile, "Kevin", 5);

  const data = readScoresFile(testFile);
  assert.strictEqual(data.leaderboard[0].name, "Kevin");
  assert.strictEqual(data.leaderboard[0].bestLevel, 5);
  assert.strictEqual(data.leaderboard[1].name, "Eva");
  assert.strictEqual(data.leaderboard[2].name, "Tom");
});

runTest("top 10 trim", () => {
  for (let i = 1; i <= 11; i += 1) {
    submitLevel(testFile, `Player${i}`, i <= 5 ? i : ((i - 1) % 5) + 1);
  }

  const data = readScoresFile(testFile);
  assert.strictEqual(data.leaderboard.length, 10);
});
runTest("globalBestLevel mirrors top entry", () => {
  submitLevel(testFile, "Kevin", 3);
  submitLevel(testFile, "Alice", 5);

  const data = readScoresFile(testFile);
  syncGlobalFields(data);

  assert.strictEqual(data.globalBestLevel, 5);
  assert.strictEqual(data.globalBestLevelName, "Alice");
  assert.strictEqual(data.globalBestLevel, data.leaderboard[0].bestLevel);
  assert.strictEqual(data.globalBestLevelName, data.leaderboard[0].name);
});

runTest("globalBestLevelName updates with new global", () => {
  submitLevel(testFile, "Kevin", 4);
  const { data } = submitLevel(testFile, "Alice", 5);

  assert.strictEqual(data.globalBestLevelName, "Alice");
  assert.strictEqual(data.globalBestLevel, 5);
});

runTest("invalid level 0", () => {
  submitLevel(testFile, "Kevin", 1);
  const invalid = submitLevel(testFile, "Kevin", 0);

  assert.ok(invalid.error);
  assert.strictEqual(parseLevel(0), null);
  assert.strictEqual(readScoresFile(testFile).leaderboard[0].gamesPlayed, 1);
});

runTest("valid level 6", () => {
  assert.strictEqual(parseLevel(6), 6);
  const { data, result } = submitLevel(testFile, "Kevin", 6);

  assert.strictEqual(result.level, 6);
  assert.strictEqual(result.bestLevel, 6);
  assert.strictEqual(data.globalBestLevel, 6);
});

runTest("valid level 7", () => {
  assert.strictEqual(parseLevel(7), 7);
  const { data, result } = submitLevel(testFile, "Kevin", 7);

  assert.strictEqual(result.level, 7);
  assert.strictEqual(result.bestLevel, 7);
  assert.strictEqual(data.globalBestLevel, 7);
});

runTest("invalid level 8", () => {
  assert.strictEqual(parseLevel(8), null);
  const invalid = submitLevel(testFile, "Kevin", 8);
  assert.ok(invalid.error);
});

runTest("Level 7 becomes bestLevel", () => {
  submitLevel(testFile, "Kevin", 5);
  const { data, result } = submitLevel(testFile, "Kevin", 7);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(result.bestLevel, 7);
  assert.strictEqual(data.leaderboard[0].bestLevel, 7);
});

runTest("lower submit after Level 7 keeps bestLevel 7", () => {
  submitLevel(testFile, "Kevin", 7);
  const { data, result } = submitLevel(testFile, "Kevin", 3);

  assert.strictEqual(result.personalBest, false);
  assert.strictEqual(result.bestLevel, 7);
  assert.strictEqual(result.lastLevel, 3);
  assert.strictEqual(data.leaderboard[0].bestLevel, 7);
  assert.strictEqual(data.globalBestLevel, 7);
});

runTest("globalBestLevel can become 7", () => {
  submitLevel(testFile, "Kevin", 5);
  const { data } = submitLevel(testFile, "Alice", 7);

  assert.strictEqual(data.globalBestLevel, 7);
  assert.strictEqual(data.globalBestLevelName, "Alice");
});

runTest("leaderboard sorts Level 7 above lower levels", () => {
  submitLevel(testFile, "Tom", 4);
  submitLevel(testFile, "Eva", 6);
  submitLevel(testFile, "Kevin", 7);

  const board = getDisplayLeaderboard(testFile);
  assert.strictEqual(board[0].name, "Kevin");
  assert.strictEqual(board[0].bestLevel, 7);
  assert.strictEqual(board[1].name, "Eva");
  assert.strictEqual(board[1].bestLevel, 6);
  assert.strictEqual(board[2].name, "Tom");
  assert.strictEqual(board[2].bestLevel, 4);
});

runTest("non-integer level", () => {
  assert.strictEqual(parseLevel(2.5), null);
  assert.strictEqual(parseLevel("abc"), null);
  const invalid = submitLevel(testFile, "Kevin", 2.5);
  assert.ok(invalid.error);
});

runTest("corrupt or empty file recovers safely", () => {
  resetFile();
  assert.deepStrictEqual(getDisplayLeaderboard(testFile), []);

  resetFile("{ invalid json");
  assert.deepStrictEqual(getDisplayLeaderboard(testFile), []);

  resetFile("");
  assert.deepStrictEqual(getDisplayLeaderboard(testFile), []);
});

runTest("API response fields", () => {
  submitLevel(testFile, "Kevin", 5);
  submitLevel(testFile, "Alice", 4);
  const { data, result } = submitLevel(testFile, "Alice", 2);

  const response = buildApiResponse(data, {
    posted: false,
    personalBest: result.personalBest,
    personalBestImproved: result.personalBest,
    name: result.name,
    level: result.level,
    bestLevel: result.bestLevel,
    isNewGlobal: result.isNewGlobal,
    rank: result.rank,
    gamesPlayed: result.gamesPlayed,
    lastLevel: result.lastLevel,
    lastPlayedAt: result.lastPlayedAt,
    reason: "not_personal_best",
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.name, "Alice");
  assert.strictEqual(response.level, 2);
  assert.strictEqual(response.bestLevel, 4);
  assert.strictEqual(response.personalBest, false);
  assert.strictEqual(response.rank, 2);
  assert.strictEqual(response.globalBestLevel, 5);
  assert.strictEqual(response.globalBestLevelName, "Kevin");
  assert.strictEqual(response.gamesPlayed, 2);
  assert.strictEqual(response.lastLevel, 2);
  assert.ok(Array.isArray(response.leaderboard));
  assert.ok(response.lastPlayedAt);
});

runTest("atomic write via normal submit flow", () => {
  submitLevel(testFile, "Kevin", 3);

  assert.ok(fs.existsSync(testFile));
  assert.ok(!fs.existsSync(`${testFile}.tmp`));

  const saved = JSON.parse(fs.readFileSync(testFile, "utf8"));
  assert.strictEqual(saved.leaderboard[0].bestLevel, 3);

  writeScoresFile(testFile, saved);
  assert.ok(fs.existsSync(testFile));
  assert.ok(!fs.existsSync(`${testFile}.tmp`));
});

runTest("lower submit after Level 5 keeps bestLevel 5", () => {
  submitLevel(testFile, "Kevin", 5);
  const { data, result } = submitLevel(testFile, "Kevin", 1);

  assert.strictEqual(result.personalBest, false);
  assert.strictEqual(result.bestLevel, 5);
  assert.strictEqual(result.lastLevel, 1);
  assert.strictEqual(data.leaderboard[0].bestLevel, 5);
  assert.strictEqual(data.globalBestLevel, 5);
});

runTest("equal bestLevels ordered by newest updatedAt", () => {
  resetFile({
    globalBestLevel: 3,
    globalBestLevelName: "Older",
    updatedAt: "2026-07-27T10:00:00.000Z",
    leaderboard: [
      {
        name: "Older",
        bestLevel: 3,
        updatedAt: "2026-07-27T10:00:00.000Z",
      },
      {
        name: "Newer",
        bestLevel: 3,
        updatedAt: "2026-07-27T12:00:00.000Z",
      },
    ],
  });

  const data = readScoresFile(testFile);
  assert.strictEqual(data.leaderboard[0].name, "Newer");
  assert.strictEqual(data.leaderboard[1].name, "Older");
});

runTest("new personal best updates updatedAt", () => {
  submitLevel(testFile, "Kevin", 2);
  const before = readScoresFile(testFile).leaderboard[0].updatedAt;
  const { data, result } = submitLevel(testFile, "Kevin", 4);

  assert.strictEqual(result.personalBest, true);
  assert.strictEqual(data.leaderboard[0].bestLevel, 4);
  assert.notStrictEqual(data.leaderboard[0].updatedAt, before);
});

runTest("lower level does not change updatedAt", () => {
  submitLevel(testFile, "Kevin", 4);
  const before = readScoresFile(testFile).leaderboard[0].updatedAt;
  submitLevel(testFile, "Kevin", 2);
  const after = readScoresFile(testFile).leaderboard[0].updatedAt;

  assert.strictEqual(after, before);
});

runTest("migrate empty/malformed root to empty scores", () => {
  const migrated = migrateInMemory(null);
  assert.strictEqual(migrated.globalBestLevel, 0);
  assert.deepStrictEqual(migrated.leaderboard, []);
});

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll bounch score tests passed.");
