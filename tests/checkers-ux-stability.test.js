/**
 * Checkers stability + start/wait UX.
 * Run: node tests/checkers-ux-stability.test.js
 */

const assert = require("assert");

const {
  createCheckersService,
  parsePvpCallbackData,
  buildSelectCallbackData,
  buildMoveCallbackData,
  buildModeCallbackData,
  STATUS,
  PHASE,
  JOIN_TIMEOUT_MS,
  BOT_THINK_MIN_MS,
  BOT_THINK_MAX_MS,
  BOT_CHAIN_THINK_MIN_MS,
  BOT_CHAIN_THINK_MAX_MS,
  BOT_USER_ID,
  MARK_B,
  MARK_DEST,
  MUST_CAPTURE_TOAST,
  NOT_YOUR_PIECE_TOAST,
  EMPTY_SQUARE_TOAST,
  STALE_BOARD_TOAST,
} = require("../services/checkers");
const {
  BLACK,
  WHITE,
  emptyBoard,
  legalMoves,
  sqToRowCol,
} = require("../services/checkersRules");
const { handlePvpCallback, registerPvpCallbacks } = require("../events/pvp-callbacks");

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
    uncleared() {
      return timers.filter((t) => !t.cleared);
    },
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.push({ id, fn, fireAt: nowMs + delay, cleared: false, delay });
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
  const service = createCheckersService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    joinTimeoutMs:
      overrides.joinTimeoutMs != null ? overrides.joinTimeoutMs : JOIN_TIMEOUT_MS,
    turnTimeoutMs: overrides.turnTimeoutMs != null ? overrides.turnTimeoutMs : 120_000,
    botThinkMinMs: overrides.botThinkMinMs != null ? overrides.botThinkMinMs : 0,
    botThinkMaxMs: overrides.botThinkMaxMs != null ? overrides.botThinkMaxMs : 0,
    botChainThinkMinMs:
      overrides.botChainThinkMinMs != null ? overrides.botChainThinkMinMs : 0,
    botChainThinkMaxMs:
      overrides.botChainThinkMaxMs != null ? overrides.botChainThinkMaxMs : 0,
  });
  return { service, timers };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createMockCtx({
  userId = USER_A,
  firstName = "Kevin",
  callbackData,
  messageId = 5001,
} = {}) {
  const ctx = {
    chat: { id: COMMUNITY_CHAT, type: "supergroup" },
    from: { id: userId, first_name: firstName, is_bot: false },
    callbackQuery: {
      id: "cb1",
      data: callbackData,
      message: { message_id: messageId, chat: { id: COMMUNITY_CHAT } },
    },
    answered: [],
    edits: [],
    async answerCbQuery(text) {
      ctx.answered.push(text || "");
    },
    async editMessageText(text, extra) {
      ctx.edits.push({ text, extra });
    },
  };
  return ctx;
}

function startChoice(service, userId = USER_A, name = "Kevin") {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId, displayName: name, isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  return started;
}

