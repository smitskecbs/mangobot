/**
 * Parallel TTT / Connect Four / Blackjack matches.
 * Run: node tests/pvp-parallel-matches.test.js
 */

const assert = require("assert");
const {
  createTicTacToeService,
  parsePvpCallbackData: parseTtt,
  STATUS: TTT_STATUS,
} = require("../services/ticTacToe");
const { createConnectFourService } = require("../services/connectFour");
const { createBlackjackService, STATUS: BJ_STATUS } = require("../services/blackjack");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const {
  createPvpMatchReservation,
  PLAYER_BUSY_TEXT,
} = require("../services/pvpMatchReservation");
const { handlePvpCallback } = require("../events/pvp-callbacks");

const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;
const USER_D = 444;
const USER_E = 555;
const USER_F = 666;
const USER_G = 777;
const USER_H = 888;

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

function starter(userId, displayName) {
  return { userId, displayName, isBot: false };
}

function createBundle() {
  const timers = createFakeTimers();
  const reservation = createPvpMatchReservation();
  const manager = createPvpSessionManager({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });
  const shared = {
    manager,
    reservation,
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    joinTimeoutMs: 60_000,
    botThinkMinMs: 0,
    botThinkMaxMs: 0,
  };
  let bjSeq = 0;
  const ttt = createTicTacToeService(shared);
  const c4 = createConnectFourService(shared);
  const bj = createBlackjackService({
    reservation,
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    randomIdFn: () => `aabbcc${String(++bjSeq).padStart(2, "0")}`,
    lobbyMs: 60_000,
    botThinkMs: 0,
    decisionMs: 30_000,
    turnMs: 30_000,
  });
  return { timers, reservation, ttt, c4, bj };
}

