/**
 * Auto scheduler ChatFight-only + Checkers isolation from community activity.
 * Run: node tests/activity-engine-chatfight-only.test.js
 */

const assert = require("assert");

const {
  ACTION_IDS,
  parseActivityEngineConfig,
  buildWeights,
  chooseAction,
  processCommunityActivitySlot,
} = require("../services/communityActivityEngine");
const {
  createChatFightService,
  FIGHT_TYPES,
  CHAT_FIGHT_COOLDOWN_MS,
} = require("../services/chatFight");
const {
  createCheckersService,
  buildSelectCallbackData,
  STATUS,
} = require("../services/checkers");
const { createTriviaService } = require("../services/trivia");
const { handlePvpCallback } = require("../events/pvp-callbacks");
const { GAME_OVER_TOAST } = require("../utils/gameCleanup");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const { createPvpMatchReservation } = require("../services/pvpMatchReservation");

const CHAT = "-1001234567890";
const USER_A = 111;
const originalChatId = process.env.TELEGRAM_CHAT_ID;

function resetEnv() {
  process.env.TELEGRAM_CHAT_ID = CHAT;
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

function createFight() {
  return createChatFightService({
    now: () => Date.now(),
    cooldownMs: CHAT_FIGHT_COOLDOWN_MS,
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      if (handle && typeof handle.unref === "function") {
        handle.unref();
      }
      return handle;
    },
  });
}

function engineCfg(overrides = {}) {
  return parseActivityEngineConfig(
    {},
    {
      enabled: true,
      twentyFourSeven: true,
      autoFightEnabled: true,
      intervalMinutes: 30,
      ...overrides,
    }
  );
}

function emptyState() {
  return {
    sent: {},
    lastMessageKey: null,
    recentActivityTypes: [],
    autoChatFight: { processedSlots: {}, lastStartedAt: null, lastType: null },
  };
}

