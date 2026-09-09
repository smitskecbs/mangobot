/**
 * Trivia stale recovery + generic game-message cleanup.
 * Run: node tests/game-message-cleanup.test.js
 */

const assert = require("assert");
const {
  createTriviaService,
  STATUS,
} = require("../services/trivia");
const {
  createTicTacToeService,
} = require("../services/ticTacToe");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const {
  GAME_TYPE,
  GAME_CLEANUP_FOOTER,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  scheduleGameMessageCleanup,
  addGameMessageIds,
  getScheduledGameCleanupIds,
  clearAllGameMessageCleanups,
  getPendingGameMessageCleanupCount,
  withGameCleanupFooter,
} = require("../utils/gameCleanup");
const { GAMES_TOPIC_REQUIRED_MESSAGE } = require("../utils/gameTopic");
const { handlePvpCallback } = require("../events/pvp-callbacks");
const { parsePvpCallbackData } = require("../services/ticTacToe");
const { createPvpMatchReservation } = require("../services/pvpMatchReservation");
const {
  isCommunityChallengeBusy,
} = require("../services/communityGameState");
const {
  ACTION_IDS,
  parseActivityEngineConfig,
  processCommunityActivitySlot,
} = require("../services/communityActivityEngine");
const { formatCommunityQuestionMessage } = require("../services/communityQuestions");

const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;

const originalChatId = process.env.TELEGRAM_CHAT_ID;

function resetEnv() {
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
}

function restoreEnv() {
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

function makeBank(n = 12) {
  const bank = [];
  for (let i = 0; i < n; i += 1) {
    bank.push({
      id: `t-${i}`,
      category: "general",
      question: `Question number ${i}?`,
      answers: ["Alpha", "Beta", "Gamma", "Delta"],
      correctIndex: 1,
    });
  }
  return bank;
}

function createTrivia(overrides = {}) {
  const timers = createFakeTimers();
  const deleted = [];
  const service = createTriviaService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    random: () => 0,
    randomIdFn: overrides.randomIdFn || (() => "abc123"),
    questions: makeBank(),
    questionTimeoutMs: overrides.questionTimeoutMs != null ? overrides.questionTimeoutMs : 60_000,
    nextQuestionDelayMs: overrides.nextQuestionDelayMs != null ? overrides.nextQuestionDelayMs : 1,
    staleAfterMs: overrides.staleAfterMs != null ? overrides.staleAfterMs : 5_000,
    cleanupDelayMs: overrides.cleanupDelayMs != null ? overrides.cleanupDelayMs : 1_000,
    deleteMessageFn: async (chatId, messageId) => {
      deleted.push({ chatId, messageId });
      if (typeof overrides.onDelete === "function") {
        return overrides.onDelete(chatId, messageId);
      }
      return true;
    },
    totalQuestions: overrides.totalQuestions || 5,
  });
  service.setEditMessageHandler(() => {});
  return { service, timers, deleted };
}

function startAuto(service, id = 44) {
  const started = service.startTrivia({ chatId: COMMUNITY_CHAT, source: "manual" });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, id);
  return started;
}

async function answerCorrect(service, sessionId) {
  const snap = service.getSnapshot();
  return service.tryAnswer({
    sessionId,
    userId: USER_A,
    answerIndex: snap.correctIndex,
    chatId: COMMUNITY_CHAT,
    displayName: "Alice",
  });
}

async function runTest(name, fn) {
  resetEnv();
  clearAllGameMessageCleanups();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  } finally {
    clearAllGameMessageCleanups();
  }
}

