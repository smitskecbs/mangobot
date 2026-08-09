/**
 * Tests for private menu, group game-link gates, and /start deep-link payloads.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { verifyGameToken } = require("../utils/gameToken");
const { GAME_LINK_UNAVAILABLE_MESSAGE } = require("../utils/gameLinks");
const {
  MENU_LABELS,
  MENU_LABEL_LIST,
  GROUP_SNAKE_MESSAGE,
  GROUP_BOUNCH_MESSAGE,
  GROUP_SNAKE_BUTTON_LABEL,
  GROUP_BOUNCH_BUTTON_LABEL,
  isPrivateChat,
  isGroupChat,
  isPrivateMenuLabel,
  getBotUsername,
  buildPrivateDeepLink,
  getPrivateMenuKeyboard,
  getGroupGameMessage,
  getGroupGameGateExtra,
} = require("../utils/botMenu");
const { handleSnake } = require("../commands/snake");
const { handleBounch } = require("../commands/bounch");
const { handleStart, WELCOME_MESSAGE } = require("../commands/start");
const { handlePoints } = require("../commands/points");
const { handleLeaderboard } = require("../commands/leaderboard");
const { handleWeekly } = require("../commands/weekly");
const { handleHelp, HELP_MESSAGE } = require("../commands/help");
const {
  shouldSkipCommunityActivity,
} = require("../events/points-trigger");
const {
  detectTrigger,
  awardDailyActivityPoint,
  hasClaimedDailyActivity,
  loadPoints,
} = require("../services/points");

const TEST_SECRET = "test-game-link-secret-do-not-use-in-prod";
const FIXED_NOW = 1_700_000_000;
const USER_A = 111111111;
const USER_B = 222222222;
const BOT_USERNAME = "ManGoTestBot";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-bot-menu-test-"));
const testPointsFile = path.join(tempDir, "points.json");

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function createMockCtx({
  chatType = "private",
  userId = USER_A,
  firstName = "Ada",
  botUsername = BOT_USERNAME,
  startPayload,
} = {}) {
  const replies = [];
  return {
    chat: { type: chatType },
    from: { id: userId, first_name: firstName },
    botInfo: botUsername ? { username: botUsername } : {},
    startPayload,
    replies,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve(replies[replies.length - 1]);
    },
  };
}

function extractPlayUrl(replyText) {
  const match = replyText.match(
    /https:\/\/www\.mangomeme\.fun\/mango-labs\?[^\s]+/
  );
  assert.ok(match, "expected Labs play URL in reply");
  return match[0];
}

function parsePlayUrl(urlString) {
  const url = new URL(urlString);
  return {
    url,
    game: url.searchParams.get("game"),
    token: url.searchParams.get("t"),
    hasUidParam:
      url.searchParams.has("uid") || url.searchParams.has("telegramUserId"),
  };
}

function getInlineUrl(extra) {
  const markup = extra && (extra.reply_markup || extra);
  const keyboard = markup && markup.inline_keyboard;
  assert.ok(keyboard && keyboard[0] && keyboard[0][0], "expected inline button");
  return keyboard[0][0];
}

function resetPointsFile(contents = { users: {} }) {
  fs.writeFileSync(
    testPointsFile,
    `${JSON.stringify(contents, null, 2)}\n`,
    "utf8"
  );
}

runTest("isPrivateChat / isGroupChat helpers", () => {
  assert.strictEqual(isPrivateChat(createMockCtx({ chatType: "private" })), true);
  assert.strictEqual(isPrivateChat(createMockCtx({ chatType: "group" })), false);
  assert.strictEqual(isPrivateChat(createMockCtx({ chatType: "supergroup" })), false);
  assert.strictEqual(isGroupChat(createMockCtx({ chatType: "group" })), true);
  assert.strictEqual(isGroupChat(createMockCtx({ chatType: "supergroup" })), true);
  assert.strictEqual(isGroupChat(createMockCtx({ chatType: "private" })), false);
});

runTest("private /snake → signed Snake link", () => {
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handleSnake(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  assert.strictEqual(ctx.replies.length, 1);
  const text = ctx.replies[0].text;
  assert.ok(text.includes("🐍 ManGo Snake"));
  const parsed = parsePlayUrl(extractPlayUrl(text));
  assert.strictEqual(parsed.game, "snake");
  assert.ok(parsed.token);
  const verified = verifyGameToken(parsed.token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.uid, String(USER_A));
});

runTest("group /snake → geen t= token", () => {
  const ctx = createMockCtx({ chatType: "group", userId: USER_A });
  handleSnake(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  assert.strictEqual(ctx.replies.length, 1);
  const text = ctx.replies[0].text;
  assert.strictEqual(text, GROUP_SNAKE_MESSAGE);
  const blob = JSON.stringify(ctx.replies[0]);
  assert.ok(!text.includes("mango-labs"));
  assert.ok(!blob.includes("mango-labs"));
  assert.ok(!/[?&]t=/.test(blob));
});

runTest("group /snake → private deep-link button", () => {
  const ctx = createMockCtx({ chatType: "supergroup", userId: USER_A });
  handleSnake(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  const button = getInlineUrl(ctx.replies[0].extra);
  assert.strictEqual(button.text, GROUP_SNAKE_BUTTON_LABEL);
  assert.strictEqual(button.url, `https://t.me/${BOT_USERNAME}?start=snake`);
});

runTest("private /bounch → signed Bounch link", () => {
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handleBounch(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  const parsed = parsePlayUrl(extractPlayUrl(ctx.replies[0].text));
  assert.strictEqual(parsed.game, "bounch");
  const verified = verifyGameToken(parsed.token, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.uid, String(USER_A));
});

runTest("group /bounch → geen t=", () => {
  const ctx = createMockCtx({ chatType: "group", userId: USER_A });
  handleBounch(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  assert.strictEqual(ctx.replies[0].text, GROUP_BOUNCH_MESSAGE);
  const blob = JSON.stringify(ctx.replies[0]);
  assert.ok(!blob.includes("mango-labs"));
  assert.ok(!/[?&]t=/.test(blob));
});

runTest("group /bounch → private deep-link button", () => {
  const ctx = createMockCtx({ chatType: "group", userId: USER_A });
  handleBounch(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  const button = getInlineUrl(ctx.replies[0].extra);
  assert.strictEqual(button.text, GROUP_BOUNCH_BUTTON_LABEL);
  assert.strictEqual(button.url, `https://t.me/${BOT_USERNAME}?start=bounch`);
});

runTest("/start snake private → signed Snake link", () => {
  const ctx = createMockCtx({
    chatType: "private",
    userId: USER_A,
    startPayload: "snake",
  });
  handleStart(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  const parsed = parsePlayUrl(extractPlayUrl(ctx.replies[0].text));
  assert.strictEqual(parsed.game, "snake");
  assert.ok(parsed.token);
});

runTest("/start bounch private → signed Bounch link", () => {
  const ctx = createMockCtx({
    chatType: "private",
    userId: USER_A,
    startPayload: "bounch",
  });
  handleStart(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  const parsed = parsePlayUrl(extractPlayUrl(ctx.replies[0].text));
  assert.strictEqual(parsed.game, "bounch");
  assert.ok(parsed.token);
});

runTest("/start snake group → geen signed token", () => {
  const ctx = createMockCtx({
    chatType: "group",
    userId: USER_A,
    startPayload: "snake",
  });
  handleStart(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  assert.strictEqual(ctx.replies[0].text, WELCOME_MESSAGE);
  assert.ok(!ctx.replies[0].text.includes("t="));
  assert.ok(!JSON.stringify(ctx.replies[0]).includes("mango-labs"));
});

runTest("gewone /start private → menu zichtbaar", () => {
  const ctx = createMockCtx({ chatType: "private", startPayload: "" });
  handleStart(ctx);

  assert.strictEqual(ctx.replies[0].text, WELCOME_MESSAGE);
  const markup =
    ctx.replies[0].extra &&
    (ctx.replies[0].extra.reply_markup || ctx.replies[0].extra);
  assert.ok(markup && markup.keyboard, "expected reply keyboard");
  assert.notStrictEqual(markup.one_time_keyboard, true);
});

runTest("menu niet zichtbaar in group /start", () => {
  const ctx = createMockCtx({ chatType: "group" });
  handleStart(ctx);

  assert.strictEqual(ctx.replies[0].text, WELCOME_MESSAGE);
  const extra = ctx.replies[0].extra;
  assert.ok(!extra || !extra.reply_markup || !extra.reply_markup.keyboard);
});

runTest("menu bevat exact de gewenste 6 opties", () => {
  assert.deepStrictEqual(MENU_LABEL_LIST, [
    MENU_LABELS.POINTS,
    MENU_LABELS.SNAKE,
    MENU_LABELS.BOUNCH,
    MENU_LABELS.LEADERBOARD,
    MENU_LABELS.WEEKLY,
    MENU_LABELS.HELP,
  ]);
  assert.strictEqual(MENU_LABEL_LIST.length, 6);

  const kb = getPrivateMenuKeyboard();
  const rows = kb.reply_markup.keyboard;
  assert.deepStrictEqual(rows, [
    [MENU_LABELS.POINTS, MENU_LABELS.SNAKE],
    [MENU_LABELS.BOUNCH, MENU_LABELS.LEADERBOARD],
    [MENU_LABELS.WEEKLY, MENU_LABELS.HELP],
  ]);
  assert.strictEqual(kb.reply_markup.resize_keyboard, true);
});

runTest("Snake menu-button → persoonlijke Snake link", () => {
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handleSnake(ctx, { secret: TEST_SECRET, now: FIXED_NOW });
  const parsed = parsePlayUrl(extractPlayUrl(ctx.replies[0].text));
  assert.strictEqual(parsed.game, "snake");
  assert.strictEqual(
    verifyGameToken(parsed.token, "snake", {
      secret: TEST_SECRET,
      now: FIXED_NOW,
    }).uid,
    String(USER_A)
  );
});

runTest("Bounch menu-button → persoonlijke Bounch link", () => {
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handleBounch(ctx, { secret: TEST_SECRET, now: FIXED_NOW });
  const parsed = parsePlayUrl(extractPlayUrl(ctx.replies[0].text));
  assert.strictEqual(parsed.game, "bounch");
});

runTest("Points menu-button → bestaande points output", () => {
  resetPointsFile({
    users: {
      [String(USER_A)]: {
        name: "Ada",
        points: 5,
        weeklyPoints: 2,
        weekStart: "2026-08-04",
        lastClaims: {},
      },
    },
  });
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handlePoints(ctx, { pointsFile: testPointsFile });
  assert.ok(ctx.replies[0].text.includes("🥭 Ada"));
  assert.ok(ctx.replies[0].text.includes("Lifetime points: 5 points"));
  assert.ok(ctx.replies[0].text.includes("Weekly points:"));
  assert.ok(ctx.replies[0].text.includes("Claimed today:"));
});

runTest("Leaderboard menu-button → bestaande leaderboard output", () => {
  resetPointsFile({ users: {} });
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handleLeaderboard(ctx, { pointsFile: testPointsFile });
  assert.ok(ctx.replies[0].text.includes("Leaderboard is empty"));
});

runTest("Weekly menu-button → bestaande weekly output", () => {
  resetPointsFile({ users: {} });
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handleWeekly(ctx, { pointsFile: testPointsFile });
  assert.ok(ctx.replies[0].text.includes("Weekly leaderboard is empty"));
});

runTest("Help menu-button → bestaande help output", () => {
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handleHelp(ctx);
  assert.strictEqual(ctx.replies[0].text, HELP_MESSAGE);
});

runTest(
  "forwarded/shared group deep-link → token pas voor private ctx.from.id",
  () => {
    const groupCtx = createMockCtx({ chatType: "group", userId: USER_A });
    handleSnake(groupCtx, { secret: TEST_SECRET, now: FIXED_NOW });
    const button = getInlineUrl(groupCtx.replies[0].extra);
    assert.strictEqual(button.url, `https://t.me/${BOT_USERNAME}?start=snake`);
    assert.ok(!/[?&]t=/.test(JSON.stringify(groupCtx.replies[0])));
    assert.ok(!JSON.stringify(groupCtx.replies[0]).includes("mango-labs"));

    const privateCtx = createMockCtx({
      chatType: "private",
      userId: USER_B,
      startPayload: "snake",
    });
    handleStart(privateCtx, { secret: TEST_SECRET, now: FIXED_NOW });
    const parsed = parsePlayUrl(extractPlayUrl(privateCtx.replies[0].text));
    const verified = verifyGameToken(parsed.token, "snake", {
      secret: TEST_SECRET,
      now: FIXED_NOW,
    });
    assert.strictEqual(verified.ok, true);
    assert.strictEqual(verified.uid, String(USER_B));
    assert.notStrictEqual(verified.uid, String(USER_A));
  }
);

runTest("missing GAME_LINK_SECRET → geen crash, generieke fout", () => {
  const previous = process.env.GAME_LINK_SECRET;
  delete process.env.GAME_LINK_SECRET;

  try {
    const ctx = createMockCtx({ chatType: "private", userId: USER_A });
    handleSnake(ctx, { now: FIXED_NOW });
    assert.strictEqual(ctx.replies[0].text, GAME_LINK_UNAVAILABLE_MESSAGE);
    assert.ok(!ctx.replies[0].text.toLowerCase().includes("secret"));
  } finally {
    if (previous === undefined) {
      delete process.env.GAME_LINK_SECRET;
    } else {
      process.env.GAME_LINK_SECRET = previous;
    }
  }
});

runTest("token/uid niet zichtbaar in groepsbericht", () => {
  const ctx = createMockCtx({ chatType: "supergroup", userId: USER_A });
  handleSnake(ctx, { secret: TEST_SECRET, now: FIXED_NOW });
  handleBounch(ctx, { secret: TEST_SECRET, now: FIXED_NOW });

  for (const reply of ctx.replies) {
    const blob = JSON.stringify(reply);
    assert.ok(!blob.includes("mango-labs"));
    assert.ok(!/[?&]t=/.test(blob));
    assert.ok(!blob.includes(String(USER_A)));
    assert.ok(!/"uid"/.test(blob));
    assert.ok(!blob.includes(TEST_SECRET));
  }
});

runTest("menu-labels veroorzaken geen gm/gn trigger", () => {
  for (const label of MENU_LABEL_LIST) {
    assert.strictEqual(detectTrigger(label), null, label);
  }
});

runTest("menu-labels veroorzaken geen Daily Activity XP in private", () => {
  resetPointsFile({ users: {} });

  for (const label of MENU_LABEL_LIST) {
    const ctx = createMockCtx({ chatType: "private", userId: USER_A });
    assert.strictEqual(shouldSkipCommunityActivity(ctx, label), true);
    assert.strictEqual(isPrivateMenuLabel(label), true);
  }

  // Skipped path must not award; control path still awards.
  for (const label of MENU_LABEL_LIST) {
    const ctx = createMockCtx({ chatType: "private", userId: USER_A });
    if (!shouldSkipCommunityActivity(ctx, label)) {
      awardDailyActivityPoint(USER_A, "Ada", testPointsFile);
    }
  }

  const dataAfterSkip = loadPoints(testPointsFile);
  assert.strictEqual(
    hasClaimedDailyActivity(dataAfterSkip.users[String(USER_A)] || {}),
    false
  );

  const awarded = awardDailyActivityPoint(USER_A, "Ada", testPointsFile);
  assert.strictEqual(awarded.awarded, true);
  assert.strictEqual(
    hasClaimedDailyActivity(loadPoints(testPointsFile).users[String(USER_A)]),
    true
  );

  // Normal non-menu private text still eligible.
  assert.strictEqual(
    shouldSkipCommunityActivity(
      createMockCtx({ chatType: "private" }),
      "hello mango community"
    ),
    false
  );
});

runTest("unknown /start payload → normale welcome, geen crash", () => {
  const ctx = createMockCtx({
    chatType: "private",
    startPayload: "not-a-real-payload",
  });
  handleStart(ctx, { secret: TEST_SECRET, now: FIXED_NOW });
  assert.strictEqual(ctx.replies[0].text, WELCOME_MESSAGE);
  assert.ok(ctx.replies[0].extra.reply_markup.keyboard);
});

runTest("getBotUsername / buildPrivateDeepLink helpers", () => {
  assert.strictEqual(
    getBotUsername({ botInfo: { username: "MyBot" } }),
    "MyBot"
  );
  assert.strictEqual(getBotUsername({ botInfo: {} }), null);
  assert.strictEqual(
    buildPrivateDeepLink("MyBot", "snake"),
    "https://t.me/MyBot?start=snake"
  );
  assert.strictEqual(buildPrivateDeepLink(null, "snake"), null);
  assert.strictEqual(buildPrivateDeepLink("ab", "snake"), null);
  assert.strictEqual(getGroupGameMessage("snake"), GROUP_SNAKE_MESSAGE);
  assert.deepStrictEqual(getGroupGameGateExtra({ botInfo: {} }, "snake"), {});
});

runTest("Points menu-button includes game claimed + unlock lines", () => {
  resetPointsFile({
    users: {
      [String(USER_A)]: {
        name: "Ada",
        points: 5,
        weeklyPoints: 2,
        weekId: "2026-08-04",
        triggerDate: null,
        triggersUsed: [],
        activityDate: null,
      },
    },
  });
  const ctx = createMockCtx({ chatType: "private", userId: USER_A });
  handlePoints(ctx, { pointsFile: testPointsFile });
  const text = ctx.replies[0].text;
  assert.ok(text.includes("⬜ Snake"));
  assert.ok(text.includes("⬜ Bounch"));
  assert.ok(text.includes("🎮 Bounch unlocks: 0 / 7"));
});

runTest("isPrivateMenuLabel exact match only", () => {
  assert.strictEqual(isPrivateMenuLabel(MENU_LABELS.POINTS), true);
  assert.strictEqual(isPrivateMenuLabel("My Points"), false);
  assert.strictEqual(isPrivateMenuLabel("/points"), false);
  assert.strictEqual(isPrivateMenuLabel("gmango"), false);
});

console.log("\nAll bot-menu tests passed.");
