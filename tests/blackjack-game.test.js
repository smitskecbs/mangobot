/**
 * ManGo Blackjack lobby, decisions, turns, bot, busy, stale callbacks.
 * Run: node tests/blackjack-game.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  createBlackjackService,
  parseBlackjackCallbackData,
  callbackData,
  STATUS,
  LATE_JOIN_TOAST,
  STALE_TURN_TOAST,
  STALE_CALLBACK,
  LOBBY_COUNTDOWN_MS,
  getBlackjackRuntime,
  BOT_ID,
} = require("../services/blackjack");
const { createCard } = require("../services/blackjackRules");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  handleBlackjack,
  handleBlackjackCallback,
  PRIVATE_BLACKJACK_TEXT,
  BLACKJACK_TOPIC_REQUIRED_TEXT,
} = require("../commands/blackjack");
const { ACTION_REGISTRY } = require("../services/communityActivityEngine");
const { GROUP_MENU_CALLBACK, getGroupGamesMenuExtra } = require("../utils/botMenu");
const { HELP_MESSAGE } = require("../commands/help");
const { handleGroupMenuCallback } = require("../commands/menu");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-bj-game-"));
const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;
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

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const edits = [];
  const sends = [];
  const service = createBlackjackService({
    now: () => timers.now(),
    setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
    randomIntFn: overrides.randomIntFn || (() => 0),
    randomIdFn: overrides.randomIdFn || (() => "aabbccdd"),
    lobbyMs: overrides.lobbyMs != null ? overrides.lobbyMs : 60_000,
    countdownMs: overrides.countdownMs,
    decisionMs: overrides.decisionMs != null ? overrides.decisionMs : 30_000,
    turnMs: overrides.turnMs != null ? overrides.turnMs : 30_000,
    botThinkMs: overrides.botThinkMs != null ? overrides.botThinkMs : 0,
    renderTimeoutMs: overrides.renderTimeoutMs,
    queueTimeoutMs: overrides.queueTimeoutMs,
  });
  service.setEditMessageHandler(async (chatId, messageId, text, extra) => {
    edits.push({ chatId, messageId, text, extra });
  });
  service.setSendMessageHandler(async (chatId, text, extra) => {
    sends.push({ chatId, text, extra });
  });
  return { service, timers, edits, sends };
}

function starter(name = "Alice", userId = USER_A) {
  return { userId, displayName: { first_name: name, id: userId }, isBot: false };
}

function start(service, extra = {}) {
  const started = service.startLobby({
    chatId: COMMUNITY_CHAT,
    threadId: extra.threadId !== undefined ? extra.threadId : 123,
    starter: extra.starter || starter(),
  });
  assert.strictEqual(started.ok, true, started.reason);
  service.setMessageId(started.gameId, extra.messageId || 9001);
  return started;
}

function joinInput(gameId, userId, name) {
  return {
    gameId,
    userId,
    displayName: { first_name: name, id: userId },
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  };
}

function actInput(gameId, userId) {
  return {
    gameId,
    userId,
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  };
}

async function pvpTable(service) {
  const started = start(service);
  const joined = service.tryJoin(joinInput(started.gameId, USER_B, "Bob"));
  assert.strictEqual(joined.ok, true, joined.reason);
  await service.forceLobbyEnd(started.gameId);
  await service.whenIdle(COMMUNITY_CHAT);
  return started.gameId;
}

function player(game, userId) {
  return game.players.find((p) => String(p.userId) === String(userId));
}

function createMockCtx(opts = {}) {
  const replies = [];
  const cbAnswers = [];
  const edits = [];
  return {
    replies,
    cbAnswers,
    edits,
    from: {
      id: opts.userId || USER_A,
      first_name: opts.firstName || "Alice",
      is_bot: Boolean(opts.isBot),
    },
    chat: {
      id: opts.chatId != null ? opts.chatId : COMMUNITY_CHAT,
      type: opts.chatType || "supergroup",
    },
    message: opts.callbackData
      ? undefined
      : {
          message_id: 1,
          message_thread_id: opts.messageThreadId != null ? opts.messageThreadId : 123,
          text: opts.text || "/blackjack",
        },
    callbackQuery: opts.callbackData
      ? {
          id: "cb1",
          data: opts.callbackData,
          message: {
            message_id: opts.messageId || 9001,
            message_thread_id: opts.messageThreadId != null ? opts.messageThreadId : 123,
            reply_markup: opts.keyboard || {
              inline_keyboard: [[{ text: "x", callback_data: opts.callbackData }]],
            },
          },
        }
      : undefined,
    reply: async (text, extra) => {
      replies.push({ text, extra });
      return { message_id: opts.replyId || 9001 };
    },
    answerCbQuery: async (text) => {
      cbAnswers.push(text);
    },
    editMessageText: async (text, extra) => {
      edits.push({ text, extra });
    },
  };
}

(async () => {
  await runTest("11. starter auto-joins", () => {
    const { service } = createService();
    const started = start(service);
    const game = service.getGame(started.gameId);
    assert.strictEqual(game.status, STATUS.LOBBY);
    assert.strictEqual(game.players.length, 1);
    assert.strictEqual(game.players[0].userId, String(USER_A));
    assert.ok(started.text.includes("Alice"));
    assert.ok(started.text.includes("Waiting for an opponent"));
  });

  await runTest("12. 60s countdown 60/55/50", async () => {
    assert.strictEqual(LOBBY_COUNTDOWN_MS, 5000);
    const { service, timers, edits } = createService();
    const started = start(service);
    assert.ok(started.text.includes("60s"));
    timers.advance(5000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.ok(edits.some((row) => String(row.text).includes("55s")));
    timers.advance(5000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.ok(edits.some((row) => String(row.text).includes("50s")));
  });

  await runTest("13. second human joins", () => {
    const { service } = createService();
    const started = start(service);
    const joined = service.tryJoin(joinInput(started.gameId, USER_B, "Bob"));
    assert.strictEqual(joined.ok, true);
    assert.ok(joined.text.includes("Bob"));
    assert.ok(joined.text.includes("Players:"));
  });

  await runTest("14. third reject", () => {
    const { service } = createService();
    const started = start(service);
    assert.strictEqual(service.tryJoin(joinInput(started.gameId, USER_B, "Bob")).ok, true);
    const third = service.tryJoin(joinInput(started.gameId, USER_C, "Cara"));
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.reason, "full");
  });

  await runTest("15. duplicate join reject", () => {
    const { service } = createService();
    const started = start(service);
    const dup = service.tryJoin(joinInput(started.gameId, USER_A, "Alice"));
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.reason, "duplicate");
  });

  await runTest("16. bot account reject", () => {
    const { service } = createService();
    const started = start(service);
    const botJoin = service.tryJoin({
      ...joinInput(started.gameId, USER_B, "Botty"),
      isBot: true,
    });
    assert.strictEqual(botJoin.ok, false);
    assert.strictEqual(botJoin.reason, "bot");
  });

  await runTest("17. no opponent → bot", async () => {
    const { service } = createService();
    const started = start(service);
    await service.forceLobbyEnd(started.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    const game = service.getGame(started.gameId);
    assert.strictEqual(game.status, STATUS.DECISION);
    assert.strictEqual(game.opponentType, "bot");
    assert.ok(game.players.some((p) => p.userId === BOT_ID));
  });

  await runTest("18. human opponent → PvP", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    const game = service.getGame(gameId);
    assert.strictEqual(game.opponentType, "human");
    assert.strictEqual(game.players.filter((p) => !p.isBot).length, 2);
  });

  await runTest("19. late join reject", async () => {
    const { service } = createService();
    const started = start(service);
    await service.forceLobbyEnd(started.gameId);
    const late = service.tryJoin(joinInput(started.gameId, USER_B, "Bob"));
    assert.strictEqual(late.ok, false);
    assert.strictEqual(late.toast, LATE_JOIN_TOAST);
  });

  await runTest("20. busy protection", () => {
    const { service } = createService();
    start(service);
    const second = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter("Bob", USER_B),
    });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, "already-active");
    assert.strictEqual(
      isCommunityChallengeBusy({ isBlackjackOpenFn: () => service.isBlackjackOpen() }),
      true
    );
    assert.strictEqual(
      getCommunityBusyReason({ isBlackjackOpenFn: () => service.isBlackjackOpen() }),
      "blackjack"
    );
  });

  await runTest("21. wrong topic reject", () => {
    const { service } = createService();
    const started = start(service);
    const wrong = service.tryJoin({
      ...joinInput(started.gameId, USER_B, "Bob"),
      threadId: 999,
    });
    assert.strictEqual(wrong.ok, false);
    assert.strictEqual(wrong.reason, "wrong-topic");
  });

  await runTest("22-23. Play/Pass recorded once", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    const play = service.tryDecide({ ...actInput(gameId, USER_A), choice: "play" });
    assert.strictEqual(play.ok, true);
    const again = service.tryDecide({ ...actInput(gameId, USER_A), choice: "pass" });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, "already");
    const pass = service.tryDecide({ ...actInput(gameId, USER_B), choice: "pass" });
    assert.strictEqual(pass.ok, true);
  });

  await runTest("24. user cannot decide for opponent", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    const outsider = service.tryDecide({ ...actInput(gameId, USER_C), choice: "play" });
    assert.strictEqual(outsider.ok, false);
    assert.strictEqual(outsider.reason, "not-seat");
  });

  await runTest("25. cards hidden before decision", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    const game = service.getGame(gameId);
    for (const p of game.players) {
      assert.deepStrictEqual(p.hand, []);
    }
  });

  await runTest("26. timeout → Pass", async () => {
    const { service } = createService({ decisionMs: 30_000, botThinkMs: 0 });
    const started = start(service);
    await service.forceLobbyEnd(started.gameId);
    await service.forceDecisionTimeout(started.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    const final = service.getFinalUi(started.gameId);
    assert.ok(final);
    assert.ok(final.text.includes("safe exit"));
    assert.strictEqual(service.isBlackjackOpen(COMMUNITY_CHAT), false);
  });

  await runTest("27. both Pass finishes", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "pass" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "pass" });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getGame(gameId), null);
    const final = service.getFinalUi(gameId);
    assert.ok(final.text.includes("safe exit"));
  });

  await runTest("28. one Pass one Play default win without cards", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "pass" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    const final = service.getFinalUi(gameId);
    assert.ok(final.text.includes("WINNER"));
    assert.ok(final.text.includes("Bob"));
  });

  await runTest("30. Hit draws", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    service.seedDeckForTests(gameId, [
      createCard("2", "spades"),
      createCard("3", "hearts"),
      createCard("4", "diamonds"),
      createCard("5", "clubs"),
      createCard("6", "spades"),
    ]);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "play" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    const before = player(service.getGame(gameId), USER_A);
    assert.strictEqual(before.hand.length, 2);
    const hit = service.tryHit(actInput(gameId, USER_A));
    assert.strictEqual(hit.ok, true);
    const after = player(service.getGame(gameId), USER_A);
    assert.strictEqual(after.hand.length, 3);
  });

  await runTest("31. Stand resolves turn", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "play" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    const stand = service.tryStand(actInput(gameId, USER_A));
    assert.strictEqual(stand.ok, true);
    const game = service.getGame(gameId);
    assert.strictEqual(game.currentTurn, String(USER_B));
  });

  await runTest("32. Hit on 21 auto-stands", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    service.seedDeckForTests(gameId, [
      createCard("10", "spades"),
      createCard("10", "hearts"),
      createCard("9", "diamonds"),
      createCard("7", "clubs"),
      createCard("A", "spades"),
    ]);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "play" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    service.tryHit(actInput(gameId, USER_A));
    const game = service.getGame(gameId);
    assert.strictEqual(player(game, USER_A).resolved, true);
    assert.strictEqual(game.currentTurn, String(USER_B));
  });

  await runTest("33. bust resolves", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    service.seedDeckForTests(gameId, [
      createCard("K", "spades"),
      createCard("Q", "hearts"),
      createCard("9", "diamonds"),
      createCard("7", "clubs"),
      createCard("5", "spades"),
    ]);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "play" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    service.tryHit(actInput(gameId, USER_A));
    const game = service.getGame(gameId);
    assert.strictEqual(player(game, USER_A).bust, true);
    assert.strictEqual(game.currentTurn, String(USER_B));
  });

  await runTest("34. wrong player cannot act", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "play" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    const hit = service.tryHit(actInput(gameId, USER_B));
    assert.strictEqual(hit.ok, false);
    assert.strictEqual(hit.toast, STALE_TURN_TOAST);
  });

  await runTest("35. stale callback safe", async () => {
    const { service } = createService();
    const started = start(service);
    await service.forceLobbyEnd(started.gameId);
    await service.forceDecisionTimeout(started.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    const ctx = createMockCtx({
      callbackData: callbackData("hit", started.gameId),
      userId: USER_A,
    });
    await handleBlackjackCallback(ctx, { runtime: service });
    assert.ok(ctx.cbAnswers.includes(STALE_CALLBACK) || ctx.cbAnswers.length > 0);
  });

  await runTest("36. turn timeout auto-stands", async () => {
    const { service } = createService({ turnMs: 30_000 });
    const gameId = await pvpTable(service);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "play" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    await service.forceTurnTimeout(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    const game = service.getGame(gameId);
    assert.strictEqual(player(game, USER_A).resolved, true);
    assert.strictEqual(game.currentTurn, String(USER_B));
  });

  await runTest("37-39. bot hits <17, stands >=17 and soft 17", async () => {
    const { service } = createService({ botThinkMs: 0 });
    const started = start(service);
    await service.forceLobbyEnd(started.gameId);
    service.seedDeckForTests(started.gameId, [
      createCard("K", "spades"),
      createCard("9", "hearts"),
      createCard("6", "diamonds"),
      createCard("A", "clubs"),
    ]);
    service.tryDecide({ ...actInput(started.gameId, USER_A), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    service.tryStand(actInput(started.gameId, USER_A));
    await service.whenIdle(COMMUNITY_CHAT);
    const final = service.getFinalUi(started.gameId);
    assert.ok(final.text.includes("ManGo Bot"));
    assert.ok(final.text.includes("stands on 17") || final.text.includes("17"));
  });

  await runTest("40. PvP winner correct", async () => {
    const { service } = createService();
    const gameId = await pvpTable(service);
    service.seedDeckForTests(gameId, [
      createCard("K", "spades"),
      createCard("9", "hearts"),
      createCard("8", "diamonds"),
      createCard("7", "clubs"),
    ]);
    service.tryDecide({ ...actInput(gameId, USER_A), choice: "play" });
    service.tryDecide({ ...actInput(gameId, USER_B), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    service.tryStand(actInput(gameId, USER_A));
    service.tryStand(actInput(gameId, USER_B));
    await service.whenIdle(COMMUNITY_CHAT);
    const final = service.getFinalUi(gameId);
    assert.ok(final.text.includes("WINNER"));
    assert.ok(final.text.includes("Alice"));
  });

  await runTest("41. bot result correct", async () => {
    const { service } = createService({ botThinkMs: 0 });
    const started = start(service);
    await service.forceLobbyEnd(started.gameId);
    service.seedDeckForTests(started.gameId, [
      createCard("K", "spades"),
      createCard("Q", "hearts"),
      createCard("8", "diamonds"),
      createCard("7", "clubs"),
      createCard("2", "spades"),
    ]);
    service.tryDecide({ ...actInput(started.gameId, USER_A), choice: "play" });
    await service.whenIdle(COMMUNITY_CHAT);
    service.tryStand(actInput(started.gameId, USER_A));
    await service.whenIdle(COMMUNITY_CHAT);
    const final = service.getFinalUi(started.gameId);
    assert.ok(final.text.includes("You beat the ManGo Bot"));
  });

  await runTest("callbacks parse without uids", () => {
    const parsed = parseBlackjackCallbackData("bj:hit:aabbccdd");
    assert.deepStrictEqual(parsed, { action: "hit", gameId: "aabbccdd" });
    assert.strictEqual(parseBlackjackCallbackData("bj:hit:aabbccdd:111"), null);
    assert.strictEqual(callbackData("join", "aabbccdd"), "bj:join:aabbccdd");
  });

  await runTest("private start redirects to Games topic", async () => {
    const ctx = createMockCtx({ chatType: "private", chatId: USER_A });
    await handleBlackjack(ctx, {
      isBusyFn: () => false,
      assertCanStartFn: async () => ({ ok: true }),
    });
    assert.ok(ctx.replies[0].text.includes(PRIVATE_BLACKJACK_TEXT.split("\n")[0]));
    assert.ok(BLACKJACK_TOPIC_REQUIRED_TEXT.includes("Games topic"));
  });

  await runTest("menu + help wire Blackjack", async () => {
    const extra = getGroupGamesMenuExtra({ botInfo: { username: "ManGoBot" } });
    const blob = JSON.stringify(extra);
    assert.ok(blob.includes(GROUP_MENU_CALLBACK.BLACKJACK));
    assert.ok(HELP_MESSAGE.includes("/blackjack"));
    assert.strictEqual(ACTION_REGISTRY.blackjack, undefined);
    const engineSrc = fs.readFileSync(
      path.join(__dirname, "../services/communityActivityEngine.js"),
      "utf8"
    );
    assert.ok(engineSrc.includes("isBlackjackBusy"));
    assert.ok(!engineSrc.includes("getBlackjackRuntime"));
    const ctx = createMockCtx({
      callbackData: GROUP_MENU_CALLBACK.BLACKJACK,
      messageThreadId: 123,
    });
    await handleGroupMenuCallback(ctx, {
      startLobbyFn: () => ({
        ok: true,
        gameId: "aabbccdd",
        text: "🃏 ManGo Blackjack",
        extra: {},
      }),
      isBusyFn: () => false,
      assertCanStartFn: async () => ({ ok: true }),
      setMessageIdFn: () => true,
    });
    assert.ok(ctx.replies.some((row) => String(row.text).includes("Blackjack")));
  });

  for (const [file, mtime] of Object.entries(prodMtimes)) {
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime, `mutated ${file}`);
  }

  restoreEnv();
  console.log("All blackjack game tests passed.");
})().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exitCode = 1;
});
