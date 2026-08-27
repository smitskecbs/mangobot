/**
 * Cross-game active-match reservation.
 * Run: node tests/pvp-player-reservation.test.js
 */

const assert = require("assert");
const { createTicTacToeService } = require("../services/ticTacToe");
const { createConnectFourService } = require("../services/connectFour");
const { createBlackjackService } = require("../services/blackjack");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const {
  createPvpMatchReservation,
  PLAYER_BUSY_TEXT,
  BOT_USER_ID,
} = require("../services/pvpMatchReservation");

const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;

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
      randomIdFn: () => `ccddff${String(++bjSeq).padStart(2, "0")}`,
      lobbyMs: 60_000,
      botThinkMs: 0,
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

  await runTest("same user cannot start TTT then Blackjack", () => {
    const { ttt, bj } = createBundle();
    assert.strictEqual(
      ttt.startChallenge({
        chatId: COMMUNITY_CHAT,
        starter: starter(USER_A, "Kevin"),
      }).ok,
      true
    );
    const blocked = bj.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_A, "Kevin"),
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, "player-busy");
    assert.strictEqual(blocked.toast, PLAYER_BUSY_TEXT);
  });

  await runTest("same user cannot join a second game", () => {
    const { ttt, c4 } = createBundle();
    const t = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    const c = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_B, "Pippi"),
    });
    const join = ttt.join({
      sessionId: t.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(join.ok, false);
    assert.strictEqual(join.reason, "player-busy");
    assert.strictEqual(c4.getSession(c.session.id).status, "waiting");
  });

  await runTest("other members can still open matches", () => {
    const { ttt, c4, bj } = createBundle();
    assert.strictEqual(
      ttt.startChallenge({
        chatId: COMMUNITY_CHAT,
        starter: starter(USER_A, "Kevin"),
      }).ok,
      true
    );
    assert.strictEqual(
      c4.startChallenge({
        chatId: COMMUNITY_CHAT,
        starter: starter(USER_B, "Pippi"),
      }).ok,
      true
    );
    assert.strictEqual(
      bj.startLobby({
        chatId: COMMUNITY_CHAT,
        threadId: 123,
        starter: starter(USER_C, "Eve"),
      }).ok,
      true
    );
  });

  await runTest("finish / timeout / cancel release the lock", () => {
    const { ttt, c4, bj, timers, reservation } = createBundle();
    const t = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    ttt.join({
      sessionId: t.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    ttt.move({ sessionId: t.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: t.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: t.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: t.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: t.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });
    assert.strictEqual(reservation.has(USER_A), false);
    assert.strictEqual(reservation.has(USER_B), false);

    const c = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    assert.strictEqual(c.ok, true);
    c4.join({
      sessionId: c.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    timers.advance(60_000);
    assert.strictEqual(c4.getSession(c.session.id).status, "won");
    assert.strictEqual(reservation.has(USER_A), false);

    const b = bj.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_A, "Kevin"),
    });
    assert.strictEqual(b.ok, true);
    bj.clearAllTimers();
    assert.strictEqual(reservation.has(USER_A), false);
  });

  await runTest("stale callback does not create a reservation", () => {
    const { ttt, reservation } = createBundle();
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: starter(USER_A, "Kevin"),
    });
    ttt.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Pippi",
      chatId: COMMUNITY_CHAT,
    });
    ttt.move({ sessionId: started.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: started.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: started.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: started.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: started.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });
    assert.strictEqual(reservation.size(), 0);
    const stale = ttt.join({
      sessionId: started.session.id,
      userId: USER_C,
      displayName: "Eve",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(reservation.has(USER_C), false);
    assert.strictEqual(reservation.has(BOT_USER_ID), false);
  });

  restoreEnv();
  console.log("\nAll PvP reservation tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