function startVsBot(service) {
  const started = startChoice(service);
  const bot = service.chooseMode({
    sessionId: started.session.id,
    userId: USER_A,
    mode: "bot",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(bot.ok, true);
  return bot;
}

function startPvpLobby(service) {
  const started = startChoice(service);
  const waiting = service.chooseMode({
    sessionId: started.session.id,
    userId: USER_A,
    mode: "pvp",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(waiting.ok, true);
  return waiting;
}

function buttonAt(rendered, square) {
  const pos = sqToRowCol(square);
  return rendered.extra.reply_markup.inline_keyboard[pos.row][pos.col];
}

function setCaptureBoard(service, sessionId) {
  const raw = service.manager.getSession(sessionId);
  raw.board = emptyBoard();
  raw.board[20] = BLACK;
  raw.board[22] = BLACK;
  raw.board[16] = WHITE;
  raw.currentPlayer = BLACK;
  raw.selectedSquare = null;
  raw.pendingFrom = null;
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    restoreEnv();
    throw err;
  }
}

async function main() {
  resetEnv();

  await runTest("A. own movable piece is accepted", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, true);
    assert.strictEqual(sel.session.selectedSquare, 20);
    assert.strictEqual(buttonAt(sel.rendered, 20).text, MARK_B);
  });

  await runTest("B. opponent piece gives Not your piece", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const ctx = createMockCtx({
      callbackData: buildSelectCallbackData(started.session.id, 0),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.ok(ctx.answered.includes(NOT_YOUR_PIECE_TOAST));
    assert.ok(ctx.edits.length >= 1);
  });

  await runTest("C. own piece blocked by mandatory capture is not Not your piece", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    setCaptureBoard(service, started.session.id);
    const ctx = createMockCtx({
      callbackData: buildSelectCallbackData(started.session.id, 22),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.ok(ctx.answered.includes(MUST_CAPTURE_TOAST));
    assert.ok(!ctx.answered.includes(NOT_YOUR_PIECE_TOAST));
    const quiet = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 22,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(quiet.ok, false);
    assert.strictEqual(quiet.reason, "must-capture");
  });

  await runTest("D. mandatory-capture pieces are selectable and dests marked", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    setCaptureBoard(service, started.session.id);
    const live = service.getSession(started.session.id);
    assert.ok(service.renderMessage(live).text.includes("Capture required"));
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, true, sel.reason);
    assert.strictEqual(buttonAt(sel.rendered, 13).text, MARK_DEST);
    assert.ok(buttonAt(sel.rendered, 13).callback_data.startsWith("pvp:chk:mv:"));
  });

  await runTest("E. legal destination immediately executes move", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    const gen = service.getSession(started.session.id).boardGeneration;
    const ctx = createMockCtx({
      callbackData: buildMoveCallbackData(started.session.id, 20, 16, gen),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.board[16], BLACK);
    assert.strictEqual(live.board[20], null);
    assert.strictEqual(live.currentPlayer, WHITE);
  });

  await runTest("F. legal destination sel callback executes move, not piece select", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    const ctx = createMockCtx({
      callbackData: buildSelectCallbackData(started.session.id, 16),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.board[16], BLACK);
    assert.strictEqual(live.selectedSquare, null);
    assert.ok(!ctx.answered.includes(NOT_YOUR_PIECE_TOAST));
    assert.ok(!ctx.answered.includes(EMPTY_SQUARE_TOAST));
  });

  await runTest("G. illegal destination redraws live board", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, true);
    const ctx = createMockCtx({
      callbackData: buildSelectCallbackData(
        started.session.id,
        12,
        sel.session.boardGeneration
      ),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.ok(ctx.edits.length >= 1);
    assert.strictEqual(service.getSession(started.session.id).selectedSquare, 20);
    assert.strictEqual(buttonAt(ctx.edits[0], 16).text, MARK_DEST);
  });

  await runTest("H. switching selected own piece works", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const first = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(first.session.selectedSquare, 20);
    const second = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 21,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.session.selectedSquare, 21);
  });

  await runTest("I. stale board callback redraws live state", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const before = service.getSession(started.session.id).boardGeneration;
    service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    const ctx = createMockCtx({
      callbackData: buildSelectCallbackData(started.session.id, 21, before),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.ok(ctx.answered.includes(STALE_BOARD_TOAST));
    assert.ok(ctx.edits.length >= 1);
    assert.strictEqual(service.getSession(started.session.id).selectedSquare, 20);
    assert.ok(ctx.edits[0].text.includes("Choose a ✨ square."));
  });

  await runTest("J. delayed old edit cannot overwrite newer state", async () => {
    const { service, timers } = createService({
      botThinkMinMs: 1000,
      botThinkMaxMs: 1000,
    });
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    let holding = true;
    const applied = [];
    const bot = {
      telegram: {
        async editMessageText(_c, _m, _i, text) {
          if (holding) await hold;
          applied.push(String(text || ""));
        },
        async deleteMessage() {},
      },
      action() {},
    };
    registerPvpCallbacks(bot, {
      checkersRuntime: service,
      awardPvpWinXpFn: async () => ({ awarded: false, pointsToAdd: 0 }),
    });
    const started = startVsBot(service);
    await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    timers.advance(1000);
    await flushMicrotasks();
    const afterBot = service.getSession(started.session.id);
    assert.strictEqual(afterBot.status, STATUS.ACTIVE);
    assert.strictEqual(afterBot.currentPlayer, BLACK);
    const legal = legalMoves({
      board: afterBot.board,
      current: afterBot.currentPlayer,
      pendingFrom: afterBot.pendingFrom,
    });
    assert.ok(legal.length > 0, "expected a legal Black piece after the bot reply");
    const from = legal[0].from;
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: from,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, true, sel.reason);
    holding = false;
    release();
    await flushMicrotasks();
    await flushMicrotasks();
    assert.strictEqual(service.getSession(started.session.id).selectedSquare, from);
    const last = applied[applied.length - 1];
    if (last) {
      assert.ok(!last.includes("Choose a ✨ square.") || last.includes("Your turn"));
    }
    assert.strictEqual(service.getSession(started.session.id).selectedSquare, from);
  });

  await runTest("K. human is Black and bot is White", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.players.b.userId, String(USER_A));
    assert.strictEqual(live.players.w.userId, BOT_USER_ID);
    assert.ok(started.rendered.text.includes("You: Black"));
    assert.ok(started.rendered.text.includes("ManGoBot: White"));
  });

  await runTest("L. bot acts only on its own turn", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    assert.strictEqual(service.getSession(started.session.id).currentPlayer, BLACK);
    const duringHuman = await service.performBotMove(started.session.id);
    assert.strictEqual(duringHuman.ok, false);
    assert.strictEqual(duringHuman.reason, "not-bot-turn");
    await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(service.getSession(started.session.id).currentPlayer, WHITE);
    const bot = await service.performBotMove(started.session.id);
    assert.strictEqual(bot.ok, true);
    assert.strictEqual(service.getSession(started.session.id).currentPlayer, BLACK);
  });

  await runTest("M. bot move is bounded by the UX think delay", async () => {
    assert.ok(BOT_THINK_MIN_MS <= 400);
    assert.ok(BOT_THINK_MAX_MS <= 700);
    assert.ok(BOT_CHAIN_THINK_MAX_MS <= 400);
    const { service, timers } = createService({
      botThinkMinMs: 400,
      botThinkMaxMs: 400,
    });
    const started = startVsBot(service);
    await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(service.getSession(started.session.id).currentPlayer, WHITE);
    timers.advance(399);
    await flushMicrotasks();
    assert.strictEqual(service.getSession(started.session.id).currentPlayer, WHITE);
    timers.advance(1);
    await flushMicrotasks();
    assert.strictEqual(service.getSession(started.session.id).currentPlayer, BLACK);
  });

  await runTest("N. chained capture stays with the same piece", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[25] = BLACK;
    raw.board[22] = WHITE;
    raw.board[15] = WHITE;
    raw.board[0] = WHITE;
    raw.currentPlayer = BLACK;
    const first = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 25,
      to: 18,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(first.session.pendingFrom, 18);
    assert.strictEqual(first.session.currentPlayer, BLACK);
    const second = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 18,
      to: 11,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.session.pendingFrom, null);
    assert.strictEqual(second.session.currentPlayer, WHITE);
  });

  await runTest("O. game can reach a normal win", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[20] = BLACK;
    raw.board[16] = WHITE;
    const win = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 13,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(win.ended, true);
    assert.strictEqual(win.session.status, STATUS.WON);
    assert.strictEqual(win.session.winnerSeat, BLACK);
  });

  await runTest("P. start always presents bot vs PvP choice", async () => {
    const { service } = createService();
    const started = startChoice(service);
    assert.strictEqual(started.session.phase, PHASE.START_CHOICE);
    assert.ok(started.text.includes("How do you want to play?"));
    const keys = JSON.stringify(started.keyboard);
    assert.ok(keys.includes("Play vs ManGoBot"));
    assert.ok(keys.includes("Wait for Opponent"));
    assert.ok(keys.includes("Cancel"));
    assert.ok(!keys.includes("JOIN GAME"));
  });

  await runTest("Q. choosing ManGoBot starts a bot game", async () => {
    const { service } = createService();
    const started = startChoice(service);
    const ctx = createMockCtx({
      callbackData: buildModeCallbackData(started.session.id, "bot"),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.status, STATUS.ACTIVE);
    assert.strictEqual(live.opponentType, "bot");
    assert.ok(ctx.edits[0].text.includes("Your turn"));
  });

  await runTest("R. choosing Wait creates a PvP lobby", async () => {
    const { service } = createService();
    const started = startChoice(service);
    const ctx = createMockCtx({
      callbackData: buildModeCallbackData(started.session.id, "pvp"),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.status, STATUS.WAITING);
    assert.strictEqual(live.phase, PHASE.PVP_LOBBY);
    assert.ok(ctx.edits[0].text.includes("looking for an opponent"));
  });

  await runTest("S. second player can join", async () => {
    const { service } = createService();
    const started = startPvpLobby(service);
    const joined = service.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(joined.session.players.w.userId, String(USER_B));
    assert.strictEqual(joined.session.opponentType, "human");
  });

  await runTest("T. requester cannot join twice", async () => {
    const { service } = createService();
    const started = startPvpLobby(service);
    const self = service.join({
      sessionId: started.session.id,
      userId: USER_A,
      displayName: "Kevin",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(self.ok, false);
    assert.strictEqual(self.reason, "already-joined");
  });

  await runTest("U. waiting timeout shows Keep Waiting / ManGoBot / Cancel", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 1000 });
    const started = startPvpLobby(service);
    timers.advance(1000);
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.phase, PHASE.WAIT_PROMPT);
    const rendered = service.renderMessage(live);
    assert.ok(rendered.text.includes("Still waiting for an opponent"));
    const keys = JSON.stringify(rendered.extra);
    assert.ok(keys.includes("Keep Waiting"));
    assert.ok(keys.includes("Play vs ManGoBot"));
    assert.ok(keys.includes("Cancel"));
  });

  await runTest("V. Keep Waiting re-arms exactly one join timer", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 1000 });
    const started = startPvpLobby(service);
    timers.advance(1000);
    const raw = service.manager.getSession(started.session.id);
    assert.strictEqual(raw.timers.joinTimeoutId, null);
    const kept = service.chooseMode({
      sessionId: started.session.id,
      userId: USER_A,
      mode: "keep",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(kept.ok, true);
    assert.strictEqual(kept.session.phase, PHASE.PVP_LOBBY);
    const after = service.manager.getSession(started.session.id);
    assert.ok(after.timers.joinTimeoutId != null);
    const joinTimers = timers
      .uncleared()
      .filter((t) => t.id === after.timers.joinTimeoutId);
    assert.strictEqual(joinTimers.length, 1);
    timers.advance(1000);
    assert.strictEqual(service.getSession(started.session.id).phase, PHASE.WAIT_PROMPT);
  });

  await runTest("W. timeout then ManGoBot converts safely", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 1000 });
    const started = startPvpLobby(service);
    timers.advance(1000);
    const converted = service.chooseMode({
      sessionId: started.session.id,
      userId: USER_A,
      mode: "bot",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(converted.ok, true);
    assert.strictEqual(converted.session.status, STATUS.ACTIVE);
    assert.strictEqual(converted.session.opponentType, "bot");
    assert.strictEqual(converted.session.players.w.userId, BOT_USER_ID);
  });

  await runTest("X. old PvP join after bot conversion is harmless", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 1000 });
    const started = startPvpLobby(service);
    timers.advance(1000);
    service.chooseMode({
      sessionId: started.session.id,
      userId: USER_A,
      mode: "bot",
      chatId: COMMUNITY_CHAT,
    });
    const ctx = createMockCtx({
      userId: USER_B,
      firstName: "Pippi",
      callbackData: `pvp:chk:join:${started.session.id}`,
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.status, STATUS.ACTIVE);
    assert.strictEqual(live.opponentType, "bot");
    assert.strictEqual(live.players.w.userId, BOT_USER_ID);
    assert.ok(ctx.edits.length >= 1);
  });

  await runTest("Y. Cancel fully cleans state", async () => {
    const { service } = createService();
    const started = startChoice(service);
    const cancelled = service.chooseMode({
      sessionId: started.session.id,
      userId: USER_A,
      mode: "cancel",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(cancelled.ok, true);
    assert.strictEqual(cancelled.session.status, STATUS.EXPIRED);
    assert.strictEqual(service.isOpen(), false);
    assert.strictEqual(service.reservation.has(USER_A), false);
    const again = startChoice(service);
    assert.strictEqual(again.ok, true);
  });

  await runTest("Z. reset/cleanup remains safe", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 5000 });
    const started = startPvpLobby(service);
    assert.ok(service.isOpen());
    service.reset();
    assert.strictEqual(service.isOpen(), false);
    assert.strictEqual(service.getSession(started.session.id), null);
    timers.advance(5000);
    await flushMicrotasks();
    assert.strictEqual(service.getSession(started.session.id), null);
  });

  restoreEnv();
  console.log("\nAll checkers UX stability tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
