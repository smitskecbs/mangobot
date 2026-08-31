/**
 * Owner (ADMIN_USER_ID) participates on public XP boards.
 * Snake/Bounch: telegramUserId from signed game identity only — never name filter.
 * Run: node tests/leaderboard-privacy.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const {
  shouldHideFromLeaderboards,
  shouldHideScoreLeaderboardEntry,
} = require("../utils/admin");
const {
  applyVerifiedTelegramUserId,
  normalizeVerifiedTelegramUserId,
} = require("../utils/scoreIdentity");
const {
  getLifetimeTop,
  getWeeklyTop,
  formatLifetimeLines,
  formatWeeklyLines,
} = require("../services/leaderboard");
const {
  savePoints,
  loadPoints,
  awardDailyActivityPoint,
  awardTriggerPoints,
  getRank,
  getEffectiveWeeklyPoints,
} = require("../services/points");
const { handleLeaderboard } = require("../commands/leaderboard");
const { handleWeekly } = require("../commands/weekly");
const { handlePoints } = require("../commands/points");
const {
  formatSnakeLeaderboardMessage,
} = require("../services/snakeLeaderboard");
const {
  formatBounchLeaderboardMessage,
} = require("../services/bounchLeaderboard");
const {
  writeScoresFile,
  createEmptyScores,
  submitScore,
  getDisplayLeaderboard: getSnakeDisplay,
  readScoresFile: readSnakeScores,
} = require("../services/snakeScores");
const bounchScores = require("../services/bounchScores");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-lb-privacy-"));
const pointsFile = path.join(tempDir, "points.json");
const snakeFile = path.join(tempDir, "snake-highscores.json");
const bounchFile = path.join(tempDir, "bounch-highscores.json");

const OWNER_ID = "999001";
const ALICE_ID = "111";
const BOB_ID = "222";
const OTHER_ID = "333";

const originalAdmin = process.env.ADMIN_USER_ID;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function restoreAdminEnv() {
  if (originalAdmin === undefined) {
    delete process.env.ADMIN_USER_ID;
  } else {
    process.env.ADMIN_USER_ID = originalAdmin;
  }
}

function seedPoints() {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  const weekId = new Date(Date.UTC(now.getUTCFullYear(), now.getMonth(), diff))
    .toISOString()
    .slice(0, 10);
  savePoints(
    {
      users: {
        [OWNER_ID]: {
          points: 500,
          weeklyPoints: 50,
          weekId,
          name: "Kevin",
          triggerDate: null,
          triggersUsed: [],
          activityDate: null,
        },
        [ALICE_ID]: {
          points: 200,
          weeklyPoints: 30,
          weekId,
          name: "Alice",
          triggerDate: null,
          triggersUsed: [],
          activityDate: null,
        },
        [BOB_ID]: {
          points: 100,
          weeklyPoints: 10,
          weekId,
          name: "Bob",
          triggerDate: null,
          triggersUsed: [],
          activityDate: null,
        },
      },
    },
    pointsFile
  );
}

function createMockCtx({
  userId = ALICE_ID,
  firstName = "Alice",
  chatType = "group",
} = {}) {
  const replies = [];
  return {
    chat: { type: chatType },
    from: { id: Number(userId), first_name: firstName },
    replies,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve();
    },
  };
}

process.env.ADMIN_USER_ID = OWNER_ID;
seedPoints();

runTest("1. owner uid zichtbaar op lifetime", () => {
  const top = getLifetimeTop(loadPoints(pointsFile).users);
  assert.deepStrictEqual(
    top.map((u) => u.name),
    ["Kevin", "Alice", "Bob"]
  );
  const lines = formatLifetimeLines(top, getRank);
  assert.ok(lines[0].startsWith("🥇 Kevin"));
  assert.ok(lines.some((l) => l.includes("Alice")));
});

runTest("2. owner uid zichtbaar op weekly", () => {
  const top = getWeeklyTop(
    loadPoints(pointsFile).users,
    getEffectiveWeeklyPoints
  );
  assert.deepStrictEqual(
    top.map((u) => u.name),
    ["Kevin", "Alice", "Bob"]
  );
  assert.ok(formatWeeklyLines(top)[0].startsWith("🥇 Kevin"));
});

runTest("3. verified owner uid blijft zichtbaar op Snake", () => {
  writeScoresFile(snakeFile, {
    ...createEmptyScores(),
    globalHighScore: 900,
    globalHighScoreName: "OwnerAlias",
    leaderboard: [
      {
        name: "OwnerAlias",
        score: 900,
        lastScore: 900,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T12:00:00.000Z",
        lastPlayedAt: "2026-08-09T12:00:00.000Z",
        telegramUserId: OWNER_ID,
      },
      {
        name: "Alice",
        score: 500,
        lastScore: 500,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T11:00:00.000Z",
        lastPlayedAt: "2026-08-09T11:00:00.000Z",
        telegramUserId: ALICE_ID,
      },
    ],
  });
  const display = getSnakeDisplay(snakeFile, 10);
  assert.deepStrictEqual(
    display.map((e) => e.name),
    ["OwnerAlias", "Alice"]
  );
  const text = formatSnakeLeaderboardMessage(snakeFile, "ManGoTestBot");
  assert.ok(text.includes("🥇 OwnerAlias — 900"));
  assert.ok(text.includes("Alice"));
});

runTest("4. verified owner uid blijft zichtbaar op Bounch", () => {
  bounchScores.writeScoresFile(bounchFile, {
    ...bounchScores.createEmptyScores(),
    globalBestLevel: 7,
    globalBestLevelName: "OwnerAlias",
    leaderboard: [
      {
        name: "OwnerAlias",
        bestLevel: 7,
        lastLevel: 7,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T12:00:00.000Z",
        lastPlayedAt: "2026-08-09T12:00:00.000Z",
        telegramUserId: OWNER_ID,
      },
      {
        name: "Alice",
        bestLevel: 5,
        lastLevel: 5,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T11:00:00.000Z",
        lastPlayedAt: "2026-08-09T11:00:00.000Z",
        telegramUserId: ALICE_ID,
      },
    ],
  });
  const display = bounchScores.getDisplayLeaderboard(bounchFile, 10);
  assert.deepStrictEqual(
    display.map((e) => e.name),
    ["OwnerAlias", "Alice"]
  );
  const text = formatBounchLeaderboardMessage(bounchFile, "ManGoTestBot");
  assert.ok(text.includes("OwnerAlias"));
  assert.ok(text.includes("Alice"));
});

runTest("5. andere speler met exact dezelfde display name blijft zichtbaar", () => {
  writeScoresFile(snakeFile, {
    ...createEmptyScores(),
    globalHighScore: 800,
    globalHighScoreName: "Kevin",
    leaderboard: [
      {
        name: "Kevin",
        score: 800,
        lastScore: 800,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T12:00:00.000Z",
        lastPlayedAt: "2026-08-09T12:00:00.000Z",
        telegramUserId: OTHER_ID,
      },
    ],
  });
  assert.strictEqual(shouldHideScoreLeaderboardEntry({
    name: "Kevin",
    telegramUserId: OTHER_ID,
  }), false);
  const display = getSnakeDisplay(snakeFile, 10);
  assert.strictEqual(display[0].name, "Kevin");
});

runTest("6. eigenaar met andere game display name blijft zichtbaar via uid", () => {
  assert.strictEqual(
    shouldHideScoreLeaderboardEntry({
      name: "TotallyDifferent",
      telegramUserId: OWNER_ID,
    }),
    false
  );
});

runTest("7. unverified body telegramUserId kan owner-filter niet spoofen", () => {
  // Unverified submit must not attach body-claimed owner uid.
  writeScoresFile(snakeFile, createEmptyScores());
  submitScore(snakeFile, "Spoof", 100, {
    verifiedTelegramUserId: undefined,
  });
  // Even if attacker tries to pass uid via a fake option that mirrors body — server
  // only passes identity.uid. Simulate: no verified uid → no field.
  let data = readSnakeScores(snakeFile);
  assert.strictEqual(data.leaderboard[0].telegramUserId, undefined);

  // Client-looking spoof value must not be written unless passed as verified option;
  // highscore-server never forwards body.telegramUserId. Confirm filter ignores name.
  data.leaderboard[0].name = "Kevin";
  writeScoresFile(snakeFile, data);
  assert.strictEqual(shouldHideScoreLeaderboardEntry(data.leaderboard[0]), false);
  assert.strictEqual(getSnakeDisplay(snakeFile, 10)[0].name, "Kevin");
});

runTest("8. oude Snake entry zonder telegramUserId blijft geldig", () => {
  writeScoresFile(snakeFile, {
    ...createEmptyScores(),
    globalHighScore: 50,
    globalHighScoreName: "Legacy",
    leaderboard: [
      {
        name: "Legacy",
        score: 50,
        lastScore: 50,
        gamesPlayed: 1,
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastPlayedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
  const display = getSnakeDisplay(snakeFile, 10);
  assert.strictEqual(display.length, 1);
  assert.strictEqual(display[0].name, "Legacy");
});

runTest("9. oude Bounch entry zonder telegramUserId blijft geldig", () => {
  bounchScores.writeScoresFile(bounchFile, {
    ...bounchScores.createEmptyScores(),
    globalBestLevel: 3,
    globalBestLevelName: "Legacy",
    leaderboard: [
      {
        name: "Legacy",
        bestLevel: 3,
        lastLevel: 3,
        gamesPlayed: 1,
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastPlayedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
  const display = bounchScores.getDisplayLeaderboard(bounchFile, 10);
  assert.strictEqual(display.length, 1);
  assert.strictEqual(display[0].name, "Legacy");
});

runTest("10. verified submit kan veilige uid koppeling toevoegen", () => {
  writeScoresFile(snakeFile, {
    ...createEmptyScores(),
    globalHighScore: 40,
    globalHighScoreName: "LinkMe",
    leaderboard: [
      {
        name: "LinkMe",
        score: 40,
        lastScore: 40,
        gamesPlayed: 1,
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastPlayedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
  const { data } = submitScore(snakeFile, "LinkMe", 45, {
    verifiedTelegramUserId: OWNER_ID,
  });
  assert.strictEqual(data.leaderboard[0].telegramUserId, OWNER_ID);
  assert.strictEqual(data.leaderboard[0].score, 45);
  assert.strictEqual(getSnakeDisplay(snakeFile, 10)[0].name, "LinkMe");
});

runTest("11. bestaande andere verified uid wordt niet blind overschreven", () => {
  writeScoresFile(snakeFile, createEmptyScores());
  submitScore(snakeFile, "SharedName", 100, {
    verifiedTelegramUserId: ALICE_ID,
  });
  const { data } = submitScore(snakeFile, "SharedName", 120, {
    verifiedTelegramUserId: OWNER_ID,
  });
  assert.strictEqual(data.leaderboard[0].telegramUserId, ALICE_ID);
  assert.strictEqual(data.leaderboard[0].score, 120);
  // Still visible (Alice's uid, not owner)
  assert.strictEqual(getSnakeDisplay(snakeFile, 10)[0].name, "SharedName");

  const conflict = applyVerifiedTelegramUserId(
    { telegramUserId: ALICE_ID },
    OWNER_ID
  );
  assert.strictEqual(conflict.conflict, true);
  assert.strictEqual(
    normalizeVerifiedTelegramUserId(ALICE_ID),
    ALICE_ID
  );
});

runTest("12. /points voor eigenaar blijft werken", () => {
  const ctx = createMockCtx({
    userId: OWNER_ID,
    firstName: "Kevin",
    chatType: "private",
  });
  handlePoints(ctx, { pointsFile });
  assert.ok(ctx.replies[0].text.includes("500") || ctx.replies[0].text.length > 10);
});

runTest("13. owner kan community competition XP verdienen", () => {
  const before = loadPoints(pointsFile).users[OWNER_ID].points;
  assert.strictEqual(
    awardDailyActivityPoint(OWNER_ID, "Kevin", pointsFile).awarded,
    true
  );
  assert.strictEqual(
    awardTriggerPoints(OWNER_ID, "Kevin", "gm", pointsFile).awarded,
    true
  );
  assert.ok(loadPoints(pointsFile).users[OWNER_ID].points > before);
});

runTest("14. ranks include owner without hiding", () => {
  const ctxLb = createMockCtx();
  handleLeaderboard(ctxLb, { pointsFile });
  assert.ok(ctxLb.replies[0].text.includes("Kevin"));
  assert.ok(ctxLb.replies[0].text.includes("Alice"));

  const ctxW = createMockCtx();
  handleWeekly(ctxW, { pointsFile });
  assert.ok(ctxW.replies[0].text.includes("Kevin"));

  assert.strictEqual(shouldHideFromLeaderboards(OWNER_ID), false);
  assert.strictEqual(shouldHideFromLeaderboards(ALICE_ID), false);
});

runTest("bounch verified uid attach + conflict same as snake", () => {
  bounchScores.writeScoresFile(bounchFile, bounchScores.createEmptyScores());
  bounchScores.submitLevel(bounchFile, "BounceMe", 2, {
    verifiedTelegramUserId: ALICE_ID,
  });
  const { data } = bounchScores.submitLevel(bounchFile, "BounceMe", 4, {
    verifiedTelegramUserId: OWNER_ID,
  });
  assert.strictEqual(data.leaderboard[0].telegramUserId, ALICE_ID);
  assert.strictEqual(data.leaderboard[0].bestLevel, 4);
});

runTest("15. legacy Snake Kevin visible after owner verified submit links uid", () => {
  writeScoresFile(snakeFile, {
    ...createEmptyScores(),
    globalHighScore: 777,
    globalHighScoreName: "Kevin",
    leaderboard: [
      {
        name: "Kevin",
        score: 777,
        lastScore: 777,
        gamesPlayed: 3,
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastPlayedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
  assert.strictEqual(getSnakeDisplay(snakeFile, 10)[0].name, "Kevin");

  const { data } = submitScore(snakeFile, "Kevin", 780, {
    verifiedTelegramUserId: OWNER_ID,
  });
  assert.strictEqual(data.leaderboard[0].telegramUserId, OWNER_ID);
  assert.strictEqual(getSnakeDisplay(snakeFile, 10)[0].name, "Kevin");
});

runTest("16. legacy Bounch Kevin links then stays visible", () => {
  bounchScores.writeScoresFile(bounchFile, {
    ...bounchScores.createEmptyScores(),
    globalBestLevel: 5,
    globalBestLevelName: "Kevin",
    leaderboard: [
      {
        name: "Kevin",
        bestLevel: 5,
        lastLevel: 5,
        gamesPlayed: 2,
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastPlayedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
  assert.strictEqual(
    bounchScores.getDisplayLeaderboard(bounchFile, 10)[0].name,
    "Kevin"
  );
  const submitted = bounchScores.submitLevel(bounchFile, "Kevin", 6, {
    verifiedTelegramUserId: OWNER_ID,
  });
  assert.ok(!submitted.error, submitted.error);
  assert.strictEqual(submitted.data.leaderboard[0].telegramUserId, OWNER_ID);
  assert.strictEqual(
    bounchScores.getDisplayLeaderboard(bounchFile, 10)[0].name,
    "Kevin"
  );
});

runTest("17. other Kevin with other verified uid stays visible after owner link", () => {
  writeScoresFile(snakeFile, {
    ...createEmptyScores(),
    globalHighScore: 900,
    globalHighScoreName: "Kevin",
    leaderboard: [
      {
        name: "Kevin",
        score: 900,
        lastScore: 900,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T12:00:00.000Z",
        lastPlayedAt: "2026-08-09T12:00:00.000Z",
        telegramUserId: OTHER_ID,
      },
      {
        name: "OwnerKev",
        score: 850,
        lastScore: 850,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T11:00:00.000Z",
        lastPlayedAt: "2026-08-09T11:00:00.000Z",
        telegramUserId: OWNER_ID,
      },
    ],
  });
  const display = getSnakeDisplay(snakeFile, 10);
  assert.deepStrictEqual(
    display.map((e) => e.name),
    ["Kevin", "OwnerKev"]
  );
  const stored = readSnakeScores(snakeFile).leaderboard.find(
    (e) => e.name === "Kevin"
  );
  assert.strictEqual(stored.telegramUserId, OTHER_ID);
  assert.strictEqual(
    shouldHideScoreLeaderboardEntry(stored),
    false
  );
});

runTest("18. name-dedupe preserves verified uid when higher score is legacy", () => {
  writeScoresFile(snakeFile, {
    ...createEmptyScores(),
    leaderboard: [
      {
        name: "Kevin",
        score: 100,
        lastScore: 100,
        gamesPlayed: 1,
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastPlayedAt: "2026-08-01T00:00:00.000Z",
        telegramUserId: OWNER_ID,
      },
      {
        name: "kevin",
        score: 200,
        lastScore: 200,
        gamesPlayed: 1,
        updatedAt: "2026-08-02T00:00:00.000Z",
        lastPlayedAt: "2026-08-02T00:00:00.000Z",
      },
    ],
  });
  // Re-read via submit that triggers normalize, or read+write path
  const raw = readSnakeScores(snakeFile);
  assert.strictEqual(raw.leaderboard.length, 1);
  assert.strictEqual(raw.leaderboard[0].score, 200);
  assert.strictEqual(raw.leaderboard[0].telegramUserId, OWNER_ID);
  assert.strictEqual(getSnakeDisplay(snakeFile, 10)[0].score, 200);
  assert.strictEqual(getSnakeDisplay(snakeFile, 10)[0].name, "kevin");
});

restoreAdminEnv();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll leaderboard-privacy tests passed.");
