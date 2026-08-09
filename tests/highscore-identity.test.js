/**
 * Optional game-token identity on highscore submits.
 * Uses fixed secret/now and temp score files — never touches production data.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("node:crypto");

const { createGameToken } = require("../utils/gameToken");
const {
  verifyOptionalGameIdentity,
  withIdentity,
} = require("../utils/gameIdentity");
const {
  submitScore,
  buildApiResponse,
  readScoresFile,
} = require("../services/snakeScores");
const bounchScores = require("../services/bounchScores");

const TEST_SECRET = "test-highscore-identity-secret-do-not-use-in-prod";
const FIXED_NOW = 1_700_000_000;
const TOKEN_UID = "123456";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-highscore-identity-"));
const snakeFile = path.join(tempDir, "snake-highscores.json");
const bounchFile = path.join(tempDir, "bounch-highscores.json");

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function resetFiles() {
  for (const file of [snakeFile, bounchFile]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function tokenOptions(extra = {}) {
  return {
    secret: TEST_SECRET,
    now: FIXED_NOW,
    ...extra,
  };
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function tamperToken(token) {
  const [payloadPart, signaturePart] = token.split(".");
  const flipped = signaturePart.endsWith("A")
    ? `${signaturePart.slice(0, -1)}B`
    : `${signaturePart.slice(0, -1)}A`;
  return `${payloadPart}.${flipped}`;
}

function craftExpiredToken(game) {
  return createGameToken(TOKEN_UID, game, {
    secret: TEST_SECRET,
    now: FIXED_NOW - 100_000,
    ttlSeconds: 60,
  });
}

/**
 * Mirrors highscore-server Snake success path (score save + identity meta).
 * Does not touch points.json or Telegram.
 */
function simulateSnakeSubmit(body, verifyOptions = tokenOptions()) {
  const identity = verifyOptionalGameIdentity(body.t, "snake", verifyOptions);
  const submission = submitScore(snakeFile, body.name, body.score);

  assert.ok(!submission.error, submission.error);

  const { data, result } = submission;
  const response = withIdentity(
    buildApiResponse(data, {
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
      reason: result.personalBest ? "telegram_not_configured" : "not_personal_best",
    }),
    identity
  );

  return { identity, submission, response, stored: readScoresFile(snakeFile) };
}

/**
 * Mirrors highscore-server Bounch success path (level save + identity meta).
 */
function simulateBounchSubmit(body, verifyOptions = tokenOptions()) {
  const identity = verifyOptionalGameIdentity(body.t, "bounch", verifyOptions);
  const submission = bounchScores.submitLevel(bounchFile, body.name, body.level);

  assert.ok(!submission.error, submission.error);

  const { data, result } = submission;
  const response = withIdentity(
    bounchScores.buildApiResponse(data, {
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
      reason: result.personalBest ? "telegram_not_configured" : "not_personal_best",
    }),
    identity
  );

  return {
    identity,
    submission,
    response,
    stored: bounchScores.readScoresFile(bounchFile),
  };
}

function assertPublicIdentityOnly(response) {
  assert.ok(response.identity);
  assert.strictEqual(typeof response.identity.verified, "boolean");
  assert.strictEqual(Object.keys(response.identity).length, 1);
  assert.strictEqual(response.identity.uid, undefined);
  assert.ok(!("uid" in response));
  assert.ok(!("telegramUserId" in response));
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes(`"uid"`));
  assert.ok(!serialized.includes(TOKEN_UID));
}

function assertLegacySnakeFields(response) {
  assert.strictEqual(response.ok, true);
  assert.ok("posted" in response);
  assert.ok("personalBest" in response);
  assert.ok("score" in response);
  assert.ok("personalBestScore" in response);
  assert.ok("rank" in response);
  assert.ok("leaderboard" in response);
  assert.ok("gamesPlayed" in response);
  assert.ok("lastScore" in response);
  assert.ok("lastPlayedAt" in response);
}

function assertLegacyBounchFields(response) {
  assert.strictEqual(response.ok, true);
  assert.ok("posted" in response);
  assert.ok("personalBest" in response);
  assert.ok("name" in response);
  assert.ok("level" in response);
  assert.ok("bestLevel" in response);
  assert.ok("rank" in response);
  assert.ok("leaderboard" in response);
  assert.ok("gamesPlayed" in response);
  assert.ok("lastLevel" in response);
  assert.ok("lastPlayedAt" in response);
}

function assertStorageHasNoToken(stored) {
  const serialized = JSON.stringify(stored);
  assert.ok(!serialized.includes('"t"'));
  assert.ok(!/"token"/i.test(serialized));
  assert.ok(!serialized.includes(TEST_SECRET));
}

// --- Pure helper smoke ---

