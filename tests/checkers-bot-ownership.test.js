/**
 * Checkers human-vs-bot ownership, turns, captures, and stale-keyboard refresh.
 * Run: node tests/checkers-bot-ownership.test.js
 */

const assert = require("assert");

const {
  createCheckersService,
  parsePvpCallbackData,
  buildSelectCallbackData,
  STATUS,
  BOT_USER_ID,
  EMPTY_DARK,
  MARK_B,
  MARK_W,
  MARK_BK,
  emptyBoard,
} = require("../services/checkers");
const {
  BLACK,
  WHITE,
  BLACK_KING,
  sideOf,
  legalMoves,
  sqToRowCol,
} = require("../services/checkersRules");
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

function createService() {
  const timers = createFakeTimers();
  const service = createCheckersService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    joinTimeoutMs: 300_000,
    turnTimeoutMs: 120_000,
    botThinkMinMs: 0,
    botThinkMaxMs: 0,
  });
  return { service, timers };
}

function startOpen(service, userId = USER_A, name = "Kevin") {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId, displayName: name, isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  const waiting = service.chooseMode({
    sessionId: started.session.id,
    userId,
    mode: "pvp",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(waiting.ok, true);
  return { ok: true, session: waiting.session };
}

function startVsBot(service) {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId: USER_A, displayName: "Kevin", isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  const bot = service.chooseMode({
    sessionId: started.session.id,
    userId: USER_A,
    mode: "bot",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(bot.ok, true);
  assert.strictEqual(bot.session.opponentType, "bot");
  return { ok: true, session: bot.session };
}

function joinPvp(service, sessionId, userId = USER_B, name = "Pippi") {
  const joined = service.join({
    sessionId,
    userId,
    displayName: name,
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(joined.ok, true);
  return joined;
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

function labelAt(rendered, square) {
  const pos = sqToRowCol(square);
  const rows = rendered.extra.reply_markup.inline_keyboard;
  return rows[pos.row][pos.col].text;
}

function ownSquares(board, seat) {
  const out = [];
  for (let sq = 0; sq < board.length; sq += 1) {
    if (sideOf(board[sq]) === seat) {
      out.push(sq);
    }
  }
  return out;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createMockCtx({ userId = USER_A, firstName = "Kevin", callbackData }) {
  const ctx = {
    chat: { id: COMMUNITY_CHAT, type: "supergroup" },
    from: { id: userId, first_name: firstName, is_bot: false },
    callbackQuery: {
      id: "cb1",
      data: callbackData,
      message: { message_id: 5001, chat: { id: COMMUNITY_CHAT } },
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

  await runTest("1. vs-bot init assigns human black and bot white", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.status, STATUS.ACTIVE);
    assert.strictEqual(live.opponentType, "bot");
    assert.strictEqual(live.players.b.userId, String(USER_A));
    assert.strictEqual(live.players.b.isBot, false);
    assert.strictEqual(live.players.w.userId, BOT_USER_ID);
    assert.strictEqual(live.players.w.isBot, true);
    assert.strictEqual(live.currentPlayer, BLACK);
    assert.strictEqual(live.board[20], BLACK);
    assert.strictEqual(live.board[0], WHITE);
  });

  await runTest("2. human can select their own checker", async () => {
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
    assert.strictEqual(labelAt(sel.rendered, 20), MARK_B);
  });

  await runTest("3. human cannot select a bot checker", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, false);
    assert.strictEqual(sel.reason, "invalid-piece");
    assert.ok(sel.rendered);
    assert.strictEqual(labelAt(sel.rendered, 0), MARK_W);
    assert.strictEqual(service.getSession(started.session.id).selectedSquare, null);
  });

  await runTest("4-5. ownership and turn stay correct after a bot move", async () => {
    const { service, timers } = createService();
    const started = startVsBot(service);
    const moved = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.session.currentPlayer, WHITE);
    timers.advance(0);
    await flushMicrotasks();
    const afterBot = service.getSession(started.session.id);
    assert.strictEqual(afterBot.status, STATUS.ACTIVE);
    assert.strictEqual(afterBot.currentPlayer, BLACK);
    assert.strictEqual(afterBot.players.b.userId, String(USER_A));
    assert.strictEqual(afterBot.players.w.userId, BOT_USER_ID);
    const humanSquares = ownSquares(afterBot.board, BLACK);
    assert.ok(humanSquares.length > 0);
    const mine = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: humanSquares[0],
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(mine.ok, true, mine.reason);
    const botSquares = ownSquares(afterBot.board, WHITE);
    const theirs = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: botSquares[0],
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(theirs.ok, false);
    assert.strictEqual(theirs.reason, "invalid-piece");
  });

  await runTest("6. repeated human/bot turns do not swap ownership", async () => {
    const { service, timers } = createService();
    const started = startVsBot(service);
    for (let i = 0; i < 5; i += 1) {
      const live = service.getSession(started.session.id);
      assert.strictEqual(live.status, STATUS.ACTIVE);
      assert.strictEqual(live.currentPlayer, BLACK);
      assert.strictEqual(live.players.b.userId, String(USER_A));
      assert.strictEqual(live.players.w.userId, BOT_USER_ID);
      for (const sq of ownSquares(live.board, BLACK)) {
        assert.strictEqual(sideOf(live.board[sq]), BLACK);
      }
      const spec = firstLegalMove(live);
      const sel = service.select({
        sessionId: started.session.id,
        userId: USER_A,
        square: spec.from,
        chatId: COMMUNITY_CHAT,
      });
      assert.strictEqual(sel.ok, true, sel.reason);
      const moved = await service.move({
        sessionId: started.session.id,
        userId: USER_A,
        from: spec.from,
        to: spec.to,
        chatId: COMMUNITY_CHAT,
      });
      assert.strictEqual(moved.ok, true);
      if (moved.ended) {
        return;
      }
      assert.strictEqual(moved.session.currentPlayer, WHITE);
      timers.advance(0);
      await flushMicrotasks();
    }
  });

  await runTest("7. bot capture does not corrupt ownership; stale square refreshes", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[8] = WHITE;
    raw.board[13] = BLACK;
    raw.board[20] = BLACK;
    raw.currentPlayer = WHITE;
    raw.selectedSquare = null;
    raw.pendingFrom = null;
    const captured = await service.performBotMove(started.session.id);
    assert.strictEqual(captured.ok, true);
    assert.strictEqual(captured.ended, false);
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.currentPlayer, BLACK);
    assert.strictEqual(live.board[13], null);
    assert.strictEqual(live.board[20], BLACK);
    assert.strictEqual(sideOf(live.board[17]), WHITE);

    const remaining = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(remaining.ok, true);

    const stale = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 13,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "empty");
    assert.ok(stale.rendered);
    assert.strictEqual(labelAt(stale.rendered, 13), EMPTY_DARK);
    assert.strictEqual(labelAt(stale.rendered, 20), MARK_B);

    const ctx = createMockCtx({
      callbackData: buildSelectCallbackData(started.session.id, 13),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.ok(ctx.answered.some((text) => text.includes("That square is empty.")));
    assert.ok(ctx.edits.length >= 1);
    const refreshed = ctx.edits[ctx.edits.length - 1];
    const pos = sqToRowCol(13);
    assert.strictEqual(
      refreshed.extra.reply_markup.inline_keyboard[pos.row][pos.col].text,
      EMPTY_DARK
    );
  });

  await runTest("8. king promotion does not corrupt ownership", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[4] = BLACK;
    raw.board[8] = WHITE;
    raw.currentPlayer = BLACK;
    raw.selectedSquare = null;
    raw.pendingFrom = null;
    const promoted = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 4,
      to: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(promoted.ok, true);
    assert.strictEqual(promoted.session.board[0], BLACK_KING);
    assert.strictEqual(promoted.session.currentPlayer, WHITE);
    const bot = await service.performBotMove(started.session.id);
    assert.strictEqual(bot.ok, true);
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.currentPlayer, BLACK);
    assert.strictEqual(sideOf(live.board[0]), BLACK);
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, true, sel.reason);
    assert.strictEqual(labelAt(sel.rendered, 0), MARK_BK);
  });

  await runTest("human cannot move or select during bot turn", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    const duringBot = service.getSession(started.session.id);
    assert.strictEqual(duringBot.currentPlayer, WHITE);
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, false);
    assert.strictEqual(sel.reason, "not-your-turn");
    assert.ok(sel.rendered);
    const mv = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 16,
      to: 12,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(mv.ok, false);
    assert.strictEqual(mv.reason, "not-your-turn");
  });

  await runTest("9. PvP ownership/select path is unchanged", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinPvp(service, started.session.id);
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.opponentType, "human");
    assert.strictEqual(live.players.b.userId, String(USER_A));
    assert.strictEqual(live.players.w.userId, String(USER_B));
    assert.strictEqual(live.currentPlayer, BLACK);
    const blackSel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(blackSel.ok, true);
    const whiteOnBlackTurn = service.select({
      sessionId: started.session.id,
      userId: USER_B,
      square: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(whiteOnBlackTurn.ok, false);
    assert.strictEqual(whiteOnBlackTurn.reason, "not-your-turn");
    const blackTakesWhite = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(blackTakesWhite.ok, false);
    assert.strictEqual(blackTakesWhite.reason, "invalid-piece");
    const moved = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.session.currentPlayer, WHITE);
    const whiteSel = service.select({
      sessionId: started.session.id,
      userId: USER_B,
      square: 8,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(whiteSel.ok, true);
  });

  restoreEnv();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
