/**
 * Focused tests for signed /snake and /bounch Labs play links.
 */

const assert = require("assert");

const { verifyGameToken } = require("../utils/gameToken");
const {
  LABS_BASE_URL,
  GAME_LINK_UNAVAILABLE_MESSAGE,
  buildSignedGameUrl,
  buildSnakeReply,
  buildBounchReply,
  getGameCommandReply,
} = require("../utils/gameLinks");

const TEST_SECRET = "test-game-link-secret-do-not-use-in-prod";
const FIXED_NOW = 1_700_000_000;
const USER_ID = 123456789;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function extractPlayUrl(replyText) {
  const match = replyText.match(/https:\/\/www\.mangomeme\.fun\/mango-labs\?[^\s]+/);
  assert.ok(match, "expected Labs play URL in reply");
  return match[0];
}

function parsePlayUrl(urlString) {
  const url = new URL(urlString);
  return {
    url,
    game: url.searchParams.get("game"),
    token: url.searchParams.get("t"),
    hasUidParam: url.searchParams.has("uid") || url.searchParams.has("telegramUserId"),
  };
}

runTest("/snake generates URL with game=snake", () => {
  const built = buildSignedGameUrl(USER_ID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.strictEqual(built.ok, true);
  const parsed = parsePlayUrl(built.url);
  assert.strictEqual(parsed.url.origin + parsed.url.pathname, LABS_BASE_URL);
  assert.strictEqual(parsed.game, "snake");
});

runTest("/bounch generates URL with game=bounch", () => {
  const built = buildSignedGameUrl(USER_ID, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.strictEqual(built.ok, true);
  const parsed = parsePlayUrl(built.url);
  assert.strictEqual(parsed.game, "bounch");
});

runTest("URL contains t=", () => {
  const snake = buildSignedGameUrl(USER_ID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const bounch = buildSignedGameUrl(USER_ID, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.ok(snake.url.includes("t="));
  assert.ok(bounch.url.includes("t="));
  assert.ok(parsePlayUrl(snake.url).token);
  assert.ok(parsePlayUrl(bounch.url).token);
});

runTest("token from Snake URL verifies as snake", () => {
  const built = buildSignedGameUrl(USER_ID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { token } = parsePlayUrl(built.url);
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.game, "snake");
});

runTest("token from Bounch URL verifies as bounch", () => {
  const built = buildSignedGameUrl(USER_ID, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { token } = parsePlayUrl(built.url);
  const result = verifyGameToken(token, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.game, "bounch");
});

runTest("Snake token does not verify as bounch", () => {
  const built = buildSignedGameUrl(USER_ID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { token } = parsePlayUrl(built.url);
  const result = verifyGameToken(token, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "wrong-game" });
});

runTest("Bounch token does not verify as snake", () => {
  const built = buildSignedGameUrl(USER_ID, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { token } = parsePlayUrl(built.url);
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "wrong-game" });
});

runTest("token uid is String(ctx.from.id)", () => {
  const built = buildSignedGameUrl(USER_ID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { token } = parsePlayUrl(built.url);
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.uid, String(USER_ID));
  assert.strictEqual(typeof result.uid, "string");
});

runTest("no uid query parameter beside token", () => {
  const snake = parsePlayUrl(
    buildSignedGameUrl(USER_ID, "snake", {
      secret: TEST_SECRET,
      now: FIXED_NOW,
    }).url
  );
  const bounch = parsePlayUrl(
    buildSignedGameUrl(USER_ID, "bounch", {
      secret: TEST_SECRET,
      now: FIXED_NOW,
    }).url
  );

  assert.strictEqual(snake.hasUidParam, false);
  assert.strictEqual(bounch.hasUidParam, false);
  assert.deepStrictEqual([...snake.url.searchParams.keys()].sort(), ["game", "t"]);
  assert.deepStrictEqual([...bounch.url.searchParams.keys()].sort(), ["game", "t"]);
});

runTest("missing GAME_LINK_SECRET does not crash and returns generic message", () => {
  const previous = process.env.GAME_LINK_SECRET;
  delete process.env.GAME_LINK_SECRET;

  try {
    const built = buildSignedGameUrl(USER_ID, "snake", { now: FIXED_NOW });
    assert.deepStrictEqual(built, { ok: false });

    const reply = getGameCommandReply(USER_ID, "snake", { now: FIXED_NOW });
    assert.strictEqual(reply, GAME_LINK_UNAVAILABLE_MESSAGE);
    assert.ok(!reply.includes("GAME_LINK_SECRET"));
    assert.ok(!reply.includes("secret"));
  } finally {
    if (previous === undefined) {
      delete process.env.GAME_LINK_SECRET;
    } else {
      process.env.GAME_LINK_SECRET = previous;
    }
  }
});

runTest("existing command text retained except link change", () => {
  const snakeUrl = buildSignedGameUrl(USER_ID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  }).url;
  const bounchUrl = buildSignedGameUrl(USER_ID, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  }).url;

  const snakeReply = buildSnakeReply(snakeUrl);
  const bounchReply = buildBounchReply(bounchUrl);

  assert.ok(snakeReply.includes("🐍 ManGo Snake"));
  assert.ok(snakeReply.includes("🎮 Play:"));
  assert.ok(snakeReply.includes(snakeUrl));
  assert.ok(snakeReply.includes("🏆 Global leaderboard:"));
  assert.ok(snakeReply.includes("/snakehighscore"));
  assert.ok(snakeReply.includes("🥭 Think you can beat the top score?"));
  assert.ok(!snakeReply.includes("mango-labs.html"));

  assert.ok(bounchReply.includes("🏀 ManGo Bounch"));
  assert.ok(bounchReply.includes("Clear levels and climb the board."));
  assert.ok(bounchReply.includes("🎮 Play:"));
  assert.ok(bounchReply.includes(bounchUrl));
  assert.ok(bounchReply.includes("🏆 Global leaderboard:"));
  assert.ok(bounchReply.includes("/bounchhighscore"));
  assert.ok(bounchReply.includes("🥭 How far can you bounce?"));

  const fullSnake = getGameCommandReply(USER_ID, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const fullBounch = getGameCommandReply(USER_ID, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.strictEqual(fullSnake, buildSnakeReply(extractPlayUrl(fullSnake)));
  assert.strictEqual(fullBounch, buildBounchReply(extractPlayUrl(fullBounch)));
});

runTest("commands/snake.js and commands/bounch.js still export bot registrars", () => {
  const snakeCommand = require("../commands/snake");
  const bounchCommand = require("../commands/bounch");
  assert.strictEqual(typeof snakeCommand, "function");
  assert.strictEqual(typeof bounchCommand, "function");
});

console.log("\nAll game-links tests passed.");
