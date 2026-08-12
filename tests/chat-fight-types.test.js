/**
 * New ChatFight race types: unscramble, missing letter, memory, quick tap.
 * Run: node tests/chat-fight-types.test.js
 */

const assert = require("assert");
const {
  createChatFightService,
  FIGHT_TYPES,
  generateUnscramble,
  generateMissingLetter,
  generateMemory,
  generateQuickTap,
} = require("../services/chatFight");

const CHAT = -1001;

function createFakeTimers() {
  let nowMs = 1_000_000;
  const timers = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
      for (const t of timers.filter((x) => !x.cleared && x.fireAt <= nowMs)) {
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

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("unscramble generate + win", () => {
  const clock = createFakeTimers();
  const service = createChatFightService({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0,
  });
  const g = generateUnscramble(() => 0);
  assert.strictEqual(g.type, FIGHT_TYPES.UNSCRAMBLE);
  service.startFight({ chatId: CHAT, type: FIGHT_TYPES.UNSCRAMBLE });
  assert.strictEqual(service.tryClaimWinner(1, CHAT, g.revealAnswer).claimed, false);
  service.revealFight(CHAT);
  assert.ok(service.tryClaimWinner(1, CHAT, g.revealAnswer).claimed);
});

runTest("missing letter generate + win", () => {
  const clock = createFakeTimers();
  const service = createChatFightService({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0,
  });
  const g = generateMissingLetter(() => 0);
  service.startFight({ chatId: CHAT, type: FIGHT_TYPES.MISSING_LETTER });
  service.revealFight(CHAT);
  assert.ok(service.tryClaimWinner(1, CHAT, g.revealAnswer).claimed);
});

runTest("memory: pre-answer invalid, post-phase valid", () => {
  const edits = [];
  const clock = createFakeTimers();
  const service = createChatFightService({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0,
    editMessage: async (chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
    },
  });
  const g = generateMemory(() => 0);
  service.startFight({ chatId: CHAT, type: FIGHT_TYPES.MEMORY });
  service.setFightMessageId(10);
  const revealed = service.revealFight(CHAT);
  assert.strictEqual(revealed.phase, "prepare");
  assert.strictEqual(service.getFightSnapshot().status, "prepare");
  assert.strictEqual(
    service.tryClaimWinner(1, CHAT, g.revealAnswer).claimed,
    false
  );
  clock.advance(5000);
  assert.strictEqual(service.getFightSnapshot().status, "active");
  assert.ok(edits.length >= 1);
  assert.ok(edits[0].text.includes("What was the word"));
  assert.ok(service.tryClaimWinner(1, CHAT, g.revealAnswer).claimed);
});

runTest("quick tap: pre-TAP invalid, post-TAP valid", () => {
  const clock = createFakeTimers();
  const service = createChatFightService({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0,
    editMessage: async () => {},
  });
  const g = generateQuickTap(() => 0);
  service.startFight({ chatId: CHAT, type: FIGHT_TYPES.QUICK_TAP });
  service.setFightMessageId(11);
  service.revealFight(CHAT);
  assert.strictEqual(service.tryClaimWinner(1, CHAT, "TAP").claimed, false);
  clock.advance(g.meta.prepareMs);
  assert.strictEqual(service.getFightSnapshot().status, "active");
  assert.ok(service.tryClaimWinner(1, CHAT, "TAP").claimed);
});

console.log("\nAll chat-fight-types tests passed.");
