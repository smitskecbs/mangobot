/**
 * Highscore Telegram announcements — private deep-link CTAs (no signed tokens).
 */

const assert = require("assert");
const {
  buildGlobalHighscoreMessage,
  buildPersonalBestMessage,
} = require("../services/snakeScores");
const {
  buildGlobalBestMessage,
  buildPersonalBestMessage: buildBounchPersonalBestMessage,
} = require("../services/bounchScores");
const {
  normalizeBotUsername,
  getConfiguredBotUsername,
  buildPrivateDeepLink,
  buildHighscoreAnnouncementPlayCta,
  appendHighscoreAnnouncementPlayCta,
} = require("../utils/botMenu");

const BOT = "ManGoMemeFunCommunityBot";

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function assertNoSignedOrPublicXpCta(text) {
  assert.ok(!text.includes("?t="), "must not contain signed ?t=");
  assert.ok(!text.includes("uid="), "must not contain uid=");
  assert.ok(!text.includes("telegramUserId="), "must not contain telegramUserId=");
  assert.ok(!text.includes("mangomeme.fun/mango-labs"), "must not use public Labs play URL");
}

runTest("Snake announcement contains private ?start=snake deep-link", () => {
  const text = buildGlobalHighscoreMessage("Kevin", 900, BOT);
  assert.ok(text.includes("?start=snake"));
  assert.ok(text.includes(`https://t.me/${BOT}?start=snake`));
  assert.ok(text.includes("NEW GLOBAL HIGHSCORE"));
  assert.ok(text.includes("Kevin"));
  assert.ok(text.includes("900"));
  assert.ok(text.includes("Want to challenge it?"));
  assert.ok(text.includes("Play with your profile:"));
  assertNoSignedOrPublicXpCta(text);
});

runTest("Bounch announcement contains private ?start=bounch deep-link", () => {
  const text = buildGlobalBestMessage("Ada", 5, BOT);
  assert.ok(text.includes("?start=bounch"));
  assert.ok(text.includes(`https://t.me/${BOT}?start=bounch`));
  assert.ok(text.includes("New Bounch global best"));
  assert.ok(text.includes("Ada"));
  assert.ok(text.includes("Level 5"));
  assertNoSignedOrPublicXpCta(text);
});

runTest("Snake personal best announcement keeps body and uses private CTA", () => {
  const text = buildPersonalBestMessage("Kevin", 420, 3, BOT);
  assert.ok(text.includes("NEW PERSONAL BEST"));
  assert.ok(text.includes("Current rank: #3"));
  assert.ok(text.includes("?start=snake"));
  assertNoSignedOrPublicXpCta(text);
});

runTest("Bounch personal best announcement keeps body and uses private CTA", () => {
  const text = buildBounchPersonalBestMessage("Ada", 4, 2, BOT);
  assert.ok(text.includes("New Bounch personal best"));
  assert.ok(text.includes("Current rank: #2"));
  assert.ok(text.includes("?start=bounch"));
  assertNoSignedOrPublicXpCta(text);
});

runTest("public announcement never builds a signed token", () => {
  const snake = buildGlobalHighscoreMessage("Kevin", 100, BOT);
  const bounch = buildGlobalBestMessage("Kevin", 3, BOT);
  assert.ok(!snake.includes("?t="));
  assert.ok(!bounch.includes("?t="));
  // Deep-link payload is only the game name; token is created later in private /start.
  assert.strictEqual(buildPrivateDeepLink(BOT, "snake").includes("?t="), false);
});

runTest("missing TELEGRAM_BOT_USERNAME does not crash; omits play CTA", () => {
  const prev = process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.TELEGRAM_BOT_USERNAME;

  const snake = buildGlobalHighscoreMessage("Kevin", 100, null);
  const bounch = buildGlobalBestMessage("Kevin", 2, null);
  assert.ok(snake.includes("NEW GLOBAL HIGHSCORE"));
  assert.ok(bounch.includes("New Bounch global best"));
  assert.ok(!snake.includes("t.me/"));
  assert.ok(!bounch.includes("t.me/"));
  assert.ok(!snake.includes("Want to challenge it?"));
  assertNoSignedOrPublicXpCta(snake);
  assertNoSignedOrPublicXpCta(bounch);

  const viaEnv = buildGlobalHighscoreMessage("Kevin", 100);
  assert.ok(!viaEnv.includes("t.me/"));
  assert.strictEqual(getConfiguredBotUsername(), null);

  if (prev === undefined) {
    delete process.env.TELEGRAM_BOT_USERNAME;
  } else {
    process.env.TELEGRAM_BOT_USERNAME = prev;
  }
});

runTest("malformed bot username yields no unsafe URL", () => {
  assert.strictEqual(normalizeBotUsername(""), null);
  assert.strictEqual(normalizeBotUsername("ab"), null);
  assert.strictEqual(normalizeBotUsername("1bad"), null);
  assert.strictEqual(normalizeBotUsername("bad name"), null);
  assert.strictEqual(normalizeBotUsername("evil.com/x"), null);
  assert.strictEqual(buildPrivateDeepLink("@", "snake"), null);
  assert.strictEqual(buildPrivateDeepLink("not valid!", "snake"), null);
  assert.strictEqual(buildHighscoreAnnouncementPlayCta("snake", "x"), null);
  assert.strictEqual(
    appendHighscoreAnnouncementPlayCta("hello", "snake", "bad!!"),
    "hello"
  );

  const text = buildGlobalHighscoreMessage("Kevin", 50, "bad!!");
  assert.ok(!text.includes("t.me/"));
  assert.ok(!text.includes("mangomeme.fun"));
});

runTest("normalizeBotUsername strips @ and accepts valid names", () => {
  assert.strictEqual(normalizeBotUsername(`@${BOT}`), BOT);
  assert.strictEqual(normalizeBotUsername(BOT), BOT);
  assert.strictEqual(
    buildPrivateDeepLink(`@${BOT}`, "snake"),
    `https://t.me/${BOT}?start=snake`
  );
});

runTest("getConfiguredBotUsername reads TELEGRAM_BOT_USERNAME", () => {
  const prev = process.env.TELEGRAM_BOT_USERNAME;
  process.env.TELEGRAM_BOT_USERNAME = BOT;
  assert.strictEqual(getConfiguredBotUsername(), BOT);
  assert.ok(
    buildGlobalHighscoreMessage("Kevin", 10).includes(`?start=snake`)
  );
  if (prev === undefined) {
    delete process.env.TELEGRAM_BOT_USERNAME;
  } else {
    process.env.TELEGRAM_BOT_USERNAME = prev;
  }
});

console.log("\nAll highscore-announcement tests passed.");
