/**
 * ManGo UX / information-architecture: menu order, Daily Quest vs Profile,
 * Activity Streak vs Quest Streak, Help, /start, and navigation.
 * Run: node tests/menu-ux.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);
const {
  MENU_LABELS,
  GROUP_MENU_CALLBACK,
  PRIVATE_HUB_CALLBACK,
  MAIN_MENU_BUTTON_LABEL,
  PRIVATE_GAMES_TEXT,
  PRIVATE_MENU_HINT,
  getPrivateMenuKeyboard,
  getGroupMenuExtra,
  getGroupRankingsMenuExtra,
  getRankingsResultExtra,
  getPrivateRankingsMenuExtra,
  getPrivateGamesMenuExtra,
  getGroupProfileMenuExtra,
  getPrivateProfileMenuExtra,
} = require("../utils/botMenu");
const { handleMenu, handlePrivateProfile } = require("../commands/menu");
const { handleDailyQuest, buildHomeText } = require("../commands/dailyquest");
const { handlePoints } = require("../commands/points");
const { handleHelp, HELP_MESSAGE } = require("../commands/help");
const { handleStart, WELCOME_MESSAGE } = require("../commands/start");
const { handleCommunityBuilder } = require("../commands/communitybuilder");
const { handleLeaderboard } = require("../commands/leaderboard");
const { WELCOME_TEXT, WELCOME_TEXT_NO_WALLET_WARNING } = require("../events/welcome");
const { CONCISE_WALLET_GRACE_NOTICE } = require("../services/walletGrace");
const {
  formatClaimedTodayLines,
  formatPointsCard,
  getUserRecord,
  loadPoints,
} = require("../services/points");
const { setWalletFileForTests, registerManualWallet } = require("../services/walletLinks");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-menu-ux-"));
const pointsFile = path.join(tempDir, "points.json");
const walletFile = path.join(tempDir, "wallet.json");
const shopFile = path.join(tempDir, "shop.json");
fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }), "utf8");
fs.writeFileSync(walletFile, JSON.stringify({ users: {}, wallets: {} }), "utf8");
setWalletFileForTests(walletFile);
setMangoShopFileForTests(shopFile);

const USER = 88001;
const files = { pointsFile, walletFile, shopFile };

function walletAddress(seed) {
  return encodeBase58(crypto.createHash("sha256").update(String(seed)).digest());
}

function mockCtx({
  chatType = "private",
  userId = USER,
  firstName = "Ada",
  callbackData,
  botUsername = "ManGoUxBot",
} = {}) {
  const replies = [];
  const edits = [];
  const answered = [];
  return {
    chat: { type: chatType, id: chatType === "private" ? userId : -1001 },
    from: { id: userId, first_name: firstName },
    botInfo: { username: botUsername },
    callbackQuery: callbackData
      ? { data: callbackData, message: { message_id: 1 } }
      : undefined,
    replies,
    edits,
    answered,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve({ text, extra, message_id: 1 });
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve({ text, extra });
    },
    answerCbQuery(text) {
      answered.push(text || "");
      return Promise.resolve();
    },
  };
}

function labelsOf(extra) {
  const rows =
    (extra && extra.reply_markup && extra.reply_markup.inline_keyboard) || [];
  return rows.flat().map((b) => b.text);
}

function runTest(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.then(() => console.log(`✓ ${name}`));
  }
  console.log(`✓ ${name}`);
  return Promise.resolve();
}

(async () => {
  await runTest("1. group main-menu layout and copy", () => {
    const ctx = mockCtx({ chatType: "supergroup" });
    handleMenu(ctx);
    assert.ok(ctx.replies[0].text.includes("🥭 ManGo Menu"));
    assert.ok(ctx.replies[0].text.includes("Your ManGo hub."));
    assert.ok(
      ctx.replies[0].text.includes("Start with Wallet, then check Daily Quest")
    );
    assert.deepStrictEqual(labelsOf(ctx.replies[0].extra), [
      "👛 Wallet",
      "🎯 Daily Quest",
      "👤 My Profile",
      "🎮 Games",
      "🏆 Rankings",
      "🎁 Rewards",
      "🏪 ManGo Shop",
      "🤝 Community Builder",
      "ℹ️ Help",
    ]);
    assert.strictEqual(labelsOf(ctx.replies[0].extra)[0], "👛 Wallet");
  });

  await runTest("2. private menu same nine destinations plus Snake/Bounch", () => {
    const rows = getPrivateMenuKeyboard().reply_markup.keyboard;
    assert.deepStrictEqual(rows, [
      [MENU_LABELS.WALLET, MENU_LABELS.DAILY_QUEST],
      [MENU_LABELS.MY_PROFILE, MENU_LABELS.GAMES],
      [MENU_LABELS.RANKINGS, MENU_LABELS.REWARDS],
      [MENU_LABELS.SHOP, MENU_LABELS.COMMUNITY_BUILDER],
      [MENU_LABELS.HELP],
      [MENU_LABELS.SNAKE, MENU_LABELS.BOUNCH],
    ]);
    const ctx = mockCtx();
    handleMenu(ctx);
    assert.strictEqual(ctx.replies[0].text, PRIVATE_MENU_HINT);
    assert.ok(PRIVATE_MENU_HINT.includes("Start with Wallet"));
  });

  await runTest("3-8. Daily Quest XP TODAY vs DAILY QUESTS; checklist source", () => {
    registerManualWallet(USER, walletAddress("ux-1"), walletFile, 1);
    const user = getUserRecord(loadPoints(pointsFile), USER);
    const checklist = formatClaimedTodayLines(user);
    const text = buildHomeText(USER, files);
    assert.ok(text.includes("⚡ XP TODAY"));
    assert.ok(text.includes("🎯 DAILY QUESTS"));
    assert.ok(text.includes("Complete Daily Quests to earn ManGo Loot"));
    assert.ok(text.includes("🎯 Quest Streak:"));
    assert.ok(!text.includes("🔥 Streak:"));
    assert.ok(text.includes(checklist));
    assert.ok(checklist.includes("⬜ Daily activity"));
    assert.ok(text.includes("Complete each quest: +5"));
    assert.ok(text.includes("Complete all 3: +10 bonus"));
  });

  await runTest("9-11. Profile and /points slim status, no claimed-today", () => {
    const ctx = mockCtx();
    handlePrivateProfile(ctx, files);
    const profile = ctx.replies[0].text;
    assert.ok(profile.includes("👤 My Profile"));
    assert.ok(profile.includes("XP:"));
    assert.ok(profile.includes("Weekly XP:"));
    assert.ok(profile.includes("Activity Streak:"));
    assert.ok(profile.includes("Builder Points (BP, not XP)"));
    assert.ok(profile.includes("ManGo Loot:"));
    assert.ok(!profile.includes("Claimed today:"));
    assert.ok(!profile.includes("⬜ Daily activity"));
    assert.deepStrictEqual(labelsOf(ctx.replies[0].extra), [
      "🎯 Daily Quest",
      "👛 Wallet",
      "🏆 Rankings",
      "⬅️ Back",
    ]);
    const pointsCtx = mockCtx();
    handlePoints(pointsCtx, files);
    assert.ok(pointsCtx.replies[0].text.includes("Open 🎯 Daily Quest"));
    assert.ok(!pointsCtx.replies[0].text.includes("Claimed today:"));
    const user = getUserRecord(loadPoints(pointsFile), USER);
    const card = formatPointsCard(user);
    assert.ok(card.includes("Activity Streak:"));
    assert.ok(!card.includes("Claimed today:"));
  });

  await runTest("12. Activity Streak vs Quest Streak wording", () => {
    const profile = mockCtx();
    handlePrivateProfile(profile, files);
    assert.ok(profile.replies[0].text.includes("🔥 Activity Streak:"));
    assert.ok(!profile.replies[0].text.includes("Quest Streak"));
    const quest = buildHomeText(USER, files);
    assert.ok(quest.includes("🎯 Quest Streak:"));
    const rankings = getGroupRankingsMenuExtra();
    const names = labelsOf(rankings);
    assert.ok(names.includes("Activity Streak"));
    assert.ok(!names.includes("Streak"));
  });

  await runTest("13-14. Builder Points distinguished; referrals explained", () => {
    const ctx = mockCtx();
    handleCommunityBuilder(ctx, files);
    const text = ctx.replies[0].text;
    assert.ok(text.includes("BP is not XP"));
    assert.ok(text.includes("Genuine referrals can earn BP"));
    assert.ok(text.includes("Useful contributions may also receive BP"));
    const buttons = labelsOf(ctx.replies[0].extra);
    assert.ok(buttons.includes("📨 My Invite Link"));
    assert.ok(buttons.includes("👥 My Referrals"));
  });

  await runTest("15. Rankings result has Back and Main Menu", () => {
    const ctx = mockCtx({ chatType: "supergroup" });
    handleLeaderboard(ctx, files);
    const names = labelsOf(ctx.replies[0].extra);
    assert.ok(names.includes("⬅️ Rankings"));
    assert.ok(names.includes(MAIN_MENU_BUTTON_LABEL));
    const privateExtra = getRankingsResultExtra(mockCtx());
    assert.ok(labelsOf(privateExtra).includes("⬅️ Rankings"));
    assert.ok(
      getPrivateRankingsMenuExtra().reply_markup.inline_keyboard.flat().some(
        (b) => b.callback_data === PRIVATE_HUB_CALLBACK.PROFILE_BACK
      )
    );
  });

  await runTest("16. Games private explanation does not start group games", () => {
    assert.ok(PRIVATE_GAMES_TEXT.includes("Games topic"));
    assert.ok(PRIVATE_GAMES_TEXT.includes("Tic-Tac-Toe"));
    const extra = getPrivateGamesMenuExtra(mockCtx());
    const blob = JSON.stringify(extra);
    assert.ok(!blob.includes(GROUP_MENU_CALLBACK.TICTACTOE));
    assert.ok(!blob.includes(GROUP_MENU_CALLBACK.MANGOBOMB));
  });

  await runTest("17-19. Wallet/Rewards/Shop remain first-level destinations", () => {
    const group = labelsOf(getGroupMenuExtra(mockCtx({ chatType: "group" })));
    assert.ok(group.includes("👛 Wallet"));
    assert.ok(group.includes("🎁 Rewards"));
    assert.ok(group.includes("🏪 ManGo Shop"));
    const privateRows = getPrivateMenuKeyboard().reply_markup.keyboard.flat();
    assert.ok(privateRows.includes(MENU_LABELS.WALLET));
    assert.ok(privateRows.includes(MENU_LABELS.REWARDS));
    assert.ok(privateRows.includes(MENU_LABELS.SHOP));
  });

  await runTest("20-22. Help beginner loop; /start to /menu; no /launch", () => {
    assert.ok(HELP_MESSAGE.includes("Register your wallet"));
    assert.ok(HELP_MESSAGE.includes("Open /menu"));
    assert.ok(HELP_MESSAGE.includes("Check Daily Quest"));
    assert.ok(HELP_MESSAGE.includes("Activity Streak"));
    assert.ok(HELP_MESSAGE.includes("Builder Points"));
    assert.ok(HELP_MESSAGE.includes("ManGo Loot"));
    assert.ok(!HELP_MESSAGE.includes("/launch"));
    assert.ok(!HELP_MESSAGE.includes("/tictactoe"));
    const help = mockCtx();
    handleHelp(help);
    assert.strictEqual(help.replies[0].text, HELP_MESSAGE);
    assert.ok(WELCOME_MESSAGE.includes("Open /menu"));
    assert.ok(!WELCOME_MESSAGE.includes("/help"));
    const start = mockCtx();
    handleStart(start);
    assert.strictEqual(start.replies[0].text, WELCOME_MESSAGE);
  });

  await runTest("23. wallet-grace wording unchanged", () => {
    const text = WELCOME_TEXT("Ada");
    assert.ok(text.includes("connect your Solana wallet within 48 hours"));
    assert.ok(text.includes("Use /menu → Wallet to register your wallet."));
    assert.ok(text.includes("automatic removal"));
    assert.ok(text.includes("Then open /menu in a private chat with the bot."));
    assert.ok(!WELCOME_TEXT_NO_WALLET_WARNING("Ada").includes("48 hours"));
    assert.ok(
      CONCISE_WALLET_GRACE_NOTICE.includes(
        "Use /menu → Wallet to register your wallet."
      )
    );
    assert.ok(!CONCISE_WALLET_GRACE_NOTICE.includes("Start Here"));
  });

  await runTest("24. locked Daily Quest asks for wallet first", () => {
    const other = 88002;
    const ctx = mockCtx({ userId: other });
    handleDailyQuest(ctx, files);
    assert.ok(ctx.replies[0].text.includes("Connect your wallet first"));
    assert.ok(!ctx.replies[0].text.includes("⚡ XP TODAY"));
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll menu-ux tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