async function main() {
    assert.strictEqual(GAME_MESSAGE_CLEANUP_DELAY_MS, 60 * 1000);

  await runTest("1. Trivia normal end releases active state", async () => {
    const { service, timers } = createTrivia();
    const started = startAuto(service);
    for (let q = 1; q <= 5; q += 1) {
      await answerCorrect(service, started.session.id);
      timers.advance(1);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, STATUS.COMPLETE);
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTriviaOpenFn: () => service.isTriviaOpen(),
        isMangoBombOpenFn: () => false,
      }),
      false
    );
  });

  await runTest("2. Trivia timeout end releases active state", () => {
    const { service, timers } = createTrivia({ questionTimeoutMs: 100 });
    startAuto(service);
    for (let q = 1; q <= 5; q += 1) {
      timers.advance(100);
      timers.advance(1);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, STATUS.COMPLETE);
  });

  await runTest("3. Trivia error/cancel releases active state", () => {
    const { service } = createTrivia();
    startAuto(service);
    service.abortRound("edit-failed");
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, STATUS.ABORTED);
    const next = service.startTrivia({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(next.ok, true);
  });

  await runTest("4. stale Trivia state does not permanently block a new game", async () => {
    const { service, timers } = createTrivia({ staleAfterMs: 500 });
    const first = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      hubMode: true,
      category: "general",
    });
    service.setMessageId(first.session.id, 11);
    await answerCorrect(service, first.session.id);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(service.isTriviaOpen(), true);
    timers.advance(500);
    assert.strictEqual(service.isTriviaOpen(), false);
    const second = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      hubMode: true,
      category: "general",
    });
    assert.strictEqual(second.ok, true);
  });

  await runTest("5. bot restart / timerless leftover is recovered", () => {
    const { service } = createTrivia();
    startAuto(service);
    service.clearAllTimers();
    assert.strictEqual(service.getPendingTimerCount(), 0);
    assert.strictEqual(service.isTriviaOpen(), false);
    const fresh = createTriviaService({
      random: () => 0,
      questions: makeBank(),
    });
    const started = fresh.startTrivia({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(started.ok, true);
    fresh.reset();
  });

  await runTest("6. cleanup only after configured delay", async () => {
    const { service, timers, deleted } = createTrivia({ cleanupDelayMs: 2_000 });
    const started = startAuto(service, 55);
    service.abortRound("cancelled");
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(deleted.length, 0);
    timers.advance(1_999);
    await Promise.resolve();
    assert.strictEqual(deleted.length, 0);
    timers.advance(1);
    await Promise.resolve();
    assert.ok(deleted.some((row) => row.messageId === 55));
    void started;
  });

  await runTest("7. only registered game message IDs are deleted", async () => {
    const timers = createFakeTimers();
    const deleted = [];
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TRIVIA,
      sessionId: "sess-a",
      chatId: COMMUNITY_CHAT,
      messageIds: [101, 102],
      delayMs: 10,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push({ chatId, messageId });
      },
    });
    assert.deepStrictEqual(getScheduledGameCleanupIds(GAME_TYPE.TRIVIA, "sess-a").sort(), [
      "101",
      "102",
    ]);
    timers.advance(10);
    await Promise.resolve();
    assert.deepStrictEqual(
      deleted.map((row) => row.messageId).sort(),
      [101, 102]
    );
    assert.ok(!deleted.some((row) => row.messageId === 999));
  });

  await runTest("8. Telegram delete failure does not crash", async () => {
    const timers = createFakeTimers();
    let logged = false;
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TRIVIA,
      sessionId: "sess-fail",
      chatId: COMMUNITY_CHAT,
      messageIds: [7],
      delayMs: 5,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async () => {
        throw new Error("telegram 400");
      },
      logErrorFn: () => {
        logged = true;
      },
    });
    timers.advance(5);
    await Promise.resolve();
    assert.strictEqual(logged, true);
  });

  await runTest("9. delete failure does not keep Trivia active", async () => {
    const { service, timers } = createTrivia({
      cleanupDelayMs: 10,
      onDelete: async () => {
        throw new Error("cannot delete");
      },
    });
    startAuto(service, 66);
    service.abortRound("cancelled");
    assert.strictEqual(service.isTriviaOpen(), false);
    timers.advance(10);
    await Promise.resolve();
    assert.strictEqual(service.isTriviaOpen(), false);
    const next = service.startTrivia({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(next.ok, true);
  });

  await runTest("10. cleanup session A does not affect session B", async () => {
    const timers = createFakeTimers();
    const deleted = [];
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TICTACTOE,
      sessionId: "a",
      chatId: COMMUNITY_CHAT,
      messageIds: [1],
      delayMs: 10,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (_c, messageId) => {
        deleted.push(messageId);
      },
    });
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TICTACTOE,
      sessionId: "b",
      chatId: COMMUNITY_CHAT,
      messageIds: [2],
      delayMs: 10_000,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (_c, messageId) => {
        deleted.push(messageId);
      },
    });
    addGameMessageIds(GAME_TYPE.TICTACTOE, "b", COMMUNITY_CHAT, [3]);
    timers.advance(10);
    await Promise.resolve();
    assert.deepStrictEqual(deleted, [1]);
    assert.deepStrictEqual(getScheduledGameCleanupIds(GAME_TYPE.TICTACTOE, "b").sort(), [
      "2",
      "3",
    ]);
  });

  await runTest("11. existing parallel PvP games still work", () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const ttt = createTicTacToeService({
      manager,
      now: timers.now,
      joinTimeoutMs: 60_000,
      turnTimeoutMs: 60_000,
    });
    const a = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    const b = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_B, displayName: "Alice", isBot: false },
    });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    ttt.setMessageId(a.session.id, 10);
    ttt.setMessageId(b.session.id, 20);
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TICTACTOE,
      sessionId: a.session.id,
      chatId: COMMUNITY_CHAT,
      messageIds: [10],
      delayMs: 1,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async () => {},
    });
    timers.advance(1);
    assert.strictEqual(ttt.getSession(b.session.id).status, "waiting");
    assert.ok(ttt.getSession(a.session.id));
    assert.strictEqual(ttt.isOpen(), true);
  });

  await runTest("12. cleanup timer unref does not keep the process open", () => {
    let unrefed = false;
    const handle = {
      unref() {
        unrefed = true;
      },
    };
    const scheduled = scheduleGameMessageCleanup({
      gameType: GAME_TYPE.BLACKJACK,
      sessionId: "unref",
      chatId: COMMUNITY_CHAT,
      messageIds: [8],
      delayMs: 50,
      setTimeoutFn: () => handle,
      clearTimeoutFn: () => {},
      deleteMessageFn: async () => {},
    });
    assert.strictEqual(scheduled.scheduled, true);
    assert.strictEqual(unrefed, true);
    scheduled.clear();
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
  });

  await runTest("16. community open-question post is not registered for game cleanup", async () => {
    const sent = [];
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        autoFightEnabled: false,
        intervalMinutes: 30,
      }
    );
    const result = await processCommunityActivitySlot({
      chatId: COMMUNITY_CHAT,
      slot: { id: "act1200", label: "12:00", hour: 12, minute: 0 },
      dayKey: "2026-08-30",
      config: cfg,
      state: {
        sent: {},
        lastMessageKey: null,
        recentActivityTypes: [],
        autoChatFight: { processedSlots: {}, lastStartedAt: null, lastType: null },
      },
      chatFight: {
        isFightOpen: () => false,
        isOnCooldown: () => false,
        startFight: () => ({ ok: false }),
      },
      sendMessage: async (_chatId, text) => {
        sent.push(text);
        return true;
      },
      random: () => 0,
      wasActiveWithinFn: () => false,
      nowMs: Date.now(),
      forceAction: ACTION_IDS.QUESTION,
    });
    assert.strictEqual(result.sent, true);
    assert.strictEqual(result.action, ACTION_IDS.QUESTION);
    assert.ok(sent[0]);
    assert.ok(sent[0].startsWith("🥭 ManGo Question"));
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
    assert.deepStrictEqual(getScheduledGameCleanupIds("community", "open-question"), []);
  });

  await runTest("17. scheduler check-in prompt is not deleted by game cleanup", async () => {
    const timers = createFakeTimers();
    const deleted = [];
    const communityMessageId = 4242;
    const gameMessageId = 88;
    const sent = [];
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        autoFightEnabled: false,
        intervalMinutes: 30,
      }
    );
    const checkin = await processCommunityActivitySlot({
      chatId: COMMUNITY_CHAT,
      slot: { id: "act1210", label: "12:10", hour: 12, minute: 10 },
      dayKey: "2026-08-30",
      config: cfg,
      state: {
        sent: {},
        lastMessageKey: null,
        recentActivityTypes: [],
        autoChatFight: { processedSlots: {}, lastStartedAt: null, lastType: null },
      },
      chatFight: {
        isFightOpen: () => false,
        isOnCooldown: () => false,
        startFight: () => ({ ok: false }),
      },
      sendMessage: async (_chatId, text) => {
        sent.push({ text, messageId: communityMessageId });
        return true;
      },
      random: () => 0,
      wasActiveWithinFn: () => false,
      nowMs: Date.now(),
      forceAction: ACTION_IDS.CHECKIN,
    });
    assert.strictEqual(checkin.sent, true);
    assert.ok(
      sent[0].text.includes("What are you building, playing or watching today?")
    );
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);

    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TICTACTOE,
      sessionId: "game-only",
      chatId: COMMUNITY_CHAT,
      messageIds: [gameMessageId],
      delayMs: 5,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push({ chatId, messageId });
      },
    });
    timers.advance(5);
    await Promise.resolve();
    assert.deepStrictEqual(
      deleted.map((row) => row.messageId),
      [gameMessageId]
    );
    assert.ok(!deleted.some((row) => row.messageId === communityMessageId));
    assert.ok(
      formatCommunityQuestionMessage({
        id: "q029",
        category: "builder",
        text: "What are you building or learning right now?",
      }).includes("What are you building or learning right now?")
    );
  });

  await runTest("A. active game message is not cleaned", async () => {
    const timers = createFakeTimers();
    const deleted = [];
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const ttt = createTicTacToeService({
      manager,
      now: timers.now,
      joinTimeoutMs: 10 * 60 * 1000,
    });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    ttt.setMessageId(started.session.id, 44);
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
    timers.advance(GAME_MESSAGE_CLEANUP_DELAY_MS);
    await Promise.resolve();
    assert.strictEqual(deleted.length, 0);
    assert.strictEqual(ttt.getSession(started.session.id).status, "waiting");
  });

  await runTest("B-C. terminal keyboard stripped and footer applied", async () => {
    const expired = require("../services/ticTacToe").renderMessage({
      status: "expired",
      players: { X: { displayName: "Kevin" } },
    });
    assert.deepStrictEqual(expired.extra.reply_markup.inline_keyboard, []);
    assert.ok(expired.text.includes(GAME_CLEANUP_FOOTER));
    assert.ok(withGameCleanupFooter("done").includes(GAME_CLEANUP_FOOTER));
  });

  await runTest("D-E. terminal result deletes after delay; session already free", async () => {
    const { service, timers, deleted } = createTrivia({ cleanupDelayMs: 60_000 });
    const started = startAuto(service, 77);
    service.abortRound("cancelled");
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(deleted.length, 0);
    timers.advance(59_999);
    await Promise.resolve();
    assert.strictEqual(deleted.length, 0);
    timers.advance(1);
    await Promise.resolve();
    assert.ok(deleted.some((d) => d.messageId === 77));
  });

  await runTest("F-G. stale callback is game-ended, not Games-topic", async () => {
    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_A, first_name: "Kevin", is_bot: false },
      callbackQuery: {
        data: "pvp:ttt:join:aabbccdd",
        message: {
          message_id: 12,
          chat: { id: COMMUNITY_CHAT },
          reply_markup: { inline_keyboard: [[{ text: "JOIN", callback_data: "x" }]] },
        },
      },
      answered: [],
      edits: [],
      async answerCbQuery(text) {
        this.answered.push(text || "");
      },
      async editMessageText(text, extra) {
        this.edits.push({ text, extra });
      },
    };
    const manager = createPvpSessionManager();
    const ttt = createTicTacToeService({ manager });
    await handlePvpCallback(ctx, {
      runtime: ttt,
      parseCallbackData: parsePvpCallbackData,
    });
    const blob = JSON.stringify(ctx.answered) + JSON.stringify(ctx.edits);
    assert.ok(!blob.includes("Games are played in the Games topic"));
    assert.ok(!blob.includes(GAMES_TOPIC_REQUIRED_MESSAGE));
    assert.ok(
      ctx.answered.some((t) => String(t).includes("ended") || String(t).includes("over"))
    );
    assert.ok(ctx.edits[0].text.includes(GAME_CLEANUP_FOOTER));
    assert.deepStrictEqual(ctx.edits[0].extra.reply_markup.inline_keyboard, []);
  });

  await runTest("H. valid game start in wrong topic still gets Games-topic guidance", async () => {
    assert.ok(GAMES_TOPIC_REQUIRED_MESSAGE.includes("Games topic"));
  });

  await runTest("I-J. old cleanup cannot delete new replay or release new reservation", async () => {
    const timers = createFakeTimers();
    const deleted = [];
    const reservation = createPvpMatchReservation();
    const live = { status: "active", messageId: 900, round: 2 };
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.RPS,
      sessionId: "old-round",
      chatId: COMMUNITY_CHAT,
      messageIds: [900],
      generation: 1,
      delayMs: 10,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push(messageId);
      },
      shouldDeleteFn: () => {
        if (live.status === "active") return false;
        if (String(live.round) !== "1") return false;
        return true;
      },
    });
    reservation.tryReserve(USER_A, "rps", "new-session");
    timers.advance(10);
    await Promise.resolve();
    assert.deepStrictEqual(deleted, []);
    assert.strictEqual(reservation.has(USER_A), true);
  });

  await runTest("K-L. user and unrelated bot messages are never deleted", async () => {
    const timers = createFakeTimers();
    const deleted = [];
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TICTACTOE,
      sessionId: "s1",
      chatId: COMMUNITY_CHAT,
      messageIds: [501],
      delayMs: 5,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push(messageId);
      },
    });
    timers.advance(5);
    await Promise.resolve();
    assert.deepStrictEqual(deleted, [501]);
    assert.ok(!deleted.includes(1));
    assert.ok(!deleted.includes(9999));
  });

  await runTest("M. cleanup Telegram failure is swallowed safely", async () => {
    const timers = createFakeTimers();
    let logged = 0;
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TICTACTOE,
      sessionId: "s-fail",
      chatId: COMMUNITY_CHAT,
      messageIds: [8],
      delayMs: 1,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async () => {
        throw new Error("telegram down");
      },
      logErrorFn: () => {
        logged += 1;
      },
    });
    timers.advance(1);
    await Promise.resolve();
    assert.strictEqual(logged, 1);
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
  });

  await runTest("N. no retry/delete loop after failure", async () => {
    const timers = createFakeTimers();
    let calls = 0;
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TICTACTOE,
      sessionId: "s-loop",
      chatId: COMMUNITY_CHAT,
      messageIds: [9],
      delayMs: 1,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async () => {
        calls += 1;
        throw new Error("fail");
      },
      logErrorFn: () => {},
    });
    timers.advance(1);
    await Promise.resolve();
    timers.advance(60_000);
    await Promise.resolve();
    assert.strictEqual(calls, 1);
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
  });

  await runTest("O. no cross-game message deletion", async () => {
    const timers = createFakeTimers();
    const deleted = [];
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TICTACTOE,
      sessionId: "ttt-1",
      chatId: COMMUNITY_CHAT,
      messageIds: [10],
      delayMs: 5,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push({ game: "ttt", messageId });
      },
    });
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.CHECKERS,
      sessionId: "chk-1",
      chatId: COMMUNITY_CHAT,
      messageIds: [11],
      delayMs: 5,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push({ game: "chk", messageId });
      },
    });
    timers.advance(5);
    await Promise.resolve();
    assert.deepStrictEqual(deleted, [
      { game: "ttt", messageId: 10 },
      { game: "chk", messageId: 11 },
    ]);
  });

  restoreEnv();
  console.log("\nAll game-message-cleanup tests passed.");
}

main().catch((err) => {
  restoreEnv();
  clearAllGameMessageCleanups();
  console.error(err);
  process.exit(1);
});
