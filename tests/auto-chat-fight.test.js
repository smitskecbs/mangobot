/**
 * Auto ChatFight — config, slots, shared runtime, reveal, failures.
 * Run: node tests/auto-chat-fight.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const {
  createChatFightService,
  FIGHT_TYPES,
  ALL_FIGHT_TYPES,
  CHAT_FIGHT_XP,
  CHAT_FIGHT_COOLDOWN_MS,
  REVEAL_CALLBACK_DATA,
  selectFightType,
} = require("../services/chatFight");
const {
  parseAutoEnabledFlag,
  parseChancePercent,
  parseAutoFightTypes,
  parseAutoChatFightConfig,
  buildAutoChatFightSlots,
  tryStartAutoChatFight,
  emptyAutoChatFightState,
  nextAutoSlotLabel,
  formatTypeLabel,
} = require("../services/autoChatFight");
const {
  createCommunityScheduler,
  getZonedClock,
} = require("../services/communityScheduler");
const { handleChatFight } = require("../commands/chatfight");
const { handleChatFightStatus } = require("../commands/chatfightstatus");
const {
  awardChatFightXp,
  awardDailyActivityPoint,
  loadPoints,
  savePoints,
} = require("../services/points");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-auto-cf-"));
let testCounter = 0;
const COMMUNITY_CHAT = "-1001234567890";
const ADMIN_ID = 424242;
const USER_A = 111;

const originalEnv = { ...process.env };

function pointsFile() {
  testCounter += 1;
  return path.join(tempDir, `points-${testCounter}.json`);
}

function stateFile() {
  testCounter += 1;
  return path.join(tempDir, `state-${testCounter}.json`);
}

function resetEnv() {
  process.env.TELEGRAM_CHAT_ID = COMMUNITY_CHAT;
  process.env.ADMIN_USER_ID = String(ADMIN_ID);
  delete process.env.AUTO_CHATFIGHT_ENABLED;
  delete process.env.AUTO_CHATFIGHT_INTERVAL_MINUTES;
  delete process.env.AUTO_CHATFIGHT_MIN_ACTIVITY_GAP_MINUTES;
  delete process.env.AUTO_CHATFIGHT_CHANCE_PERCENT;
  delete process.env.AUTO_CHATFIGHT_TYPES;
  delete process.env.COMMUNITY_AUTO_MESSAGES_ENABLED;
  process.env.COMMUNITY_TIMEZONE = "Europe/Amsterdam";
  process.env.COMMUNITY_ACTIVE_START_HOUR = "9";
  process.env.COMMUNITY_ACTIVE_END_HOUR = "22";
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
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

function utcDate(iso) {
  return new Date(iso);
}

function createFakeTimers() {
  let nowMs = 1_700_000_000_000;
  const timers = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    setNow(ms) {
      nowMs = ms;
    },
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

function createService(overrides = {}) {
  const clock = createFakeTimers();
  const service = createChatFightService({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: overrides.random || (() => 0),
    durationMs: overrides.durationMs || 60_000,
    revealWaitMs: overrides.revealWaitMs || 300_000,
    cooldownMs: overrides.cooldownMs || CHAT_FIGHT_COOLDOWN_MS,
    ...overrides,
  });
  return { service, clock };
}

resetEnv();

async function main() {
  // --- Config ---
  await runTest("1. AUTO_CHATFIGHT_ENABLED default false", async () => {
    assert.strictEqual(parseAutoEnabledFlag(undefined), false);
    assert.strictEqual(parseAutoChatFightConfig({}).enabled, false);
  });

  await runTest("2. true parsed correct", async () => {
    assert.strictEqual(parseAutoEnabledFlag("true"), true);
    assert.strictEqual(parseAutoEnabledFlag("1"), true);
    assert.strictEqual(
      parseAutoChatFightConfig({ AUTO_CHATFIGHT_ENABLED: "yes" }).enabled,
      true
    );
  });

  await runTest("3. invalid interval fallback", async () => {
    const cfg = parseAutoChatFightConfig({
      AUTO_CHATFIGHT_INTERVAL_MINUTES: "nope",
    });
    assert.strictEqual(cfg.intervalMinutes, 120);
  });

  await runTest("4. interval 30 accepted", async () => {
    const cfg = parseAutoChatFightConfig({
      AUTO_CHATFIGHT_INTERVAL_MINUTES: "30",
    });
    assert.strictEqual(cfg.intervalMinutes, 30);
  });

  await runTest("5-7. chance 0 / 100 / clamp", async () => {
    assert.strictEqual(parseChancePercent("0"), 0);
    assert.strictEqual(parseChancePercent("100"), 100);
    assert.strictEqual(parseChancePercent("-5"), 0);
    assert.strictEqual(parseChancePercent("150"), 100);
    assert.strictEqual(parseChancePercent("x"), 100);
  });

  await runTest("8-10. type parsing", async () => {
    assert.deepStrictEqual(parseAutoFightTypes(""), [...ALL_FIGHT_TYPES]);
    assert.deepStrictEqual(parseAutoFightTypes("math,emoji"), [
      FIGHT_TYPES.MATH_RUSH,
      FIGHT_TYPES.EMOJI_GUESS,
    ]);
    assert.deepStrictEqual(parseAutoFightTypes("bogus,xyz"), [
      ...ALL_FIGHT_TYPES,
    ]);
    assert.deepStrictEqual(parseAutoFightTypes("type,bogus,math"), [
      FIGHT_TYPES.TYPE_RUSH,
      FIGHT_TYPES.MATH_RUSH,
    ]);
  });

  // --- Scheduling ---
  await runTest("11. disabled → no start", async () => {
    const { service } = createService();
    const announcements = [];
    const autoState = emptyAutoChatFightState();
    const cfg = parseAutoChatFightConfig({}, { enabled: false });
    const result = await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: cfg.slots[0],
      dayKey: "2026-08-11",
      config: cfg,
      autoState,
      chatFight: service,
      announce: async (...a) => {
        announcements.push(a);
        return { message_id: 1 };
      },
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.strictEqual(result.started, false);
    assert.strictEqual(result.reason, "disabled");
    assert.strictEqual(announcements.length, 0);
    assert.strictEqual(service.isFightOpen(), false);
  });

  await runTest("12. missing TELEGRAM chat → no start", async () => {
    const { service } = createService();
    const autoState = emptyAutoChatFightState();
    const cfg = parseAutoChatFightConfig({}, { enabled: true });
    const result = await tryStartAutoChatFight({
      chatId: "",
      slot: cfg.slots[0],
      dayKey: "2026-08-11",
      config: cfg,
      autoState,
      chatFight: service,
      announce: async () => ({ message_id: 1 }),
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.strictEqual(result.started, false);
    assert.strictEqual(result.reason, "missing-chat-id");
  });

  await runTest("13. outside active hours → no slots", async () => {
    const slots = buildAutoChatFightSlots(120, 9, 22);
    assert.ok(slots.every((s) => s.hour >= 9 && s.hour < 22));
    assert.ok(!slots.some((s) => s.hour === 23));
    assert.ok(!slots.some((s) => s.hour < 9));
  });

  await runTest("14-16. eligible slot starts; same slot no duplicate; restart", async () => {
    const file = stateFile();
    const { service } = createService({ random: () => 0 });
    const announcements = [];
    let now = utcDate("2026-08-10T06:59:00.000Z"); // 08:59 Amsterdam CEST
    const cfg = parseAutoChatFightConfig(
      {},
      { enabled: true, intervalMinutes: 120, chancePercent: 100, minGapMinutes: 1 }
    );

    const sched = createCommunityScheduler({
      enabled: false,
      chatId: COMMUNITY_CHAT,
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      autoChatFightConfig: cfg,
      chatFight: service,
      announceChatFight: async (chatId, teaser, kb) => {
        announcements.push({ chatId, teaser, kb });
        return { message_id: 42 };
      },
      autoChatFightRandom: () => 0,
    });

    await sched.tick(); // seed
    now = utcDate("2026-08-10T07:00:00.000Z"); // 09:00
    const first = await sched.tick();
    assert.ok(first.autoFight.started.includes("acf0900"));
    assert.strictEqual(announcements.length, 1);
    assert.ok(announcements[0].teaser.includes("A new challenge is ready"));
    assert.ok(!announcements[0].teaser.includes("MANGO"));
    assert.ok(service.isFightOpen());
    assert.strictEqual(service.getFightSnapshot().source, "auto");

    // Same slot again (simulate restart crossing)
    const service2 = createService({ random: () => 0 }).service;
    now = utcDate("2026-08-10T07:10:00.000Z");
    const sched2 = createCommunityScheduler({
      enabled: false,
      chatId: COMMUNITY_CHAT,
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      autoChatFightConfig: cfg,
      chatFight: service2,
      announceChatFight: async () => {
        announcements.push("dup");
        return { message_id: 99 };
      },
      autoChatFightRandom: () => 0,
    });
    await sched2.tick();
    sched2.setLastChecked(utcDate("2026-08-10T06:59:00.000Z"));
    now = utcDate("2026-08-10T07:15:00.000Z");
    const again = await sched2.tick();
    assert.deepStrictEqual(again.autoFight.started, []);
    assert.ok(!announcements.includes("dup"));
    sched.stop();
    sched2.stop();
  });

  await runTest("17. missed old slot no catch-up", async () => {
    const { service } = createService();
    const announcements = [];
    const cfg = parseAutoChatFightConfig(
      {},
      { enabled: true, intervalMinutes: 120, chancePercent: 100 }
    );
    let now = utcDate("2026-08-10T10:00:00.000Z"); // 12:00 Amsterdam — missed 09:00+11:00
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: COMMUNITY_CHAT,
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      autoChatFightConfig: cfg,
      chatFight: service,
      announceChatFight: async () => {
        announcements.push(1);
        return { message_id: 1 };
      },
      autoChatFightRandom: () => 0,
    });
    await sched.tick();
    now = utcDate("2026-08-10T10:01:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.autoFight.started, []);
    assert.strictEqual(announcements.length, 0);
    sched.stop();
  });

  await runTest("18. next slot works after prior", async () => {
    const file = stateFile();
    const { service, clock } = createService({ random: () => 0 });
    const announcements = [];
    const cfg = parseAutoChatFightConfig(
      {},
      {
        enabled: true,
        intervalMinutes: 120,
        chancePercent: 100,
        minGapMinutes: 1,
      }
    );
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: COMMUNITY_CHAT,
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      autoChatFightConfig: cfg,
      chatFight: service,
      announceChatFight: async (_c, t) => {
        announcements.push(t);
        return { message_id: announcements.length };
      },
      autoChatFightRandom: () => 0,
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(announcements.length, 1);
    // Complete fight + cooldown
    service.forceTimeout();
    clock.advance(CHAT_FIGHT_COOLDOWN_MS);
    service.setLastStartedAt(null);
    // Also clear auto min-gap by advancing wall clock far
    now = utcDate("2026-08-10T08:59:00.000Z");
    await sched.tick();
    // Clear shared cooldown by resetting service last start after timeout already set it
    service.reset();
    now = utcDate("2026-08-10T09:00:00.000Z"); // 11:00 Amsterdam
    const second = await sched.tick();
    assert.ok(second.autoFight.started.includes("acf1100"));
    assert.strictEqual(announcements.length, 2);
    sched.stop();
  });

  await runTest("19-20. 30-min and 120-min slot math", async () => {
    const s30 = buildAutoChatFightSlots(30, 9, 22);
    assert.strictEqual(s30[0].label, "09:00");
    assert.strictEqual(s30[1].label, "09:30");
    assert.strictEqual(s30[s30.length - 1].label, "21:30");
    const s120 = buildAutoChatFightSlots(120, 9, 22);
    assert.deepStrictEqual(
      s120.map((s) => s.label),
      ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"]
    );
  });

  // --- Shared runtime ---
  await runTest("21-25. shared state blocks manual/auto both ways", async () => {
    const { service } = createService({ random: () => 0 });
    const cfg = parseAutoChatFightConfig(
      {},
      { enabled: true, chancePercent: 100, minGapMinutes: 0 }
    );
    const autoState = emptyAutoChatFightState();

    // Manual starts first
    const manual = service.startFight({
      chatId: COMMUNITY_CHAT,
      type: FIGHT_TYPES.TYPE_RUSH,
      source: "manual",
    });
    assert.ok(manual.ok);

    const blocked = await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: { id: "acf0900", label: "09:00", hour: 9, minute: 0 },
      dayKey: "2026-08-11",
      config: cfg,
      autoState,
      chatFight: service,
      announce: async () => ({ message_id: 1 }),
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.strictEqual(blocked.reason, "active-fight");

    service.forceTimeout();
    service.setLastStartedAt(service.getFightSnapshot().startedAt);
    // still on cooldown from manual
    assert.ok(service.isOnCooldown());

    const autoState2 = emptyAutoChatFightState();
    const cooldownBlock = await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: { id: "acf1100", label: "11:00", hour: 11, minute: 0 },
      dayKey: "2026-08-11",
      config: cfg,
      autoState: autoState2,
      chatFight: service,
      announce: async () => ({ message_id: 2 }),
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.strictEqual(cooldownBlock.reason, "cooldown");

    service.reset();
    // Auto then blocks manual
    const autoState3 = emptyAutoChatFightState();
    const autoOk = await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: { id: "acf1300", label: "13:00", hour: 13, minute: 0 },
      dayKey: "2026-08-11",
      config: cfg,
      autoState: autoState3,
      chatFight: service,
      announce: async () => ({ message_id: 3 }),
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.ok(autoOk.started);
    const manualBlocked = service.startFight({
      chatId: COMMUNITY_CHAT,
      type: FIGHT_TYPES.MATH_RUSH,
    });
    assert.strictEqual(manualBlocked.reason, "already-active");
  });

  // --- Type rotation ---
  await runTest("26-28. type selection / no immediate repeat", async () => {
    const picked = selectFightType(
      [FIGHT_TYPES.TYPE_RUSH, FIGHT_TYPES.MATH_RUSH],
      FIGHT_TYPES.TYPE_RUSH,
      () => 0
    );
    assert.strictEqual(picked, FIGHT_TYPES.MATH_RUSH);
    const only = selectFightType(
      [FIGHT_TYPES.EMOJI_GUESS],
      FIGHT_TYPES.EMOJI_GUESS,
      () => 0
    );
    assert.strictEqual(only, FIGHT_TYPES.EMOJI_GUESS);
    assert.ok(ALL_FIGHT_TYPES.includes(selectFightType(null, null, () => 0.5)));
  });

  // --- Reveal + XP ---
  await runTest("29-38. auto reveal flow + XP", async () => {
    const file = pointsFile();
    const { service } = createService({ random: () => 0 });
    const cfg = parseAutoChatFightConfig(
      {},
      { enabled: true, chancePercent: 100, minGapMinutes: 0, types: [FIGHT_TYPES.TYPE_RUSH] }
    );
    const autoState = emptyAutoChatFightState();
    let teaser = "";
    let keyboard = null;
    await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: { id: "acf0900", label: "09:00", hour: 9, minute: 0 },
      dayKey: "2026-08-11",
      config: cfg,
      autoState,
      chatFight: service,
      announce: async (_c, t, kb) => {
        teaser = t;
        keyboard = kb;
        return { message_id: 7 };
      },
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.ok(teaser.includes("A new challenge is ready"));
    assert.ok(!teaser.includes("Type this exactly"));
    assert.ok(!teaser.includes("MANGO"));
    const btn = keyboard.reply_markup.inline_keyboard[0][0];
    assert.strictEqual(btn.callback_data, REVEAL_CALLBACK_DATA);
    assert.ok(!JSON.stringify(btn).toLowerCase().includes("mango"));

    const pre = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
    assert.strictEqual(pre.claimed, false);

    const revealed = service.revealFight(COMMUNITY_CHAT);
    assert.ok(revealed.ok);
    assert.ok(revealed.prompt.includes("TYPE RUSH"));

    const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "mango");
    assert.ok(claim.claimed);
    assert.strictEqual(claim.pointsToAdd, CHAT_FIGHT_XP);

    const award = await awardChatFightXp(USER_A, "Player", file);
    assert.strictEqual(award.awarded, true);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 2);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].weeklyPoints, 2);

    const second = service.tryClaimWinner(999, COMMUNITY_CHAT, "MANGO");
    assert.strictEqual(second.claimed, false);

    const activity = await awardDailyActivityPoint(USER_A, "Player", file);
    assert.strictEqual(activity.awarded, true);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 3);
  });

  // --- Failure ---
  await runTest("39-42. send failure rollback", async () => {
    const { service } = createService({ random: () => 0 });
    const cfg = parseAutoChatFightConfig(
      {},
      { enabled: true, chancePercent: 100, minGapMinutes: 0 }
    );
    const autoState = emptyAutoChatFightState();
    const result = await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: { id: "acf0900", label: "09:00", hour: 9, minute: 0 },
      dayKey: "2026-08-11",
      config: cfg,
      autoState,
      chatFight: service,
      announce: async () => {
        throw new Error("network");
      },
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.strictEqual(result.reason, "send-failed");
    assert.strictEqual(service.isFightOpen(), false);
    assert.strictEqual(service.isOnCooldown(), false);
    assert.ok(autoState.processedSlots["2026-08-11"].includes("acf0900"));

    // Retry same slot blocked
    const retry = await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: { id: "acf0900", label: "09:00", hour: 9, minute: 0 },
      dayKey: "2026-08-11",
      config: cfg,
      autoState,
      chatFight: service,
      announce: async () => ({ message_id: 1 }),
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.strictEqual(retry.reason, "already-processed");
  });

  // --- Chance ---
  await runTest("43-45. chance fail processed; next slot can start", async () => {
    const { service } = createService({ random: () => 0 });
    const cfg = parseAutoChatFightConfig(
      {},
      { enabled: true, chancePercent: 0, minGapMinutes: 0 }
    );
    const autoState = emptyAutoChatFightState();
    const fail = await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: { id: "acf0900", label: "09:00", hour: 9, minute: 0 },
      dayKey: "2026-08-11",
      config: cfg,
      autoState,
      chatFight: service,
      announce: async () => ({ message_id: 1 }),
      nowMs: Date.now(),
      random: () => 0.5,
    });
    assert.strictEqual(fail.reason, "chance");
    assert.ok(autoState.processedSlots["2026-08-11"].includes("acf0900"));

    const cfg2 = { ...cfg, chancePercent: 100 };
    const next = await tryStartAutoChatFight({
      chatId: COMMUNITY_CHAT,
      slot: { id: "acf1100", label: "11:00", hour: 11, minute: 0 },
      dayKey: "2026-08-11",
      config: cfg2,
      autoState,
      chatFight: service,
      announce: async () => ({ message_id: 2 }),
      nowMs: Date.now(),
      random: () => 0,
    });
    assert.ok(next.started);
  });

  // --- Status ---
  await runTest("46-49. /chatfightstatus admin", async () => {
    const { service } = createService();
    const replies = [];
    const adminCtx = {
      chat: { type: "private", id: ADMIN_ID },
      from: { id: ADMIN_ID, first_name: "Admin" },
      reply(t) {
        replies.push(t);
        return Promise.resolve();
      },
    };
    await handleChatFightStatus(adminCtx, {
      isAdminFn: (id) => String(id) === String(ADMIN_ID),
      getRuntimeStatusFn: () => service.getRuntimeStatus(),
      autoConfig: parseAutoChatFightConfig(
        {},
        { enabled: true, intervalMinutes: 120 }
      ),
      now: () => utcDate("2026-08-10T08:00:00.000Z"), // 10:00 Amsterdam
    });
    assert.ok(replies[0].includes("Auto enabled: yes"));
    assert.ok(replies[0].includes("120 min"));
    assert.ok(replies[0].includes("Current fight: none"));
    assert.ok(!replies[0].toLowerCase().includes("acceptedanswers"));
    assert.ok(!replies[0].includes("MANGO"));

    const denied = [];
    await handleChatFightStatus(
      {
        chat: { type: "supergroup", id: COMMUNITY_CHAT },
        from: { id: USER_A },
        telegram: {
          getChatMember: async () => ({ status: "member" }),
        },
        reply(t) {
          denied.push(t);
          return Promise.resolve();
        },
      },
      {
        isAdminFn: () => false,
      }
    );
    assert.ok(denied[0].includes("admin only"));
  });

  // --- Regression ---
  await runTest("50-52. manual /chatfight still works", async () => {
    resetEnv();
    const { service } = createService({ random: () => 0 });
    const replies = [];
    const replyExtras = [];
    const ctx = {
      chat: { type: "supergroup", id: Number(COMMUNITY_CHAT) },
      from: { id: ADMIN_ID, first_name: "Admin" },
      message: { text: "/chatfight type" },
      telegram: {
        getChatMember: async () => ({ status: "member" }),
        sendMessage: async () => {},
      },
      reply(msg, extra) {
        replies.push(msg);
        replyExtras.push(extra);
        return Promise.resolve({ message_id: 1 });
      },
    };
    await handleChatFight(ctx, {
      startFightFn: (p) => service.startFight(p),
      isAdminFn: () => true,
      setFightMessageIdFn: (id) => service.setFightMessageId(id),
    });
    assert.ok(replies[0].includes("A new challenge is ready"));
    assert.strictEqual(service.getFightSnapshot().source, "manual");
  });

  await runTest("55-57. reminders unchanged + state outside points", async () => {
    const pointsProbe = path.join(tempDir, "points-probe.json");
    fs.writeFileSync(pointsProbe, '{"users":{}}\n', "utf8");
    const before = fs.readFileSync(pointsProbe, "utf8");
    const sent = [];
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const file = stateFile();
    const winnersProbe = path.join(tempDir, "winners-probe.json");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      pointsFile: pointsProbe,
      weeklyWinnersFile: winnersProbe,
      activityEngineConfig: { enabled: false, slots: [] },
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
      autoChatFightConfig: parseAutoChatFightConfig({}, { enabled: false }),
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(fs.readFileSync(pointsProbe, "utf8"), before);
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(st.autoChatFight);
    assert.ok(!file.includes("points"));
    sched.stop();
  });

  await runTest("nextAutoSlotLabel helper", async () => {
    const cfg = parseAutoChatFightConfig(
      {},
      { enabled: true, intervalMinutes: 120 }
    );
    const clock = getZonedClock(utcDate("2026-08-10T08:00:00.000Z"), "Europe/Amsterdam");
    // 10:00 Amsterdam
    assert.strictEqual(nextAutoSlotLabel(cfg, clock), "11:00");
    assert.ok(formatTypeLabel(FIGHT_TYPES.MATH_RUSH) === "math");
  });

  restoreEnv();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll auto-chat-fight tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
