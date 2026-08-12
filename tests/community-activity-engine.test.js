/**
 * Community activity engine — one action per slot, weights, 24/7.
 * Run: node tests/community-activity-engine.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  createChatFightService,
  FIGHT_TYPES,
  CHAT_FIGHT_COOLDOWN_MS,
} = require("../services/chatFight");
const {
  ACTION_IDS,
  ACTION_WEIGHTS,
  parseActivityEngineConfig,
  buildActivitySlots,
  pickWeightedAction,
  processCommunityActivitySlot,
  chooseAction,
} = require("../services/communityActivityEngine");
const {
  createCommunityScheduler,
  getZonedClock,
} = require("../services/communityScheduler");
const {
  resetCommunityActivityPulse,
  noteCommunityActivity,
} = require("../utils/communityActivityPulse");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-acteng-"));
let n = 0;
const CHAT = "-100111";

function stateFile() {
  n += 1;
  return path.join(tempDir, `s-${n}.json`);
}

function utcDate(iso) {
  return new Date(iso);
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function createService() {
  return createChatFightService({
    random: () => 0,
    durationMs: 60_000,
    revealWaitMs: 300_000,
    cooldownMs: CHAT_FIGHT_COOLDOWN_MS,
  });
}

async function main() {
  await runTest("weights total 100", () => {
    const total = Object.values(ACTION_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, 100);
  });

  await runTest("24/7 slots midnight and 23:30", () => {
    const slots = buildActivitySlots(30, { twentyFourSeven: true });
    assert.strictEqual(slots[0].id, "act0000");
    assert.strictEqual(slots[slots.length - 1].id, "act2330");
    assert.strictEqual(slots.length, 48);
  });

  await runTest("one action per slot + no duplicate", async () => {
    const service = createService();
    const state = { sent: {}, lastMessageKey: null, recentActivityTypes: [], autoChatFight: { processedSlots: {}, lastStartedAt: null, lastType: null } };
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        autoFightEnabled: false,
        intervalMinutes: 30,
      }
    );
    const sent = [];
    const slot = { id: "act0900", label: "09:00", hour: 9, minute: 0 };
    const r1 = await processCommunityActivitySlot({
      chatId: CHAT,
      slot,
      dayKey: "2026-08-12",
      config: cfg,
      state,
      chatFight: service,
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      random: () => 0.5,
      wasActiveWithinFn: () => false,
      nowMs: Date.now(),
    });
    assert.ok(r1.action);
    const r2 = await processCommunityActivitySlot({
      chatId: CHAT,
      slot,
      dayKey: "2026-08-12",
      config: cfg,
      state,
      chatFight: service,
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      random: () => 0.5,
      wasActiveWithinFn: () => false,
      nowMs: Date.now(),
    });
    assert.strictEqual(r2.reason, "already-processed");
    assert.ok(sent.length <= 1);
  });

  await runTest("weighted pick deterministic", () => {
    // random 0 → first positive weight action
    const id = pickWeightedAction(ACTION_WEIGHTS, () => 0);
    assert.strictEqual(id, ACTION_IDS.CHATFIGHT);
  });

  await runTest("chatfight cooldown → fallback other action", async () => {
    const service = createService();
    service.startFight({ chatId: CHAT, type: FIGHT_TYPES.TYPE_RUSH });
    const state = {
      sent: {},
      lastMessageKey: null,
      recentActivityTypes: [],
      autoChatFight: { processedSlots: {}, lastStartedAt: null, lastType: null },
    };
    const cfg = parseActivityEngineConfig(
      {},
      { enabled: true, autoFightEnabled: true, twentyFourSeven: true }
    );
    const action = chooseAction(
      cfg,
      {
        config: cfg,
        chatFight: service,
        autoState: state.autoChatFight,
        nowMs: Date.now(),
        wasActiveWithin: () => false,
        lastActivityAt: 0,
        recentActivityTypes: [],
      },
      () => 0
    );
    assert.notStrictEqual(action, ACTION_IDS.CHATFIGHT);
    service.reset();
  });

  await runTest("recent activity suppresses passive", () => {
    resetCommunityActivityPulse();
    noteCommunityActivity(Date.now());
    const cfg = parseActivityEngineConfig(
      {},
      { enabled: true, autoFightEnabled: false }
    );
    cfg.skipRecentMs = 10 * 60 * 1000;
    const action = chooseAction(
      cfg,
      {
        config: cfg,
        chatFight: createService(),
        autoState: { lastStartedAt: null, lastType: null, processedSlots: {} },
        nowMs: Date.now(),
        wasActiveWithin: () => true,
        lastActivityAt: Date.now(),
        recentActivityTypes: [],
      },
      () => 0.99
    );
    assert.ok(
      ![ACTION_IDS.COMMUNITY, ACTION_IDS.CHECKIN, ACTION_IDS.GMGN].includes(
        action
      ) || action === ACTION_IDS.SKIP
    );
  });

  await runTest("engine slot via scheduler — no catch-up", async () => {
    const file = stateFile();
    const service = createService();
    const sent = [];
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        intervalMinutes: 30,
        autoFightEnabled: false,
      }
    );
    let now = utcDate("2026-08-12T10:00:00.000Z");
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: CHAT,
      timeZone: "UTC",
      stateFile: file,
      now: () => now,
      activityEngineConfig: cfg,
      chatFight: service,
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      activityRandom: () => 0.5,
    });
    await sched.tick();
    now = utcDate("2026-08-12T10:01:00.000Z");
    const result = await sched.tick();
    assert.ok(result.activity);
    assert.deepStrictEqual(result.activity.results, []);
    assert.strictEqual(sent.length, 0);
    sched.stop();
  });

  await runTest("engine fires on slot cross once", async () => {
    const file = stateFile();
    const service = createService();
    const sent = [];
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        intervalMinutes: 30,
        autoFightEnabled: false,
      }
    );
    let now = utcDate("2026-08-12T08:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: CHAT,
      timeZone: "UTC",
      stateFile: file,
      now: () => now,
      activityEngineConfig: cfg,
      chatFight: service,
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      activityRandom: () => 0.4,
    });
    await sched.tick();
    now = utcDate("2026-08-12T09:00:00.000Z");
    const result = await sched.tick();
    assert.ok(result.activity.results.length >= 1);
    assert.ok(result.activity.results.every((r) => r.slot));
    // second cross of same shouldn't fire again
    now = utcDate("2026-08-12T09:00:30.000Z");
    sched.setLastChecked(utcDate("2026-08-12T08:59:00.000Z"));
    const again = await sched.tick();
    const act0900 = again.activity.results.filter((r) => r.slot === "act0900");
    assert.ok(act0900.every((r) => r.reason === "already-processed" || !r.sent));
    sched.stop();
  });

  await runTest("chatfight announce fail → prompt fallback", async () => {
    const service = createService();
    const state = {
      sent: {},
      lastMessageKey: null,
      recentActivityTypes: [],
      autoChatFight: { processedSlots: {}, lastStartedAt: null, lastType: null },
    };
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        autoFightEnabled: true,
        intervalMinutes: 30,
      }
    );
    const sent = [];
    const slot = { id: "act1830", label: "18:30", hour: 18, minute: 30 };
    const result = await processCommunityActivitySlot({
      chatId: CHAT,
      slot,
      dayKey: "2026-08-12",
      config: cfg,
      state,
      chatFight: service,
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      announceChatFight: async () => {
        throw new Error("announce failed");
      },
      random: () => 0,
      wasActiveWithinFn: () => false,
      nowMs: Date.now(),
    });
    assert.notStrictEqual(result.action, ACTION_IDS.CHATFIGHT);
    assert.ok(result.fallback && String(result.fallback).includes("chatfight"));
    assert.strictEqual(result.sent, true);
    assert.strictEqual(sent.length, 1);
    assert.ok(state.sent["2026-08-12"].includes("act1830"));
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll community-activity-engine tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