async function runTest(name, fn) {
  resetEnv();
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

  await runTest("two TTT matches run in parallel", async () => {
    const { ttt } = createBundle();
    const a = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    const b = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Alice"),
    });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.notStrictEqual(a.session.id, b.session.id);
    ttt.join({
      sessionId: a.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    ttt.join({
      sessionId: b.session.id,
      userId: USER_D,
      displayName: "Bob",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(ttt.getSession(a.session.id).status, TTT_STATUS.ACTIVE);
    assert.strictEqual(ttt.getSession(b.session.id).status, TTT_STATUS.ACTIVE);
    ttt.move({
      sessionId: a.session.id,
      userId: USER_A,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(ttt.getSession(a.session.id).board[0], "X");
    assert.strictEqual(ttt.getSession(b.session.id).board[0], null);
  });

  await runTest("TTT and Connect Four run in parallel", async () => {
    const { ttt, c4 } = createBundle();
    const t = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    const c = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Charlie"),
    });
    assert.strictEqual(t.ok, true);
    assert.strictEqual(c.ok, true);
    ttt.join({
      sessionId: t.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    c4.join({
      sessionId: c.session.id,
      userId: USER_D,
      displayName: "Dave",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(ttt.getSession(t.session.id).status, TTT_STATUS.ACTIVE);
    assert.strictEqual(c4.getSession(c.session.id).status, "active");
  });

  await runTest("Connect Four and Blackjack run in parallel", async () => {
    const { c4, bj } = createBundle();
    const c = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Charlie"),
    });
    const b = bj.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_E, "Eve"),
    });
    assert.strictEqual(c.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(bj.isBlackjackOpen(COMMUNITY_CHAT), true);
    assert.strictEqual(c4.isOpen(), true);
  });

  await runTest("multiple Blackjack matches in the same chat", async () => {
    const { bj } = createBundle();
    const one = bj.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_A, "Alice"),
    });
    const two = bj.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_C, "Carol"),
    });
    assert.strictEqual(one.ok, true);
    assert.strictEqual(two.ok, true);
    assert.notStrictEqual(one.gameId, two.gameId);
    const joinOne = bj.tryJoin({
      gameId: one.gameId,
      userId: USER_B,
      displayName: "Bob",
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    assert.strictEqual(joinOne.ok, true);
    assert.strictEqual(bj.getGame(two.gameId).status, BJ_STATUS.LOBBY);
    assert.strictEqual(bj.getGame(one.gameId).players.length, 2);
    assert.strictEqual(bj.getGame(two.gameId).players.length, 1);
  });

  await runTest("timers are isolated across lobbies", async () => {
    const { timers, ttt, c4, bj } = createBundle();
    const t = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    timers.advance(20_000);
    const c = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Charlie"),
    });
    const b = bj.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_E, "Eve"),
    });
    timers.advance(40_000);
    assert.strictEqual(ttt.getSession(t.session.id).status, TTT_STATUS.ACTIVE);
    assert.strictEqual(ttt.getSession(t.session.id).opponentType, "bot");
    assert.strictEqual(c4.getSession(c.session.id).status, "waiting");
    assert.strictEqual(bj.getGame(b.gameId).status, BJ_STATUS.LOBBY);
    timers.advance(20_000);
    await bj.whenIdle();
    assert.strictEqual(c4.getSession(c.session.id).status, "active");
    assert.notStrictEqual(bj.getGame(b.gameId).status, BJ_STATUS.LOBBY);
  });

  await runTest("moves stay on the owning match", async () => {
    const { ttt } = createBundle();
    const a = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    const b = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Alice"),
    });
    ttt.join({
      sessionId: a.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    ttt.join({
      sessionId: b.session.id,
      userId: USER_D,
      displayName: "Bob",
      chatId: COMMUNITY_CHAT,
    });
    ttt.move({
      sessionId: a.session.id,
      userId: USER_A,
      cell: 4,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(ttt.getSession(a.session.id).board[4], "X");
    assert.strictEqual(ttt.getSession(b.session.id).board[4], null);
    assert.strictEqual(ttt.getSession(b.session.id).currentPlayer, "X");
  });

  await runTest("cleanup of one match leaves the other running", async () => {
    const { ttt } = createBundle();
    const a = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    const b = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Alice"),
    });
    ttt.join({
      sessionId: a.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    ttt.move({ sessionId: a.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: a.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: a.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: a.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: a.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });
    assert.strictEqual(ttt.getSession(a.session.id).status, TTT_STATUS.WON);
    assert.strictEqual(ttt.getSession(b.session.id).status, TTT_STATUS.WAITING);
    assert.strictEqual(ttt.isOpen(), true);
  });

  await runTest("player reservation blocks a second interactive match", async () => {
    const { ttt, bj, reservation } = createBundle();
    const t = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    assert.strictEqual(t.ok, true);
    const blocked = bj.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_A, "Kevin"),
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, "player-busy");
    assert.ok(blocked.toast.includes("already have an active game"));
    assert.strictEqual(reservation.has(USER_A), true);
  });

  await runTest("stale callback never attaches to a newer match", async () => {
    const { ttt } = createBundle();
    const a = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    ttt.join({
      sessionId: a.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    ttt.move({ sessionId: a.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: a.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: a.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: a.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: a.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });

    const b = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Alice"),
    });
    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_G, is_bot: false, first_name: "Eve" },
      callbackQuery: {
        data: `pvp:ttt:join:${a.session.id}`,
        from: { id: USER_G, is_bot: false },
        message: { message_id: 1, chat: { id: COMMUNITY_CHAT } },
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
    await handlePvpCallback(ctx, {
      runtime: ttt,
      parseCallbackData: parseTtt,
      awardPvpWinXpFn: () => ({ awarded: false }),
    });
    assert.strictEqual(ctx.cbAnswers[0], "This game is over.");
    assert.strictEqual(ttt.getSession(b.session.id).players.O, null);
    assert.strictEqual(ttt.getSession(b.session.id).status, TTT_STATUS.WAITING);
  });

  await runTest("stale JOIN on match A does not change live match B", async () => {
    const { ttt } = createBundle();
    const a = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    ttt.join({
      sessionId: a.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    ttt.move({
      sessionId: a.session.id,
      userId: USER_A,
      cell: 4,
      chatId: COMMUNITY_CHAT,
    });
    const b = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Alice"),
    });
    ttt.join({
      sessionId: b.session.id,
      userId: USER_D,
      displayName: "Bob",
      chatId: COMMUNITY_CHAT,
    });
    ttt.move({
      sessionId: b.session.id,
      userId: USER_C,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    const beforeB = ttt.getSession(b.session.id);
    const boardB = JSON.stringify(beforeB.board);
    const ctx = {
      chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      from: { id: USER_E, is_bot: false, first_name: "Eve" },
      callbackQuery: {
        data: `pvp:ttt:join:${a.session.id}`,
        from: { id: USER_E, is_bot: false },
        message: {
          message_id: 11,
          chat: { id: COMMUNITY_CHAT },
          reply_markup: {
            inline_keyboard: [[{ text: "JOIN GAME", callback_data: "x" }]],
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
    await handlePvpCallback(ctx, {
      runtime: ttt,
      parseCallbackData: parseTtt,
      awardPvpWinXpFn: () => ({ awarded: false }),
    });
    assert.strictEqual(ctx.cbAnswers[0], "This game already started.");
    const afterA = ttt.getSession(a.session.id);
    const afterB = ttt.getSession(b.session.id);
    assert.strictEqual(afterA.status, TTT_STATUS.ACTIVE);
    assert.strictEqual(afterA.board[4], "X");
    assert.strictEqual(afterB.status, TTT_STATUS.ACTIVE);
    assert.strictEqual(JSON.stringify(afterB.board), boardB);
    assert.strictEqual(afterB.board[0], "X");
    assert.strictEqual(afterB.players.O.userId, String(USER_D));
    assert.ok(ctx.edited[0].text.includes("❌"));
    assert.ok(ctx.edited[0].extra.reply_markup.inline_keyboard.length > 0);
  });

  await runTest("simultaneous last-seat JOIN: one winner, one full", async () => {
    const { ttt } = createBundle();
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    const first = ttt.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    const second = ttt.join({
      sessionId: started.session.id,
      userId: USER_C,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.started, true);
    assert.strictEqual(second.ok, false);
    assert.ok(["full", "not-waiting"].includes(second.reason));
    const session = ttt.getSession(started.session.id);
    assert.strictEqual(session.players.O.userId, String(USER_B));
    assert.notStrictEqual(session.players.O.userId, String(USER_C));
  });

  restoreEnv();
  console.log("\nAll parallel PvP match tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