function chooseContext(cfg, fight) {
  return {
    config: cfg,
    chatFight: fight,
    autoState: { lastStartedAt: null, lastType: null, processedSlots: {} },
    nowMs: Date.now(),
    wasActiveWithin: () => false,
    lastActivityAt: 0,
    recentActivityTypes: [],
  };
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

  await runTest("auto weights keep only ChatFight and skip", () => {
    const cfg = engineCfg();
    const weights = buildWeights(cfg, chooseContext(cfg, createFight()));
    assert.ok(weights[ACTION_IDS.CHATFIGHT] > 0);
    assert.ok(weights[ACTION_IDS.SKIP] > 0);
    for (const id of [
      ACTION_IDS.TRIVIA,
      ACTION_IDS.QUESTION,
      ACTION_IDS.GAME,
      ACTION_IDS.SNAKE,
      ACTION_IDS.BOUNCH,
      ACTION_IDS.GMGN,
      ACTION_IDS.COMMUNITY,
      ACTION_IDS.WEEKLY,
      ACTION_IDS.LEADERBOARD,
      ACTION_IDS.CHECKIN,
    ]) {
      assert.strictEqual(weights[id], 0, id);
    }
  });

  await runTest("chooseAction never picks trivia/snake/question/gmgn/game", () => {
    const cfg = engineCfg();
    const fight = createFight();
    const banned = new Set([
      ACTION_IDS.TRIVIA,
      ACTION_IDS.QUESTION,
      ACTION_IDS.GAME,
      ACTION_IDS.SNAKE,
      ACTION_IDS.BOUNCH,
      ACTION_IDS.GMGN,
      ACTION_IDS.COMMUNITY,
      ACTION_IDS.WEEKLY,
      ACTION_IDS.LEADERBOARD,
      ACTION_IDS.CHECKIN,
    ]);
    for (const roll of [0, 0.15, 0.4, 0.72, 0.99]) {
      const action = chooseAction(cfg, chooseContext(cfg, fight), () => roll);
      assert.ok(
        action === ACTION_IDS.CHATFIGHT || action === ACTION_IDS.SKIP,
        `roll ${roll} picked ${action}`
      );
      assert.ok(!banned.has(action));
    }
  });

  await runTest("scheduler slot can still start ChatFight", async () => {
    const fight = createFight();
    const sent = [];
    const result = await processCommunityActivitySlot({
      chatId: CHAT,
      slot: { id: "act1200", label: "12:00", hour: 12, minute: 0 },
      dayKey: "2026-09-02",
      config: engineCfg(),
      state: emptyState(),
      chatFight: fight,
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      announceChatFight: async (_c, teaser) => {
        sent.push(teaser);
        return { message_id: 88 };
      },
      random: () => 0,
      wasActiveWithinFn: () => false,
      nowMs: Date.now(),
    });
    assert.strictEqual(result.action, ACTION_IDS.CHATFIGHT);
    assert.strictEqual(result.sent, true);
    assert.strictEqual(fight.isFightOpen(), true);
    assert.ok(sent.length >= 1);
  });

  await runTest("scheduler slot does not auto-send trivia/snake/question/gmgn", async () => {
    const fight = createFight();
    fight.startFight({ chatId: CHAT, type: FIGHT_TYPES.TYPE_RUSH });
    const sent = [];
    const result = await processCommunityActivitySlot({
      chatId: CHAT,
      slot: { id: "act1230", label: "12:30", hour: 12, minute: 30 },
      dayKey: "2026-09-02",
      config: engineCfg(),
      state: emptyState(),
      chatFight: fight,
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      announceTrivia: async (_c, t) => {
        sent.push(t);
        return { message_id: 89 };
      },
      random: () => 0.5,
      wasActiveWithinFn: () => false,
      nowMs: Date.now(),
    });
    assert.strictEqual(result.action, ACTION_IDS.SKIP);
    assert.strictEqual(result.sent, false);
    assert.strictEqual(sent.length, 0);
    fight.reset();
  });

  await runTest("active Checkers vs bot survives auto Trivia start", async () => {
    try {
      require("../services/trivia").getTriviaRuntime().reset();
    } catch (_err) {
      /* ignore */
    }
    const timers = createFakeTimers();
    const chk = createCheckersService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      joinTimeoutMs: 300_000,
      turnTimeoutMs: 300_000,
      botThinkMinMs: 0,
      botThinkMaxMs: 0,
      manager: createPvpSessionManager({
        now: timers.now,
        setTimeoutFn: timers.setTimeout,
        clearTimeoutFn: timers.clearTimeout,
      }),
      reservation: createPvpMatchReservation(),
    });
    const trivia = createTriviaService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      random: () => 0,
      randomIdFn: () => "abc123",
    });

    const started = chk.startChallenge({
      chatId: CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    assert.strictEqual(started.ok, true);
    chk.setMessageId(started.session.id, 5001);
    const vsBot = chk.expireJoin(started.session.id);
    assert.strictEqual(vsBot.session.opponentType, "bot");
    assert.strictEqual(chk.getSession(started.session.id).status, STATUS.ACTIVE);

    const slot = await processCommunityActivitySlot({
      chatId: CHAT,
      slot: { id: "act1300", label: "13:00", hour: 13, minute: 0 },
      dayKey: "2026-09-02",
      config: engineCfg(),
      state: emptyState(),
      chatFight: createFight(),
      triviaRuntime: trivia,
      forceAction: ACTION_IDS.TRIVIA,
      announceTrivia: async () => ({ message_id: 77 }),
      sendMessage: async () => true,
      random: () => 0,
      wasActiveWithinFn: () => false,
      nowMs: timers.now(),
    });
    assert.strictEqual(slot.action, ACTION_IDS.TRIVIA);
    assert.strictEqual(slot.sent, true);
    assert.strictEqual(trivia.isTriviaOpen(), true);

    const live = chk.getSession(started.session.id);
    assert.ok(live);
    assert.strictEqual(live.status, STATUS.ACTIVE);

    const ctx = {
      chat: { id: Number(CHAT), type: "supergroup" },
      from: { id: USER_A, first_name: "Kevin", is_bot: false },
      callbackQuery: {
        id: "cb1",
        data: buildSelectCallbackData(started.session.id, 20),
        message: { message_id: 5001, chat: { id: Number(CHAT) } },
      },
      answered: [],
      edits: [],
      answerCbQuery(text) {
        this.answered.push(text || "");
        return Promise.resolve();
      },
      editMessageText(text, extra) {
        this.edits.push({ text, extra });
        return Promise.resolve();
      },
    };
    await handlePvpCallback(ctx, {
      runtime: chk,
      parseCallbackData: require("../services/checkers").parsePvpCallbackData,
    });
    assert.ok(!ctx.answered.includes(GAME_OVER_TOAST));
    assert.ok(
      !ctx.answered.some((t) => String(t).includes("This game has ended"))
    );
    assert.ok(
      !ctx.edits.some((e) => String(e.text).includes("This game has ended"))
    );
    assert.strictEqual(chk.getSession(started.session.id).status, STATUS.ACTIVE);
    trivia.reset();
    chk.reset();
  });

  await runTest("active Checkers survives ChatFight auto start", async () => {
    const timers = createFakeTimers();
    const chk = createCheckersService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      joinTimeoutMs: 300_000,
      turnTimeoutMs: 300_000,
      botThinkMinMs: 0,
      botThinkMaxMs: 0,
    });
    const fight = createFight();
    const started = chk.startChallenge({
      chatId: CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    chk.setMessageId(started.session.id, 5001);
    chk.expireJoin(started.session.id);
    assert.strictEqual(chk.getSession(started.session.id).status, STATUS.ACTIVE);

    const result = await processCommunityActivitySlot({
      chatId: CHAT,
      slot: { id: "act1330", label: "13:30", hour: 13, minute: 30 },
      dayKey: "2026-09-02",
      config: engineCfg(),
      state: emptyState(),
      chatFight: fight,
      announceChatFight: async () => ({ message_id: 90 }),
      sendMessage: async () => true,
      random: () => 0,
      wasActiveWithinFn: () => false,
      nowMs: timers.now(),
    });
    assert.strictEqual(result.action, ACTION_IDS.CHATFIGHT);
    assert.strictEqual(fight.isFightOpen(), true);
    assert.strictEqual(chk.getSession(started.session.id).status, STATUS.ACTIVE);
    fight.reset();
    chk.reset();
  });

  restoreEnv();
  console.log("\nAll activity-engine-chatfight-only tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