runTest("verifyOptionalGameIdentity: empty/missing → unverified", () => {
  assert.deepStrictEqual(verifyOptionalGameIdentity(undefined, "snake", tokenOptions()), {
    verified: false,
  });
  assert.deepStrictEqual(verifyOptionalGameIdentity("", "snake", tokenOptions()), {
    verified: false,
  });
  assert.deepStrictEqual(verifyOptionalGameIdentity(null, "snake", tokenOptions()), {
    verified: false,
  });
});

runTest("withIdentity never exposes uid", () => {
  const response = withIdentity({ ok: true }, { verified: true, uid: TOKEN_UID });
  assert.deepStrictEqual(response.identity, { verified: true });
  assert.strictEqual(response.identity.uid, undefined);
});

// --- SNAKE 1–5 ---

runTest("1. Snake submit without t → accepted + identity.verified false", () => {
  resetFiles();
  const { response, submission } = simulateSnakeSubmit({
    name: "PlayerOne",
    score: 42,
  });

  assert.strictEqual(submission.result.score, 42);
  assert.strictEqual(response.identity.verified, false);
  assertPublicIdentityOnly(response);
  assertLegacySnakeFields(response);
});

runTest("2. Snake valid token → accepted + identity.verified true", () => {
  resetFiles();
  const t = createGameToken(TOKEN_UID, "snake", tokenOptions());
  const { identity, response, submission } = simulateSnakeSubmit({
    name: "PlayerTwo",
    score: 55,
    t,
  });

  assert.strictEqual(submission.result.score, 55);
  assert.strictEqual(identity.verified, true);
  assert.strictEqual(identity.uid, TOKEN_UID);
  assert.strictEqual(response.identity.verified, true);
  assertPublicIdentityOnly(response);
});

runTest("3. Bounch token on Snake → accepted + false", () => {
  resetFiles();
  const t = createGameToken(TOKEN_UID, "bounch", tokenOptions());
  const { response, submission } = simulateSnakeSubmit({
    name: "PlayerThree",
    score: 10,
    t,
  });

  assert.strictEqual(submission.result.score, 10);
  assert.strictEqual(response.identity.verified, false);
});

runTest("4. Snake tampered token → accepted + false", () => {
  resetFiles();
  const t = tamperToken(createGameToken(TOKEN_UID, "snake", tokenOptions()));
  const { response, submission } = simulateSnakeSubmit({
    name: "PlayerFour",
    score: 11,
    t,
  });

  assert.strictEqual(submission.result.score, 11);
  assert.strictEqual(response.identity.verified, false);
});

runTest("5. Snake expired token → accepted + false", () => {
  resetFiles();
  const t = craftExpiredToken("snake");
  const { response, submission } = simulateSnakeSubmit(
    {
      name: "PlayerFive",
      score: 12,
      t,
    },
    tokenOptions()
  );

  assert.strictEqual(submission.result.score, 12);
  assert.strictEqual(response.identity.verified, false);
});

// --- BOUNCH 6–10 ---

runTest("6. Bounch submit without t → accepted + false", () => {
  resetFiles();
  const { response, submission } = simulateBounchSubmit({
    name: "BouncerOne",
    level: 3,
  });

  assert.strictEqual(submission.result.level, 3);
  assert.strictEqual(response.identity.verified, false);
  assertPublicIdentityOnly(response);
  assertLegacyBounchFields(response);
});

runTest("7. Bounch valid token → accepted + true", () => {
  resetFiles();
  const t = createGameToken(TOKEN_UID, "bounch", tokenOptions());
  const { identity, response, submission } = simulateBounchSubmit({
    name: "BouncerTwo",
    level: 7,
    t,
  });

  assert.strictEqual(submission.result.level, 7);
  assert.strictEqual(identity.verified, true);
  assert.strictEqual(identity.uid, TOKEN_UID);
  assert.strictEqual(response.identity.verified, true);
  assertPublicIdentityOnly(response);
});

runTest("8. Snake token on Bounch → accepted + false", () => {
  resetFiles();
  const t = createGameToken(TOKEN_UID, "snake", tokenOptions());
  const { response, submission } = simulateBounchSubmit({
    name: "BouncerThree",
    level: 2,
    t,
  });

  assert.strictEqual(submission.result.level, 2);
  assert.strictEqual(response.identity.verified, false);
});

runTest("9. Bounch tampered token → accepted + false", () => {
  resetFiles();
  const t = tamperToken(createGameToken(TOKEN_UID, "bounch", tokenOptions()));
  const { response, submission } = simulateBounchSubmit({
    name: "BouncerFour",
    level: 4,
    t,
  });

  assert.strictEqual(submission.result.level, 4);
  assert.strictEqual(response.identity.verified, false);
});

