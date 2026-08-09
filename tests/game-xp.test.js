/**
 * Game XP v1 tests — Snake/Bounch awards, highscore integration, mixed concurrency.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { createGameToken } = require("../utils/gameToken");
const {
  verifyOptionalGameIdentity,
} = require("../utils/gameIdentity");
const {
  submitScore,
  buildApiResponse,
  readScoresFile,
} = require("../services/snakeScores");
const bounchScores = require("../services/bounchScores");
const {
  loadPoints,
  mutatePoints,
  awardSnakeGameXp,
  awardBounchGameXp,
  awardDailyActivityPoint,
  awardTriggerPoints,
  getEffectiveWeeklyPoints,
  emptyGameXpPayload,
} = require("../services/points");

const TEST_SECRET = "test-game-xp-secret-do-not-use-in-prod";
const FIXED_NOW = 1_700_000_000;
const UID = "424242";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-game-xp-"));
const pointsFile = path.join(tempDir, "points.json");
const snakeFile = path.join(tempDir, "snake-highscores.json");
const bounchFile = path.join(tempDir, "bounch-highscores.json");
const concurrencyWorker = path.join(
  __dirname,
  "helpers",
  "game-xp-concurrency-worker.js"
);

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function resetPoints(contents = { users: {} }) {
  fs.writeFileSync(pointsFile, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function setGameDates(userId, patch) {
  mutatePoints((data) => {
    const id = String(userId);
    if (!data.users[id]) {
      data.users[id] = {
        points: 0,
        weeklyPoints: 0,
        weekId: todayUtc(),
        name: "T",
        triggerDate: null,
        triggersUsed: [],
        activityDate: null,
        game: {
          snakePlayDate: null,
          bounchPlayDate: null,
          bounchUnlockedMax: 0,
        },
      };
    }
    if (!data.users[id].game) {
      data.users[id].game = {
        snakePlayDate: null,
        bounchPlayDate: null,
        bounchUnlockedMax: 0,
      };
    }
    Object.assign(data.users[id].game, patch);
  }, pointsFile);
}

function publicXpFromAward(result) {
  if (!result || !result.xp) {
    return emptyGameXpPayload();
  }
  return {
    awarded: result.xp.awarded || 0,
    dailyPlay: result.xp.dailyPlay || 0,
    unlock: result.xp.unlock || 0,
  };
}

function tryAwardSnake(identity, name) {
  if (!identity || !identity.verified || !identity.uid) {
    return emptyGameXpPayload();
  }
  try {
    return publicXpFromAward(
      awardSnakeGameXp(identity.uid, name, pointsFile)
    );
  } catch {
    return emptyGameXpPayload();
  }
}

function tryAwardBounch(identity, name, level) {
  if (!identity || !identity.verified || !identity.uid) {
    return emptyGameXpPayload();
  }
  try {
    return publicXpFromAward(
      awardBounchGameXp(identity.uid, name, level, pointsFile)
    );
  } catch {
    return emptyGameXpPayload();
  }
}

/**
 * Mirrors highscore-server success path: save score first, then XP, then response.
 */
