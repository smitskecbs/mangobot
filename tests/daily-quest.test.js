/**
 * Daily Quest activities, wallet gate, menu, and concurrency.
 * Run: node tests/daily-quest.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { spawn } = require("child_process");

const { encodeBase58 } = require("../utils/base58");
const { setMangoShopFileForTests, loadShopStore } = require("../services/mangoShopStore");
const { getLootBalance, getLootAccount } = require("../services/mangoLoot");
const {
  noteDailyQuestCommunity,
  noteDailyQuestGame,
  noteDailyQuestXp,
  getDailyQuestSnapshot,
  utcDate,
  ACTIVITY_LOOT,
  FULL_COMPLETION_LOOT,
  BASE_DAILY_MAX,
  GAME_SOURCES,
  QUEST_IDS,
  completeSelectedQuests,
  fillDailyQuest,
  selectQuestsForDate,
  findUtcDateForSelection,
} = require("../services/dailyQuest");
const { setWalletFileForTests, registerManualWallet, disconnectWallet, mutateWalletStore, applyVerifiedWallet } = require("../services/walletLinks");
const { awardDailyActivityPoint, awardSnakeGameXp, awardBounchGameXp, awardChatFightXp, awardMangoBombXp } = require("../services/points");
const { processCommunityMessage, isEligibleDailyQuestCommunityMessage } = require("../events/points-trigger");
const { MENU_LABELS, getPrivateMenuKeyboard, getGroupMenuExtra } = require("../utils/botMenu");
const { handleDailyQuest, handleDailyQuestCallback, parseDailyQuestCallback, GROUP_QUEST_TEXT } = require("../commands/dailyquest");
const { handleMenu } = require("../commands/menu");
const { HELP_MESSAGE } = require("../commands/help");
const { purchaseTitle, formatShopProgressBlock } = require("../services/mangoShop");
const { loadMemberDetail } = require("../services/phase2ControlCenter");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-dquest-"));
let n = 0;
const USER = "7001";
const CHAT = -1001234567890;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
process.env.TELEGRAM_CHAT_ID = String(CHAT);
const DAY = Date.UTC(2026, 7, 24, 12, 0, 0);
const DATE = utcDate(DAY);

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function walletAddress(seed) {
  return encodeBase58(crypto.createHash("sha256").update(String(seed)).digest());
}

function nextFiles() {
  n += 1;
  const shopFile = path.join(tempDir, `shop-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(walletFile, JSON.stringify({ users: {}, wallets: {} }, null, 2), "utf8");
  setMangoShopFileForTests(shopFile);
  setWalletFileForTests(walletFile);
  return { shopFile, walletFile, pointsFile };
}

function link(files, userId = USER) {
  registerManualWallet(userId, walletAddress(`w-${n}-${userId}`), files.walletFile, DAY);
}

function opts(files, now = DAY) {
  return {
    shopFile: files.shopFile,
    walletFile: files.walletFile,
    pointsFile: files.pointsFile,
    now,
    date: utcDate(now),
  };
}

function groupCtx({ userId = USER, text = "hello mango", isBot = false, extra = {} } = {}) {
  return {
    from: { id: Number(userId), is_bot: isBot, first_name: "Ada" },
    chat: { id: CHAT, type: "supergroup" },
    message: Object.assign({ text, message_id: 1 }, extra),
  };
}

function mockPrivate({ userId = USER, data } = {}) {
  const replies = [];
  const edits = [];
  const answered = [];
  return {
    from: { id: Number(userId), first_name: "Ada" },
    chat: { type: "private", id: Number(userId) },
    callbackQuery: data ? { data } : undefined,
    replies,
    edits,
    answered,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve();
    },
    answerCbQuery(text) {
      answered.push(text || "");
      return Promise.resolve();
    },
  };
}

function spawnQuest(mode, files, userId, now, amount) {
  return new Promise((resolve) => {
    const args = [
      path.join(__dirname, "helpers", "daily-quest-worker.js"),
      mode,
      files.shopFile,
      files.walletFile,
      String(userId),
      String(now),
    ];
    if (amount) args.push(String(amount));
    const child = spawn(process.execPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const communityDay = findUtcDateForSelection({ social: QUEST_IDS.COMMUNITY_ACTIVITY });
const botDay = findUtcDateForSelection({ game: QUEST_IDS.BOT_GAME_1 });
const xpDay = findUtcDateForSelection({ progression: QUEST_IDS.EARN_XP_3 });

function communityOpts(files) {
  return opts(files, communityDay.now);
}

function botOpts(files) {
  return opts(files, botDay.now);
}

function xpOpts(files) {
  return opts(files, xpDay.now);
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("10. daily state starts 0/3", async () => {
    const files = nextFiles();
    link(files);
    const snap = getDailyQuestSnapshot(USER, opts(files));
    assert.strictEqual(snap.completedToday, 0);
    assert.strictEqual(snap.loot, 0);
    assert.strictEqual(snap.streak, 0);
  });

  await runTest("11-14. community message once; slash/bot ignored", async () => {
    const files = nextFiles();
    link(files);
    const ok = await processCommunityMessage(groupCtx({ text: "hello mango" }), communityOpts(files));
    assert.ok(ok);
    assert.strictEqual(isEligibleDailyQuestCommunityMessage(groupCtx({ text: "hello" })), true);
    assert.strictEqual(
      isEligibleDailyQuestCommunityMessage(groupCtx({ text: "/points" })),
      false
    );
    await processCommunityMessage(groupCtx({ text: "/help" }), communityOpts(files));
    await processCommunityMessage(groupCtx({ text: "hi", isBot: true }), communityOpts(files));
    await processCommunityMessage(groupCtx({ text: "hello again" }), communityOpts(files));
    const snap = getDailyQuestSnapshot(USER, communityOpts(files));
    assert.strictEqual(snap.community.completed, true);
    assert.strictEqual(getLootBalance(USER, files.shopFile), ACTIVITY_LOOT);
  });

  await runTest("sticker-only does not complete community quest", async () => {
    const files = nextFiles();
    link(files);
    const ctx = groupCtx({ text: undefined, extra: { sticker: { file_id: "x" } } });
    delete ctx.message.text;
    await processCommunityMessage(ctx, communityOpts(files));
    const snap = getDailyQuestSnapshot(USER, communityOpts(files));
    assert.strictEqual(snap.community.completed, false);
  });

  await runTest("15-17. valid bot game once; snake/bounch/cancelled do not", async () => {
    const files = nextFiles();
    link(files);
    noteDailyQuestGame(USER, "chatfight", botOpts(files));
    let snap = getDailyQuestSnapshot(USER, botOpts(files));
    assert.strictEqual(snap.game.completed, true);
    assert.strictEqual(getLootBalance(USER, files.shopFile), ACTIVITY_LOOT);
    const skip = nextFiles();
    link(skip);
    await awardSnakeGameXp(USER, "Ada", skip.pointsFile, skip.walletFile);
    await awardBounchGameXp(USER, "Ada", 1, skip.pointsFile, skip.walletFile);
    const skipped = getDailyQuestSnapshot(USER, botOpts(skip));
    assert.strictEqual(skipped.game.completed, false);
    assert.ok(!GAME_SOURCES.includes("snake"));
    assert.ok(!GAME_SOURCES.includes("bounch"));
    const files2 = nextFiles();
    link(files2);
    await awardMangoBombXp(USER, "Ada", 0, "", files2.pointsFile, files2.walletFile);
    const empty = getDailyQuestSnapshot(USER, botOpts(files2));
    assert.strictEqual(empty.game.completed, false);
    assert.strictEqual(getLootBalance(USER, files2.shopFile), 0);
  });

  await runTest("18-21. XP progress 1/3 then 3/3 awards +5", async () => {
    const files = nextFiles();
    link(files);
    noteDailyQuestXp(USER, 1, xpOpts(files));
    let snap = getDailyQuestSnapshot(USER, xpOpts(files));
    assert.strictEqual(snap.xp.progress, 1);
    assert.strictEqual(snap.xp.completed, false);
    assert.strictEqual(getLootBalance(USER, files.shopFile), 0);
    noteDailyQuestXp(USER, 2, xpOpts(files));
    snap = getDailyQuestSnapshot(USER, xpOpts(files));
    assert.strictEqual(snap.xp.completed, true);
    assert.strictEqual(getLootBalance(USER, files.shopFile), ACTIVITY_LOOT);
  });

  await runTest("20. blocked XP does not count", async () => {
    const files = nextFiles();
    const blocked = await awardDailyActivityPoint(USER, "Ada", files.pointsFile, DATE, files.walletFile);
    assert.strictEqual(blocked.awarded, false);
    const snap = getDailyQuestSnapshot(USER, xpOpts(files));
    assert.strictEqual(snap.xp.progress, 0);
  });

  await runTest("22-24. all 3 gives +10; day total 25; duplicates no extra", async () => {
    const files = nextFiles();
    link(files);
    completeSelectedQuests(USER, opts(files));
    completeSelectedQuests(USER, opts(files));
    const snap = getDailyQuestSnapshot(USER, opts(files));
    assert.strictEqual(snap.completedToday, 3);
    assert.strictEqual(snap.fullComplete, true);
    assert.strictEqual(getLootBalance(USER, files.shopFile), BASE_DAILY_MAX);
    assert.strictEqual(snap.lootAwardedToday, BASE_DAILY_MAX);
  });

  await runTest("25. restart no duplicate", async () => {
    const files = nextFiles();
    link(files);
    const first = selectQuestsForDate(utcDate(DAY))[0];
    fillDailyQuest(USER, first, opts(files));
    setMangoShopFileForTests(files.shopFile);
    fillDailyQuest(USER, first, opts(files));
    assert.strictEqual(getLootBalance(USER, files.shopFile), ACTIVITY_LOOT);
    const store = loadShopStore(files.shopFile);
    const spends = Object.values(store.transactions).filter((row) => row.reason === "daily-activity");
    assert.strictEqual(spends.length, 1);
  });

  await runTest("26-27. next UTC day fresh; previous does not leak", async () => {
    const files = nextFiles();
    link(files);
    completeSelectedQuests(USER, opts(files));
    const next = DAY + 24 * 60 * 60 * 1000;
    const snap = getDailyQuestSnapshot(USER, opts(files, next));
    assert.strictEqual(snap.completedToday, 0);
    const prev = getDailyQuestSnapshot(USER, opts(files, DAY));
    assert.strictEqual(prev.completedToday, 3);
  });

  await runTest("28-32. unlinked view, no loot, registered/verified unlock, no retroactive", async () => {
    const files = nextFiles();
    const ctx = mockPrivate();
    handleDailyQuest(ctx, communityOpts(files));
    assert.ok(ctx.replies[0].text.includes("Loot earning locked"));
    noteDailyQuestCommunity(USER, communityOpts(files));
    assert.strictEqual(getLootBalance(USER, files.shopFile), 0);
    const snap = getDailyQuestSnapshot(USER, communityOpts(files));
    assert.strictEqual(snap.community.completed, true);
    assert.strictEqual(snap.community.lootSkipped, true);
    link(files);
    noteDailyQuestCommunity(USER, communityOpts(files));
    assert.strictEqual(getLootBalance(USER, files.shopFile), 0);
    noteDailyQuestGame(USER, "trivia", botOpts(files));
    assert.strictEqual(getLootBalance(USER, files.shopFile), ACTIVITY_LOOT);
    const filesV = nextFiles();
    mutateWalletStore((store) => {
      applyVerifiedWallet(store, USER, walletAddress("verified"), DAY);
    }, filesV.walletFile);
    noteDailyQuestCommunity(USER, communityOpts(filesV));
    assert.strictEqual(getLootBalance(USER, filesV.shopFile), ACTIVITY_LOOT);
  });

  await runTest("33-34. unlink blocks future; re-link enables", async () => {
    const files = nextFiles();
    link(files);
    const selected = selectQuestsForDate(utcDate(DAY));
    fillDailyQuest(USER, selected[0], opts(files));
    assert.strictEqual(getLootBalance(USER, files.shopFile), ACTIVITY_LOOT);
    disconnectWallet(USER, files.walletFile);
    fillDailyQuest(USER, selected[1], opts(files));
    assert.strictEqual(getLootBalance(USER, files.shopFile), ACTIVITY_LOOT);
    const skipped = getDailyQuestSnapshot(USER, opts(files));
    assert.strictEqual(skipped.questList[1].completed, true);
    assert.strictEqual(skipped.questList[1].lootSkipped, true);
    link(files);
    fillDailyQuest(USER, selected[2], opts(files));
    assert.strictEqual(
      getLootBalance(USER, files.shopFile),
      ACTIVITY_LOOT * 2 + FULL_COMPLETION_LOOT
    );
  });

  await runTest("46-51. menu, private, group redirect, refresh, shop link", async () => {
    const files = nextFiles();
    link(files);
    const kb = getPrivateMenuKeyboard({ from: { id: Number(USER) } });
    assert.ok(kb.reply_markup.keyboard.flat().includes(MENU_LABELS.DAILY_QUEST));
    assert.ok(kb.reply_markup.keyboard.flat().includes(MENU_LABELS.SHOP));
    const menu = mockPrivate();
    handleMenu(menu);
    assert.ok(menu.replies[0].extra.reply_markup.keyboard.flat().includes(MENU_LABELS.DAILY_QUEST));
    const priv = mockPrivate();
    handleDailyQuest(priv, opts(files));
    assert.ok(priv.replies[0].text.includes("🎯 Daily Quest"));
    assert.ok(priv.replies[0].text.includes("UTC"));
    assert.ok(priv.replies[0].text.includes("Today:"));
    assert.ok(priv.replies[0].text.includes("Complete each quest: +5"));
    const selected = selectQuestsForDate(utcDate(DAY));
    if (selected.includes(QUEST_IDS.BOT_GAME_1)) {
      assert.ok(priv.replies[0].text.includes("Snake and Bounch do not count"));
    }
    if (selected.includes(QUEST_IDS.PVP_GAME_1)) {
      assert.ok(priv.replies[0].text.includes("another member"));
    }
    assert.ok(!priv.replies[0].text.includes("🎮 Play a Game"));
    const group = {
      from: { id: Number(USER) },
      chat: { type: "supergroup", id: CHAT },
      replies: [],
      reply(text) {
        this.replies.push({ text });
        return Promise.resolve();
      },
    };
    handleDailyQuest(group, opts(files));
    assert.strictEqual(group.replies[0].text, GROUP_QUEST_TEXT);
    const refresh = mockPrivate({ data: "dquest:refresh" });
    await handleDailyQuestCallback(refresh, opts(files));
    assert.ok((refresh.edits[0] || refresh.replies[0]).text.includes("Daily Quest"));
    assert.strictEqual(parseDailyQuestCallback("dquest:home:7001"), null);
    assert.ok(!HELP_MESSAGE.includes("/dailyquest"));
    const labels = getGroupMenuExtra({
      from: { id: 1 },
      chat: { type: "group" },
      botInfo: { username: "ManGoBot" },
    }).reply_markup.inline_keyboard.flat().map((b) => b.text);
    const shop = mockPrivate({ data: "dquest:shop" });
    await handleDailyQuestCallback(shop, opts(files));
    assert.ok((shop.replies[0] || shop.edits[0]).text.includes("🏪 ManGo Shop"));
  });

  await runTest("52-53. profile compact progress; Phase 2 detail", async () => {
    const files = nextFiles();
    link(files);
    fillDailyQuest(USER, selectQuestsForDate(utcDate(DAY))[0], opts(files));
    fillDailyQuest(USER, selectQuestsForDate(utcDate(DAY))[1], opts(files));
    const block = formatShopProgressBlock(USER, opts(files));
    assert.ok(block.includes("🥭 ManGo Loot:"));
    assert.ok(block.includes("🔥 Daily Streak: 0"));
    assert.ok(block.includes("🎯 Today: 2/3"));
    const detail = loadMemberDetail(USER, opts(files));
    assert.ok(String(detail.dailyQuestToday).includes("2/3"));
    assert.strictEqual(detail.dailyStreak, 0);
    assert.strictEqual(detail.mangoLoot, ACTIVITY_LOOT * 2);
  });

  await runTest("54. callbacks no raw uid", async () => {
    assert.deepStrictEqual(parseDailyQuestCallback("dquest:home"), { action: "home" });
    assert.strictEqual(parseDailyQuestCallback("dquest:buy:7001"), null);
  });

  await runTest("55-56. concurrent activity and full-completion bonus once", async () => {
    const files = nextFiles();
    link(files);
    const selected = selectQuestsForDate(utcDate(DAY));
    fillDailyQuest(USER, selected[0], opts(files));
    fillDailyQuest(USER, selected[1], opts(files));
    const [a, b] = await Promise.all([
      spawnQuest("fill", files, USER, DAY, selected[2]),
      spawnQuest("fill", files, USER, DAY, selected[2]),
    ]);
    assert.strictEqual(a.status, 0, a.stderr);
    assert.strictEqual(b.status, 0, b.stderr);
    assert.strictEqual(getLootBalance(USER, files.shopFile), BASE_DAILY_MAX);
    const store = loadShopStore(files.shopFile);
    const full = Object.values(store.transactions).filter(
      (row) => row.referenceId && String(row.referenceId).includes("full-completion")
    );
    assert.strictEqual(full.length, 1);
  });

  await runTest("58. title purchase + daily loot stay coherent", async () => {
    const files = nextFiles();
    link(files);
    const { awardLoot } = require("../services/mangoLoot");
    awardLoot(USER, 40, "admin-award", "seed-buy", { shopFile: files.shopFile });
    fs.writeFileSync(
      files.pointsFile,
      JSON.stringify({
        users: { [USER]: { name: "Ada", points: 120, weeklyPoints: 0 } },
      }),
      "utf8"
    );
    const builderFile = path.join(tempDir, `builder-${n}.json`);
    fs.writeFileSync(
      builderFile,
      JSON.stringify({
        version: 1,
        builders: { [USER]: { points: 20, referralIds: [], displayName: "Ada", createdAt: 1, activeInviteId: null } },
        referrals: {},
        inviteLinks: {},
        builderEvents: {},
        welcomeOpportunities: {},
      }),
      "utf8"
    );
    completeSelectedQuests(USER, opts(files));
    purchaseTitle(USER, "supporter", {
      shopFile: files.shopFile,
      pointsFile: files.pointsFile,
      builderFile,
    });
    const acc = getLootAccount(USER, files.shopFile);
    assert.ok(acc.balance >= 0);
    assert.strictEqual(acc.lifetimeEarned - acc.lifetimeSpent, acc.balance);
  });

  await runTest("no production files touched", async () => {
    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
    }
  });
}

main()
  .then(() => {
    setMangoShopFileForTests(null);
    setWalletFileForTests(null);
    if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChatId;
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll daily-quest tests passed.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
