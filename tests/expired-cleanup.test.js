/**
 * Expired challenge message cleanup.
 * Run: node tests/expired-cleanup.test.js
 */

const assert = require("assert");
const {
  scheduleExpiredMessageCleanup,
  emptyInlineKeyboardExtra,
  EXPIRED_MESSAGE_CLEANUP_MS,
  clearAllExpiredMessageCleanups,
  getPendingExpiredCleanupCount,
} = require("../utils/expiredMessageCleanup");
const {
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  clearAllGameMessageCleanups,
  getPendingGameMessageCleanupCount,
} = require("../utils/gameCleanup");
const {
  createChatFightService,
  buildTimeoutMessage,
  buildRevealTimeoutMessage,
} = require("../services/chatFight");
const { createTicTacToeService } = require("../services/ticTacToe");
const { createConnectFourService } = require("../services/connectFour");
const { createPvpSessionManager } = require("../services/pvpSessionManager");

const COMMUNITY_CHAT = -1001234567890;
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

async function runTest(name, fn) {
  resetEnv();
  clearAllExpiredMessageCleanups();
  clearAllGameMessageCleanups();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("empty keyboard helper", () => {
    const extra = emptyInlineKeyboardExtra();
    assert.deepStrictEqual(extra.reply_markup.inline_keyboard, []);
    assert.strictEqual(EXPIRED_MESSAGE_CLEANUP_MS, 30_000);
    assert.strictEqual(GAME_MESSAGE_CLEANUP_DELAY_MS, 5 * 60 * 1000);
  });

  await runTest("ChatFight timeout edits expired + schedules cleanup", async () => {
    const timers = createFakeTimers();
    const edits = [];
    const deleted = [];
    const fight = createChatFightService({
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      durationMs: 60_000,
      revealWaitMs: 300_000,
      cooldownMs: 0,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push({ chatId, messageId });
      },
    });
    fight.setEditMessageHandler((chatId, messageId, text, extra) => {
      edits.push({ chatId, messageId, text, extra });
      return Promise.resolve();
    });
    const started = fight.startFight({
      chatId: COMMUNITY_CHAT,
      type: "type_rush",
      source: "manual",
    });
    assert.strictEqual(started.ok, true);
    fight.setFightMessageId(77);
    fight.revealFight(COMMUNITY_CHAT);
    timers.advance(60_000);
    await Promise.resolve();
    assert.ok(edits.length >= 1);
    assert.ok(edits[0].text.includes("CHAT FIGHT EXPIRED"));
    assert.ok(edits[0].text.includes("Nobody solved it in time"));
    assert.deepStrictEqual(edits[0].extra.reply_markup.inline_keyboard, []);
    timers.advance(GAME_MESSAGE_CLEANUP_DELAY_MS);
    await Promise.resolve();
    assert.ok(deleted.some((d) => d.messageId === 77));
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
    fight.reset();
  });

  await runTest("ChatFight winner board is cleaned after delay, not immediately", async () => {
    const timers = createFakeTimers();
    const deleted = [];
    const fight = createChatFightService({
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      durationMs: 60_000,
      revealWaitMs: 300_000,
      cooldownMs: 0,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push(messageId);
      },
    });
    fight.setEditMessageHandler(() => Promise.resolve());
    fight.startFight({ chatId: COMMUNITY_CHAT, type: "type_rush" });
    fight.setFightMessageId(88);
    fight.revealFight(COMMUNITY_CHAT);
    const snap = fight.getFightSnapshot();
    const answer = snap.acceptedAnswers[0];
    fight.tryClaimWinner(111, COMMUNITY_CHAT, answer);
    timers.advance(90_000);
    await Promise.resolve();
    assert.strictEqual(deleted.length, 0);
    timers.advance(GAME_MESSAGE_CLEANUP_DELAY_MS);
    await Promise.resolve();
    assert.ok(deleted.includes(88));
    fight.reset();
  });

  await runTest("timeout message builders", () => {
    assert.ok(buildRevealTimeoutMessage().includes("Nobody revealed"));
    assert.ok(
      buildTimeoutMessage({ revealAnswer: "42" }).includes("Answer: 42")
    );
    assert.ok(
      require("../services/ticTacToe")
        .renderMessage({ status: "expired" })
        .text.includes("Tic-Tac-Toe cancelled")
    );
    assert.ok(
      require("../services/connectFour")
        .renderMessage({ status: "expired" })
        .text.includes("Connect Four cancelled")
    );
  });

  await runTest("TTT join timeout render clears keyboard", () => {
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
    });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: 111, displayName: "Kevin", isBot: false },
    });
    assert.strictEqual(started.ok, true);
    const expired = ttt.expireJoin(started.session.id);
    assert.strictEqual(expired.ok, true);
    assert.strictEqual(expired.session.status, "active");
    assert.strictEqual(expired.startedBot, true);
    assert.ok(!JSON.stringify(expired.rendered.extra).includes("JOIN GAME"));
  });

  await runTest("Connect4 join timeout render clears keyboard", () => {
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
    });
    const started = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: 111, displayName: "Kevin", isBot: false },
    });
    assert.strictEqual(started.ok, true);
    const expired = c4.expireJoin(started.session.id);
    assert.strictEqual(expired.ok, true);
    assert.strictEqual(expired.session.status, "active");
    assert.strictEqual(expired.startedBot, true);
    assert.ok(!JSON.stringify(expired.rendered.extra).includes("JOIN GAME"));
  });

  await runTest("delete failure does not throw", async () => {
    const timers = createFakeTimers();
    let logged = false;
    scheduleExpiredMessageCleanup({
      chatId: 1,
      messageId: 2,
      delayMs: 10,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async () => {
        throw new Error("fail");
      },
      logErrorFn: () => {
        logged = true;
      },
    });
    timers.advance(10);
    await Promise.resolve();
    assert.strictEqual(logged, true);
    assert.strictEqual(getPendingExpiredCleanupCount(), 0);
  });

  clearAllExpiredMessageCleanups();
  restoreEnv();
  console.log("\nAll expired-cleanup tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
