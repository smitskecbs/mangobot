/**
 * Production-shaped Checkers multi-jump select (pvp:chk:sel:<id>:18).
 * Defensive regression only — the production TypeError was not reproduced.
 * Run: node tests/checkers-multijump-callback.test.js
 */

const assert = require("assert");
const { Telegraf } = require("telegraf");

const {
  createCheckersService,
  parsePvpCallbackData,
  buildSelectCallbackData,
  buildMoveCallbackData,
  STATUS,
} = require("../services/checkers");
const {
  BLACK,
  WHITE,
  emptyBoard,
  legalMoves,
  destinations,
  sqToRowCol,
} = require("../services/checkersRules");
const { handlePvpCallback, registerPvpCallbacks } = require("../events/pvp-callbacks");
const { attachUpdateErrorHandler } = require("../utils/botLifecycle");

const COMMUNITY_CHAT = -1001234567890;
const KEVIN = 111;
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
    joinTimeoutMs: 60_000,
    turnTimeoutMs: 120_000,
    botThinkMinMs: 0,
    botThinkMaxMs: 0,
  });
  return { service, timers };
}

function setupForcedJumpOn18(service) {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId: KEVIN, displayName: "Kevin", isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 8001);
  const vsBot = service.expireJoin(started.session.id);
  assert.strictEqual(vsBot.session.opponentType, "bot");
  const raw = service.manager.getSession(started.session.id);
  raw.board = emptyBoard();
  raw.board[25] = BLACK;
  raw.board[22] = WHITE;
  raw.board[15] = WHITE;
  raw.board[0] = WHITE;
  raw.currentPlayer = BLACK;
  raw.pendingFrom = null;
  raw.selectedSquare = null;
  return started.session.id;
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

  await runTest("capture into square 18 requires multi-jump", async () => {
    const { service } = createService();
    const sessionId = setupForcedJumpOn18(service);
    const moved = await service.move({
      sessionId,
      userId: KEVIN,
      from: 25,
      to: 18,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.session.status, STATUS.ACTIVE);
    assert.strictEqual(moved.session.pendingFrom, 18);
    assert.strictEqual(moved.session.selectedSquare, 18);
    assert.strictEqual(moved.session.currentPlayer, BLACK);
    assert.ok(moved.rendered.text.includes("Continue the capture with the same piece."));
    const pos = sqToRowCol(18);
    const btn = moved.rendered.extra.reply_markup.inline_keyboard[pos.row][pos.col];
    assert.strictEqual(btn.callback_data, buildSelectCallbackData(sessionId, 18));
    assert.deepStrictEqual(parsePvpCallbackData(btn.callback_data), {
      action: "sel",
      sessionId,
      square: 18,
      game: "checkers",
    });
  });

  await runTest("selecting forced square 18 does not throw and keeps continuation", async () => {
    const { service } = createService();
    const sessionId = setupForcedJumpOn18(service);
    await service.move({
      sessionId,
      userId: KEVIN,
      from: 25,
      to: 18,
      chatId: COMMUNITY_CHAT,
    });
    let threw = null;
    let result;
    try {
      result = service.select({
        sessionId,
        userId: KEVIN,
        square: 18,
        chatId: COMMUNITY_CHAT,
      });
    } catch (err) {
      threw = err;
    }
    assert.strictEqual(threw, null);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.continued, true);
    assert.strictEqual(result.session.status, STATUS.ACTIVE);
    assert.strictEqual(result.session.pendingFrom, 18);
    assert.strictEqual(result.session.selectedSquare, 18);
    assert.ok(result.rendered.text.includes("Continue the capture with the same piece."));
    const dests = destinations(
      {
        board: result.session.board,
        current: result.session.currentPlayer,
        pendingFrom: result.session.pendingFrom,
      },
      18
    );
    assert.ok(dests.some((m) => m.to === 11));
    const pos11 = sqToRowCol(11);
    const destBtn =
      result.rendered.extra.reply_markup.inline_keyboard[pos11.row][pos11.col];
    assert.strictEqual(destBtn.callback_data, buildMoveCallbackData(sessionId, 18, 11));
  });

  await runTest("production-shaped sel:18 callback stays ACTIVE and can finish the jump", async () => {
    const { service } = createService();
    const sessionId = setupForcedJumpOn18(service);
    await service.move({
      sessionId,
      userId: KEVIN,
      from: 25,
      to: 18,
      chatId: COMMUNITY_CHAT,
    });
    const answered = [];
    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: KEVIN, first_name: "Kevin", is_bot: false },
      callbackQuery: {
        id: "cb1",
        data: buildSelectCallbackData(sessionId, 18),
        message: { message_id: 8001, chat: { id: COMMUNITY_CHAT } },
      },
      async answerCbQuery(text) {
        answered.push(text || "");
      },
      async editMessageText() {},
    };
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.deepStrictEqual(answered, [""]);
    const live = service.getSession(sessionId);
    assert.strictEqual(live.status, STATUS.ACTIVE);
    assert.strictEqual(live.pendingFrom, 18);
    assert.strictEqual(live.selectedSquare, 18);
    const finished = await service.move({
      sessionId,
      userId: KEVIN,
      from: 18,
      to: 11,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(finished.ok, true);
    assert.strictEqual(finished.session.status, STATUS.ACTIVE);
    assert.strictEqual(finished.session.pendingFrom, null);
    assert.strictEqual(finished.session.currentPlayer, WHITE);
    assert.ok(
      legalMoves({
        board: finished.session.board,
        current: WHITE,
        pendingFrom: null,
      }).length > 0
    );
  });

  await runTest("Telegraf handleUpdate of sel:18 does not throw", async () => {
    const { service } = createService();
    const sessionId = setupForcedJumpOn18(service);
    await service.move({
      sessionId,
      userId: KEVIN,
      from: 25,
      to: 18,
      chatId: COMMUNITY_CHAT,
    });
    const bot = new Telegraf("123:TESTTOKEN");
    bot.botInfo = { id: 1, is_bot: true, first_name: "t", username: "t" };
    bot.telegram.callApi = async () => true;
    attachUpdateErrorHandler(bot, () => {});
    registerPvpCallbacks(bot, {
      checkersRuntime: service,
      skipTimeoutHook: true,
      awardPvpWinXpFn: async () => ({ awarded: false, pointsToAdd: 0 }),
    });
    await bot.handleUpdate({
      update_id: 42,
      callback_query: {
        id: "q1",
        from: { id: KEVIN, is_bot: false, first_name: "Kevin" },
        chat_instance: "1",
        data: `pvp:chk:sel:${sessionId}:18`,
        message: {
          message_id: 8001,
          date: 1,
          chat: { id: COMMUNITY_CHAT, type: "supergroup" },
        },
      },
    });
    const live = service.getSession(sessionId);
    assert.strictEqual(live.status, STATUS.ACTIVE);
    assert.strictEqual(live.pendingFrom, 18);
    assert.strictEqual(live.selectedSquare, 18);
  });

  restoreEnv();
  console.log("\nAll checkers multi-jump callback tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
