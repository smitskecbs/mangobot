/**
 * Shared game lobby/final-message cleanup + Bomb winner fallback.
 * Run: node tests/game-cleanup.test.js
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  createMangoBombService,
  joinCallbackData,
  STATUS,
  STALE_CALLBACK,
  getMangoBombRuntime,
} = require("../services/mangoBomb");
const { handleMangoBombCallback } = require("../commands/mangobomb");
const {
  createTicTacToeService,
  parsePvpCallbackData: parseTttCallbackData,
} = require("../services/ticTacToe");
const {
  createConnectFourService,
  parsePvpCallbackData: parseC4CallbackData,
} = require("../services/connectFour");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const { handlePvpCallback, registerPvpCallbacks } = require("../events/pvp-callbacks");
const {
  getPendingExpiredCleanupCount,
  clearAllExpiredMessageCleanups,
} = require("../utils/expiredMessageCleanup");
const {
  createChatFightService,
  FIGHT_TYPES,
  REVEAL_CALLBACK_DATA,
} = require("../services/chatFight");
const { handleChatFightReveal } = require("../commands/chatfight");
const {
  createTriviaService,
  buildAnswerCallbackData,
  STATUS: TRIVIA_STATUS,
} = require("../services/trivia");
const { handleTriviaAnswer } = require("../commands/trivia");
const {
  isCommunityChallengeBusy,
} = require("../services/communityGameState");
const {
  GAME_OVER_TOAST,
  GAME_TYPE,
  FINAL_STATE,
  buildFinalGameText,
  callbackMessageHasButtons,
  clearAllGameMessageCleanups,
} = require("../utils/gameCleanup");

const COMMUNITY_CHAT = -1001234567890;
const OTHER_CHAT = -1009999999999;
const USER_A = 111;
const USER_B = 222;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalAdmin = process.env.ADMIN_USER_ID;

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
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  process.env.ADMIN_USER_ID = "999001";
}

function restoreEnv() {
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
}

async function runTest(name, fn) {
  resetEnv();
  getMangoBombRuntime().reset();
  clearAllExpiredMessageCleanups();
  clearAllGameMessageCleanups();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  } finally {
    getMangoBombRuntime().reset();
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

function joinKeyboardMarkup(gameId) {
  return {
    inline_keyboard: [[{ text: "💣 JOIN BOMB", callback_data: joinCallbackData(gameId) }]],
  };
}

function createBombCtx({ gameId, userId = USER_A, chatId = COMMUNITY_CHAT, hasButtons = true }) {
  const cbAnswers = [];
  const edited = [];
  return {
    chat: { id: chatId, type: "supergroup" },
    from: { id: userId, first_name: "Kevin", is_bot: false },
    callbackQuery: {
      data: joinCallbackData(gameId),
      from: { id: userId, is_bot: false },
      message: {
        message_id: 9001,
        chat: { id: chatId, type: "supergroup" },
        message_thread_id: 123,
        reply_markup: hasButtons ? joinKeyboardMarkup(gameId) : { inline_keyboard: [] },
      },
    },
    cbAnswers,
    edited,
    answerCbQuery(text) {
      cbAnswers.push(text || "");
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      edited.push({ text, extra });
      if (this.callbackQuery && this.callbackQuery.message) {
        this.callbackQuery.message.reply_markup = extra && extra.reply_markup;
      }
      return Promise.resolve();
    },
  };
}

async function main() {
  await runTest("copy. empty / not-enough / expired / cancelled", async () => {
    assert.strictEqual(STALE_CALLBACK, GAME_OVER_TOAST);
    assert.ok(
      buildFinalGameText(GAME_TYPE.MANGOBOMB, FINAL_STATE.EMPTY).includes(
        "No one joined this round."
      )
    );
    assert.ok(
      buildFinalGameText(GAME_TYPE.TICTACTOE, FINAL_STATE.NOT_ENOUGH).includes(
        "Not enough players joined."
      )
    );
    assert.ok(
      buildFinalGameText(GAME_TYPE.CONNECT4, FINAL_STATE.EXPIRED).includes(
        "This game has ended."
      )
    );
    assert.ok(
      buildFinalGameText(GAME_TYPE.TRIVIA, FINAL_STATE.CANCELLED).includes(
        "This round was cancelled."
      )
    );
  });

  await runTest("1-8. bomb empty lobby closes, strips buttons, busy free, restart ok", async () => {
    const timers = createFakeTimers();
    const edits = [];
    const service = createMangoBombService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      randomIntFn: () => 0,
      randomIdFn: () => "aabbccdd",
      lobbyMs: 500,
      startCooldownMs: 0,
      watchdogMs: 10_000,
    });
    service.setEditMessageHandler(async (chatId, messageId, text, extra) => {
      edits.push({ chatId, messageId, text, extra });
    });
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(started.gameId, 9001);
    assert.strictEqual(service.isMangoBombOpen(), true);
    timers.advance(500);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
    const final = edits.find((row) => row.text.includes("No one joined this round."));
    assert.ok(final);
    assert.deepStrictEqual(final.extra.reply_markup.inline_keyboard, []);
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isTriviaOpenFn: () => false,
        isMangoBombOpenFn: () => service.isMangoBombOpen(),
      }),
      false
    );

    const ctx = createBombCtx({ gameId: started.gameId });
    assert.strictEqual(callbackMessageHasButtons(ctx), true);
    await handleMangoBombCallback(ctx, { runtime: service });
    assert.strictEqual(ctx.cbAnswers[0], GAME_OVER_TOAST);
    assert.ok(ctx.edited[0].text.includes("No one joined this round."));
    assert.deepStrictEqual(ctx.edited[0].extra.reply_markup.inline_keyboard, []);

    const again = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    assert.strictEqual(again.ok, true);
    service.clearAllTimers();
    assert.strictEqual(service.getPendingTimerCount(), 0);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
  });

  await runTest("7. cleanup edit failure does not reopen game", async () => {
    const timers = createFakeTimers();
    const service = createMangoBombService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      randomIntFn: () => 0,
      randomIdFn: () => "aabbccdd",
      lobbyMs: 200,
      startCooldownMs: 0,
      watchdogMs: 10_000,
    });
    service.setEditMessageHandler(async () => {
      throw new Error("telegram down");
    });
    service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    timers.advance(200);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
    assert.strictEqual(service.isMangoBombOpen(), false);
  });

  await runTest("27. old bomb callback cannot mutate new game", async () => {
    const timers = createFakeTimers();
    let n = 0;
    const service = createMangoBombService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      randomIntFn: () => 0,
      randomIdFn: () => {
        n += 1;
        return n === 1 ? "aaaa1111" : "bbbb2222";
      },
      lobbyMs: 200,
      startCooldownMs: 0,
      watchdogMs: 10_000,
    });
    const edits = [];
    service.setEditMessageHandler(async (_c, _m, text, extra) => {
      edits.push({ text, extra });
    });
    const first = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(first.gameId, 9001);
    timers.advance(200);
    await service.whenIdle(COMMUNITY_CHAT);
    const second = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(second.gameId, 9002);
    const ctx = createBombCtx({ gameId: first.gameId });
    await handleMangoBombCallback(ctx, { runtime: service });
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(service.getGame(second.gameId).playerCount, 0);
  });

  await runTest("28. wrong chat/topic stay safe", async () => {
    const timers = createFakeTimers();
    const service = createMangoBombService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      randomIntFn: () => 0,
      randomIdFn: () => "aabbccdd",
      startCooldownMs: 0,
      watchdogMs: 10_000,
    });
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    const ctx = createBombCtx({ gameId: started.gameId, chatId: OTHER_CHAT });
    await handleMangoBombCallback(ctx, { runtime: service });
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(ctx.cbAnswers[0], GAME_OVER_TOAST);
    service.clearAllTimers();
  });

  await runTest("23. TTT stale join strips buttons", async () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const ttt = createTicTacToeService({
      manager,
      now: timers.now,
      joinTimeoutMs: 1000,
      turnTimeoutMs: 1000,
    });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    ttt.setMessageId(started.session.id, 5001);
    ttt.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    timers.advance(1000);
    assert.strictEqual(ttt.getSession(started.session.id).status, "won");
    const ended = ttt.getSession(started.session.id);
    assert.deepStrictEqual(
      ttt.renderMessage(ended).extra.reply_markup.inline_keyboard,
      []
    );

    const edited = [];
    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_A, is_bot: false, first_name: "Kevin" },
      callbackQuery: {
        data: `pvp:ttt:join:${started.session.id}`,
        from: { id: USER_A, is_bot: false },
        message: {
          message_id: 5001,
          chat: { id: COMMUNITY_CHAT },
          reply_markup: {
            inline_keyboard: [[{ text: "Join game", callback_data: "x" }]],
          },
        },
      },
      cbAnswers: [],
      answerCbQuery(text) {
        this.cbAnswers.push(text || "");
        return Promise.resolve();
      },
      editMessageText(text, extra) {
        edited.push({ text, extra });
        return Promise.resolve();
      },
    };
    await handlePvpCallback(ctx, {
      runtime: ttt,
      parseCallbackData: parseTttCallbackData,
      awardPvpWinXpFn: () => ({ awarded: false }),
    });
    assert.strictEqual(ctx.cbAnswers[0], GAME_OVER_TOAST);
    assert.ok(edited[0].text.includes("TIC-TAC-TOE") || edited[0].text.includes("Tic-Tac-Toe"));
    assert.deepStrictEqual(edited[0].extra.reply_markup.inline_keyboard, []);
  });

  await runTest("23b. TTT live bot match join does not strip board", async () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const ttt = createTicTacToeService({
      manager,
      now: timers.now,
      joinTimeoutMs: 1000,
      turnTimeoutMs: 60_000,
    });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    ttt.setMessageId(started.session.id, 5001);
    ttt.expireJoin(started.session.id);
    const before = ttt.getSession(started.session.id);
    assert.strictEqual(before.status, "active");
    const boardBefore = JSON.stringify(before.board);
    const playersBefore = JSON.stringify(before.players);

    const edited = [];
    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_B, is_bot: false, first_name: "Alice" },
      callbackQuery: {
        data: `pvp:ttt:join:${started.session.id}`,
        from: { id: USER_B, is_bot: false },
        message: {
          message_id: 5001,
          chat: { id: COMMUNITY_CHAT },
          reply_markup: {
            inline_keyboard: [[{ text: "JOIN GAME", callback_data: "x" }]],
          },
        },
      },
      cbAnswers: [],
      answerCbQuery(text) {
        this.cbAnswers.push(text || "");
        return Promise.resolve();
      },
      editMessageText(text, extra) {
        edited.push({ text, extra });
        return Promise.resolve();
      },
    };
    await handlePvpCallback(ctx, {
      runtime: ttt,
      parseCallbackData: parseTttCallbackData,
      awardPvpWinXpFn: () => ({ awarded: false }),
    });
    assert.strictEqual(ctx.cbAnswers[0], "This game already started.");
    assert.ok(edited[0].text.includes("TIC-TAC-TOE"));
    assert.ok(edited[0].text.includes("⬜"));
    assert.ok(edited[0].extra.reply_markup.inline_keyboard.length > 0);
    const after = ttt.getSession(started.session.id);
    assert.strictEqual(after.status, "active");
    assert.strictEqual(after.opponentType, "bot");
    assert.strictEqual(JSON.stringify(after.board), boardBefore);
    assert.strictEqual(JSON.stringify(after.players), playersBefore);
    assert.strictEqual(after.currentPlayer, before.currentPlayer);
  });

  await runTest("24. Connect Four stale join strips buttons", async () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const c4 = createConnectFourService({
      manager,
      now: timers.now,
      joinTimeoutMs: 800,
      turnTimeoutMs: 800,
    });
    const started = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    c4.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    const expired = c4.resolveTurnTimeout(started.session.id);
    assert.ok(expired.ok);
    assert.strictEqual(expired.session.status, "won");
    assert.deepStrictEqual(expired.rendered.extra.reply_markup.inline_keyboard, []);
    assert.strictEqual(c4.isOpen(), false);

    const edited = [];
    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_A, is_bot: false, first_name: "Kevin" },
      callbackQuery: {
        data: `pvp:c4:join:${started.session.id}`,
        from: { id: USER_A, is_bot: false },
        message: {
          message_id: 5002,
          chat: { id: COMMUNITY_CHAT },
          reply_markup: {
            inline_keyboard: [[{ text: "Join game", callback_data: "x" }]],
          },
        },
      },
      cbAnswers: [],
      answerCbQuery(text) {
        this.cbAnswers.push(text || "");
        return Promise.resolve();
      },
      editMessageText(text, extra) {
        edited.push({ text, extra });
        return Promise.resolve();
      },
    };
    await handlePvpCallback(ctx, {
      runtime: c4,
      parseCallbackData: parseC4CallbackData,
      awardPvpWinXpFn: () => ({ awarded: false }),
    });
    assert.strictEqual(ctx.cbAnswers[0], GAME_OVER_TOAST);
    assert.ok(edited[0].text.includes("CONNECT FOUR") || edited[0].text.includes("Connect Four"));
    assert.deepStrictEqual(edited[0].extra.reply_markup.inline_keyboard, []);
  });

  await runTest("24b. C4 live bot match join does not strip board", async () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const c4 = createConnectFourService({
      manager,
      now: timers.now,
      joinTimeoutMs: 1000,
      turnTimeoutMs: 60_000,
    });
    const started = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    c4.setMessageId(started.session.id, 5002);
    c4.expireJoin(started.session.id);
    assert.strictEqual(c4.getSession(started.session.id).status, "active");

    const edited = [];
    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_B, is_bot: false, first_name: "Alice" },
      callbackQuery: {
        data: `pvp:c4:join:${started.session.id}`,
        from: { id: USER_B, is_bot: false },
        message: {
          message_id: 5002,
          chat: { id: COMMUNITY_CHAT },
          reply_markup: {
            inline_keyboard: [[{ text: "JOIN GAME", callback_data: "x" }]],
          },
        },
      },
      cbAnswers: [],
      answerCbQuery(text) {
        this.cbAnswers.push(text || "");
        return Promise.resolve();
      },
      editMessageText(text, extra) {
        edited.push({ text, extra });
        return Promise.resolve();
      },
    };
    await handlePvpCallback(ctx, {
      runtime: c4,
      parseCallbackData: parseC4CallbackData,
      awardPvpWinXpFn: () => ({ awarded: false }),
    });
    assert.strictEqual(ctx.cbAnswers[0], "This game already started.");
    assert.ok(edited[0].extra.reply_markup.inline_keyboard.length > 0);
  });

  await runTest("24c. TTT timeout result stays visible (not deleted)", async () => {
    clearAllExpiredMessageCleanups();
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const ttt = createTicTacToeService({
      manager,
      now: timers.now,
      joinTimeoutMs: 1000,
      turnTimeoutMs: 1000,
    });
    const edits = [];
    const deletes = [];
    const bot = {
      telegram: {
        editMessageText: async (chatId, messageId, _inline, text, extra) => {
          edits.push({ chatId, messageId, text, extra });
        },
        deleteMessage: async (chatId, messageId) => {
          deletes.push({ chatId, messageId });
        },
      },
      action() {},
    };
    registerPvpCallbacks(bot, {
      runtime: ttt,
      connectFourRuntime: ttt,
      awardPvpWinXpFn: () => ({ awarded: false, pointsToAdd: 0 }),
    });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    ttt.setMessageId(started.session.id, 5001);
    ttt.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    const timed = ttt.resolveTurnTimeout(started.session.id);
    assert.strictEqual(timed.session.status, "won");
    assert.ok(timed.rendered.text.includes("ran out of time"));
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(edits.some((row) => row.text && row.text.includes("ran out of time")));
    assert.strictEqual(getPendingExpiredCleanupCount(), 0);
    assert.strictEqual(deletes.length, 0);
    clearAllExpiredMessageCleanups();
  });

  await runTest("25. ChatFight expired reveal strips buttons", async () => {
    const timers = createFakeTimers();
    const edits = [];
    const service = createChatFightService({
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      random: () => 0,
      revealWaitMs: 1000,
    });
    service.setEditMessageHandler(async (_c, _m, text, extra) => {
      edits.push({ text, extra });
    });
    service.startFight({ chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
    service.setFightMessageId(77);
    timers.advance(1000);
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(service.isFightOpen(), false);
    assert.ok(edits.some((row) => row.text.includes("Nobody revealed")));
    assert.ok(
      edits.some(
        (row) => row.extra && row.extra.reply_markup.inline_keyboard.length === 0
      )
    );

    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_A, is_bot: false },
      callbackQuery: {
        data: REVEAL_CALLBACK_DATA,
        from: { id: USER_A, is_bot: false },
        message: {
          message_id: 77,
          chat: { id: COMMUNITY_CHAT },
          reply_markup: {
            inline_keyboard: [[{ text: "👀 Reveal challenge", callback_data: REVEAL_CALLBACK_DATA }]],
          },
        },
      },
      cbAnswers: [],
      edited: [],
      answerCbQuery(text) {
        this.cbAnswers.push(text || "");
        return Promise.resolve();
      },
      editMessageText(text, extra) {
        this.edited.push({ text, extra });
        return Promise.resolve();
      },
    };
    await handleChatFightReveal(ctx, { revealFightFn: (id) => service.revealFight(id) });
    assert.strictEqual(ctx.cbAnswers[0], GAME_OVER_TOAST);
    assert.ok(ctx.edited[0].text.includes("Nobody revealed"));
    assert.deepStrictEqual(ctx.edited[0].extra.reply_markup.inline_keyboard, []);
  });

  await runTest("26. Trivia abort/final clears buttons and busy", async () => {
    const timers = createFakeTimers();
    const edits = [];
    const service = createTriviaService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      random: () => 0,
    });
    service.setEditMessageHandler(async (_c, _m, text, extra) => {
      edits.push({ text, extra });
    });
    const started = service.startTrivia({ chatId: COMMUNITY_CHAT });
    service.setMessageId(started.session.id, 44);
    service.abortRound("edit-failed");
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, TRIVIA_STATUS.ABORTED);
    assert.ok(edits.some((row) => row.text.includes("This round was cancelled.")));
    assert.ok(
      edits.some(
        (row) => row.extra && row.extra.reply_markup.inline_keyboard.length === 0
      )
    );

    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_A, is_bot: false, first_name: "Kevin" },
      callbackQuery: {
        data: buildAnswerCallbackData(started.session.id, 0),
        from: { id: USER_A, is_bot: false },
        message: {
          message_id: 44,
          chat: { id: COMMUNITY_CHAT },
          reply_markup: {
            inline_keyboard: [[{ text: "A", callback_data: "x" }]],
          },
        },
      },
      cbAnswers: [],
      edited: [],
      answerCbQuery(text) {
        this.cbAnswers.push(text || "");
        return Promise.resolve();
      },
      editMessageText(text, extra) {
        this.edited.push({ text, extra });
        return Promise.resolve();
      },
    };
    await handleTriviaAnswer(ctx, { getRuntimeFn: () => service });
    assert.strictEqual(ctx.cbAnswers[0], GAME_OVER_TOAST);
    assert.deepStrictEqual(ctx.edited[0].extra.reply_markup.inline_keyboard, []);
  });

  await runTest("21. bomb busy released before winner fallback", async () => {
    const timers = createFakeTimers();
    const sends = [];
    const service = createMangoBombService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      randomIntFn: () => 0,
      randomIdFn: () => "aabbccdd",
      lobbyMs: 50,
      bombMinMs: 50,
      bombMaxMs: 50,
      startCooldownMs: 0,
      renderTimeoutMs: 25,
      watchdogMs: 10_000,
    });
    service.setEditMessageHandler(async () => new Promise(() => {}));
    service.setSendMessageHandler(async (chatId, text, extra) => {
      sends.push({ chatId, text, extra });
    });
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(started.gameId, 9001);
    service.tryJoin({
      gameId: started.gameId,
      userId: USER_A,
      displayName: { first_name: "Kevin" },
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    service.tryJoin({
      gameId: started.gameId,
      userId: USER_B,
      displayName: { first_name: "Lojay" },
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.forceLobbyEnd(started.gameId);
    service.injectRenderHang();
    await service.forceExplode(started.gameId);
    assert.strictEqual(service.isMangoBombOpen(), false);
    assert.strictEqual(sends.length, 0);
    timers.advance(25);
    await service.whenWinnerUiIdle();
    assert.strictEqual(sends.length, 1);
    assert.ok(sends[0].text.includes("WINNER"));
  });

  await runTest("29. no production data touched", async () => {
    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
    }
  });

  for (const file of prodRoots) {
    if (!fs.existsSync(file)) continue;
    assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
  }
}

main()
  .then(() => {
    restoreEnv();
    console.log("\nAll game-cleanup tests passed.");
  })
  .catch((err) => {
    restoreEnv();
    console.error(err);
    process.exit(1);
  });
