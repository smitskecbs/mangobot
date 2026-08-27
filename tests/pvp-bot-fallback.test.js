/**
 * TTT / Connect Four / Blackjack solo lobby → ManGo Bot fallback.
 * Run: node tests/pvp-bot-fallback.test.js
 */

const assert = require("assert");
const {
  createTicTacToeService,
  emptyBoard: emptyTttBoard,
  STATUS: TTT_STATUS,
  BOT_USER_ID,
} = require("../services/ticTacToe");
const {
  createConnectFourService,
  emptyBoard: emptyC4Board,
  dropToken,
  STATUS: C4_STATUS,
} = require("../services/connectFour");
const { createBlackjackService, STATUS: BJ_STATUS, BOT_ID } = require("../services/blackjack");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const { createPvpMatchReservation } = require("../services/pvpMatchReservation");
const {
  chooseTicTacToeBotCell,
  isLegalTicTacToeBotMove,
} = require("../services/ticTacToeBot");
const {
  chooseConnectFourBotColumn,
  isLegalConnectFourBotMove,
} = require("../services/connectFourBot");

const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;
const USER_D = 444;

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

function createBundle(overrides = {}) {
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
    joinTimeoutMs: overrides.joinTimeoutMs != null ? overrides.joinTimeoutMs : 60_000,
    botThinkMinMs: 0,
    botThinkMaxMs: 0,
  };
  let bjSeq = 0;
  return {
    timers,
    reservation,
    ttt: createTicTacToeService(shared),
    c4: createConnectFourService(shared),
    bj: createBlackjackService({
      reservation,
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      randomIdFn: () => `bbffcc${String(++bjSeq).padStart(2, "0")}`,
      lobbyMs: overrides.lobbyMs != null ? overrides.lobbyMs : 60_000,
      botThinkMs: 0,
      decisionMs: 30_000,
      turnMs: 30_000,
    }),
  };
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

  await runTest("TTT solo lobby becomes a bot match", () => {
    const { ttt, timers } = createBundle({ joinTimeoutMs: 60_000 });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    assert.ok(started.text.includes("ManGo Bot"));
    assert.ok(started.text.includes("JOIN GAME") || JSON.stringify(started.keyboard).includes("JOIN GAME"));
    timers.advance(60_000);
    const session = ttt.getSession(started.session.id);
    assert.strictEqual(session.status, TTT_STATUS.ACTIVE);
    assert.strictEqual(session.opponentType, "bot");
    assert.strictEqual(session.players.O.userId, BOT_USER_ID);
    assert.ok(session.players.O.isBot);
  });

  await runTest("C4 solo lobby becomes a bot match", () => {
    const { c4, timers } = createBundle({ joinTimeoutMs: 60_000 });
    const started = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    timers.advance(60_000);
    const session = c4.getSession(started.session.id);
    assert.strictEqual(session.status, C4_STATUS.ACTIVE);
    assert.strictEqual(session.opponentType, "bot");
    assert.strictEqual(session.players.Y.userId, BOT_USER_ID);
    assert.ok(session.players.Y.isBot);
  });

  await runTest("Blackjack solo lobby still falls back to bot", async () => {
    const { bj } = createBundle({ lobbyMs: 60_000 });
    const started = bj.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_A, "Eve"),
    });
    await bj.forceLobbyEnd(started.gameId);
    const game = bj.getGame(started.gameId);
    assert.ok(game.players.some((p) => p.userId === BOT_ID || p.isBot));
    assert.strictEqual(game.opponentType, "bot");
  });

  await runTest("human JOIN prevents bot fallback", () => {
    const { ttt, c4, timers } = createBundle({ joinTimeoutMs: 60_000 });
    const t = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    const c = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Charlie"),
    });
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
    timers.advance(60_000);
    assert.strictEqual(ttt.getSession(t.session.id).opponentType, "human");
    assert.strictEqual(ttt.getSession(t.session.id).players.O.userId, String(USER_B));
    assert.strictEqual(c4.getSession(c.session.id).opponentType, "human");
    assert.ok(!c4.getSession(c.session.id).players.Y.isBot);
  });

  await runTest("timeout vs JOIN race: exactly one outcome", () => {
    const { ttt } = createBundle({ joinTimeoutMs: 60_000 });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    const joined = ttt.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    const expired = ttt.expireJoin(started.session.id);
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(expired.ok, false);
    const session = ttt.getSession(started.session.id);
    assert.strictEqual(session.opponentType, "human");
    assert.ok(!session.players.O.isBot);
    assert.notStrictEqual(session.players.O.userId, BOT_USER_ID);

    const other = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_C, "Alice"),
    });
    const botFirst = ttt.expireJoin(other.session.id);
    const lateJoin = ttt.join({
      sessionId: other.session.id,
      userId: USER_D,
      displayName: "Dave",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(botFirst.ok, true);
    assert.strictEqual(botFirst.startedBot, true);
    assert.strictEqual(lateJoin.ok, false);
    const botSession = ttt.getSession(other.session.id);
    assert.strictEqual(botSession.opponentType, "bot");
    assert.strictEqual(botSession.players.O.userId, BOT_USER_ID);
    assert.notStrictEqual(botSession.players.O.userId, String(USER_D));
  });

  await runTest("TTT bot only plays legal cells", () => {
    const board = emptyTttBoard();
    board[0] = "X";
    board[1] = "O";
    const cell = chooseTicTacToeBotCell(board, "O", () => 0);
    assert.ok(isLegalTicTacToeBotMove(board, cell));
    assert.notStrictEqual(cell, 0);
    assert.notStrictEqual(cell, 1);
  });

  await runTest("TTT bot wins and blocks", () => {
    const winBoard = emptyTttBoard();
    winBoard[0] = "O";
    winBoard[1] = "O";
    winBoard[3] = "X";
    assert.strictEqual(chooseTicTacToeBotCell(winBoard, "O", () => 0), 2);

    const blockBoard = emptyTttBoard();
    blockBoard[0] = "X";
    blockBoard[1] = "X";
    blockBoard[4] = "O";
    assert.strictEqual(chooseTicTacToeBotCell(blockBoard, "O", () => 0), 2);
  });

  await runTest("C4 bot respects gravity and open columns", () => {
    const board = emptyC4Board();
    for (let i = 0; i < 6; i += 1) {
      dropToken(board, 3, i % 2 === 0 ? "R" : "Y");
    }
    const col = chooseConnectFourBotColumn(board, "Y", () => 0);
    assert.ok(isLegalConnectFourBotMove(board, col));
    assert.notStrictEqual(col, 3);
  });

  await runTest("C4 bot wins and blocks", () => {
    const winBoard = emptyC4Board();
    dropToken(winBoard, 0, "Y");
    dropToken(winBoard, 1, "Y");
    dropToken(winBoard, 2, "Y");
    dropToken(winBoard, 0, "R");
    assert.strictEqual(chooseConnectFourBotColumn(winBoard, "Y", () => 0), 3);

    const blockBoard = emptyC4Board();
    dropToken(blockBoard, 0, "R");
    dropToken(blockBoard, 1, "R");
    dropToken(blockBoard, 2, "R");
    dropToken(blockBoard, 6, "Y");
    assert.strictEqual(chooseConnectFourBotColumn(blockBoard, "Y", () => 0), 3);
  });

  await runTest("bot match cleanup releases reservation", () => {
    const { ttt, c4, timers, reservation } = createBundle({
      joinTimeoutMs: 1000,
    });
    const t = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    timers.advance(1000);
    assert.strictEqual(reservation.has(USER_A), true);
    ttt.move({
      sessionId: t.session.id,
      userId: USER_A,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    timers.advance(0);
    ttt.resolveTurnTimeout(t.session.id);
    assert.strictEqual(reservation.has(USER_A), false);

    const c = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_B, "Pippi"),
    });
    timers.advance(1000);
    c4.resolveTurnTimeout(c.session.id);
    assert.strictEqual(reservation.has(USER_B), false);
    assert.strictEqual(c4.getSession(c.session.id).status, C4_STATUS.WON);
  });

  restoreEnv();
  console.log("\nAll PvP bot fallback tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
