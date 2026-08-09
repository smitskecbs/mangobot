/**
 * /snakescore, /snakehighscore, /bounchscore, /bounchhighscore — private play CTAs.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  formatSnakeLeaderboardMessage,
} = require("../services/snakeLeaderboard");
const {
  formatBounchLeaderboardMessage,
} = require("../services/bounchLeaderboard");
const {
  replyWithLeaderboard: replySnakeLeaderboard,
} = require("../commands/snakehighscore");
const {
  replyWithLeaderboard: replyBounchLeaderboard,
} = require("../commands/bounchhighscore");
const { writeScoresFile, createEmptyScores } = require("../services/snakeScores");
const bounchScores = require("../services/bounchScores");

const BOT = "ManGoTestBot";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-score-cmd-"));
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

function assertSafePublicCta(text) {
  assert.ok(!text.includes("?t="), "must not contain signed ?t=");
  assert.ok(!text.includes("uid="), "must not contain uid=");
  assert.ok(!text.includes("telegramUserId="), "must not contain telegramUserId=");
  assert.ok(!text.includes("GAME_LINK_SECRET"), "must not leak secret");
  assert.ok(
    !text.includes("mangomeme.fun/mango-labs"),
    "must not use public Labs play URL"
  );
}

function createMockCtx({ chatType = "group", botUsername = BOT } = {}) {
  const replies = [];
  return {
    chat: { type: chatType },
    botInfo: botUsername ? { username: botUsername } : {},
    replies,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve();
    },
  };
}

function seedSnakeLeaderboard() {
  writeScoresFile(snakeFile, {
    globalHighScore: 900,
    globalHighScoreName: "Kevin",
    updatedAt: "2026-08-09T12:00:00.000Z",
    leaderboard: [
      {
        name: "Kevin",
        score: 900,
        lastScore: 900,
        gamesPlayed: 2,
        updatedAt: "2026-08-09T12:00:00.000Z",
        lastPlayedAt: "2026-08-09T12:00:00.000Z",
      },
      {
        name: "Ada",
        score: 500,
        lastScore: 500,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T11:00:00.000Z",
        lastPlayedAt: "2026-08-09T11:00:00.000Z",
      },
    ],
  });
}

function seedBounchLeaderboard() {
  bounchScores.writeScoresFile(bounchFile, {
    globalBestLevel: 5,
    globalBestLevelName: "Kevin",
    updatedAt: "2026-08-09T12:00:00.000Z",
    leaderboard: [
      {
        name: "Kevin",
        bestLevel: 5,
        lastLevel: 5,
        gamesPlayed: 3,
        updatedAt: "2026-08-09T12:00:00.000Z",
        lastPlayedAt: "2026-08-09T12:00:00.000Z",
      },
      {
        name: "Ada",
        bestLevel: 3,
        lastLevel: 3,
        gamesPlayed: 1,
        updatedAt: "2026-08-09T11:00:00.000Z",
        lastPlayedAt: "2026-08-09T11:00:00.000Z",
      },
    ],
  });
}

writeScoresFile(snakeFile, createEmptyScores());
bounchScores.writeScoresFile(bounchFile, bounchScores.createEmptyScores());

runTest("/snakescore and /snakehighscore contain private ?start=snake", () => {
  seedSnakeLeaderboard();
  const text = formatSnakeLeaderboardMessage(snakeFile, BOT);
  assert.ok(text.includes("?start=snake"));
  assert.ok(text.includes(`https://t.me/${BOT}?start=snake`));
  assert.ok(text.includes("ManGo Snake Leaderboard"));
  assert.ok(text.includes("Kevin — 900"));
  assert.ok(text.includes("Ada — 500"));
  assert.ok(text.includes("🎮 Play:"));
  assertSafePublicCta(text);

  // Commands share one handler for /snakescore and /snakehighscore.
  const ctxScore = createMockCtx();
  const ctxHigh = createMockCtx();
  replySnakeLeaderboard(ctxScore);
  replySnakeLeaderboard(ctxHigh);
  assert.ok(ctxScore.replies[0].text.includes(`https://t.me/${BOT}?start=snake`));
  assert.ok(ctxHigh.replies[0].text.includes(`https://t.me/${BOT}?start=snake`));
  assertSafePublicCta(ctxScore.replies[0].text);
  assertSafePublicCta(ctxHigh.replies[0].text);
});

runTest("/bounchscore and /bounchhighscore contain private ?start=bounch", () => {
  seedBounchLeaderboard();
  const text = formatBounchLeaderboardMessage(bounchFile, BOT);
  assert.ok(text.includes("?start=bounch"));
  assert.ok(text.includes(`https://t.me/${BOT}?start=bounch`));
  assert.ok(text.includes("ManGo Bounch Leaderboard"));
  assert.ok(text.includes("Kevin — Level 5"));
  assert.ok(text.includes("Ada — Level 3"));
  assert.ok(text.includes("🎮 Play:"));
  assertSafePublicCta(text);

  const ctx = createMockCtx();
  replyBounchLeaderboard(ctx);
  assert.ok(ctx.replies[0].text.includes(`https://t.me/${BOT}?start=bounch`));
  assertSafePublicCta(ctx.replies[0].text);
});

runTest("score outputs never contain signed t= or Labs play CTA", () => {
  seedSnakeLeaderboard();
  seedBounchLeaderboard();
  assertSafePublicCta(formatSnakeLeaderboardMessage(snakeFile, BOT));
  assertSafePublicCta(formatBounchLeaderboardMessage(bounchFile, BOT));
  assertSafePublicCta(formatSnakeLeaderboardMessage(snakeFile, null));
  assertSafePublicCta(formatBounchLeaderboardMessage(bounchFile, null));
});

runTest("missing bot username keeps score info and omits play CTA", () => {
  seedSnakeLeaderboard();
  seedBounchLeaderboard();
  const snake = formatSnakeLeaderboardMessage(snakeFile, null);
  const bounch = formatBounchLeaderboardMessage(bounchFile, null);
  assert.ok(snake.includes("Kevin — 900"));
  assert.ok(bounch.includes("Kevin — Level 5"));
  assert.ok(!snake.includes("t.me/"));
  assert.ok(!bounch.includes("t.me/"));
  assert.ok(!snake.includes("🎮 Play:"));
  assert.ok(!bounch.includes("🎮 Play:"));
  assertSafePublicCta(snake);
  assertSafePublicCta(bounch);

  const prev = process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.TELEGRAM_BOT_USERNAME;
  const viaEnv = formatSnakeLeaderboardMessage(snakeFile);
  assert.ok(viaEnv.includes("Kevin — 900"));
  assert.ok(!viaEnv.includes("t.me/"));
  if (prev === undefined) {
    delete process.env.TELEGRAM_BOT_USERNAME;
  } else {
    process.env.TELEGRAM_BOT_USERNAME = prev;
  }
});

runTest("malformed bot username yields no unsafe URL", () => {
  seedSnakeLeaderboard();
  const text = formatSnakeLeaderboardMessage(snakeFile, "bad!!");
  assert.ok(text.includes("Kevin — 900"));
  assert.ok(!text.includes("t.me/"));
  assert.ok(!text.includes("mangomeme.fun"));
  assertSafePublicCta(text);

  const ctx = createMockCtx({ botUsername: "x" });
  replySnakeLeaderboard(ctx);
  assert.ok(!ctx.replies[0].text.includes("t.me/"));
  assertSafePublicCta(ctx.replies[0].text);
});

runTest("empty leaderboards keep body; private invite when username present", () => {
  writeScoresFile(snakeFile, createEmptyScores());
  bounchScores.writeScoresFile(bounchFile, bounchScores.createEmptyScores());

  const snakeEmpty = formatSnakeLeaderboardMessage(snakeFile, BOT);
  const bounchEmpty = formatBounchLeaderboardMessage(bounchFile, BOT);
  assert.ok(snakeEmpty.includes("No scores yet."));
  assert.ok(bounchEmpty.includes("No clears yet."));
  assert.ok(snakeEmpty.includes("?start=snake"));
  assert.ok(bounchEmpty.includes("?start=bounch"));
  assertSafePublicCta(snakeEmpty);
  assertSafePublicCta(bounchEmpty);

  const snakeNoCta = formatSnakeLeaderboardMessage(snakeFile, null);
  assert.ok(snakeNoCta.includes("No scores yet."));
  assert.ok(!snakeNoCta.includes("Be the first"));
  assert.ok(!snakeNoCta.includes("t.me/"));
});

runTest("leaderboard ranking content preserved", () => {
  seedSnakeLeaderboard();
  seedBounchLeaderboard();
  const snake = formatSnakeLeaderboardMessage(snakeFile, BOT);
  const bounch = formatBounchLeaderboardMessage(bounchFile, BOT);
  assert.ok(snake.startsWith("🐍 ManGo Snake Leaderboard"));
  assert.ok(bounch.startsWith("🏀 ManGo Bounch Leaderboard"));
  assert.ok(snake.includes("🥇 Kevin — 900"));
  assert.ok(snake.includes("🥈 Ada — 500"));
  assert.ok(bounch.includes("🥇 Kevin — Level 5"));
  assert.ok(bounch.includes("🥈 Ada — Level 3"));
});

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll score-command tests passed.");
