/**
 * Tests for private menu, group game-link gates, and /start deep-link payloads.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const { verifyGameToken } = require("../utils/gameToken");
const { GAME_LINK_UNAVAILABLE_MESSAGE } = require("../utils/gameLinks");
const {
  MENU_LABELS,
  MENU_LABEL_LIST,
  GROUP_MENU_TEXT,
  GROUP_RANKINGS_TEXT,
  GROUP_GAMES_TEXT,
  GROUP_PROGRESS_TEXT,
  GROUP_PROFILE_TEXT,
  PRIVATE_MENU_HINT,
  GROUP_MENU_CALLBACK,
  PRIVATE_HUB_CALLBACK,
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
  getGroupMenuExtra,
  getGroupRankingsMenuExtra,
  getGroupGamesMenuExtra,
  getGroupProgressMenuExtra,
  getGroupProfileMenuExtra,
  getPrivateProfileMenuExtra,
} = require("../utils/botMenu");
const { handleSnake } = require("../commands/snake");
const { handleBounch } = require("../commands/bounch");
const { handleStart, WELCOME_MESSAGE } = require("../commands/start");
const { handlePoints } = require("../commands/points");
const { handleLeaderboard } = require("../commands/leaderboard");
const { handleWeekly } = require("../commands/weekly");
const { handleHelp, HELP_MESSAGE } = require("../commands/help");
const {
  handleMenu,
  handleGroupMenuCallback,
  handlePrivateProfile,
  handlePrivateHubCallback,
} = require("../commands/menu");
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

const pendingAsyncTests = [];

function runTest(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pendingAsyncTests.push(
        result
          .then(() => {
            console.log(`✓ ${name}`);
          })
          .catch((err) => {
            console.error(`✗ ${name}`);
            throw err;
          })
      );
      return;
    }
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
  callbackData,
  chatId = -1003916996602,
} = {}) {
  const replies = [];
  const answered = [];
  const edits = [];
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName },
    botInfo: botUsername ? { username: botUsername } : {},
    startPayload,
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    replies,
    answered,
    edits,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve(replies[replies.length - 1]);
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve(edits[edits.length - 1]);
    },
    answerCbQuery(text) {
      answered.push(text || true);
      return Promise.resolve();
    },
  };
}

function getInlineRows(extra) {
  return (
    (extra &&
      extra.reply_markup &&
      extra.reply_markup.inline_keyboard) ||
    []
  );
}

function getInlineButtons(extra) {
  const rows =
    (extra &&
      extra.reply_markup &&
      extra.reply_markup.inline_keyboard) ||
    [];
  return rows.flat();
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
  assert.ok(text.includes("🥭 Snake now has 4 difficulty levels."));
  assert.ok(text.includes("No level unlocking. Players choose difficulty on the website."));
  const parsed = parsePlayUrl(extractPlayUrl(text));
  assert.strictEqual(parsed.game, "snake");
  assert.ok(parsed.token);
  const verified = verifyGameToken(parsed.token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.uid, String(USER_A));
  assert.strictEqual(verified.name, "Ada");
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
  assert.strictEqual(verified.name, "Ada");
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

runTest("menu bevat private opties zonder PvP", () => {
  assert.deepStrictEqual(MENU_LABEL_LIST, [
    MENU_LABELS.MY_PROFILE,
    MENU_LABELS.WALLET,
    MENU_LABELS.REWARDS,
    MENU_LABELS.HELP,
    MENU_LABELS.COMMUNITY_BUILDER,
    MENU_LABELS.SHOP,
    MENU_LABELS.DAILY_QUEST,
    MENU_LABELS.PHASE2,
    MENU_LABELS.ADMIN,
    MENU_LABELS.SNAKE,
    MENU_LABELS.BOUNCH,
    MENU_LABELS.POINTS,
    MENU_LABELS.MY_STREAK,
    MENU_LABELS.PRESALE,
    MENU_LABELS.LEADERBOARD,
    MENU_LABELS.WEEKLY,
  ]);

  const kb = getPrivateMenuKeyboard();
  const rows = kb.reply_markup.keyboard;
  assert.deepStrictEqual(rows, [
    [MENU_LABELS.MY_PROFILE, MENU_LABELS.WALLET],
    [MENU_LABELS.REWARDS, MENU_LABELS.HELP],
    [MENU_LABELS.DAILY_QUEST, MENU_LABELS.SHOP],
    [MENU_LABELS.COMMUNITY_BUILDER],
    [MENU_LABELS.SNAKE, MENU_LABELS.BOUNCH],
  ]);
  assert.ok(rows.every((row) => row.length <= 2));
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
  assert.ok(ctx.replies[0].text.includes("🥭 Your ManGo Progress"));
  assert.ok(ctx.replies[0].text.includes("XP: 5"));
  assert.ok(ctx.replies[0].text.includes("Weekly XP:"));
  assert.ok(ctx.replies[0].text.includes("Claimed today:"));
  assert.ok(ctx.replies[0].text.includes("Current streak:"));
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

  // Private text is never community daily activity.
  assert.strictEqual(
    shouldSkipCommunityActivity(
      createMockCtx({ chatType: "private" }),
      "hello mango community"
    ),
    true
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
  assert.strictEqual(isPrivateMenuLabel(MENU_LABELS.MY_PROFILE), true);
  assert.strictEqual(isPrivateMenuLabel(MENU_LABELS.WALLET), true);
  assert.strictEqual(isPrivateMenuLabel(MENU_LABELS.POINTS), true);
  assert.strictEqual(isPrivateMenuLabel("My Points"), false);
  assert.strictEqual(isPrivateMenuLabel("/points"), false);
  assert.strictEqual(isPrivateMenuLabel("gmango"), false);
});

runTest("/menu group toont Wallet en Rewards op hoofdmenu", () => {
  const ctx = createMockCtx({ chatType: "supergroup" });
  handleMenu(ctx);
  assert.strictEqual(ctx.replies[0].text, GROUP_MENU_TEXT);
  const rows = getInlineRows(ctx.replies[0].extra);
  assert.strictEqual(rows.length, 5);
  assert.ok(rows.every((row) => row.length <= 2));
  const labels = rows.flat().map((b) => b.text);
  assert.deepStrictEqual(labels, [
    "🏆 Rankings",
    "🎮 Games",
    "👤 My Profile",
    "👛 Wallet",
    "🎁 Rewards",
    "ℹ️ Help",
    "🎯 Daily Quest",
    "🏪 ManGo Shop",
    "🤝 Community Builder",
  ]);
  const streakLabels = labels.filter((t) => /streak/i.test(t));
  assert.strictEqual(streakLabels.length, 0);
  const wallet = rows[1][1];
  const rewards = rows[2][0];
  assert.strictEqual(wallet.url, `https://t.me/${BOT_USERNAME}?start=wallet`);
  assert.strictEqual(rewards.url, `https://t.me/${BOT_USERNAME}?start=rewards`);
});

runTest("group hoofdmenu callbacks bevatten geen uid/token", () => {
  const ctx = createMockCtx({ chatType: "group" });
  handleMenu(ctx);
  const blob = JSON.stringify(ctx.replies[0]);
  assert.ok(!blob.includes("?t="));
  assert.ok(!blob.includes("uid="));
  assert.ok(!blob.includes("telegramUserId="));
  assert.ok(!blob.includes(String(USER_A)));
});

runTest("Rankings submenu layout", () => {
  const rows = getInlineRows(getGroupRankingsMenuExtra());
  assert.ok(rows.every((row) => row.length <= 2));
  assert.deepStrictEqual(
    rows.flat().map((b) => b.text),
    [
      "Leaderboard",
      "Weekly",
      "Weekly Winners",
      "Streak",
      "Streak Record",
      "⬅️ Back",
    ]
  );
  assert.strictEqual(
    rows.flat().filter((b) => /streak/i.test(b.text)).length,
    2
  );
});

runTest("Games submenu Snake/Bounch safe deep-links", () => {
  const ctx = createMockCtx({ chatType: "group" });
  const rows = getInlineRows(getGroupGamesMenuExtra(ctx));
  assert.ok(rows.every((row) => row.length <= 2));
  const buttons = rows.flat();
  const snake = buttons.find((b) => b.text === "Snake");
  const bounch = buttons.find((b) => b.text === "Bounch");
  assert.strictEqual(snake.url, `https://t.me/${BOT_USERNAME}?start=snake`);
  assert.strictEqual(bounch.url, `https://t.me/${BOT_USERNAME}?start=bounch`);
  assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.TICTACTOE));
  assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.CONNECT4));
  assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.TRIVIA));
  assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.MANGOBOMB));
  assert.ok(buttons.some((b) => b.text === "ManGo Bomb"));
  assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.BLACKJACK));
  assert.ok(buttons.some((b) => b.text === "🃏 Blackjack"));
  assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.BACK));
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes("?t="));
  assert.ok(!blob.includes("uid="));
});

runTest("My Profile submenu deep-links", () => {
  const ctx = createMockCtx({ chatType: "group" });
  const rows = getInlineRows(getGroupProfileMenuExtra(ctx));
  assert.ok(rows.every((row) => row.length <= 2));
  const buttons = rows.flat();
  const points = buttons.find((b) => b.text === "My Points");
  const myStreak = buttons.find((b) => b.text === "My Streak");
  assert.strictEqual(points.url, `https://t.me/${BOT_USERNAME}?start=points`);
  assert.strictEqual(myStreak.url, `https://t.me/${BOT_USERNAME}?start=streak`);
  const wallet = buttons.find((b) => b.text === "Wallet Status");
  assert.strictEqual(wallet.url, `https://t.me/${BOT_USERNAME}?start=wallet`);
  const rewards = buttons.find((b) => b.text === "Rewards");
  assert.strictEqual(rewards.url, `https://t.me/${BOT_USERNAME}?start=rewards`);
  assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.BACK));
  assert.strictEqual(
    buttons.filter((b) => /streak/i.test(b.text)).length,
    1
  );
  assert.deepStrictEqual(
    rows.map((row) => row.map((b) => b.text)),
    [
      ["My Points", "My Streak"],
      ["Wallet Status", "Rewards"],
      ["⬅️ Back"],
    ]
  );
  assert.deepStrictEqual(
    getInlineRows(getGroupProgressMenuExtra(ctx)).map((row) =>
      row.map((b) => b.text)
    ),
    [
      ["My Points", "My Streak"],
      ["Wallet Status", "Rewards"],
      ["⬅️ Back"],
    ]
  );
});

runTest("/menu private toont reply-keyboard hint", () => {
  const ctx = createMockCtx({ chatType: "private" });
  handleMenu(ctx);
  assert.strictEqual(ctx.replies[0].text, PRIVATE_MENU_HINT);
  assert.ok(ctx.replies[0].extra.reply_markup.keyboard);
  const rows = ctx.replies[0].extra.reply_markup.keyboard;
  assert.deepStrictEqual(rows, [
    [MENU_LABELS.MY_PROFILE, MENU_LABELS.WALLET],
    [MENU_LABELS.REWARDS, MENU_LABELS.HELP],
    [MENU_LABELS.DAILY_QUEST, MENU_LABELS.SHOP],
    [MENU_LABELS.COMMUNITY_BUILDER],
    [MENU_LABELS.SNAKE, MENU_LABELS.BOUNCH],
  ]);
  assert.ok(rows.every((row) => row.length <= 2));
});

runTest("/start points private → persoonlijke points", () => {
  resetPointsFile({
    users: {
      [String(USER_A)]: {
        name: "Ada",
        points: 9,
        weeklyPoints: 1,
        weekId: "2026-08-04",
        triggerDate: null,
        triggersUsed: [],
        activityDate: null,
      },
    },
  });
  const ctx = createMockCtx({
    chatType: "private",
    userId: USER_A,
    startPayload: "points",
  });
  handleStart(ctx, { pointsFile: testPointsFile });
  assert.ok(ctx.replies[0].text.includes("🥭 Your ManGo Progress"));
  assert.ok(ctx.replies[0].text.includes("XP: 9"));
  assert.ok(ctx.replies[0].text.includes("Claimed today:"));
  assert.ok(ctx.replies[0].text.includes("Current streak:"));
});

runTest("/start points group → geen persoonlijke points", () => {
  resetPointsFile({
    users: {
      [String(USER_A)]: {
        name: "Ada",
        points: 9,
        weeklyPoints: 1,
        weekId: "2026-08-04",
      },
    },
  });
  const ctx = createMockCtx({
    chatType: "group",
    userId: USER_A,
    startPayload: "points",
  });
  handleStart(ctx, { pointsFile: testPointsFile });
  assert.strictEqual(ctx.replies[0].text, WELCOME_MESSAGE);
  assert.ok(!ctx.replies[0].text.includes("Your ManGo Progress"));
});

runTest("Weekly callback gebruikt bestaande weekly logic", async () => {
  const ctx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.WEEKLY,
  });
  await handleGroupMenuCallback(ctx, { pointsFile: testPointsFile });
  assert.strictEqual(ctx.answered.length, 1);
  assert.ok(ctx.replies[0].text.includes("Weekly"));
});

runTest("Weekly Winners callback toont winners board", async () => {
  const ctx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.WEEKLY_WINNERS,
  });
  await handleGroupMenuCallback(ctx, { pointsFile: testPointsFile });
  assert.strictEqual(ctx.answered.length, 1);
  assert.ok(ctx.replies[0].text.includes("ManGo Weekly Winners"));
});

runTest("Leaderboard callback gebruikt bestaande leaderboard logic", async () => {
  const ctx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.LEADERBOARD,
  });
  await handleGroupMenuCallback(ctx, { pointsFile: testPointsFile });
  assert.ok(ctx.replies[0].text.includes("Leaderboard"));
});

runTest("Help callback toont bestaande help", async () => {
  const ctx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.HELP,
  });
  await handleGroupMenuCallback(ctx);
  assert.strictEqual(ctx.replies[0].text, HELP_MESSAGE);
});

runTest("Streak callback toont publieke current streak board", async () => {
  const ctx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.STREAK,
  });
  await handleGroupMenuCallback(ctx, { pointsFile: testPointsFile });
  assert.strictEqual(ctx.answered.length, 1);
  assert.ok(ctx.replies[0].text.includes("ManGo Active Streaks"));
});

runTest("Streak Record callback toont longest board", async () => {
  const ctx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.STREAK_RECORD,
  });
  await handleGroupMenuCallback(ctx, { pointsFile: testPointsFile });
  assert.ok(ctx.replies[0].text.includes("Longest ManGo Streaks"));
});

runTest("Rankings / Games / Profile / Back navigation edits menu", async () => {
  const rankingsCtx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.RANKINGS,
  });
  await handleGroupMenuCallback(rankingsCtx);
  assert.strictEqual(rankingsCtx.edits[0].text, GROUP_RANKINGS_TEXT);
  assert.ok(
    getInlineButtons(rankingsCtx.edits[0].extra).some(
      (b) => b.callback_data === GROUP_MENU_CALLBACK.WEEKLY_WINNERS
    )
  );

  const gamesCtx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.GAMES,
  });
  await handleGroupMenuCallback(gamesCtx);
  assert.strictEqual(gamesCtx.edits[0].text, GROUP_GAMES_TEXT);

  const profileCtx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.PROFILE,
  });
  await handleGroupMenuCallback(profileCtx);
  assert.strictEqual(profileCtx.edits[0].text, GROUP_PROFILE_TEXT);

  const progressCtx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.PROGRESS,
  });
  await handleGroupMenuCallback(progressCtx);
  assert.strictEqual(progressCtx.edits[0].text, GROUP_PROGRESS_TEXT);

  const backCtx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.BACK,
  });
  await handleGroupMenuCallback(backCtx);
  assert.strictEqual(backCtx.edits[0].text, GROUP_MENU_TEXT);
  assert.deepStrictEqual(
    getInlineButtons(backCtx.edits[0].extra).map((b) => b.text),
    [
      "🏆 Rankings",
      "🎮 Games",
      "👤 My Profile",
      "👛 Wallet",
      "🎁 Rewards",
      "ℹ️ Help",
      "🎯 Daily Quest",
      "🏪 ManGo Shop",
      "🤝 Community Builder",
    ]
  );
});

runTest("Back fallback replies when edit unavailable", async () => {
  const ctx = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.BACK,
  });
  delete ctx.editMessageText;
  await handleGroupMenuCallback(ctx);
  assert.strictEqual(ctx.replies[0].text, GROUP_MENU_TEXT);
});

runTest("Tic-Tac-Toe menu lets members start (no admin required)", async () => {
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_CHAT_ID = String(-1003916996602);
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  try {
    const ctx = createMockCtx({
      chatType: "supergroup",
      callbackData: GROUP_MENU_CALLBACK.TICTACTOE,
    });
    let started = false;
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return {
          ok: true,
          text: "🎮 Tic-Tac-Toe challenge open",
          session: { id: "ttt-1" },
        };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, true);
    assert.ok(ctx.replies[0].text.includes("Tic-Tac-Toe"));
  } finally {
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChat;
  }
});

runTest("Tic-Tac-Toe menu respects Games topic gate", async () => {
  const ctx = createMockCtx({
    chatType: "supergroup",
    callbackData: GROUP_MENU_CALLBACK.TICTACTOE,
  });
  await handleGroupMenuCallback(ctx, {
    isBusyFn: () => false,
    assertCanStartFn: async () => ({ ok: false, reason: "wrong-topic" }),
    startChallengeFn: () => {
      throw new Error("must not start");
    },
  });
  assert.ok(ctx.replies[0].text.includes("Games topic"));
});

runTest("Connect Four menu lets members start (no admin required)", async () => {
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_CHAT_ID = String(-1003916996602);
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  try {
    const ctx = createMockCtx({
      chatType: "supergroup",
      callbackData: GROUP_MENU_CALLBACK.CONNECT4,
    });
    let started = false;
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return {
          ok: true,
          text: "🟡 Connect Four challenge open",
          session: { id: "c4-1" },
        };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, true);
    assert.ok(ctx.replies[0].text.includes("Connect Four"));
  } finally {
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChat;
  }
});

runTest("Trivia menu opens category chooser (no admin required)", async () => {
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_CHAT_ID = String(-1003916996602);
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  try {
    const ctx = createMockCtx({
      chatType: "supergroup",
      callbackData: GROUP_MENU_CALLBACK.TRIVIA,
    });
    let started = false;
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startTriviaFn: () => {
        started = true;
        return {
          ok: true,
          text: "🧠 Trivia round",
          session: { id: "tr-1" },
          keyboard: {},
        };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, false);
    const view = ctx.edits[0] || ctx.replies[0];
    assert.ok(view.text.includes("ManGo Trivia"));
    assert.ok(view.text.includes("Choose a category"));
    const buttons = (view.extra.reply_markup.inline_keyboard || []).flat();
    assert.ok(buttons.some((b) => /Geography/.test(b.text)));
    assert.ok(buttons.some((b) => b.callback_data === "trivia:cat:geography"));
    assert.ok(buttons.some((b) => b.callback_data === "trivia:games"));
  } finally {
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChat;
  }
});

runTest("ManGo Bomb menu lets members start (no admin required)", async () => {
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_CHAT_ID = String(-1003916996602);
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  try {
    const ctx = createMockCtx({
      chatType: "supergroup",
      callbackData: GROUP_MENU_CALLBACK.MANGOBOMB,
    });
    let started = false;
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startLobbyFn: () => {
        started = true;
        return {
          ok: true,
          gameId: "aabbccdd",
          text: "🥭💣 MANGO BOMB!",
          extra: {},
        };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, true);
    assert.ok(ctx.replies[0].text.includes("MANGO BOMB"));
  } finally {
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChat;
  }
});

runTest("/start streak private → persoonlijke streak, geen uid", () => {
  const ctx = createMockCtx({
    chatType: "private",
    userId: USER_A,
    startPayload: "streak",
  });
  handleStart(ctx, { pointsFile: testPointsFile });
  assert.ok(ctx.replies[0].text.includes("Your ManGo Streak"));
  assert.ok(ctx.replies[0].text.includes("Current streak:"));
  assert.ok(!JSON.stringify(ctx.replies[0]).includes("uid="));
});

runTest("/start streak group → geen persoonlijke streak dump", () => {
  const ctx = createMockCtx({
    chatType: "group",
    userId: USER_A,
    startPayload: "streak",
  });
  handleStart(ctx, { pointsFile: testPointsFile });
  assert.strictEqual(ctx.replies[0].text, WELCOME_MESSAGE);
  assert.ok(!ctx.replies[0].text.includes("Your ManGo Streak"));
});

runTest("/menu command skips daily activity", () => {
  assert.strictEqual(shouldSkipCommunityActivity(createMockCtx(), "/menu"), true);
});

runTest("private My Profile submenu layout and Back", async () => {
  const ctx = createMockCtx({ chatType: "private" });
  handlePrivateProfile(ctx);
  assert.ok(ctx.replies[0].text.includes(GROUP_PROFILE_TEXT));
  assert.ok(ctx.replies[0].text.includes("Community Title:"));
  assert.ok(ctx.replies[0].text.includes("ManGo Loot:"));
  const rows = getInlineRows(ctx.replies[0].extra);
  assert.ok(rows.every((row) => row.length <= 2));
  assert.deepStrictEqual(
    rows.map((row) => row.map((b) => b.text)),
    [
      ["My Points", "My Streak"],
      ["Wallet Status", "Rewards"],
      ["⬅️ Back"],
    ]
  );
  assert.strictEqual(
    rows[2][0].callback_data,
    PRIVATE_HUB_CALLBACK.PROFILE_BACK
  );

  const backCtx = createMockCtx({
    chatType: "private",
    callbackData: PRIVATE_HUB_CALLBACK.PROFILE_BACK,
  });
  await handlePrivateHubCallback(backCtx);
  assert.strictEqual(backCtx.replies[0].text, PRIVATE_MENU_HINT);
});

Promise.all(pendingAsyncTests)
  .then(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll bot-menu tests passed.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
