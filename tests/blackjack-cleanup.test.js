/**
 * ManGo Blackjack cleanup, fallback, busy release, restart, stale games.
 * Run: node tests/blackjack-cleanup.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  createBlackjackService,
  callbackData,
  STATUS,
  getBlackjackRuntime,
  STALE_CALLBACK,
} = require("../services/blackjack");
const {
  isCommunityChallengeBusy,
} = require("../services/communityGameState");
const {
  GAME_TYPE,
  FINAL_STATE,
  buildFinalGameText,
  emptyGameKeyboardExtra,
} = require("../utils/gameCleanup");
const { handleBlackjackCallback } = require("../commands/blackjack");

const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const OWNER_ID = 999001;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;

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
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
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
  const sends = [];
  const service = createBlackjackService({
    now: () => timers.now(),
    setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
    randomIntFn: () => 0,
    randomIdFn: overrides.randomIdFn || (() => "aabbccdd"),
    botThinkMs: 0,
    renderTimeoutMs: overrides.renderTimeoutMs || 20,
  });
  service.setEditMessageHandler(async (chatId, messageId, text, extra) => {
    edits.push({ chatId, messageId, text, extra });
  });
  service.setSendMessageHandler(async (chatId, text, extra) => {
    sends.push({ chatId, text, extra });
    return { message_id: 42 };
  });
  return { service, timers, edits, sends };
}

function starter() {
  return { userId: USER_A, displayName: { first_name: "Alice", id: USER_A }, isBot: false };
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

function createMockCtx(opts = {}) {
  const cbAnswers = [];
  const edits = [];
  return {
    cbAnswers,
    edits,
    from: { id: opts.userId || USER_A, first_name: "Alice", is_bot: false },
    chat: { id: COMMUNITY_CHAT, type: "supergroup" },
    callbackQuery: {
      id: "cb1",
      data: opts.callbackData,
      message: {
        message_id: opts.messageId || 9001,
        message_thread_id: 123,
        reply_markup: {
          inline_keyboard: [[{ text: "Hit", callback_data: opts.callbackData }]],
        },
      },
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
  await runTest("67. final buttons removed", async () => {
    const { service } = createService();
    const started = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    service.setMessageId(started.gameId, 9001);
    await service.forceLobbyEnd(started.gameId);
    await service.forceDecisionTimeout(started.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    const ui = service.getFinalUi(started.gameId);
    assert.ok(ui);
    const extra = ui.extra || emptyGameKeyboardExtra();
    const keyboard =
      extra.reply_markup && extra.reply_markup.inline_keyboard
        ? extra.reply_markup.inline_keyboard
        : [];
    assert.ok(keyboard.every((row) => !row.length));
  });

  await runTest("68. lobby cancelled safe", async () => {
    const { service, timers } = createService();
    const started = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    service.cancelAll("test");
    assert.strictEqual(service.isBlackjackOpen(), false);
    assert.strictEqual(service.getGame(started.gameId), null);
    assert.strictEqual(service.getPendingTimerCount(), 0);
    timers.advance(60_000);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.isBlackjackOpen(), false);
  });

  await runTest("69. render failure state still finishes", async () => {
    const { service } = createService();
    service.injectRenderFailureForTests("throw");
    const started = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    service.setMessageId(started.gameId, 9001);
    await service.forceLobbyEnd(started.gameId);
    await service.forceDecisionTimeout(started.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.isBlackjackOpen(COMMUNITY_CHAT), false);
    assert.ok(service.getFinalUi(started.gameId));
  });

  await runTest("70. final edit failure fallback", async () => {
    const { service, sends } = createService();
    const started = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    service.setMessageId(started.gameId, 9001);
    await service.forceLobbyEnd(started.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    service.injectRenderFailureForTests("throw");
    await service.forceDecisionTimeout(started.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    await service.whenWinnerUiIdle();
    assert.ok(sends.length >= 1);
    assert.ok(String(sends[0].text).includes("Blackjack") || String(sends[0].text).includes("safe exit"));
  });

  await runTest("71. busy released", async () => {
    const { service } = createService();
    const started = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    assert.strictEqual(service.isBlackjackOpen(), true);
    assert.strictEqual(
      isCommunityChallengeBusy({ isBlackjackOpenFn: () => service.isBlackjackOpen() }),
      false
    );
    await service.forceLobbyEnd(started.gameId);
    await service.forceDecisionTimeout(started.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.isBlackjackOpen(), false);
    assert.strictEqual(
      isCommunityChallengeBusy({ isBlackjackOpenFn: () => service.isBlackjackOpen() }),
      false
    );
  });

  await runTest("72. restart/shutdown clears", () => {
    const { service } = createService();
    service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    service.clearAllTimers();
    assert.strictEqual(service.isBlackjackOpen(), false);
    assert.strictEqual(service.getPendingTimerCount(), 0);
  });

  await runTest("73. new Blackjack can start afterward", async () => {
    const { service } = createService({ randomIdFn: () => "aabbccdd" });
    const first = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    await service.forceLobbyEnd(first.gameId);
    await service.forceDecisionTimeout(first.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    const second = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    assert.strictEqual(second.ok, true);
    assert.notStrictEqual(second.gameId, first.gameId);
  });

  await runTest("74. stale callback old game cannot affect new", async () => {
    let ids = 0;
    const { service } = createService({
      randomIdFn: () => {
        ids += 1;
        return ids === 1 ? "aaaa1111" : "bbbb2222";
      },
    });
    const first = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(),
    });
    service.setMessageId(first.gameId, 1);
    await service.forceLobbyEnd(first.gameId);
    await service.forceDecisionTimeout(first.gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    const second = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: {
        userId: USER_B,
        displayName: { first_name: "Bob", id: USER_B },
        isBot: false,
      },
    });
    service.setMessageId(second.gameId, 2);
    const ctx = createMockCtx({
      callbackData: callbackData("join", first.gameId),
      userId: USER_A,
      messageId: 1,
    });
    await handleBlackjackCallback(ctx, { runtime: service });
    assert.ok(ctx.cbAnswers.includes(STALE_CALLBACK) || ctx.cbAnswers.length > 0);
    const live = service.getGame(second.gameId);
    assert.strictEqual(live.status, STATUS.LOBBY);
    assert.strictEqual(live.players.length, 1);
    assert.strictEqual(live.players[0].userId, String(USER_B));
  });

  await runTest("final copy helpers include blackjack", () => {
    const text = buildFinalGameText(GAME_TYPE.BLACKJACK, FINAL_STATE.CANCELLED);
    assert.ok(text.includes("Blackjack"));
    assert.strictEqual(GAME_TYPE.BLACKJACK, "blackjack");
  });

  for (const [file, mtime] of Object.entries(prodMtimes)) {
    if (fs.existsSync(file)) {
      assert.strictEqual(fs.statSync(file).mtimeMs, mtime, `mutated ${file}`);
    }
  }

  restoreEnv();
  console.log("All blackjack cleanup tests passed.");
})().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exitCode = 1;
});
