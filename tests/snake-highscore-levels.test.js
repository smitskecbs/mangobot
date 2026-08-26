/**
 * Snake highscore submissions with optional difficulty metadata.
 * Uses a temporary file — never touches snake-highscores.json.
 * Run with: node tests/snake-highscore-levels.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  submitScore,
  readScoresFile,
  getDisplayLeaderboard,
  migrateInMemory,
} = require("../services/snakeScores");
const { formatSnakeLeaderboardMessage } = require("../services/snakeLeaderboard");
const { resolveSnakeScoreSubmission } = require("../services/snakeLevelScore");
const { GAME_SOURCES } = require("../services/dailyQuest");
const { awardSnakeGameXp, loadPoints } = require("../services/points");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const { HELP_MESSAGE } = require("../commands/help");
const { buildSnakeReply, buildSignedGameUrl } = require("../utils/gameLinks");
const { MENU_LABELS } = require("../utils/botMenu");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-snake-levels-"));
const testFile = path.join(tempDir, "snake-highscores.json");
const pointsFile = path.join(tempDir, "points.json");
const TEST_SECRET = "test-snake-levels-secret-do-not-use-in-prod";

function resetFiles() {
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }
  fs.writeFileSync(pointsFile, `${JSON.stringify({ users: {} }, null, 2)}\n`, "utf8");
}

function runTest(name, fn) {
  try {
    resetFiles();
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("old score-only submission stays valid", () => {
  const resolved = resolveSnakeScoreSubmission({ name: "Legacy", score: 290 });
  const { data, result } = submitScore(testFile, "Legacy", resolved.score);
  assert.strictEqual(result.score, 290);
  assert.strictEqual(data.leaderboard[0].level, undefined);
});

runTest("new level 1-4 accepted and stored on personal best", () => {
  const resolved = resolveSnakeScoreSubmission({
    name: "Ada",
    score: 400,
    mangoCount: 5,
    bonusMangoesEaten: 1,
    level: 4,
  });
  const { data } = submitScore(testFile, "Ada", resolved.score, {
    level: resolved.level,
    mangoCount: resolved.mangoCount,
  });
  assert.strictEqual(data.leaderboard[0].score, 400);
  assert.strictEqual(data.leaderboard[0].level, 4);
  assert.strictEqual(data.leaderboard[0].mangoCount, 5);
});

runTest("invalid level is rejected before write", () => {
  const resolved = resolveSnakeScoreSubmission({
    score: 40,
    mangoCount: 1,
    bonusMangoesEaten: 0,
    level: 8,
  });
  assert.strictEqual(resolved.error, "Invalid level.");
  assert.strictEqual(fs.existsSync(testFile), false);
});

runTest("tampered score is ignored and does not write", () => {
  const resolved = resolveSnakeScoreSubmission({
    score: 5000,
    mangoCount: 2,
    bonusMangoesEaten: 0,
    level: 1,
  });
  assert.strictEqual(resolved.error, "Invalid score.");
  assert.strictEqual(fs.existsSync(testFile), false);
});

runTest("one shared leaderboard: L1 and L4 compete by numeric score", () => {
  submitScore(testFile, "Alice", 420, { level: 4, mangoCount: 8 });
  submitScore(testFile, "Bob", 330, { level: 3, mangoCount: 8 });
  submitScore(testFile, "Charlie", 290, { level: 1, mangoCount: 24 });

  const board = getDisplayLeaderboard(testFile);
  assert.strictEqual(board.length, 3);
  assert.strictEqual(board[0].name, "Alice");
  assert.strictEqual(board[0].score, 420);
  assert.strictEqual(board[0].level, 4);
  assert.strictEqual(board[1].name, "Bob");
  assert.strictEqual(board[2].name, "Charlie");
  assert.strictEqual(board[2].level, 1);
});

runTest("legacy entries render without a level tag", () => {
  submitScore(testFile, "OldUser", 900);
  submitScore(testFile, "Ada", 400, { level: 4, mangoCount: 5 });
  const text = formatSnakeLeaderboardMessage(testFile, null);
  assert.match(text, /🐍 ManGo Snake Leaderboard/);
  assert.match(text, /OldUser — 900/);
  assert.doesNotMatch(text, /OldUser — 900 .L/);
  assert.match(text, /Ada — 400 pts 🔥 L4/);
  assert.ok(!text.includes("Level 4 leaderboard"));
});

runTest("old highscore records remain valid through migrate", () => {
  const migrated = migrateInMemory({
    globalHighScore: 730,
    name: "Kevin",
    updatedAt: "2026-07-27T10:00:00.000Z",
  });
  assert.strictEqual(migrated.leaderboard[0].score, 730);
  assert.strictEqual(migrated.leaderboard[0].level, undefined);
});

runTest("Snake XP stays +1 first UTC day and is not multiplied by level", () => {
  const first = awardSnakeGameXp(9, "Ada", pointsFile);
  const second = awardSnakeGameXp(9, "Ada", pointsFile);
  assert.strictEqual(first.xp.dailyPlay, 1);
  assert.strictEqual(first.xp.awarded, 1);
  assert.strictEqual(second.xp.awarded, 0);
  assert.strictEqual(second.xp.dailyPlay, 0);
  const data = loadPoints(pointsFile);
  assert.strictEqual(data.users["9"].points, 1);
});

runTest("Daily Quest still excludes Snake", () => {
  assert.ok(!GAME_SOURCES.includes("snake"));
  assert.ok(!GAME_SOURCES.includes("bounch"));
});

runTest("bot copy explains difficulties and keeps personal play link + highscore", () => {
  const built = buildSignedGameUrl(123, "snake", {
    secret: TEST_SECRET,
    now: 1_700_000_000,
  });
  const reply = buildSnakeReply(built.url);
  assert.match(reply, /🥭 Snake now has 4 difficulty levels/);
  assert.match(reply, /🥭 Classic/);
  assert.match(reply, /🧱 Walls/);
  assert.match(reply, /🎯 Center/);
  assert.match(reply, /🔥 Danger Zone/);
  assert.match(reply, /Harder levels have more obstacles/);
  assert.match(reply, /same leaderboard/);
  assert.match(reply, /No level unlocking/);
  assert.match(reply, /\/snakehighscore/);
  assert.ok(reply.includes(built.url));
  assert.match(HELP_MESSAGE, /Classic, Walls, Center, Danger Zone/);
  assert.match(HELP_MESSAGE, /One leaderboard/);
  assert.match(HELP_MESSAGE, /No unlocking/);
  assert.strictEqual(MENU_LABELS.SNAKE, "🎮 Play Snake");
});

runTest("no new member slash-command is required", () => {
  assert.match(HELP_MESSAGE, /\/snake\n/);
  assert.doesNotMatch(HELP_MESSAGE, /\/snakedifficulty/);
  assert.doesNotMatch(HELP_MESSAGE, /\/snakelevel/);
});

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll snake highscore-level tests passed.");
