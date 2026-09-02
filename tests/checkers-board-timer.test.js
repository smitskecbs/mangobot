/**
 * Checkers 8×8 board UX, ACK order, and turn-timer generation.
 * Run: node tests/checkers-board-timer.test.js
 */

const assert = require("assert");

const {
  createCheckersService,
  parsePvpCallbackData,
  buildSelectCallbackData,
  buildMoveCallbackData,
  buildNoopCallbackData,
  formatBoard,
  TURN_TIMEOUT_MS,
  LIGHT_CELL,
  EMPTY_DARK,
  STATUS,
  emptyBoard,
} = require("../services/checkers");
const { BLACK, WHITE, BLACK_KING, WHITE_KING, sqToRowCol, rowColToSq, isDark, legalMoves, applyMove } = require("../services/checkersRules");
const { handlePvpCallback } = require("../events/pvp-callbacks");

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
  };
}

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const service = createCheckersService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    joinTimeoutMs: overrides.joinTimeoutMs != null ? overrides.joinTimeoutMs : 300_000,
    turnTimeoutMs:
      overrides.turnTimeoutMs != null ? overrides.turnTimeoutMs : TURN_TIMEOUT_MS,
    botThinkMinMs: overrides.botThinkMinMs != null ? overrides.botThinkMinMs : 0,
    botThinkMaxMs: overrides.botThinkMaxMs != null ? overrides.botThinkMaxMs : 0,
  });
  return { service, timers };
}

function startVsBot(service) {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId: USER_A, displayName: "Kevin", isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  const expired = service.expireJoin(started.session.id);
  assert.strictEqual(expired.session.opponentType, "bot");
  return started;
}

function firstLegalMove(session) {
  const moves = legalMoves({
    board: session.board,
    current: session.currentPlayer,
    pendingFrom: session.pendingFrom,
  });
  assert.ok(moves.length > 0, "expected legal moves");
  return moves[0];
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createMockCtx({ userId = USER_A, firstName = "Kevin", callbackData, messageId = 5001 }) {
  const order = [];
  const ctx = {
    order,
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
      order.push("ack");
      ctx.answered.push(text || "");
    },
    async editMessageText(text, extra) {
      order.push("edit");
      ctx.edits.push({ text, extra });
    },
  };
  return ctx;
}

