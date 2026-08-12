/**
 * Community scheduler — slot crossing, dedupe, disabled/missing env.
 * Run: node tests/community-scheduler.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  createCommunityScheduler,
  parseEnabledFlag,
  getZonedClock,
  didCrossSlot,
  pickMessage,
  MESSAGE_POOLS,
  ACTIVITY_MESSAGES,
  DEFAULT_SLOTS,
  buildIntervalSlots,
  resolveSlotsFromEnv,
} = require("../services/communityScheduler");
const {
  noteCommunityActivity,
  resetCommunityActivityPulse,
} = require("../utils/communityActivityPulse");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-community-sched-"));
let testCounter = 0;

function stateFile() {
  testCounter += 1;
  return path.join(tempDir, `state-${testCounter}.json`);
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

async function main() {
  await runTest("parseEnabledFlag defaults false-ish", () => {
    assert.strictEqual(parseEnabledFlag(undefined), false);
    assert.strictEqual(parseEnabledFlag(""), false);
    assert.strictEqual(parseEnabledFlag("false"), false);
    assert.strictEqual(parseEnabledFlag("true"), true);
    assert.strictEqual(parseEnabledFlag("1"), true);
  });

  await runTest("disabled scheduler verstuurt niets", async () => {
    const sent = [];
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: "123",
      stateFile: stateFile(),
      activityEngineConfig: {
        enabled: false,
        twentyFourSeven: false,
        intervalMinutes: 30,
        slots: [],
        autoFightEnabled: false,
        autoFightMinGapMinutes: 120,
        autoFightMinGapMs: 120 * 60_000,
        skipRecentMs: 0,
        fightTypes: [],
      },
      autoChatFightConfig: {
        enabled: false,
        intervalMinutes: 120,
        chancePercent: 0,
        slots: [],
        types: [],
        startHour: 9,
        endHour: 22,
        minActivityGapMs: 0,
      },
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return true;
      },
      now: () => utcDate("2026-08-10T07:00:00.000Z"),
    });
    sched.setLastChecked(utcDate("2026-08-10T06:59:00.000Z"));
    const result = await sched.tick();
    assert.strictEqual(result.skipped, "disabled");
    assert.strictEqual(sent.length, 0);
  });

  await runTest("ontbrekende TELEGRAM_CHAT_ID → geen crash", async () => {
    const sent = [];
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "",
      stateFile: stateFile(),
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return true;
      },
      now: () => utcDate("2026-08-10T07:00:00.000Z"),
    });
    sched.start();
    const result = await sched.tick();
    assert.strictEqual(result.skipped, "missing-chat-id");
    assert.strictEqual(sent.length, 0);
    sched.stop();
  });

  await runTest("morning slot stuurt morning message", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "999",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return true;
      },
    });

    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["morning"]);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].chatId, "999");
    assert.ok(MESSAGE_POOLS.morning.includes(sent[0].text));
    assert.ok(!sent[0].text.includes("?t="));
    assert.ok(!sent[0].text.includes("uid="));
    assert.ok(!sent[0].text.includes("GAME_LINK_SECRET"));
  });

  await runTest("afternoon slot stuurt game message", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T11:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T12:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["afternoon"]);
    assert.ok(MESSAGE_POOLS.afternoon.includes(sent[0]));
  });

  await runTest("evening slot stuurt ranking message", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T17:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T18:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["evening"]);
    assert.ok(MESSAGE_POOLS.evening.includes(sent[0]));
  });

  await runTest("zelfde slot/dag geen duplicate", async () => {
    const sent = [];
    const file = stateFile();
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(sent.length, 1);

    sched.setLastChecked(utcDate("2026-08-10T06:59:00.000Z"));
    now = utcDate("2026-08-10T07:05:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.strictEqual(sent.length, 1);
  });

  await runTest("andere dag mag opnieuw", async () => {
    const sent = [];
    const file = stateFile();
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(sent.length, 1);

    sched.setLastChecked(utcDate("2026-08-11T06:59:00.000Z"));
    now = utcDate("2026-08-11T07:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["morning"]);
    assert.strictEqual(sent.length, 2);
  });

  await runTest("restart met persisted slot stuurt niet opnieuw", async () => {
    const file = stateFile();
    const sent1 = [];
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const first = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent1.push(text);
        return true;
      },
    });
    await first.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await first.tick();
    assert.strictEqual(sent1.length, 1);
    first.stop();

    const sent2 = [];
    now = utcDate("2026-08-10T07:30:00.000Z");
    const second = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent2.push(text);
        return true;
      },
    });
    await second.tick();
    assert.strictEqual(sent2.length, 0);
    second.setLastChecked(utcDate("2026-08-10T06:59:00.000Z"));
    now = utcDate("2026-08-10T07:31:00.000Z");
    const result = await second.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.strictEqual(sent2.length, 0);
  });

  await runTest("gemist oud slot wordt niet ingehaald", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T10:00:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    const seed = await sched.tick();
    assert.strictEqual(seed.skipped, "startup-seed");
    assert.strictEqual(sent.length, 0);
    now = utcDate("2026-08-10T10:01:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.strictEqual(sent.length, 0);
  });

  await runTest("statefile blijft valide JSON", async () => {
    const file = stateFile();
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async () => true,
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(parsed.sent["2026-08-10"].includes("morning"));
  });

  await runTest("send failure crasht bot niet", async () => {
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async () => {
        throw new Error("network down");
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.ok(!sched.getState().sent["2026-08-10"]);
  });

  await runTest("geen points.json writes", async () => {
    const pointsProbe = path.join(tempDir, "points.json");
    fs.writeFileSync(pointsProbe, '{"users":{}}\n', "utf8");
    const before = fs.readFileSync(pointsProbe, "utf8");
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async () => true,
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(fs.readFileSync(pointsProbe, "utf8"), before);
  });

  await runTest("didCrossSlot helpers", () => {
    const tz = "Europe/Amsterdam";
    const prev = getZonedClock(utcDate("2026-08-10T06:59:00.000Z"), tz);
    const now = getZonedClock(utcDate("2026-08-10T07:00:00.000Z"), tz);
    assert.strictEqual(didCrossSlot(prev, now, DEFAULT_SLOTS[0]), true);
    assert.strictEqual(didCrossSlot(prev, now, DEFAULT_SLOTS[1]), false);
    // Different local days must not catch up (22:00 UTC Aug9 = 00:00 Aug10 Amsterdam).
    assert.strictEqual(
      didCrossSlot(
        getZonedClock(utcDate("2026-08-09T21:59:00.000Z"), tz),
        getZonedClock(utcDate("2026-08-10T07:00:00.000Z"), tz),
        DEFAULT_SLOTS[0]
      ),
      false
    );
  });

  await runTest("pickMessage rotates by day/slot without secrets", () => {
    const a = pickMessage("morning", "2026-08-10");
    const b = pickMessage("morning", "2026-08-11");
    assert.ok(typeof a === "string" && a.length > 0);
    assert.ok(MESSAGE_POOLS.morning.includes(a));
    assert.ok(MESSAGE_POOLS.morning.includes(b));
    assert.ok(!a.includes("uid="));
  });

  await runTest("25. 30-minute interval slots correct", () => {
    const slots = buildIntervalSlots(30, 9, 22);
    assert.strictEqual(slots[0].id, "a0900");
    assert.strictEqual(slots[0].hour, 9);
    assert.strictEqual(slots[0].minute, 0);
    assert.strictEqual(slots[1].id, "a0930");
    assert.strictEqual(slots[slots.length - 1].id, "a2130");
    assert.ok(slots.every((s) => s.pool === "activity"));
    assert.strictEqual(slots.length, 26);
  });

  await runTest("26-27. active hours — no night send", async () => {
    const slots = buildIntervalSlots(30, 9, 22);
    const sent = [];
    let now = utcDate("2026-08-10T21:59:00.000Z"); // 23:59 Amsterdam summer
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      slots,
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T22:00:00.000Z"); // 00:00 next day Amsterdam
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.strictEqual(sent.length, 0);
  });

  await runTest("interval slot fires during active hours", async () => {
    const slots = buildIntervalSlots(30, 9, 22);
    const sent = [];
    // 06:59 UTC = 08:59 Amsterdam CEST
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      slots,
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z"); // 09:00 Amsterdam
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["a0900"]);
    assert.strictEqual(sent.length, 1);
    assert.ok(ACTIVITY_MESSAGES.includes(sent[0]));
  });

  await runTest("28. restart duplicate voorkomen (interval)", async () => {
    const slots = buildIntervalSlots(30, 9, 22);
    const file = stateFile();
    const sent1 = [];
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const first = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      slots,
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent1.push(text);
        return true;
      },
    });
    await first.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await first.tick();
    assert.strictEqual(sent1.length, 1);
    first.stop();

    const sent2 = [];
    now = utcDate("2026-08-10T07:10:00.000Z");
    const second = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      slots,
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent2.push(text);
        return true;
      },
    });
    await second.tick();
    second.setLastChecked(utcDate("2026-08-10T06:59:00.000Z"));
    now = utcDate("2026-08-10T07:15:00.000Z");
    const result = await second.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.strictEqual(sent2.length, 0);
  });

  await runTest("29-30. activity messages rotate; avoid immediate repeat", () => {
    assert.ok(ACTIVITY_MESSAGES.length >= 8);
    const a = pickMessage("a0900", "2026-08-10", {
      poolName: "activity",
    });
    const b = pickMessage("a0900", "2026-08-10", {
      poolName: "activity",
      avoidKey: a.slice(0, 80),
    });
    assert.ok(ACTIVITY_MESSAGES.includes(a));
    assert.ok(ACTIVITY_MESSAGES.includes(b));
    assert.notStrictEqual(a, b);
  });

  await runTest("31-32. recent community activity can skip then next slot ok", async () => {
    resetCommunityActivityPulse();
    const slots = buildIntervalSlots(30, 9, 22);
    const sent = [];
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      slots,
      stateFile: stateFile(),
      now: () => now,
      skipIfRecentActivityMs: 10 * 60 * 1000,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    noteCommunityActivity(now.getTime());
    now = utcDate("2026-08-10T07:00:00.000Z");
    const skipped = await sched.tick();
    assert.deepStrictEqual(skipped.fired, []);
    assert.deepStrictEqual(skipped.skippedRecent, ["a0900"]);
    assert.strictEqual(sent.length, 0);

    resetCommunityActivityPulse();
    now = utcDate("2026-08-10T07:29:00.000Z");
    await sched.tick();
    now = utcDate("2026-08-10T07:30:00.000Z");
    const next = await sched.tick();
    assert.deepStrictEqual(next.fired, ["a0930"]);
    assert.strictEqual(sent.length, 1);
  });

  await runTest("33. state blijft buiten points.json", async () => {
    const pointsProbe = path.join(tempDir, "points-interval.json");
    fs.writeFileSync(pointsProbe, '{"users":{}}\n', "utf8");
    const before = fs.readFileSync(pointsProbe, "utf8");
    const slots = buildIntervalSlots(30, 9, 22);
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const file = stateFile();
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      slots,
      stateFile: file,
      now: () => now,
      sendMessage: async () => true,
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(fs.readFileSync(pointsProbe, "utf8"), before);
    assert.ok(fs.existsSync(file));
    assert.ok(!file.includes("points.json"));
  });

  await runTest("34-35. missing chat id + disabled safe (interval mode)", async () => {
    const slots = buildIntervalSlots(30, 9, 22);
    const sent = [];
    const missing = createCommunityScheduler({
      enabled: true,
      chatId: "",
      slots,
      stateFile: stateFile(),
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
    });
    assert.strictEqual((await missing.tick()).skipped, "missing-chat-id");

    const disabled = createCommunityScheduler({
      enabled: false,
      chatId: "1",
      slots,
      stateFile: stateFile(),
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
    });
    assert.strictEqual((await disabled.tick()).skipped, "disabled");
    assert.strictEqual(sent.length, 0);
  });

  await runTest("resolveSlotsFromEnv backward compatible", () => {
    const prev = process.env.COMMUNITY_ACTIVITY_INTERVAL_MINUTES;
    delete process.env.COMMUNITY_ACTIVITY_INTERVAL_MINUTES;
    assert.strictEqual(resolveSlotsFromEnv(), DEFAULT_SLOTS);
    process.env.COMMUNITY_ACTIVITY_INTERVAL_MINUTES = "30";
    const interval = resolveSlotsFromEnv();
    assert.ok(interval.length > 3);
    assert.strictEqual(interval[0].pool, "activity");
    if (prev === undefined) {
      delete process.env.COMMUNITY_ACTIVITY_INTERVAL_MINUTES;
    } else {
      process.env.COMMUNITY_ACTIVITY_INTERVAL_MINUTES = prev;
    }
  });

  await runTest("PROD BUG: 18:12 seed → 18:31 processes 18:30 once", async () => {
    const {
      parseActivityEngineConfig,
    } = require("../services/communityActivityEngine");
    const {
      createChatFightService,
      CHAT_FIGHT_COOLDOWN_MS,
    } = require("../services/chatFight");
    const file = stateFile();
    const sent = [];
    const announced = [];
    // 18:12 / 18:31 Europe/Amsterdam (CEST = UTC+2)
    let now = utcDate("2026-08-12T16:12:00.000Z");
    const cfg = parseActivityEngineConfig(
      {
        COMMUNITY_ACTIVITY_ENGINE_ENABLED: "true",
        COMMUNITY_ACTIVITY_24_7: "true",
        COMMUNITY_ACTIVITY_INTERVAL_MINUTES: "30",
        AUTO_CHATFIGHT_ENABLED: "true",
        TELEGRAM_CHAT_ID: "-1003916996602",
      },
      {}
    );
    const service = createChatFightService({
      random: () => 0,
      durationMs: 60_000,
      revealWaitMs: 300_000,
      cooldownMs: CHAT_FIGHT_COOLDOWN_MS,
    });
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: "-1003916996602",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      activityEngineConfig: cfg,
      autoChatFightConfig: {
        enabled: true,
        intervalMinutes: 30,
        chancePercent: 100,
        slots: cfg.slots,
        types: cfg.fightTypes,
        startHour: 0,
        endHour: 24,
        minActivityGapMs: 0,
      },
      chatFight: service,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
      announceChatFight: async (_c, teaser) => {
        announced.push(teaser);
        return { message_id: 99 };
      },
      // Prefer prompt action so we don't depend on fight start.
      activityRandom: () => 0.4,
    });

    const seed = await sched.tick();
    assert.strictEqual(seed.skipped, "startup-seed");
    assert.ok(fs.existsSync(file), "state file must exist after startup seed");

    now = utcDate("2026-08-12T16:31:00.000Z");
    const result = await sched.tick();
    assert.ok(result.activity && result.activity.enabled);
    assert.strictEqual(result.activity.results.length, 1);
    assert.strictEqual(result.activity.results[0].slot, "act1830");
    assert.ok(
      result.activity.results[0].sent === true ||
        result.activity.results[0].reason === "skip" ||
        result.activity.results[0].fallback,
      "slot must send, skip, or fallback explicitly"
    );
    const st = sched.getState();
    assert.ok(st.sent["2026-08-12"].includes("act1830"));
    assert.ok(String(st.lastProcessedActivitySlot).includes("18:30"));
    assert.ok(fs.existsSync(file));

    // Same slot must not fire twice.
    now = utcDate("2026-08-12T16:32:00.000Z");
    const again = await sched.tick();
    const dup = (again.activity.results || []).filter((r) => r.slot === "act1830");
    assert.ok(dup.every((r) => r.reason === "already-processed" || !r.sent));
    sched.stop();
  });

  await runTest("engine-only: reminders+auto off still processes slot", async () => {
    const {
      parseActivityEngineConfig,
    } = require("../services/communityActivityEngine");
    const {
      createChatFightService,
      CHAT_FIGHT_COOLDOWN_MS,
    } = require("../services/chatFight");
    const file = stateFile();
    const sent = [];
    let now = utcDate("2026-08-12T16:12:00.000Z");
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        intervalMinutes: 30,
        autoFightEnabled: false,
      }
    );
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      activityEngineConfig: cfg,
      autoChatFightConfig: {
        enabled: false,
        intervalMinutes: 120,
        chancePercent: 0,
        slots: [],
        types: [],
        startHour: 9,
        endHour: 22,
        minActivityGapMs: 0,
      },
      chatFight: createChatFightService({
        random: () => 0,
        durationMs: 60_000,
        revealWaitMs: 300_000,
        cooldownMs: CHAT_FIGHT_COOLDOWN_MS,
      }),
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      activityRandom: () => 0.5,
    });
    await sched.tick();
    now = utcDate("2026-08-12T16:31:00.000Z");
    const result = await sched.tick();
    assert.strictEqual(result.activity.results.length, 1);
    assert.strictEqual(result.activity.results[0].slot, "act1830");
    assert.ok(sent.length === 1 || result.activity.results[0].reason === "skip");
    sched.stop();
  });

  await runTest("start() schedules timer when activity engine only", async () => {
    const {
      parseActivityEngineConfig,
    } = require("../services/communityActivityEngine");
    const { DEFAULT_TICK_MS: tickDefault } = require("../services/communityScheduler");
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        intervalMinutes: 30,
        autoFightEnabled: false,
      }
    );
    const scheduled = [];
    let cleared = 0;
    let now = utcDate("2026-08-12T16:12:00.000Z");
    const file = stateFile();
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      tickMs: tickDefault,
      now: () => now,
      activityEngineConfig: cfg,
      autoChatFightConfig: {
        enabled: false,
        intervalMinutes: 120,
        chancePercent: 0,
        slots: [],
        types: [],
        startHour: 9,
        endHour: 22,
        minActivityGapMs: 0,
      },
      sendMessage: async () => true,
      setIntervalFn: (fn, ms) => {
        scheduled.push({ fn, ms });
        return { unref() {}, id: scheduled.length };
      },
      clearIntervalFn: () => {
        cleared += 1;
      },
    });
    sched.start();
    assert.strictEqual(scheduled.length, 1);
    assert.strictEqual(scheduled[0].ms, 60_000);
    assert.strictEqual(sched.isTimerRunning(), true);
    assert.ok(fs.existsSync(file));
    // Let the immediate post-start tick finish while still at 18:12.
    await Promise.resolve();
    await Promise.resolve();

    now = utcDate("2026-08-12T16:31:00.000Z");
    await scheduled[0].fn();
    const st = sched.getState();
    assert.ok(st.sent["2026-08-12"] && st.sent["2026-08-12"].includes("act1830"));

    sched.stop();
    assert.strictEqual(cleared, 1);
    assert.strictEqual(sched.isTimerRunning(), false);
  });

  await runTest("engine ON suppresses legacy reminder + standalone auto", async () => {
    const {
      parseActivityEngineConfig,
    } = require("../services/communityActivityEngine");
    const {
      createChatFightService,
      CHAT_FIGHT_COOLDOWN_MS,
      FIGHT_TYPES,
    } = require("../services/chatFight");
    const file = stateFile();
    const sent = [];
    const announced = [];
    let now = utcDate("2026-08-12T16:12:00.000Z");
    const cfg = parseActivityEngineConfig(
      {},
      {
        enabled: true,
        twentyFourSeven: true,
        intervalMinutes: 30,
        autoFightEnabled: true,
      }
    );
    const legacySlots = [
      { id: "evening", hour: 18, minute: 30, pool: "evening" },
    ];
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      slots: legacySlots,
      stateFile: file,
      now: () => now,
      activityEngineConfig: cfg,
      autoChatFightConfig: {
        enabled: true,
        intervalMinutes: 30,
        chancePercent: 100,
        slots: [{ id: "acf1830", hour: 18, minute: 30 }],
        types: [FIGHT_TYPES.TYPE_RUSH],
        startHour: 0,
        endHour: 24,
        minActivityGapMs: 0,
      },
      chatFight: createChatFightService({
        random: () => 0,
        durationMs: 60_000,
        revealWaitMs: 300_000,
        cooldownMs: CHAT_FIGHT_COOLDOWN_MS,
      }),
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
      announceChatFight: async (_c, t) => {
        announced.push(t);
        return { message_id: 1 };
      },
      activityRandom: () => 0.5,
      autoChatFightRandom: () => 0,
    });
    await sched.tick();
    now = utcDate("2026-08-12T16:31:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.ok(result.autoFight.deferredToEngine);
    assert.strictEqual(result.activity.results.length, 1);
    // At most one outbound action from engine path.
    assert.ok(sent.length + announced.length <= 1);
    sched.stop();
  });

  await runTest("engine OFF + legacy reminders ON still works", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      slots: DEFAULT_SLOTS,
      stateFile: stateFile(),
      now: () => now,
      activityEngineConfig: {
        enabled: false,
        twentyFourSeven: false,
        intervalMinutes: 30,
        slots: [],
        autoFightEnabled: false,
        autoFightMinGapMinutes: 120,
        autoFightMinGapMs: 0,
        skipRecentMs: 0,
        fightTypes: [],
      },
      autoChatFightConfig: {
        enabled: false,
        intervalMinutes: 120,
        chancePercent: 0,
        slots: [],
        types: [],
        startHour: 9,
        endHour: 22,
        minActivityGapMs: 0,
      },
      sendMessage: async (_c, t) => {
        sent.push(t);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["morning"]);
    assert.strictEqual(sent.length, 1);
    sched.stop();
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll community-scheduler tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