runTest("10. Bounch expired token → accepted + false", () => {
  resetFiles();
  const t = craftExpiredToken("bounch");
  const { response, submission } = simulateBounchSubmit({
    name: "BouncerFive",
    level: 5,
    t,
  });

  assert.strictEqual(submission.result.level, 5);
  assert.strictEqual(response.identity.verified, false);
});

// --- SECURITY / BACKCOMPAT 11–15 ---

runTest("11. body uid / telegramUserId are ignored", () => {
  resetFiles();

  const withoutToken = simulateSnakeSubmit({
    name: "Spoof",
    score: 9,
    uid: "999999",
    telegramUserId: "888888",
  });
  assert.strictEqual(withoutToken.identity.verified, false);
  assert.strictEqual(withoutToken.identity.uid, undefined);

  const t = createGameToken(TOKEN_UID, "snake", tokenOptions());
  const withToken = simulateSnakeSubmit({
    name: "SpoofTwo",
    score: 8,
    t,
    uid: "999999",
    telegramUserId: "888888",
  });
  assert.strictEqual(withToken.identity.verified, true);
  assert.strictEqual(withToken.identity.uid, TOKEN_UID);
  assertPublicIdentityOnly(withToken.response);
});

runTest("12. missing GAME_LINK_SECRET does not block submit", () => {
  resetFiles();
  const t = createGameToken(TOKEN_UID, "snake", tokenOptions());
  const snake = simulateSnakeSubmit(
    {
      name: "NoSecret",
      score: 21,
      t,
    },
    { secret: "", now: FIXED_NOW }
  );

  assert.strictEqual(snake.submission.result.score, 21);
  assert.strictEqual(snake.response.identity.verified, false);

  const bt = createGameToken(TOKEN_UID, "bounch", tokenOptions());
  const bounch = simulateBounchSubmit(
    {
      name: "NoSecretB",
      level: 6,
      t: bt,
    },
    { secret: "", now: FIXED_NOW }
  );

  assert.strictEqual(bounch.submission.result.level, 6);
  assert.strictEqual(bounch.response.identity.verified, false);
});

runTest("13. response never contains uid", () => {
  resetFiles();
  const t = createGameToken(TOKEN_UID, "snake", tokenOptions());
  const snake = simulateSnakeSubmit({ name: "UidCheck", score: 33, t });
  assertPublicIdentityOnly(snake.response);

  const bt = createGameToken(TOKEN_UID, "bounch", tokenOptions());
  const bounch = simulateBounchSubmit({ name: "UidCheckB", level: 7, t: bt });
  assertPublicIdentityOnly(bounch.response);
});

runTest("14. token is not part of score storage", () => {
  resetFiles();
  const t = createGameToken(TOKEN_UID, "snake", tokenOptions());
  const snake = simulateSnakeSubmit({ name: "StoreCheck", score: 44, t });
  assertStorageHasNoToken(snake.stored);
  assert.ok(!JSON.stringify(snake.stored).includes(t));

  const bt = createGameToken(TOKEN_UID, "bounch", tokenOptions());
  const bounch = simulateBounchSubmit({ name: "StoreCheckB", level: 6, t: bt });
  assertStorageHasNoToken(bounch.stored);
  assert.ok(!JSON.stringify(bounch.stored).includes(bt));
});

runTest("15. legacy public score-response fields still exist", () => {
  resetFiles();
  const snake = simulateSnakeSubmit({ name: "Legacy", score: 5 });
  assertLegacySnakeFields(snake.response);
  assert.deepStrictEqual(snake.response.identity, { verified: false });

  const bounch = simulateBounchSubmit({ name: "LegacyB", level: 1 });
  assertLegacyBounchFields(bounch.response);
  assert.deepStrictEqual(bounch.response.identity, { verified: false });
});

runTest("malformed token does not throw and stays unverified", () => {
  assert.deepStrictEqual(
    verifyOptionalGameIdentity("not-a-token", "snake", tokenOptions()),
    { verified: false }
  );
  assert.deepStrictEqual(
    verifyOptionalGameIdentity(12345, "snake", tokenOptions()),
    { verified: false }
  );
  assert.deepStrictEqual(
    verifyOptionalGameIdentity(
      `${base64UrlEncode(Buffer.from("{", "utf8"))}.${base64UrlEncode(crypto.randomBytes(32))}`,
      "snake",
      tokenOptions()
    ),
    { verified: false }
  );
});

runTest("highscore-server source does not write points.json", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "highscore-server.js"), "utf8");
  assert.ok(!source.includes("points.json"));
  assert.ok(!/require\(["'].*points/.test(source));
  assert.ok(source.includes('verifyOptionalGameIdentity(body.t, "snake")'));
  assert.ok(source.includes('verifyOptionalGameIdentity(body.t, "bounch")'));
  assert.ok(!source.includes("require.main"));
  assert.ok(!source.includes("module.exports"));
});

console.log("\nAll highscore-identity tests passed.");
