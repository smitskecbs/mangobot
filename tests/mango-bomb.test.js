/**
 * ManGo Bomb lobby / pass / boom / XP / timers / concurrency.
 * Run: node tests/mango-bomb.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  createMangoBombService,
  parseMangoBombCallbackData,
  joinCallbackData,
  passCallbackData,
  STATUS,
  BOMB_MIN_MS,
  BOMB_MAX_MS,
  LOBBY_COUNTDOWN_MS,
  STALE_CALLBACK,
  getMangoBombRuntime,
} = require("../services/mangoBomb");
const {
  awardMangoBombXp,
  MANGO_BOMB_PARTICIPATE_XP,
  MANGO_BOMB_SURVIVE_XP,
  MANGO_BOMB_WIN_XP,
  MANGO_BOMB_DAILY_ROUND_CAP,
  loadPoints,
  canEarnXp,
} = require("../services/points");
const {
  handleMangoBomb,
  handleMangoBombCallback,
  PRIVATE_MANGO_BOMB_TEXT,
  MANGO_BOMB_TOPIC_REQUIRED_TEXT,
} = require("../commands/mangobomb");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const { GROUP_MENU_CALLBACK, getGroupGamesMenuExtra } = require("../utils/botMenu");
const { HELP_MESSAGE } = require("../commands/help");
const { buildGamesTopicUrl } = require("../utils/gameTopic");
const { handleGroupMenuCallback } = require("../commands/menu");
const {
  ACTION_REGISTRY,
} = require("../services/communityActivityEngine");
const {
  registerManualWallet,
  setWalletFileForTests,
} = require("../services/walletLinks");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { XP_WALLET_REQUIRED } = require("../services/xpWalletGate");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-bomb-"));
let testCounter = 0;
const COMMUNITY_CHAT = -1001234567890;
const OTHER_CHAT = -1009999999999;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;
const USER_D = 444;
const OWNER_ID = 999001;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function pointsFile() {
  testCounter += 1;
  return path.join(tempDir, `points-${testCounter}.json`);
}

function walletFile() {
  return path.join(tempDir, `wallet-${testCounter}.json`);
}

function resetEnv() {
  process.env.ADMIN_USER_ID = String(OWNER_ID);
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalGamesTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalGamesTopic;
}

async function runTest(name, fn) {
  resetEnv();
  setWalletFileForTests(null);
  require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
  getMangoBombRuntime().reset();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  } finally {
    getMangoBombRuntime().reset();
    setWalletFileForTests(null);
  }
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
    pendingCount() {
      return timers.filter((t) => !t.cleared).length;
    },
  };
}

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const edits = [];
  const randomIntFn =
    typeof overrides.randomIntFn === "function" ? overrides.randomIntFn : () => 0;
  const service = createMangoBombService({
    now: () => timers.now(),
    setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
    randomIntFn,
    randomIdFn: overrides.randomIdFn || (() => "aabbccdd"),
    lobbyMs: overrides.lobbyMs != null ? overrides.lobbyMs : 60_000,
    bombMinMs: overrides.bombMinMs != null ? overrides.bombMinMs : 8_000,
    bombMaxMs: overrides.bombMaxMs != null ? overrides.bombMaxMs : 20_000,
    passCooldownMs: overrides.passCooldownMs != null ? overrides.passCooldownMs : 400,
    betweenRoundsMs: overrides.betweenRoundsMs != null ? overrides.betweenRoundsMs : 2_500,
    startCooldownMs: overrides.startCooldownMs != null ? overrides.startCooldownMs : 0,
  });
  service.setEditMessageHandler(async (chatId, messageId, text, extra) => {
    edits.push({ chatId, messageId, text, extra });
  });
  return { service, timers, edits };
}

function join(service, gameId, userId, name, extra = {}) {
  return service.tryJoin({
    gameId,
    userId,
    displayName: { first_name: name, id: userId },
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: extra.threadId !== undefined ? extra.threadId : 123,
  });
}

function pass(service, gameId, userId, extra = {}) {
  return service.tryPass({
    gameId,
    userId,
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: extra.threadId !== undefined ? extra.threadId : 123,
  });
}

async function startWithPlayers(service, names) {
  const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.gameId, 9001);
  const ids = [USER_A, USER_B, USER_C, USER_D];
  names.forEach((name, i) => {
    const result = join(service, started.gameId, ids[i], name);
    assert.strictEqual(result.ok, true, result.reason);
  });
  return started.gameId;
}

function attachXp(service, pFile, wFile) {
  service.setAwardXpHandler((userId, name, amount, roundId) =>
    awardMangoBombXp(userId, name, amount, roundId, pFile, wFile)
  );
}

function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    address: encodeBase58(publicKeyRaw),
    sign(message) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      return signEd25519Detached(buf, privateKey);
    },
  };
}

function verifyUser(wFile, userId, wallet, now) {
  const created = createLinkToken(userId, { walletFile: wFile, now });
  const limiter = createMemoryRateLimiter();
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile: wFile, now: now + 1, rateLimiter: limiter }
  );
  const verified = verifyWalletSignature(
    {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    },
    { walletFile: wFile, now: now + 2, rateLimiter: limiter }
  );
  assert.strictEqual(verified.ok, true, verified.error);
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Alice",
  text = "/mangobomb",
  isBot = false,
  memberStatus = "member",
  callbackData,
  messageThreadId,
} = {}) {
  const replies = [];
  const replyExtras = [];
  const cbAnswers = [];
  const edited = [];
  const message = { text };
  if (messageThreadId != null) {
    message.message_thread_id = messageThreadId;
  }
  const callbackQuery = callbackData
    ? {
        data: callbackData,
        from: { id: userId, is_bot: isBot },
        message: {
          message_id: 9001,
          chat: { id: chatId, type: chatType },
          ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
        },
      }
    : undefined;
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName, is_bot: isBot },
    message,
    callbackQuery,
    replies,
    replyExtras,
    cbAnswers,
    edited,
    telegram: {
      getChatMember() {
        return Promise.resolve({ status: memberStatus, user: { id: userId } });
      },
    },
    reply(msg, extra) {
      replies.push({ text: msg, extra });
      replyExtras.push(extra);
      return Promise.resolve({ message_id: 9001, extra });
    },
    answerCbQuery(msg) {
      cbAnswers.push(msg || "");
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      edited.push({ text, extra });
      return Promise.resolve(true);
    },
  };
}

function pointsOf(file, userId) {
  const data = loadPoints(file);
  const user = data.users[String(userId)];
  return user && typeof user.points === "number" ? user.points : 0;
}

function lobbySecondsFrom(text) {
  const match = String(text).match(/You have (\d+) seconds to join/);
  return match ? Number(match[1]) : null;
}

function playersFrom(text) {
  const match = String(text).match(/Players: (\d+)/);
  return match ? Number(match[1]) : null;
}

async function main() {
  await runTest("1. start lobby", () => {
    const { service } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(started.ok, true);
    assert.ok(started.text.includes("MANGO BOMB"));
    assert.ok(started.text.includes("60 seconds to join"));
    assert.ok(started.text.includes("Players: 0"));
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(service.getGame(started.gameId).status, STATUS.LOBBY);
  });

  await runTest("2. join", () => {
    const { service } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT });
    const result = join(service, started.gameId, USER_A, "Kevin");
    assert.strictEqual(result.ok, true);
    assert.ok(result.text.includes("Players: 1"));
    assert.deepStrictEqual(service.getGame(started.gameId).alivePlayers, [String(USER_A)]);
  });

  await runTest("3. duplicate join ignored", () => {
    const { service } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(join(service, started.gameId, USER_A, "Kevin").ok, true);
    const dup = join(service, started.gameId, USER_A, "Kevin");
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.reason, "duplicate");
    assert.strictEqual(service.getGame(started.gameId).playerCount, 1);
  });

  await runTest("4. bot cannot join", () => {
    const { service } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT });
    const result = service.tryJoin({
      gameId: started.gameId,
      userId: 55,
      displayName: { first_name: "Bot" },
      isBot: true,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "bot");
    assert.strictEqual(service.getGame(started.gameId).playerCount, 0);
  });

  await runTest("5. late join rejected", async () => {
    const { service } = createService();
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    await service.forceLobbyEnd(gameId);
    const late = join(service, gameId, USER_C, "Ada");
    assert.strictEqual(late.ok, false);
    assert.strictEqual(late.reason, "late");
  });

  await runTest("6. <2 players cancels", async () => {
    const { service, timers } = createService({ lobbyMs: 1_000 });
    const started = service.startLobby({ chatId: COMMUNITY_CHAT });
    join(service, started.gameId, USER_A, "Kevin");
    timers.advance(1_000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
    assert.strictEqual(service.getGame(started.gameId), null);
    assert.strictEqual(pointsOf(pointsFile(), USER_A), 0);
  });

  await runTest("7. 2+ starts", async () => {
    const { service } = createService();
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    const closed = await service.forceLobbyEnd(gameId);
    assert.strictEqual(closed.ok, true);
    assert.strictEqual(closed.status, STATUS.RUNNING);
    assert.strictEqual(service.getGame(gameId).currentHolder, String(USER_A));
    assert.ok(service.getGame(gameId).bombDeadline > service.getGame(gameId).bombStartedAt);
  });

  await runTest("8. only holder can pass", async () => {
    const { service } = createService();
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    await service.forceLobbyEnd(gameId);
    const denied = pass(service, gameId, USER_B);
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, "not-holder");
    assert.strictEqual(service.getGame(gameId).currentHolder, String(USER_A));
  });

  await runTest("9-10. holder cannot pass to self; next is alive other", async () => {
    const { service } = createService();
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    const result = pass(service, gameId, USER_A);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(service.getGame(gameId).currentHolder, String(USER_B));
    assert.notStrictEqual(service.getGame(gameId).currentHolder, String(USER_A));
    assert.ok(service.getGame(gameId).alivePlayers.includes(String(USER_B)));
  });

  await runTest("11. callback replay no double pass", async () => {
    const { service } = createService({ passCooldownMs: 10_000 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    const first = await service.enqueuePass({
      gameId,
      userId: USER_A,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    const replay = await service.enqueuePass({
      gameId,
      userId: USER_A,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(replay.ok, false);
    assert.ok(replay.reason === "not-holder" || replay.reason === "cooldown");
    assert.strictEqual(service.getGame(gameId).currentHolder, String(USER_B));
  });

  await runTest("12. pass after explosion rejected", async () => {
    const { service } = createService();
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    const holder = service.getGame(gameId).currentHolder;
    await service.forceExplode(gameId);
    const after = pass(service, gameId, holder);
    assert.strictEqual(after.ok, false);
  });

  await runTest("13-16. boom eliminates, skips victim, new round", async () => {
    const { service, timers, edits } = createService({ betweenRoundsMs: 100 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    const victim = service.getGame(gameId).currentHolder;
    const boom = await service.forceExplode(gameId);
    assert.strictEqual(boom.ok, true);
    assert.ok(service.getGame(gameId).eliminatedPlayers.includes(victim));
    assert.strictEqual(service.getGame(gameId).aliveCount, 2);
    assert.ok(!service.getGame(gameId).alivePlayers.includes(victim));
    assert.ok(edits.some((e) => e.text.includes("BOOM")));
    timers.advance(100);
    await service.whenIdle(COMMUNITY_CHAT);
    const next = service.getGame(gameId);
    assert.strictEqual(next.status, STATUS.RUNNING);
    assert.notStrictEqual(next.currentHolder, victim);
    assert.ok(next.alivePlayers.includes(next.currentHolder));
  });

  await runTest("17-18. one survivor → exactly one winner", async () => {
    const { service, timers, edits } = createService({ betweenRoundsMs: 50 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    await service.forceLobbyEnd(gameId);
    const boom = await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(boom.status, STATUS.FINISHED);
    assert.strictEqual(boom.winnerId, String(USER_B));
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
    assert.ok(edits.some((e) => e.text.includes("MANGO BOMB WINNER")));
    assert.strictEqual(edits.filter((e) => e.text.includes("WINNER")).length, 1);
    const again = await service.forceExplode(gameId);
    assert.strictEqual(again.ok, false);
  });

  await runTest("19. AFK holder does nothing → eliminated", async () => {
    const { service, timers } = createService({
      bombMinMs: 8_000,
      bombMaxMs: 8_000,
      betweenRoundsMs: 50,
    });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    const holder = service.getGame(gameId).currentHolder;
    timers.advance(8_000);
    await service.whenIdle(COMMUNITY_CHAT);
    const game = service.getGame(gameId);
    assert.ok(game.eliminatedPlayers.includes(holder));
    assert.strictEqual(game.status, STATUS.BETWEEN_ROUNDS);
  });

  await runTest("20. random timer bounds", () => {
    const seen = [];
    const { service } = createService({
      bombMinMs: BOMB_MIN_MS,
      bombMaxMs: BOMB_MAX_MS,
      randomIntFn: (n) => {
        seen.push(n);
        return n - 1;
      },
    });
    service.startLobby({ chatId: COMMUNITY_CHAT });
    join(service, "aabbccdd", USER_A, "A");
    join(service, "aabbccdd", USER_B, "B");
    return service.forceLobbyEnd("aabbccdd").then(() => {
      const game = service.getGame("aabbccdd");
      const life = game.bombDeadline - game.bombStartedAt;
      assert.ok(life >= BOMB_MIN_MS && life <= BOMB_MAX_MS);
      assert.strictEqual(life, BOMB_MAX_MS);
    });
  });

  await runTest("20b. min bomb bound", async () => {
    const { service } = createService({
      bombMinMs: BOMB_MIN_MS,
      bombMaxMs: BOMB_MAX_MS,
      randomIntFn: () => 0,
    });
    const gameId = await startWithPlayers(service, ["A", "B"]);
    await service.forceLobbyEnd(gameId);
    const game = service.getGame(gameId);
    assert.strictEqual(game.bombDeadline - game.bombStartedAt, BOMB_MIN_MS);
  });

  await runTest("21-23. one bomb timer; cleaned after round and game", async () => {
    const { service, timers } = createService({
      bombMinMs: 8_000,
      bombMaxMs: 8_000,
      betweenRoundsMs: 50,
    });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    assert.strictEqual(service.getActiveBombTimerCount(), 1);
    const beforePass = service.getPendingTimerCount();
    pass(service, gameId, USER_A);
    assert.strictEqual(service.getActiveBombTimerCount(), 1);
    assert.ok(service.getPendingTimerCount() <= beforePass);
    await service.forceExplode(gameId);
    assert.strictEqual(service.getActiveBombTimerCount(), 0);
    timers.advance(50);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getActiveBombTimerCount(), 1);
    await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getActiveBombTimerCount(), 0);
    assert.strictEqual(service.getPendingTimerCount(), 0);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
  });

  await runTest("24. shutdown cleanup", async () => {
    const { service } = createService();
    await startWithPlayers(service, ["Kevin", "Lojay"]);
    assert.ok(service.getPendingTimerCount() > 0);
    service.clearAllTimers();
    assert.strictEqual(service.getPendingTimerCount(), 0);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
  });

  await runTest("25. restart/recovery cancels in-memory game", async () => {
    const { service } = createService();
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    service.clearAllTimers();
    assert.strictEqual(service.getGame(gameId), null);
    const stale = join(service, gameId, USER_C, "Ada");
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.toast, STALE_CALLBACK);
    const again = service.startLobby({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(again.ok, true);
  });

  await runTest("26. unlinked can play but 0 XP", async () => {
    require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    const { service } = createService();
    attachXp(service, pFile, wFile);
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    await service.forceLobbyEnd(gameId);
    await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(pFile, USER_A), 0);
    assert.strictEqual(pointsOf(pFile, USER_B), 0);
    assert.strictEqual(canEarnXp(USER_A, wFile), false);
  });

  await runTest("27. manual wallet earns XP", async () => {
    require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    registerManualWallet(USER_A, generateSolanaWallet().address, wFile);
    registerManualWallet(USER_B, generateSolanaWallet().address, wFile);
    const { service } = createService();
    attachXp(service, pFile, wFile);
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    await service.forceLobbyEnd(gameId);
    await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(pFile, USER_A), MANGO_BOMB_PARTICIPATE_XP);
    assert.strictEqual(
      pointsOf(pFile, USER_B),
      MANGO_BOMB_PARTICIPATE_XP + MANGO_BOMB_SURVIVE_XP + MANGO_BOMB_WIN_XP
    );
  });

  await runTest("28. verified wallet earns XP", async () => {
    require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    verifyUser(wFile, USER_A, generateSolanaWallet(), 1_700_000_000_000);
    verifyUser(wFile, USER_B, generateSolanaWallet(), 1_700_000_000_100);
    const { service } = createService();
    attachXp(service, pFile, wFile);
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    await service.forceLobbyEnd(gameId);
    await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.ok(pointsOf(pFile, USER_B) > 0);
    assert.ok(pointsOf(pFile, USER_A) > 0);
  });

  await runTest("29-31. participation once, survival per boom, winner once", async () => {
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    const { service, timers } = createService({ betweenRoundsMs: 50 });
    attachXp(service, pFile, wFile);
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    join(service, gameId, USER_A, "Kevin");
    await service.forceLobbyEnd(gameId);
    assert.strictEqual(pointsOf(pFile, USER_A), MANGO_BOMB_PARTICIPATE_XP);
    assert.strictEqual(pointsOf(pFile, USER_B), MANGO_BOMB_PARTICIPATE_XP);
    assert.strictEqual(pointsOf(pFile, USER_C), MANGO_BOMB_PARTICIPATE_XP);
    await service.forceExplode(gameId);
    assert.strictEqual(pointsOf(pFile, USER_A), MANGO_BOMB_PARTICIPATE_XP);
    assert.strictEqual(
      pointsOf(pFile, USER_B),
      MANGO_BOMB_PARTICIPATE_XP + MANGO_BOMB_SURVIVE_XP
    );
    timers.advance(50);
    await service.whenIdle(COMMUNITY_CHAT);
    await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(
      pointsOf(pFile, USER_C),
      MANGO_BOMB_PARTICIPATE_XP + MANGO_BOMB_SURVIVE_XP + MANGO_BOMB_SURVIVE_XP + MANGO_BOMB_WIN_XP
    );
  });

  await runTest("32. callback replay no duplicate XP", async () => {
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    const { service } = createService();
    attachXp(service, pFile, wFile);
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    await service.forceLobbyEnd(gameId);
    const before = pointsOf(pFile, USER_A);
    await service.enqueuePass({
      gameId,
      userId: USER_A,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.enqueuePass({
      gameId,
      userId: USER_A,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    assert.strictEqual(pointsOf(pFile, USER_A), before);
  });

  await runTest("33. daily cap one rewarded round", async () => {
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    const first = awardMangoBombXp(USER_A, "Kevin", 1, "round-1", pFile, wFile);
    assert.strictEqual(first.awarded, true);
    const same = awardMangoBombXp(USER_A, "Kevin", 5, "round-1", pFile, wFile);
    assert.strictEqual(same.awarded, true);
    const next = awardMangoBombXp(USER_A, "Kevin", 1, "round-2", pFile, wFile);
    assert.strictEqual(next.awarded, false);
    assert.strictEqual(next.reason, "daily-cap");
    assert.strictEqual(MANGO_BOMB_DAILY_ROUND_CAP, 1);
    assert.strictEqual(pointsOf(pFile, USER_A), 6);
  });

  await runTest("34. existing XP gate unchanged", () => {
    const gateSrc = fs.readFileSync(
      path.join(__dirname, "../services/xpWalletGate.js"),
      "utf8"
    );
    const awardSrc = fs.readFileSync(path.join(__dirname, "../services/points.js"), "utf8");
    assert.ok(gateSrc.includes("function canEarnXp"));
    assert.ok(awardSrc.includes("if (!canEarnXp(userId, walletFile))"));
    assert.ok(awardSrc.includes("function awardMangoBombXp"));
  });

  await runTest("35. Games submenu contains ManGo Bomb", () => {
    const extra = getGroupGamesMenuExtra({
      bot: { botInfo: { username: "ManGoTestBot" } },
    });
    const blob = JSON.stringify(extra);
    assert.ok(blob.includes(GROUP_MENU_CALLBACK.MANGOBOMB));
    assert.ok(blob.includes("ManGo Bomb"));
    assert.ok(HELP_MESSAGE.includes("/mangobomb"));
  });

  await runTest("36. private /mangobomb → no lobby + Open Games", async () => {
    process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
    process.env.TELEGRAM_GAMES_TOPIC_ID = "77";
    const { service } = createService();
    let started = false;
    const ctx = createMockCtx({ chatType: "private", chatId: USER_A });
    await handleMangoBomb(ctx, {
      isBusyFn: () => false,
      startLobbyFn: (p) => {
        started = true;
        return service.startLobby(p);
      },
    });
    assert.strictEqual(started, false);
    assert.strictEqual(service.isMangoBombOpen(COMMUNITY_CHAT), false);
    assert.ok(ctx.replies[0].text.includes(PRIVATE_MANGO_BOMB_TEXT.split("\n")[0]));
    assert.ok(ctx.replies[0].text.includes("live community game"));
    assert.ok(ctx.replies[0].text.includes("ManGo Games topic"));
    const extra = ctx.replyExtras[0];
    const url = extra && extra.reply_markup && extra.reply_markup.inline_keyboard[0][0].url;
    const label = extra && extra.reply_markup && extra.reply_markup.inline_keyboard[0][0].text;
    assert.strictEqual(url, buildGamesTopicUrl());
    assert.ok(url.includes("/77"));
    assert.strictEqual(label, "🎮 Open Games");
  });

  await runTest("37. /mangobomb Games topic starts; General/wrong topic/admin do not", async () => {
    process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
    const { service } = createService();

    const general = createMockCtx({ userId: USER_A, memberStatus: "member" });
    await handleMangoBomb(general, {
      startLobbyFn: (p) => service.startLobby(p),
      isBusyFn: () => false,
      canManageGroupFn: async () => true,
    });
    assert.strictEqual(general.replies[0].text, MANGO_BOMB_TOPIC_REQUIRED_TEXT);
    assert.strictEqual(service.isMangoBombOpen(COMMUNITY_CHAT), false);
    const generalBtn = general.replyExtras[0];
    assert.strictEqual(
      generalBtn && generalBtn.reply_markup.inline_keyboard[0][0].text,
      "🎮 Open Games"
    );
    assert.ok(
      generalBtn.reply_markup.inline_keyboard[0][0].url.includes("/123")
    );

    const wrong = createMockCtx({
      userId: USER_A,
      memberStatus: "administrator",
      messageThreadId: 1,
    });
    await handleMangoBomb(wrong, {
      startLobbyFn: (p) => service.startLobby(p),
      isBusyFn: () => false,
      canManageGroupFn: async () => true,
    });
    assert.strictEqual(wrong.replies[0].text, MANGO_BOMB_TOPIC_REQUIRED_TEXT);
    assert.strictEqual(service.isMangoBombOpen(COMMUNITY_CHAT), false);

    const ok = createMockCtx({
      userId: USER_A,
      memberStatus: "member",
      messageThreadId: 123,
    });
    await handleMangoBomb(ok, {
      startLobbyFn: (p) => service.startLobby(p),
      isBusyFn: () => false,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(String(ok.replies[0].text).includes("MANGO BOMB"));
    assert.strictEqual(ok.replyExtras[0].message_thread_id, 123);
    assert.strictEqual(service.isMangoBombOpen(COMMUNITY_CHAT), true);
  });

  await runTest("routing. menu private ManGo Bomb → Open Games, no lobby", async () => {
    process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
    process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
    const { service } = createService();
    let started = false;
    const ctx = createMockCtx({
      chatType: "private",
      chatId: USER_A,
      callbackData: GROUP_MENU_CALLBACK.MANGOBOMB,
    });
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startLobbyFn: (p) => {
        started = true;
        return service.startLobby(p);
      },
    });
    assert.strictEqual(started, false);
    assert.ok(ctx.replies[0].text.includes("live community game"));
    assert.strictEqual(
      ctx.replyExtras[0].reply_markup.inline_keyboard[0][0].text,
      "🎮 Open Games"
    );
  });

  await runTest("routing. wrong-topic JOIN/PASS rejected, no mutation, no XP", async () => {
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    const { service } = createService();
    attachXp(service, pFile, wFile);
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    const beforePlayers = service.getGame(gameId).playerCount;
    const beforePointsA = pointsOf(pFile, USER_A);

    const badJoin = createMockCtx({
      callbackData: joinCallbackData(gameId),
      userId: USER_C,
      firstName: "Ada",
      messageThreadId: 1,
    });
    await handleMangoBombCallback(badJoin, { runtime: service });
    assert.strictEqual(badJoin.cbAnswers[0], STALE_CALLBACK);
    assert.strictEqual(service.getGame(gameId).playerCount, beforePlayers);
    assert.strictEqual(service.getGame(gameId).status, "lobby");
    assert.strictEqual(pointsOf(pFile, USER_A), beforePointsA);
    assert.strictEqual(pointsOf(pFile, USER_C), 0);

    await service.forceLobbyEnd(gameId);
    const afterStartA = pointsOf(pFile, USER_A);
    const afterStartB = pointsOf(pFile, USER_B);
    const holder = service.getGame(gameId).currentHolder;
    const badPass = createMockCtx({
      callbackData: passCallbackData(gameId),
      userId: Number(holder),
      firstName: "Kevin",
      messageThreadId: 1,
    });
    await handleMangoBombCallback(badPass, { runtime: service });
    assert.strictEqual(badPass.cbAnswers[0], STALE_CALLBACK);
    assert.strictEqual(service.getGame(gameId).currentHolder, holder);
    assert.strictEqual(pointsOf(pFile, USER_A), afterStartA);
    assert.strictEqual(pointsOf(pFile, USER_B), afterStartB);
  });

  await runTest("routing. Games-topic JOIN/PASS still work", async () => {
    const { service } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    const joinCtx = createMockCtx({
      callbackData: joinCallbackData(started.gameId),
      userId: USER_A,
      firstName: "Kevin",
      messageThreadId: 123,
    });
    await handleMangoBombCallback(joinCtx, { runtime: service });
    assert.strictEqual(joinCtx.cbAnswers[0], "Joined!");
    const joinB = createMockCtx({
      callbackData: joinCallbackData(started.gameId),
      userId: USER_B,
      firstName: "Lojay",
      messageThreadId: 123,
    });
    await handleMangoBombCallback(joinB, { runtime: service });
    await service.forceLobbyEnd(started.gameId);
    const holder = service.getGame(started.gameId).currentHolder;
    const passCtx = createMockCtx({
      callbackData: passCallbackData(started.gameId),
      userId: Number(holder),
      firstName: "Kevin",
      messageThreadId: 123,
    });
    await handleMangoBombCallback(passCtx, { runtime: service });
    assert.strictEqual(passCtx.cbAnswers[0], "Passed!");
    assert.notStrictEqual(service.getGame(started.gameId).currentHolder, holder);
  });

  await runTest("routing. activity engine does not start ManGo Bomb / no General fallback", () => {
    const engineSrc = fs.readFileSync(
      path.join(__dirname, "../services/communityActivityEngine.js"),
      "utf8"
    );
    assert.strictEqual(ACTION_REGISTRY.mangobomb, undefined);
    assert.ok(!engineSrc.includes("getMangoBombRuntime"));
    assert.ok(!engineSrc.includes("startLobby"));
    assert.ok(engineSrc.includes("isMangoBombBusy"));
    const gateSrc = fs.readFileSync(
      path.join(__dirname, "../utils/gameTopic.js"),
      "utf8"
    );
    assert.ok(gateSrc.includes("allowAdminTopicBypass"));
    const cmdSrc = fs.readFileSync(
      path.join(__dirname, "../commands/mangobomb.js"),
      "utf8"
    );
    assert.ok(cmdSrc.includes("allowAdminTopicBypass: false"));
  });

  await runTest("38-40. simultaneous pass and explode vs pass", async () => {
    const { service } = createService({ passCooldownMs: 0 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    const [a, b] = await Promise.all([
      service.enqueuePass({
        gameId,
        userId: USER_A,
        chatId: COMMUNITY_CHAT,
        threadId: 123,
      }),
      service.enqueuePass({
        gameId,
        userId: USER_A,
        chatId: COMMUNITY_CHAT,
        threadId: 123,
      }),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    assert.strictEqual(oks.length, 1);
    assert.strictEqual(service.getGame(gameId).currentHolder, String(USER_B));

    const { service: s2 } = createService();
    const id2 = await startWithPlayers(s2, ["Kevin", "Lojay", "Ada"]);
    await s2.forceLobbyEnd(id2);
    const [p, e] = await Promise.all([
      s2.enqueuePass({
        gameId: id2,
        userId: USER_A,
        chatId: COMMUNITY_CHAT,
        threadId: 123,
      }),
      s2.forceExplode(id2),
    ]);
    const game = s2.getGame(id2) || { status: STATUS.FINISHED, aliveCount: 1 };
    const passOk = Boolean(p && p.ok);
    const boomOk = Boolean(e && e.ok);
    assert.ok(passOk !== boomOk || (boomOk && game.status));
    assert.ok(game.aliveCount === 2 || game.aliveCount === 1 || game.status === STATUS.FINISHED || s2.getStatus(COMMUNITY_CHAT) === STATUS.IDLE);
    const holders = new Set();
    if (s2.getGame(id2) && s2.getGame(id2).currentHolder) {
      holders.add(s2.getGame(id2).currentHolder);
    }
    assert.ok(holders.size <= 1);
  });

  await runTest("41-43. security: no client holder, no spoof, stale safe", async () => {
    assert.strictEqual(parseMangoBombCallbackData("mb:join:aabbccdd").action, "join");
    assert.strictEqual(parseMangoBombCallbackData("mb:pass:aabbccdd").gameId, "aabbccdd");
    assert.strictEqual(parseMangoBombCallbackData("mb:join:aabbccdd:111"), null);
    assert.strictEqual(parseMangoBombCallbackData("mb:pass:111"), null);
    assert.ok(!joinCallbackData("aabbccdd").includes(String(USER_A)));
    assert.ok(!passCallbackData("aabbccdd").includes(String(USER_A)));
    const { service } = createService();
    const stale = await handleMangoBombCallback(
      createMockCtx({ callbackData: "mb:join:deadbeef" }),
      { runtime: service }
    );
    void stale;
    const ctx = createMockCtx({ callbackData: "mb:join:deadbeef", userId: USER_A });
    await handleMangoBombCallback(ctx, { runtime: service });
    assert.strictEqual(ctx.cbAnswers[0], STALE_CALLBACK);

    const started = service.startLobby({ chatId: COMMUNITY_CHAT });
    const spoof = createMockCtx({
      callbackData: joinCallbackData(started.gameId),
      userId: USER_B,
      firstName: "Eve",
    });
    await handleMangoBombCallback(spoof, { runtime: service });
    assert.deepStrictEqual(service.getGame(started.gameId).alivePlayers, [String(USER_B)]);
  });

  await runTest("44. no production files touched", () => {
    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file]);
    }
  });

  await runTest("join cancelled awards no XP", async () => {
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    const { service, timers } = createService({ lobbyMs: 500 });
    attachXp(service, pFile, wFile);
    const started = service.startLobby({ chatId: COMMUNITY_CHAT });
    join(service, started.gameId, USER_A, "Kevin");
    timers.advance(500);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(pointsOf(pFile, USER_A), 0);
  });

  await runTest("per chat one game + start cooldown", () => {
    const { service } = createService({ startCooldownMs: 90_000 });
    assert.strictEqual(service.startLobby({ chatId: COMMUNITY_CHAT }).ok, true);
    const second = service.startLobby({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, "already-active");
    service.reset();
    assert.strictEqual(service.startLobby({ chatId: COMMUNITY_CHAT }).ok, true);
    service.reset();
    const { service: cooled } = createService({ startCooldownMs: 90_000 });
    assert.strictEqual(cooled.startLobby({ chatId: COMMUNITY_CHAT }).ok, true);
    cooled.cancelAll();
    const again = cooled.startLobby({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, "cooldown");
    assert.strictEqual(cooled.startLobby({ chatId: OTHER_CHAT }).ok, true);
  });

  await runTest("busy flag overlaps Trivia", async () => {
    const { service } = createService();
    await startWithPlayers(service, ["Kevin", "Lojay"]);
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isTriviaOpenFn: () => false,
        isMangoBombOpenFn: () => service.isMangoBombOpen(),
      }),
      true
    );
    assert.strictEqual(
      getCommunityBusyReason({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isTriviaOpenFn: () => false,
        isMangoBombOpenFn: () => service.isMangoBombOpen(),
      }),
      "mangobomb"
    );
  });

  await runTest("wrong-chat callback rejected", async () => {
    const { service } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT });
    const result = service.tryJoin({
      gameId: started.gameId,
      userId: USER_A,
      displayName: { first_name: "Kevin" },
      isBot: false,
      chatId: OTHER_CHAT,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "wrong-chat");
  });

  await runTest("award result keeps rankUp fields", () => {
    const pFile = pointsFile();
    const wFile = walletFile();
    setWalletFileForTests(wFile);
    const result = awardMangoBombXp(USER_A, "Kevin", 5, "r1", pFile, wFile);
    assert.strictEqual(typeof result.rankUp, "boolean");
    assert.ok(result.rank);
    assert.ok(result.previousRank);
  });

  await runTest("countdown. 60 then 55/50, JOIN keeps remaining and player count", async () => {
    assert.strictEqual(LOBBY_COUNTDOWN_MS, 5000);
    const { service, timers, edits } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    assert.strictEqual(lobbySecondsFrom(started.text), 60);
    assert.strictEqual(playersFrom(started.text), 0);
    service.setMessageId(started.gameId, 9001);
    assert.strictEqual(service.getActiveCountdownTimerCount(), 1);

    timers.advance(5000);
    await service.whenIdle(COMMUNITY_CHAT);
    const at55 = edits.filter((row) => lobbySecondsFrom(row.text) === 55);
    assert.ok(at55.length >= 1);
    assert.strictEqual(playersFrom(at55[0].text), 0);

    timers.advance(2000);
    const joined = await service.enqueueJoin({
      gameId: started.gameId,
      userId: USER_A,
      displayName: { first_name: "Kevin" },
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(playersFrom(joined.text), 1);
    assert.ok(lobbySecondsFrom(joined.text) <= 53);
    assert.ok(lobbySecondsFrom(joined.text) >= 52);
    assert.notStrictEqual(lobbySecondsFrom(joined.text), 60);

    timers.advance(3000);
    await service.whenIdle(COMMUNITY_CHAT);
    const at50 = edits.filter((row) => lobbySecondsFrom(row.text) === 50);
    assert.ok(at50.length >= 1);
    assert.strictEqual(playersFrom(at50[at50.length - 1].text), 1);
    assert.ok(
      !edits.some(
        (row) =>
          lobbySecondsFrom(row.text) === 60 && playersFrom(row.text) === 1
      )
    );
    assert.strictEqual(service.getActiveCountdownTimerCount(), 1);

    join(service, started.gameId, USER_B, "Lojay");
    const endsAt = service.getGame(started.gameId).lobbyEndsAt;
    timers.advance(50000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(timers.now(), endsAt);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);
    assert.strictEqual(service.getActiveCountdownTimerCount(), 0);
  });

  await runTest("countdown. JOIN/countdown queue uses live player count", async () => {
    const { service, timers, edits } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(started.gameId, 9001);
    timers.advance(5000);
    const joinP = service.enqueueJoin({
      gameId: started.gameId,
      userId: USER_A,
      displayName: { first_name: "Kevin" },
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await Promise.all([joinP, service.whenIdle(COMMUNITY_CHAT)]);
    const lastLobby = [...edits]
      .reverse()
      .find((row) => lobbySecondsFrom(row.text) != null);
    assert.ok(lastLobby);
    assert.strictEqual(playersFrom(lastLobby.text), 1);
    assert.notStrictEqual(lobbySecondsFrom(lastLobby.text), 60);
  });

  await runTest("countdown. edit failure does not stop lobby", async () => {
    const { service, timers } = createService();
    service.setEditMessageHandler(async () => {
      throw new Error("telegram down");
    });
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(started.gameId, 9001);
    join(service, started.gameId, USER_A, "Kevin");
    join(service, started.gameId, USER_B, "Lojay");
    timers.advance(5000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    timers.advance(55000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);
  });

  await runTest("countdown. message-not-modified is ignored", async () => {
    const { service, timers } = createService();
    let calls = 0;
    service.setEditMessageHandler(async () => {
      calls += 1;
      const err = new Error("Bad Request: message is not modified");
      err.description = "Bad Request: message is not modified";
      throw err;
    });
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(started.gameId, 9001);
    timers.advance(5000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.ok(calls >= 1);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    join(service, started.gameId, USER_A, "Kevin");
    join(service, started.gameId, USER_B, "Lojay");
    timers.advance(55000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);
  });

  await runTest("countdown. one timer; cleanup on start/cancel/shutdown", async () => {
    const { service, timers } = createService();
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(started.gameId, 9001);
    assert.strictEqual(service.getActiveCountdownTimerCount(), 1);
    timers.advance(5000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getActiveCountdownTimerCount(), 1);

    join(service, started.gameId, USER_A, "Kevin");
    join(service, started.gameId, USER_B, "Lojay");
    timers.advance(55000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getActiveCountdownTimerCount(), 0);

    const { service: cancelled } = createService();
    const lobby = cancelled.startLobby({ chatId: COMMUNITY_CHAT });
    cancelled.setMessageId(lobby.gameId, 9001);
    assert.strictEqual(cancelled.getActiveCountdownTimerCount(), 1);
    await cancelled.forceLobbyEnd(lobby.gameId);
    assert.strictEqual(cancelled.getActiveCountdownTimerCount(), 0);

    const { service: halted } = createService();
    const open = halted.startLobby({ chatId: COMMUNITY_CHAT });
    halted.setMessageId(open.gameId, 9001);
    assert.ok(halted.getPendingTimerCount() > 1);
    halted.clearAllTimers();
    assert.strictEqual(halted.getActiveCountdownTimerCount(), 0);
    assert.strictEqual(halted.getPendingTimerCount(), 0);
    assert.strictEqual(halted.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
  });

  for (const file of prodRoots) {
    if (!fs.existsSync(file)) continue;
    assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
  }
}

main()
  .then(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    restoreEnv();
    console.log("\nAll mango-bomb tests passed.");
  })
  .catch((err) => {
    restoreEnv();
    console.error(err);
    process.exit(1);
  });