function simulateSnakeHighscore(body) {
  const identity = verifyOptionalGameIdentity(body.t, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const submission = submitScore(snakeFile, body.name, body.score);
  assert.ok(!submission.error, submission.error);

  const xp = tryAwardSnake(identity, body.name);
  const { data, result } = submission;
  const response = {
    ...buildApiResponse(data, {
      score: result.score,
      personalBestScore: result.personalBestScore,
      rank: result.rank,
      isNewGlobal: result.isNewGlobal,
      gamesPlayed: result.gamesPlayed,
      lastScore: result.lastScore,
      lastPlayedAt: result.lastPlayedAt,
      posted: false,
      personalBest: result.personalBest,
      personalBestImproved: result.personalBest,
      reason: "telegram_not_configured",
    }),
    identity: { verified: Boolean(identity.verified) },
    xp,
  };

  return { identity, submission, response, stored: readScoresFile(snakeFile) };
}

function simulateBounchHighscore(body) {
  const identity = verifyOptionalGameIdentity(body.t, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const submission = bounchScores.submitLevel(
    bounchFile,
    body.name,
    body.level
  );
  assert.ok(!submission.error, submission.error);

  const xp = tryAwardBounch(identity, body.name, body.level);
  const { data, result } = submission;
  const response = {
    ...bounchScores.buildApiResponse(data, {
      name: result.name,
      level: result.level,
      bestLevel: result.bestLevel,
      rank: result.rank,
      isNewGlobal: result.isNewGlobal,
      gamesPlayed: result.gamesPlayed,
      lastLevel: result.lastLevel,
      lastPlayedAt: result.lastPlayedAt,
      posted: false,
      personalBest: result.personalBest,
      personalBestImproved: result.personalBest,
      reason: "telegram_not_configured",
    }),
    identity: { verified: Boolean(identity.verified) },
    xp,
  };

  return {
    identity,
    submission,
    response,
    stored: bounchScores.readScoresFile(bounchFile),
  };
}

function sumAllPoints() {
  const data = loadPoints(pointsFile);
  return Object.values(data.users).reduce(
    (sum, user) => sum + (user.points || 0),
    0
  );
}

resetPoints();

runTest("1. Snake first day +1", () => {
  resetPoints();
  const result = awardSnakeGameXp(UID, "Ada", pointsFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.xp.awarded, 1);
  assert.strictEqual(result.xp.dailyPlay, 1);
  assert.strictEqual(result.xp.unlock, 0);
  assert.strictEqual(result.points, 1);
  assert.strictEqual(loadPoints(pointsFile).users[UID].game.snakePlayDate, todayUtc());
});

runTest("2. Snake second same day +0", () => {
  const result = awardSnakeGameXp(UID, "Ada", pointsFile);
  assert.strictEqual(result.awarded, false);
  assert.deepStrictEqual(result.xp, { awarded: 0, dailyPlay: 0, unlock: 0 });
  assert.strictEqual(result.points, 1);
});

runTest("3. Snake next day +1", () => {
  setGameDates(UID, { snakePlayDate: "2000-01-01" });
  const result = awardSnakeGameXp(UID, "Ada", pointsFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.xp.dailyPlay, 1);
  assert.strictEqual(result.points, 2);
});

runTest("4. Snake weekly +1", () => {
  resetPoints();
  const result = awardSnakeGameXp(UID, "Ada", pointsFile);
  const user = loadPoints(pointsFile).users[UID];
  assert.strictEqual(result.points, 1);
  assert.strictEqual(getEffectiveWeeklyPoints(user), 1);
});

runTest("5. Snake rank-up", () => {
  resetPoints({
    users: {
      [UID]: {
        points: 24,
        weeklyPoints: 0,
        weekId: todayUtc(),
        name: "Ada",
        triggerDate: null,
        triggersUsed: [],
        activityDate: null,
      },
    },
  });
  const result = awardSnakeGameXp(UID, "Ada", pointsFile);
  assert.strictEqual(result.points, 25);
  assert.strictEqual(result.rankUp, true);
  assert.strictEqual(result.rank.title, "Sprout");
});

runTest("6. Bounch L1 first day total +2", () => {
  resetPoints();
  const result = awardBounchGameXp(UID, "Ada", 1, pointsFile);
  assert.strictEqual(result.xp.dailyPlay, 1);
  assert.strictEqual(result.xp.unlock, 1);
  assert.strictEqual(result.xp.awarded, 2);
  assert.strictEqual(result.points, 2);
  assert.strictEqual(loadPoints(pointsFile).users[UID].game.bounchUnlockedMax, 1);
});

runTest("7. Bounch direct L4 total +5", () => {
  resetPoints();
  const result = awardBounchGameXp(UID, "Ada", 4, pointsFile);
  assert.strictEqual(result.xp.dailyPlay, 1);
  assert.strictEqual(result.xp.unlock, 4);
  assert.strictEqual(result.xp.awarded, 5);
  assert.strictEqual(result.points, 5);
  assert.strictEqual(loadPoints(pointsFile).users[UID].game.bounchUnlockedMax, 4);
});

runTest("8. repeated L4 same day +0", () => {
  const result = awardBounchGameXp(UID, "Ada", 4, pointsFile);
  assert.deepStrictEqual(result.xp, { awarded: 0, dailyPlay: 0, unlock: 0 });
  assert.strictEqual(result.points, 5);
});

runTest("9. L4 → L7 same day +3", () => {
  const result = awardBounchGameXp(UID, "Ada", 7, pointsFile);
  assert.strictEqual(result.xp.dailyPlay, 0);
  assert.strictEqual(result.xp.unlock, 3);
  assert.strictEqual(result.xp.awarded, 3);
  assert.strictEqual(result.points, 8);
  assert.strictEqual(loadPoints(pointsFile).users[UID].game.bounchUnlockedMax, 7);
});

runTest("10. next day L7 +1 daily", () => {
  setGameDates(UID, { bounchPlayDate: "2000-01-01", bounchUnlockedMax: 7 });
  const before = loadPoints(pointsFile).users[UID].points;
  const result = awardBounchGameXp(UID, "Ada", 7, pointsFile);
  assert.strictEqual(result.xp.dailyPlay, 1);
  assert.strictEqual(result.xp.unlock, 0);
  assert.strictEqual(result.xp.awarded, 1);
  assert.strictEqual(result.points, before + 1);
});

runTest("11. bounchUnlockedMax persists", () => {
  assert.strictEqual(loadPoints(pointsFile).users[UID].game.bounchUnlockedMax, 7);
  awardBounchGameXp(UID, "Ada", 7, pointsFile);
  assert.strictEqual(loadPoints(pointsFile).users[UID].game.bounchUnlockedMax, 7);
});

runTest("12. old user without game object works", () => {
  resetPoints({
    users: {
      [UID]: {
        points: 3,
        weeklyPoints: 1,
        weekId: todayUtc(),
        name: "Legacy",
      },
    },
  });
  const result = awardSnakeGameXp(UID, "Legacy", pointsFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 4);
  assert.ok(loadPoints(pointsFile).users[UID].game);
  assert.strictEqual(loadPoints(pointsFile).users[UID].game.snakePlayDate, todayUtc());
});

runTest("13. invalid Bounch levels rejected safely", () => {
  resetPoints();
  for (const level of [0, 8, 3.5, "4", null, undefined, -1]) {
    const result = awardBounchGameXp(UID, "Ada", level, pointsFile);
    assert.strictEqual(result.awarded, false);
    assert.deepStrictEqual(result.xp, emptyGameXpPayload());
  }
  assert.deepStrictEqual(loadPoints(pointsFile), { users: {} });
});

runTest("14. rank-up on multi-XP award", () => {
  resetPoints({
    users: {
      [UID]: {
        points: 74,
        weeklyPoints: 0,
        weekId: todayUtc(),
        name: "Ada",
      },
    },
  });
  const result = awardBounchGameXp(UID, "Ada", 4, pointsFile);
  assert.strictEqual(result.points, 79);
  assert.strictEqual(result.xp.awarded, 5);
  assert.strictEqual(result.rankUp, true);
  assert.strictEqual(result.rank.title, "Tree");
});

runTest("15. unverified highscore submit → XP 0", () => {
  resetPoints();
  if (fs.existsSync(snakeFile)) fs.unlinkSync(snakeFile);
  const { response, stored } = simulateSnakeHighscore({
    name: "Guest",
    score: 10,
  });
  assert.strictEqual(response.identity.verified, false);
  assert.deepStrictEqual(response.xp, emptyGameXpPayload());
  assert.ok(stored.leaderboard.length >= 1);
  assert.deepStrictEqual(loadPoints(pointsFile), { users: {} });
});

runTest("16. verified Snake highscore → XP expected", () => {
  resetPoints();
  if (fs.existsSync(snakeFile)) fs.unlinkSync(snakeFile);
  const token = createGameToken(UID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { response } = simulateSnakeHighscore({
    name: "Ada",
    score: 42,
    t: token,
  });
  assert.strictEqual(response.identity.verified, true);
  assert.deepStrictEqual(response.xp, { awarded: 1, dailyPlay: 1, unlock: 0 });
  assert.strictEqual(loadPoints(pointsFile).users[UID].points, 1);
  assert.ok(!JSON.stringify(response).includes(UID));
});

runTest("17. verified Bounch highscore → XP expected", () => {
  resetPoints();
  if (fs.existsSync(bounchFile)) fs.unlinkSync(bounchFile);
  const token = createGameToken(UID, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { response } = simulateBounchHighscore({
    name: "Ada",
    level: 1,
    t: token,
  });
  assert.strictEqual(response.identity.verified, true);
  assert.deepStrictEqual(response.xp, { awarded: 2, dailyPlay: 1, unlock: 1 });
  assert.strictEqual(loadPoints(pointsFile).users[UID].points, 2);
});

runTest("18. body uid spoofing irrelevant", () => {
  resetPoints();
  if (fs.existsSync(snakeFile)) fs.unlinkSync(snakeFile);
  const token = createGameToken(UID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  simulateSnakeHighscore({
    name: "Ada",
    score: 11,
    t: token,
    uid: "999999",
    telegramUserId: "999999",
  });
  const data = loadPoints(pointsFile);
  assert.ok(data.users[UID]);
  assert.ok(!data.users["999999"]);
});

runTest("19. token not stored in points.json", () => {
  resetPoints();
  if (fs.existsSync(snakeFile)) fs.unlinkSync(snakeFile);
  const token = createGameToken(UID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  simulateSnakeHighscore({ name: "Ada", score: 12, t: token });
  const raw = fs.readFileSync(pointsFile, "utf8");
  assert.ok(!raw.includes(token));
  assert.ok(!raw.includes(TEST_SECRET));
  assert.ok(!raw.includes('"t"'));
});

runTest("20. mixed cross-process chat + game award loses no updates", () => {
  resetPoints();
  const count = 40;
  const coordinator = `
    const { spawn } = require('child_process');
    const worker = ${JSON.stringify(concurrencyWorker)};
    const file = ${JSON.stringify(pointsFile)};
    const n = ${count};
    function run(mode, base) {
      return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [worker, file, mode, String(n), String(base)], {
          stdio: 'inherit',
        });
        c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(mode + ' exit ' + code))));
        c.on('error', reject);
      });
    }
    Promise.all([run('trigger', 1000), run('snake', 2000)])
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  `;

  const result = spawnSync(process.execPath, ["-e", coordinator], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  // trigger gmango = +2 each × 40; snake = +1 each × 40
  assert.strictEqual(sumAllPoints(), count * 2 + count * 1);
});

runTest("21. XP failure does not invalidate valid score submit", () => {
  if (fs.existsSync(snakeFile)) fs.unlinkSync(snakeFile);
  const token = createGameToken(UID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const identity = verifyOptionalGameIdentity(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  assert.strictEqual(identity.verified, true);

  const submission = submitScore(snakeFile, "Ada", 99);
  assert.ok(!submission.error);

  const missingDir = path.join(tempDir, "missing-points-dir", "points.json");
  let xp;
  try {
    awardSnakeGameXp(identity.uid, "Ada", missingDir);
    xp = { awarded: 1, dailyPlay: 1, unlock: 0 };
  } catch {
    xp = emptyGameXpPayload();
  }

  assert.deepStrictEqual(xp, emptyGameXpPayload());
  const stored = readScoresFile(snakeFile);
  assert.ok(stored.leaderboard.some((row) => row.score === 99));
  assert.strictEqual(submission.result.score, 99);
});

// Control: activity still works alongside game helpers in-process
runTest("control: activity + snake same user accumulate", () => {
  resetPoints();
  assert.strictEqual(awardDailyActivityPoint(UID, "Ada", pointsFile).points, 1);
  assert.strictEqual(awardSnakeGameXp(UID, "Ada", pointsFile).points, 2);
  assert.strictEqual(awardTriggerPoints(UID, "Ada", "gm", pointsFile).points, 3);
});

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll game-xp tests passed.");
