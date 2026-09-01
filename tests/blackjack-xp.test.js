/**
 * ManGo Blackjack XP, daily cap, wallet, pair anti-farm, Daily Quest.
 * Run: node tests/blackjack-xp.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);

const {
  createBlackjackService,
  getBlackjackRuntime,
  STATUS,
} = require("../services/blackjack");
const { createCard } = require("../services/blackjackRules");
const {
  reserveBlackjackRewardedRound,
  awardBlackjackPassXp,
  awardBlackjackBotResultXp,
  awardBlackjackPvpResultXp,
  markBlackjackPvpMatchup,
  getBlackjackStatus,
  BLACKJACK_PASS_XP,
  BLACKJACK_TIE_XP,
  BLACKJACK_BOT_WIN_XP,
  BLACKJACK_PVP_WIN_XP,
  BLACKJACK_STAKE_XP,
  BLACKJACK_DAILY_REWARDED_CAP,
  BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP,
  loadPoints,
  mutatePoints,
  getTodayDate,
  utcYesterday,
} = require("../services/points");
const { registerManualWallet, setWalletFileForTests } = require("../services/walletLinks");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const {
  getDailyQuestSnapshot,
  GAME_SOURCES,
  noteDailyQuestGame,
} = require("../services/dailyQuest");
const { getLootBalance } = require("../services/mangoLoot");
const { isTrueRankUp } = require("../services/rankUpAnnounce");
const { XP_WALLET_REQUIRED } = require("../services/xpWalletGate");
const { assertEligibleBotGameProgress } = require("./helpers/dailyQuestAssert");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-bj-xp-"));
let n = 0;
const COMMUNITY_CHAT = -1001234567890;
const USER_A = "111";
const USER_B = "222";
const USER_C = "333";

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
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
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  const shopFile = path.join(tempDir, `shop-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(walletFile, JSON.stringify({ users: {}, wallets: {} }, null, 2), "utf8");
  setWalletFileForTests(walletFile);
  setMangoShopFileForTests(shopFile);
  return { pointsFile, walletFile, shopFile };
}

function link(files, userId) {
  registerManualWallet(userId, walletAddress(`${n}-${userId}`), files.walletFile);
}

function pointsOf(files, userId) {
  const data = loadPoints(files.pointsFile);
  const user = data.users[String(userId)];
  return user && typeof user.points === "number" ? user.points : 0;
}

function seedPoints(files, userId, points, name = "Player") {
  mutatePoints((data) => {
    data.users[String(userId)] = {
      points,
      weeklyPoints: 0,
      weekId: getTodayDate(),
      name,
      triggerDate: getTodayDate(),
      triggersUsed: [],
      activityDate: null,
    };
  }, files.pointsFile);
}

function attachXp(service, files) {
  service.setAwardHandlers({
    reserve: (userId, name, payload) => reserveBlackjackRewardedRound(userId, name, payload, files.pointsFile, files.walletFile),
    pass: (userId, name, payload) => awardBlackjackPassXp(
        userId,
        name,
        { ...payload, shopFile: files.shopFile },
        files.pointsFile,
        files.walletFile
      ),
    bot: (userId, name, payload) => awardBlackjackBotResultXp(
        userId,
        name,
        { ...payload, shopFile: files.shopFile },
        files.pointsFile,
        files.walletFile
      ),
    pvp: (userId, name, payload) => awardBlackjackPvpResultXp(
        userId,
        name,
        { ...payload, shopFile: files.shopFile },
        files.pointsFile,
        files.walletFile
      ),
    status: (userId) => getBlackjackStatus(userId, files.pointsFile),
    markPair: (userId, opponentId) => markBlackjackPvpMatchup(userId, opponentId, files.pointsFile),
  });
}

function createFakeTimers() {
  let nowMs = 1_700_000_000_000;
  const timers = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
      const due = timers
        .filter((t) => !t.cleared && t.fireAt <= nowMs)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const t of due) {
        if (t.cleared) continue;
        t.cleared = true;
        t.fn();
      }
    },
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.push({ id, fn, fireAt: nowMs + delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
  };
}

function createService() {
  const timers = createFakeTimers();
  const service = createBlackjackService({
    now: () => timers.now(),
    setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
    randomIntFn: () => 0,
    randomIdFn: () => "aabbccdd",
    botThinkMs: 0,
  });
  service.setEditMessageHandler(async () => {});
  service.setSendMessageHandler(async () => {});
  return { service, timers };
}

function starter(userId, name) {
  return { userId, displayName: { first_name: name, id: userId }, isBot: false };
}

async function startBotGame(service) {
  const started = service.startLobby({
    chatId: COMMUNITY_CHAT,
    threadId: 123,
    starter: starter(USER_A, "Alice"),
  });
  service.setMessageId(started.gameId, 9001);
  await service.forceLobbyEnd(started.gameId);
  await service.whenIdle(COMMUNITY_CHAT);
  return started.gameId;
}

async function startPvp(service) {
  const started = service.startLobby({
    chatId: COMMUNITY_CHAT,
    threadId: 123,
    starter: starter(USER_A, "Alice"),
  });
  service.setMessageId(started.gameId, 9001);
  service.tryJoin({
    gameId: started.gameId,
    userId: USER_B,
    displayName: { first_name: "Bob", id: USER_B },
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  });
  await service.forceLobbyEnd(started.gameId);
  await service.whenIdle(COMMUNITY_CHAT);
  return started.gameId;
}

async function decide(service, gameId, userId, choice) {
  return await service.tryDecide({
    gameId,
    userId,
    choice,
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  });
}

async function playBotWin(service) {
  const gameId = await startBotGame(service);
  service.seedDeckForTests(gameId, [
    createCard("K", "spades"),
    createCard("Q", "hearts"),
    createCard("8", "diamonds"),
    createCard("7", "clubs"),
  ]);
  await decide(service, gameId, USER_A, "play");
  await service.whenIdle(COMMUNITY_CHAT);
  await service.tryStand({
    gameId,
    userId: USER_A,
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  });
  await service.whenIdle(COMMUNITY_CHAT);
  return gameId;
}

async function runTest(name, fn) {
  getBlackjackRuntime().reset();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  } finally {
    getBlackjackRuntime().reset();
  }
}

(async () => {
  await runTest("42. provisional 10 not awarded at game start", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    await startBotGame(service);
    assert.strictEqual(pointsOf(files, USER_A), 0);
  });

  await runTest("43. Pass +2", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startBotGame(service);
    await decide(service, gameId, USER_A, "pass");
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_PASS_XP);
  });

  await runTest("44-45. PvP winner both Play +20 loser +0", async () => {
    const files = nextFiles();
    link(files, USER_A);
    link(files, USER_B);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startPvp(service);
    service.seedDeckForTests(gameId, [
      createCard("K", "spades"),
      createCard("9", "hearts"),
      createCard("8", "diamonds"),
      createCard("7", "clubs"),
    ]);
    await decide(service, gameId, USER_A, "play");
    await decide(service, gameId, USER_B, "play");
    await service.whenIdle(COMMUNITY_CHAT);
    await service.tryStand({
      gameId,
      userId: USER_A,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.tryStand({
      gameId,
      userId: USER_B,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_PVP_WIN_XP);
    assert.strictEqual(pointsOf(files, USER_B), 0);
  });

  await runTest("46. PvP tie +5 each", async () => {
    const files = nextFiles();
    link(files, USER_A);
    link(files, USER_B);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startPvp(service);
    service.seedDeckForTests(gameId, [
      createCard("K", "spades"),
      createCard("9", "hearts"),
      createCard("K", "diamonds"),
      createCard("9", "clubs"),
    ]);
    await decide(service, gameId, USER_A, "play");
    await decide(service, gameId, USER_B, "play");
    await service.whenIdle(COMMUNITY_CHAT);
    await service.tryStand({
      gameId,
      userId: USER_A,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.tryStand({
      gameId,
      userId: USER_B,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_TIE_XP);
    assert.strictEqual(pointsOf(files, USER_B), BLACKJACK_TIE_XP);
  });

  await runTest("47. bot win +10", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startBotGame(service);
    service.seedDeckForTests(gameId, [
      createCard("K", "spades"),
      createCard("Q", "hearts"),
      createCard("8", "diamonds"),
      createCard("7", "clubs"),
      createCard("2", "spades"),
    ]);
    await decide(service, gameId, USER_A, "play");
    await service.whenIdle(COMMUNITY_CHAT);
    await service.tryStand({
      gameId,
      userId: USER_A,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_BOT_WIN_XP);
  });

  await runTest("48. bot tie +5", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startBotGame(service);
    service.seedDeckForTests(gameId, [
      createCard("K", "spades"),
      createCard("9", "hearts"),
      createCard("K", "diamonds"),
      createCard("9", "clubs"),
    ]);
    await decide(service, gameId, USER_A, "play");
    await service.whenIdle(COMMUNITY_CHAT);
    await service.tryStand({
      gameId,
      userId: USER_A,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_TIE_XP);
  });

  await runTest("49. first bot loss of UTC day +2", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startBotGame(service);
    service.seedDeckForTests(gameId, [
      createCard("8", "spades"),
      createCard("7", "hearts"),
      createCard("K", "diamonds"),
      createCard("Q", "clubs"),
    ]);
    await decide(service, gameId, USER_A, "play");
    await service.whenIdle(COMMUNITY_CHAT);
    await service.tryStand({
      gameId,
      userId: USER_A,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
  });

  await runTest("49b. second bot loss same UTC day +0", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const first = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(first.pointsToAdd, BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
    const second = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(second.pointsToAdd, 0);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
  });

  await runTest("50. no negative lifetime XP", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const loss = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(loss.pointsToAdd, BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
    assert.ok(loss.points >= 0);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
  });

  await runTest("51-52. rank-up fields and announcement predicate", async () => {
    const files = nextFiles();
    link(files, USER_A);
    seedPoints(files, USER_A, 24, "Alice");
    const result = await awardBlackjackPvpResultXp(
      USER_A,
      "Alice",
      { result: "win", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(result.awarded, true);
    assert.strictEqual(result.pointsToAdd, BLACKJACK_PVP_WIN_XP);
    assert.strictEqual(result.rankUp, true);
    assert.ok(result.rank);
    assert.ok(result.previousRank);
    assert.notStrictEqual(result.rank.title, result.previousRank.title);
    assert.strictEqual(isTrueRankUp(result), true);
  });

  await runTest("53-54. wallet blocked 0 XP but slot still counts", async () => {
    const files = nextFiles();
    const reserved = await reserveBlackjackRewardedRound(
      USER_A,
      "Alice",
      {},
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(reserved.slotConsumed, true);
    assert.strictEqual(reserved.walletOk, false);
    assert.strictEqual(reserved.reason, XP_WALLET_REQUIRED);
    const pass = await awardBlackjackPassXp(
      USER_A,
      "Alice",
      { eligible: true, funOnly: true, shopFile: files.shopFile },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(pass.awarded, false);
    assert.strictEqual(pass.pointsToAdd, 0);
    assert.strictEqual(pass.reason, XP_WALLET_REQUIRED);
    assert.strictEqual(getBlackjackStatus(USER_A, files.pointsFile).rewardedRoundsUsed, 1);
  });

  await runTest("55-56. max 2 rewarded rounds then fun-only", async () => {
    const files = nextFiles();
    link(files, USER_A);
    for (let i = 0; i < 2; i += 1) {
      await reserveBlackjackRewardedRound(USER_A, "Alice", {}, files.pointsFile, files.walletFile);
      await awardBlackjackPassXp(
        USER_A,
        "Alice",
        { eligible: true, shopFile: files.shopFile },
        files.pointsFile,
        files.walletFile
      );
    }
    assert.strictEqual(pointsOf(files, USER_A), 4);
    const third = await reserveBlackjackRewardedRound(
      USER_A,
      "Alice",
      {},
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(third.eligible, false);
    assert.strictEqual(third.funOnly, true);
    const fun = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "win", eligible: false, funOnly: true, shopFile: files.shopFile },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(fun.pointsToAdd, 0);
    assert.strictEqual(pointsOf(files, USER_A), 4);
    assert.ok(getBlackjackStatus(USER_A, files.pointsFile).limitReached);
    assert.strictEqual(BLACKJACK_DAILY_REWARDED_CAP, 2);
    assert.strictEqual(BLACKJACK_STAKE_XP, 10);
  });

  await runTest("57-58. UTC reset and restart preserves cap then clears next day", async () => {
    const files = nextFiles();
    link(files, USER_A);
    await reserveBlackjackRewardedRound(USER_A, "Alice", {}, files.pointsFile, files.walletFile);
    const yesterday = utcYesterday();
    mutatePoints((data) => {
      data.users[USER_A].blackjack.rewardDate = yesterday;
      data.users[USER_A].blackjack.rewardedRoundsUsed = 2;
    }, files.pointsFile);
    const reloaded = loadPoints(files.pointsFile);
    assert.strictEqual(reloaded.users[USER_A].blackjack.rewardedRoundsUsed, 2);
    const status = getBlackjackStatus(USER_A, files.pointsFile);
    assert.strictEqual(status.rewardedRoundsUsed, 0);
    const next = await reserveBlackjackRewardedRound(
      USER_A,
      "Alice",
      {},
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(next.eligible, true);
    assert.strictEqual(next.rewardedRoundsUsed, 1);
  });

  await runTest("59. same-opponent anti-farm", async () => {
    const files = nextFiles();
    link(files, USER_A);
    link(files, USER_B);
    await markBlackjackPvpMatchup(USER_A, USER_B, files.pointsFile);
    const blocked = await reserveBlackjackRewardedRound(
      USER_A,
      "Alice",
      { opponentUserId: USER_B },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(blocked.pairBlocked, true);
    assert.strictEqual(blocked.slotConsumed, false);
    const vsC = await reserveBlackjackRewardedRound(
      USER_A,
      "Alice",
      { opponentUserId: USER_C },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(vsC.pairBlocked, false);
    assert.strictEqual(vsC.slotConsumed, true);
    const vsBot = await reserveBlackjackRewardedRound(
      USER_A,
      "Alice",
      {},
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(vsBot.pairBlocked, false);
  });

  await runTest("60. duplicate result no duplicate XP", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startBotGame(service);
    await decide(service, gameId, USER_A, "pass");
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), 2);
    await service.tryDecide({
      gameId,
      userId: USER_A,
      choice: "pass",
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), 2);
  });

  await runTest("61. valid resolved Blackjack counts Play a Bot Game", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startBotGame(service);
    await decide(service, gameId, USER_A, "pass");
    await service.whenIdle(COMMUNITY_CHAT);
    const snap = getDailyQuestSnapshot(USER_A, {
      shopFile: files.shopFile,
      walletFile: files.walletFile,
    });
    assertEligibleBotGameProgress(snap);
    assert.ok(GAME_SOURCES.includes("blackjack"));
  });

  await runTest("62-63. lobby opening / cancelled lobby does not count", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    const started = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_A, "Alice"),
    });
    let snap = getDailyQuestSnapshot(USER_A, {
      shopFile: files.shopFile,
      walletFile: files.walletFile,
    });
    assert.strictEqual(snap.game.completed, false);
    service.cancelAll("test");
    snap = getDailyQuestSnapshot(USER_A, {
      shopFile: files.shopFile,
      walletFile: files.walletFile,
    });
    assert.strictEqual(snap.game.completed, false);
    assert.ok(started.ok);
  });

  await runTest("64. Pass resolved counts", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const pass = await awardBlackjackPassXp(
      USER_A,
      "Alice",
      { eligible: true, shopFile: files.shopFile },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(pass.awarded, true);
    const snap = getDailyQuestSnapshot(USER_A, {
      shopFile: files.shopFile,
      walletFile: files.walletFile,
    });
    assertEligibleBotGameProgress(snap);
  });

  await runTest("65-66. fun-mode resolved counts, no duplicate Daily Quest Loot", async () => {
    const files = nextFiles();
    link(files, USER_A);
    await awardBlackjackPassXp(
      USER_A,
      "Alice",
      { eligible: false, funOnly: true, shopFile: files.shopFile },
      files.pointsFile,
      files.walletFile
    );
    const snap = getDailyQuestSnapshot(USER_A, {
      shopFile: files.shopFile,
      walletFile: files.walletFile,
    });
    assertEligibleBotGameProgress(snap);
    const loot = getLootBalance(USER_A, files.shopFile);
    await awardBlackjackPassXp(
      USER_A,
      "Alice",
      { eligible: false, funOnly: true, shopFile: files.shopFile },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(getLootBalance(USER_A, files.shopFile), loot);
    noteDailyQuestGame(USER_A, "blackjack", {
      shopFile: files.shopFile,
      walletFile: files.walletFile,
    });
    assert.strictEqual(getLootBalance(USER_A, files.shopFile), loot);
  });

  await runTest("one Pass one Play awards +2 and +10", async () => {
    const files = nextFiles();
    link(files, USER_A);
    link(files, USER_B);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await startPvp(service);
    await decide(service, gameId, USER_A, "pass");
    await decide(service, gameId, USER_B, "play");
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_PASS_XP);
    assert.strictEqual(pointsOf(files, USER_B), BLACKJACK_STAKE_XP);
  });

  await runTest("bot XP: completed dealer game awards once", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    const gameId = await playBotWin(service);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_BOT_WIN_XP);
    await service.tryStand({
      gameId,
      userId: USER_A,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_BOT_WIN_XP);
  });

  await runTest("bot XP: daily cap applies to bot games", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createService();
    attachXp(service, files);
    await playBotWin(service);
    await playBotWin(service);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_BOT_WIN_XP * 2);
    assert.ok(getBlackjackStatus(USER_A, files.pointsFile).limitReached);
    await playBotWin(service);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_BOT_WIN_XP * 2);
  });

  await runTest("bot XP: owner can earn bot win XP", async () => {
    const prev = process.env.ADMIN_USER_ID;
    process.env.ADMIN_USER_ID = String(USER_A);
    try {
      const files = nextFiles();
      link(files, USER_A);
      const { service } = createService();
      attachXp(service, files);
      await playBotWin(service);
      assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_BOT_WIN_XP);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_USER_ID;
      else process.env.ADMIN_USER_ID = prev;
    }
  });

  await runTest("bot XP: human vs human PvP XP still works after bot game", async () => {
    const files = nextFiles();
    link(files, USER_A);
    link(files, USER_B);
    const { service } = createService();
    attachXp(service, files);
    await playBotWin(service);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_BOT_WIN_XP);
    const gameId = await startPvp(service);
    service.seedDeckForTests(gameId, [
      createCard("K", "spades"),
      createCard("9", "hearts"),
      createCard("8", "diamonds"),
      createCard("7", "clubs"),
    ]);
    await decide(service, gameId, USER_A, "play");
    await decide(service, gameId, USER_B, "play");
    await service.whenIdle(COMMUNITY_CHAT);
    await service.tryStand({
      gameId,
      userId: USER_A,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.tryStand({
      gameId,
      userId: USER_B,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_BOT_WIN_XP + BLACKJACK_PVP_WIN_XP);
    assert.strictEqual(pointsOf(files, USER_B), 0);
  });

  await runTest("first-completed: win stays 10 not 12", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const win = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "win", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(win.pointsToAdd, BLACKJACK_BOT_WIN_XP);
  });

  await runTest("first-completed: pass does not consume bot Play floor", async () => {
    const files = nextFiles();
    link(files, USER_A);
    await awardBlackjackPassXp(
      USER_A,
      "Alice",
      { eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_PASS_XP);
    const loss = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(loss.pointsToAdd, BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
    assert.strictEqual(
      pointsOf(files, USER_A),
      BLACKJACK_PASS_XP + BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP
    );
  });

  await runTest("first-completed: wallet block does not consume the claim", async () => {
    const files = nextFiles();
    const blocked = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(blocked.awarded, false);
    assert.strictEqual(blocked.reason, XP_WALLET_REQUIRED);
    assert.strictEqual(pointsOf(files, USER_A), 0);
    link(files, USER_A);
    const later = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(later.pointsToAdd, BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
  });

  await runTest("first-completed: fun-only loss does not consume the claim", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const fun = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: false, funOnly: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(fun.pointsToAdd, 0);
    const later = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(later.pointsToAdd, BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
  });

  await runTest("first-completed: PvP loss stays +0", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const pvp = await awardBlackjackPvpResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(pvp.pointsToAdd, 0);
    const botLoss = await awardBlackjackBotResultXp(
      USER_A,
      "Alice",
      { result: "loss", eligible: true },
      files.pointsFile,
      files.walletFile
    );
    assert.strictEqual(botLoss.pointsToAdd, BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
  });

  await runTest("first-completed: owner loss still grants floor", async () => {
    const prev = process.env.ADMIN_USER_ID;
    process.env.ADMIN_USER_ID = String(USER_A);
    try {
      const files = nextFiles();
      link(files, USER_A);
      const loss = await awardBlackjackBotResultXp(
        USER_A,
        "Alice",
        { result: "loss", eligible: true },
        files.pointsFile,
        files.walletFile
      );
      assert.strictEqual(loss.awarded, true);
      assert.strictEqual(loss.pointsToAdd, BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
      assert.strictEqual(pointsOf(files, USER_A), BLACKJACK_FIRST_COMPLETED_BOT_MIN_XP);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_USER_ID;
      else process.env.ADMIN_USER_ID = prev;
    }
  });

  for (const [file, mtime] of Object.entries(prodMtimes)) {
    if (fs.existsSync(file)) {
      assert.strictEqual(fs.statSync(file).mtimeMs, mtime, `mutated ${file}`);
    }
  }

  setWalletFileForTests(null);
  setMangoShopFileForTests(null);
  console.log("All blackjack XP tests passed.");
})().catch((err) => {
  setWalletFileForTests(null);
  setMangoShopFileForTests(null);
  console.error(err);
  process.exitCode = 1;
});
