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
const { BLACK, WHITE, sqToRowCol, rowColToSq, isDark } = require("../services/checkersRules");
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
    const rendered = service.renderMessage(service.getSession(started.session.id));
    const lines = formatBoard(service.getSession(started.session.id).board).split("\n");
    assert.strictEqual(lines.length, 8);
    const rows = rendered.extra.reply_markup.inline_keyboard;
    assert.strictEqual(rows.length, 8);
    assert.ok(rows.every((row) => row.length === 8));
    assert.strictEqual(rows.flat().length, 64);
    assert.ok(lines[0].includes(LIGHT_CELL));
    assert.ok(lines[0].includes("⚪") || lines[0].includes(EMPTY_DARK));
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

  restoreEnv();
  console.log("\nAll checkers board/timer tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