async function handleChk(ctx, service, extras = {}) {
  return handlePvpCallback(ctx, {
    runtime: service,
    parseCallbackData: parsePvpCallbackData,
    ...extras,
  });
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

  await runTest("board visually has 8 columns × 8 rows", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const session = service.getSession(started.session.id);
    const rendered = service.renderMessage(session);
    const rows = rendered.extra.reply_markup.inline_keyboard;
    assert.strictEqual(rows.length, 8);
    assert.ok(rows.every((row) => row.length === 8));
    assert.strictEqual(rows.flat().length, 64);
    const labels = rows.flat().map((b) => b.text);
    const codePoints = new Set(labels.map((t) => [...t].length));
    assert.strictEqual(codePoints.size, 1);
    assert.ok(!rendered.text.includes(formatBoard(session.board)));
    assert.ok(rendered.text.includes("🏁 CHECKERS"));
    assert.ok(rendered.text.includes("Select your piece."));
    assert.ok(labels.includes("🟠"));
    assert.ok(labels.includes("🟢"));
    assert.ok(!labels.includes("🟥"));
    assert.ok(!labels.includes("🟦"));
    assert.ok(!rendered.text.includes("🟥"));
    assert.ok(!rendered.text.includes("🟦"));
  });

  await runTest("non-playable squares cannot trigger moves", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const rendered = service.renderMessage(service.getSession(started.session.id));
    const light = rendered.extra.reply_markup.inline_keyboard[0][0];
    assert.strictEqual(light.text, LIGHT_CELL);
    assert.strictEqual(light.callback_data, buildNoopCallbackData(started.session.id));
    assert.deepStrictEqual(parsePvpCallbackData(light.callback_data), {
      action: "noop",
      sessionId: started.session.id,
      game: "checkers",
    });
    const before = service.getSession(started.session.id).board.slice();
    const ctx = createMockCtx({ callbackData: light.callback_data });
    await handleChk(ctx, service);
    assert.deepStrictEqual(ctx.answered, [""]);
    assert.deepStrictEqual(ctx.edits, []);
    assert.deepStrictEqual(service.getSession(started.session.id).board, before);
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
  });

  await runTest("diagonal coordinates still map on the 8×8 keyboard", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, true);
    const pos20 = sqToRowCol(20);
    const pos16 = sqToRowCol(16);
    assert.strictEqual(rowColToSq(pos20.row, pos20.col), 20);
    assert.strictEqual(isDark(pos20.row, pos20.col), true);
    const rows = sel.rendered.extra.reply_markup.inline_keyboard;
    assert.strictEqual(
      rows[pos20.row][pos20.col].callback_data,
      buildSelectCallbackData(started.session.id, 20)
    );
    assert.strictEqual(
      rows[pos16.row][pos16.col].callback_data,
      buildMoveCallbackData(started.session.id, 20, 16)
    );
    const light = rows[0][0];
    assert.ok(!isDark(0, 0));
    assert.strictEqual(light.callback_data, buildNoopCallbackData(started.session.id));
    const moved = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.session.board[16], BLACK);
    assert.strictEqual(moved.session.board[20], null);
  });

  await runTest("selecting a piece ACKs before the board edit", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const ctx = createMockCtx({
      callbackData: buildSelectCallbackData(started.session.id, 20),
    });
    await handleChk(ctx, service);
    assert.strictEqual(ctx.order[0], "ack");
    assert.ok(ctx.order.indexOf("ack") < ctx.order.indexOf("edit"));
    assert.strictEqual(service.getSession(started.session.id).selectedSquare, 20);
  });

  await runTest("valid move ACKs before edit and XP", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[20] = BLACK;
    raw.board[16] = WHITE;
    const order = [];
    const ctx = createMockCtx({
      callbackData: buildMoveCallbackData(started.session.id, 20, 13),
    });
    ctx.answerCbQuery = async (text) => {
      order.push("ack");
      ctx.answered.push(text || "");
    };
    ctx.editMessageText = async (text, extra) => {
      order.push("edit");
      ctx.edits.push({ text, extra });
    };
    await handleChk(ctx, service, {
      awardPvpWinXpFn: async () => {
        order.push("xp");
        return { awarded: true, pointsToAdd: 3 };
      },
    });
    assert.strictEqual(order[0], "ack");
    assert.ok(order.indexOf("ack") < order.indexOf("edit"));
    assert.ok(order.indexOf("ack") < order.indexOf("xp"));
    assert.ok(order.indexOf("edit") < order.indexOf("xp"));
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.WON);
  });

  await runTest("human move invalidates previous turn timer", async () => {
    const { service } = createService({ turnTimeoutMs: 1000 });
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    const genBefore = raw.turnGeneration;
    const moved = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(moved.ok, true);
    assert.ok(raw.turnGeneration > genBefore);
    const stale = await service.resolveTurnTimeout(started.session.id, genBefore);
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-timer");
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
  });

  await runTest("bot move creates a fresh human turn timer", async () => {
    const { service } = createService({ turnTimeoutMs: 5000 });
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    const genAfterHuman = raw.turnGeneration;
    assert.strictEqual(raw.currentPlayer, WHITE);
    const bot = await service.performBotMove(started.session.id);
    assert.strictEqual(bot.ok, true);
    assert.strictEqual(raw.currentPlayer, BLACK);
    assert.ok(raw.turnGeneration > genAfterHuman);
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
  });

  await runTest("stale timer callback cannot end a newer turn", async () => {
    const { service } = createService({ turnTimeoutMs: 1000 });
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    const staleGen = raw.turnGeneration;
    const moved = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(moved.ok, true);
    const stale = await service.resolveTurnTimeout(started.session.id, staleGen);
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-timer");
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
    assert.ok(raw.turnGeneration !== staleGen);
  });

  await runTest("multi-jump cannot be killed by the previous turn timer", async () => {
    const { service } = createService({ turnTimeoutMs: 1000 });
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[20] = BLACK;
    raw.board[16] = WHITE;
    raw.board[9] = WHITE;
    raw.board[0] = WHITE;
    raw.currentPlayer = BLACK;
    raw.selectedSquare = null;
    raw.pendingFrom = null;
    const genBefore = raw.turnGeneration;
    const first = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 13,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.session.pendingFrom, 13);
    assert.ok(raw.turnGeneration > genBefore);
    const stale = await service.resolveTurnTimeout(started.session.id, genBefore);
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-timer");
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
    assert.strictEqual(service.getSession(started.session.id).pendingFrom, 13);
    const second = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 13,
      to: 6,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.session.pendingFrom, null);
    assert.strictEqual(second.session.currentPlayer, WHITE);
  });

  await runTest("Checkers turn timeout is 120 seconds", async () => {
    assert.strictEqual(TURN_TIMEOUT_MS, 120 * 1000);
    const { service } = createService();
    assert.strictEqual(service.turnTimeoutMs, 120 * 1000);
  });

  await runTest("current turn still ends on genuine timeout", async () => {
    const { service, timers } = createService({ turnTimeoutMs: 1000 });
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    const gen = raw.turnGeneration;
    timers.advance(1000);
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.WON);
    assert.strictEqual(service.getSession(started.session.id).endReason, "timeout");
    const again = await service.resolveTurnTimeout(started.session.id, gen);
    assert.strictEqual(again.ok, false);
  });

  await runTest("win / no-legal-moves capture still ends the game", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[20] = BLACK;
    raw.board[16] = WHITE;
    const moved = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 13,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.ended, true);
    assert.strictEqual(moved.session.status, STATUS.WON);
    assert.strictEqual(moved.session.winnerSeat, BLACK);
    assert.strictEqual(moved.session.endReason, "win");
  });

  await runTest("consecutive human/bot turns stay active", async () => {
    const { service, timers } = createService();
    const started = startVsBot(service);
    for (let i = 0; i < 5; i += 1) {
      const live = service.getSession(started.session.id);
      assert.strictEqual(live.status, STATUS.ACTIVE);
      assert.strictEqual(live.currentPlayer, BLACK);
      const spec = firstLegalMove(live);
      const sel = service.select({
        sessionId: started.session.id,
        userId: USER_A,
        square: spec.from,
        chatId: COMMUNITY_CHAT,
      });
      assert.strictEqual(sel.ok, true);
      const moved = await service.move({
        sessionId: started.session.id,
        userId: USER_A,
        from: spec.from,
        to: spec.to,
        chatId: COMMUNITY_CHAT,
      });
      assert.strictEqual(moved.ok, true);
      assert.strictEqual(moved.ended, false);
      assert.strictEqual(moved.session.status, STATUS.ACTIVE);
      assert.strictEqual(moved.session.currentPlayer, WHITE);
      const raw = service.manager.getSession(started.session.id);
      assert.strictEqual(raw.timers.turnTimeoutId, null);
      timers.advance(0);
      await flushMicrotasks();
      const afterBot = service.getSession(started.session.id);
      assert.strictEqual(afterBot.status, STATUS.ACTIVE);
      assert.strictEqual(afterBot.currentPlayer, BLACK);
      const again = service.select({
        sessionId: started.session.id,
        userId: USER_A,
        square: firstLegalMove(afterBot).from,
        chatId: COMMUNITY_CHAT,
      });
      assert.strictEqual(again.ok, true);
    }
  });

  await runTest("bot plays a legal move when legal moves exist", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    const before = service.getSession(started.session.id);
    const state = {
      board: before.board,
      current: WHITE,
      pendingFrom: before.pendingFrom,
    };
    const legal = legalMoves(state);
    assert.ok(legal.length > 0);
    const bot = await service.performBotMove(started.session.id);
    assert.strictEqual(bot.ok, true);
    assert.strictEqual(bot.session.status, STATUS.ACTIVE);
    const played = legal.some((m) => {
      const applied = applyMove(state, m.from, m.to);
      return (
        applied.ok &&
        JSON.stringify(applied.state.board) === JSON.stringify(bot.session.board)
      );
    });
    assert.ok(played, "bot must play one of the legal moves");
  });

  await runTest("bot no-legal-moves ends only when the bot truly cannot move", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const trapped = service.manager.getSession(started.session.id);
    trapped.board = emptyBoard();
    trapped.board[28] = WHITE;
    trapped.board[20] = BLACK;
    trapped.currentPlayer = WHITE;
    trapped.selectedSquare = null;
    trapped.pendingFrom = null;
    const ended = await service.performBotMove(started.session.id);
    assert.strictEqual(ended.ok, true);
    assert.strictEqual(ended.ended, true);
    assert.strictEqual(ended.session.status, STATUS.WON);
    assert.strictEqual(ended.session.winnerSeat, BLACK);
    assert.strictEqual(ended.session.endReason, "win");

    const { service: liveService } = createService();
    const live = startVsBot(liveService);
    const raw = liveService.manager.getSession(live.session.id);
    raw.currentPlayer = WHITE;
    const moved = await liveService.performBotMove(live.session.id);
    assert.strictEqual(moved.ok, true);
    assert.notStrictEqual(moved.session.status, STATUS.WON);
    assert.strictEqual(moved.session.status, STATUS.ACTIVE);
    assert.ok(legalMoves({
      board: liveService.getSession(live.session.id).board,
      current: BLACK,
      pendingFrom: null,
    }).length > 0);
  });

  await runTest("human timer cannot end the game during bot think delay", async () => {
    const { service, timers } = createService({
      turnTimeoutMs: 1000,
      botThinkMinMs: 5000,
      botThinkMaxMs: 5000,
    });
    const started = startVsBot(service);
    const spec = firstLegalMove(service.getSession(started.session.id));
    const ctx = createMockCtx({
      callbackData: buildMoveCallbackData(started.session.id, spec.from, spec.to),
    });
    await handleChk(ctx, service);
    assert.strictEqual(ctx.order[0], "ack");
    assert.ok(ctx.order.indexOf("ack") < ctx.order.indexOf("edit"));
    assert.ok(ctx.edits.some((e) => String(e.text).includes("ManGo Bot is thinking")));
    const afterHuman = service.getSession(started.session.id);
    assert.strictEqual(afterHuman.status, STATUS.ACTIVE);
    assert.strictEqual(afterHuman.currentPlayer, WHITE);
    const raw = service.manager.getSession(started.session.id);
    assert.strictEqual(raw.timers.turnTimeoutId, null);
    const genDuringBot = raw.turnGeneration;
    timers.advance(1000);
    await flushMicrotasks();
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
    assert.strictEqual(service.getSession(started.session.id).currentPlayer, WHITE);
    const timed = await service.resolveTurnTimeout(started.session.id, genDuringBot);
    assert.strictEqual(timed.ok, false);
    assert.strictEqual(timed.reason, "bot-turn");
    timers.advance(4000);
    await flushMicrotasks();
    const afterBot = service.getSession(started.session.id);
    assert.strictEqual(afterBot.status, STATUS.ACTIVE);
    assert.strictEqual(afterBot.currentPlayer, BLACK);
    const humanAgain = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: firstLegalMove(afterBot).from,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(humanAgain.ok, true);
  });

  await runTest("callback_data stays within Telegram's 64-byte limit", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    const rows = sel.rendered.extra.reply_markup.inline_keyboard;
    for (const btn of rows.flat()) {
      assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64);
    }
  });

  await runTest("kings stay distinguishable from normal pieces", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[20] = BLACK;
    raw.board[16] = BLACK_KING;
    raw.board[8] = WHITE;
    raw.board[4] = WHITE_KING;
    const rendered = service.renderMessage(service.getSession(started.session.id));
    const labels = rendered.extra.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.includes("🟠"));
    assert.ok(labels.includes("🔶"));
    assert.ok(labels.includes("🟢"));
    assert.ok(labels.includes("💚"));
    assert.notStrictEqual("🔶", "🟠");
    assert.notStrictEqual("💚", "🟢");
    assert.ok(!labels.includes("🟥"));
    assert.ok(!labels.includes("🟦"));
  });

  restoreEnv();
  console.log("\nAll checkers board/timer tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
