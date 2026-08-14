/**
 * Automatic community messages to TELEGRAM_CHAT_ID (group only).
 *
 * Modes:
 * - Legacy: morning/afternoon/evening slots (default when interval unset)
 * - Interval: every N minutes during active hours when
 *   COMMUNITY_ACTIVITY_INTERVAL_MINUTES is set (e.g. 30)
 *
 * Disabled unless COMMUNITY_AUTO_MESSAGES_ENABLED=true.
 * Never catch up missed slots after restart.
 * Persists in data/community-scheduler.json (not points.json).
 */

const fs = require("fs");
const path = require("path");
const { writeJsonFileAtomic } = require("../utils/json");
const { log, error: logError } = require("../utils/logger");
const {
  wasActiveWithin,
} = require("../utils/communityActivityPulse");
const {
  parseAutoChatFightConfig,
  normalizeAutoChatFightState,
  emptyAutoChatFightState,
  pruneAutoProcessedSlots,
  tryStartAutoChatFight,
} = require("./autoChatFight");
const {
  parseActivityEngineConfig,
  processCommunityActivitySlot,
  nextActivitySlotLabel,
} = require("./communityActivityEngine");
const { chatFightRuntime } = require("./chatFight");
const {
  processWeeklyWinnersBoundary,
} = require("./weeklyWinners");

/**
 * Absolute path to production scheduler state.
 * Deterministic from this module's location (not process.cwd()).
 */
function resolveDefaultStateFile() {
  return path.resolve(__dirname, "..", "data", "community-scheduler.json");
}

const DEFAULT_STATE_FILE = resolveDefaultStateFile();

const DEFAULT_TIMEZONE = "Europe/Amsterdam";
const DEFAULT_TICK_MS = 60_000;
const DEFAULT_ACTIVE_START_HOUR = 9;
const DEFAULT_ACTIVE_END_HOUR = 22;

/** Local wall-clock slots in COMMUNITY_TIMEZONE (default Europe/Amsterdam). */
const DEFAULT_SLOTS = Object.freeze([
  Object.freeze({ id: "morning", hour: 9, minute: 0, pool: "morning" }),
  Object.freeze({ id: "afternoon", hour: 14, minute: 0, pool: "afternoon" }),
  Object.freeze({ id: "evening", hour: 20, minute: 0, pool: "evening" }),
]);

const ACTIVITY_MESSAGES = Object.freeze([
  `🎮 Quick ManGo mission

Play one verified game today:

🐍 Snake
🏀 Bounch

Use /menu to play and earn XP.`,
  `🏆 Check the race

See who's leading this week with /weekly.

Can you climb a spot today?`,
  `🥭 Community XP

Your first real message today earns XP.

Join the conversation and keep ManGo active.`,
  `🥭 Remember:

GM / GMango / GN / GNango can earn daily XP.

Check /points to see what you still have available.`,
  `⚔️ Ready for a ChatFight?

An admin can start /chatfight or watch for the next community challenge.`,
  `🏆 ManGo challenge

Can you improve your Snake or Bounch score today?

Open /menu and give it a try.`,
  `🌱 Keep growing

Drop a real message in the chat for daily activity XP.

Then check /leaderboard to see the ManGo trees.`,
  `🏀 Bounce into XP

Clear a Bounch level with your personal profile.

Start from /menu → Bounch.`,
  `🐍 Snake warm-up

One verified Snake run can earn daily game XP.

Open /menu → Snake and play with your profile.`,
  `📅 Weekly climb

Who is on top this week?

Use /weekly — then send a message or play a game to catch up.`,
  `🥭 ManGo check-in

Stay active in the community.

Message · Games · ChatFight — small actions, real XP.`,
  `🔥 Momentum

A short message now can claim today's community XP.

Then try /menu for Snake or Bounch.`,
]);

const MESSAGE_POOLS = Object.freeze({
  morning: Object.freeze([
    `🥭 GM ManGo!
Your first real message of the day earns XP.
GM / GMango can earn extra points too.
Use /points to check your progress.`,
    `☀️ Morning ManGo!
Drop into the chat and claim your daily activity XP.
Then check /menu for rankings and games.`,
  ]),
  afternoon: Object.freeze([
    `🎮 Daily game XP is waiting.
🐍 Snake
🏀 Bounch
Open /menu and play with your personal profile.`,
    `🏀 Midday ManGo challenge!
Play Snake or Bounch with your profile for verified XP.
Start from /menu → Snake or Bounch.`,
  ]),
  evening: Object.freeze([
    `🏆 How did you do today?
Check /weekly and see who is leading the ManGo community.`,
    `🌙 Evening wrap-up
Who climbed the board today?
Use /weekly and /leaderboard — or open /menu.`,
  ]),
  activity: ACTIVITY_MESSAGES,
});

function parseEnabledFlag(raw) {
  if (typeof raw !== "string") {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseHour(raw, fallback) {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) {
    return fallback;
  }
  return n;
}

/**
 * Build interval slots for active hours [startHour, endHour).
 * @param {number} intervalMinutes
 * @param {number} startHour
 * @param {number} endHour
 */
function buildIntervalSlots(intervalMinutes, startHour, endHour) {
  const slots = [];
  if (!intervalMinutes || intervalMinutes <= 0) {
    return slots;
  }
  const start = startHour * 60;
  const end = endHour * 60;
  if (end <= start) {
    return slots;
  }
  for (let m = start; m < end; m += intervalMinutes) {
    const hour = Math.floor(m / 60);
    const minute = m % 60;
    const id = `a${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
    slots.push(
      Object.freeze({ id, hour, minute, pool: "activity" })
    );
  }
  return Object.freeze(slots);
}

function resolveSlotsFromEnv() {
  const interval = parsePositiveInt(
    process.env.COMMUNITY_ACTIVITY_INTERVAL_MINUTES,
    0
  );
  if (!interval) {
    return DEFAULT_SLOTS;
  }
  const startHour = parseHour(
    process.env.COMMUNITY_ACTIVE_START_HOUR,
    DEFAULT_ACTIVE_START_HOUR
  );
  const endHour = parseHour(
    process.env.COMMUNITY_ACTIVE_END_HOUR,
    DEFAULT_ACTIVE_END_HOUR
  );
  const built = buildIntervalSlots(interval, startHour, endHour);
  return built.length ? built : DEFAULT_SLOTS;
}

function emptyState() {
  return {
    sent: {},
    lastMessageKey: null,
    lastActivityType: null,
    recentActivityTypes: [],
    lastProcessedActivitySlot: null,
    lastProcessedActivityAt: null,
    lastCheckedAt: null,
    runtime: {
      startedAt: null,
      lastCheckedAt: null,
      lastProcessedActivitySlot: null,
      timerStartedAt: null,
      tickCount: 0,
      lastTickAt: null,
    },
    autoChatFight: emptyAutoChatFightState(),
  };
}

/** Production singleton set by startCommunityScheduler (for /chatfightstatus). */
let liveCommunityScheduler = null;

function getLiveCommunityScheduler() {
  return liveCommunityScheduler;
}

function clearLiveCommunityScheduler(scheduler) {
  if (liveCommunityScheduler === scheduler) {
    liveCommunityScheduler = null;
  }
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadState(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) {
      return emptyState();
    }
    const raw = fs.readFileSync(stateFile, "utf8").trim();
    if (!raw) {
      return emptyState();
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyState();
    }
    if (!parsed.sent || typeof parsed.sent !== "object" || Array.isArray(parsed.sent)) {
      return emptyState();
    }
    return {
      sent: parsed.sent,
      lastMessageKey:
        typeof parsed.lastMessageKey === "string" ? parsed.lastMessageKey : null,
      lastActivityType:
        typeof parsed.lastActivityType === "string"
          ? parsed.lastActivityType
          : null,
      recentActivityTypes: Array.isArray(parsed.recentActivityTypes)
        ? parsed.recentActivityTypes.filter((x) => typeof x === "string")
        : [],
      lastProcessedActivitySlot:
        typeof parsed.lastProcessedActivitySlot === "string"
          ? parsed.lastProcessedActivitySlot
          : null,
      lastProcessedActivityAt:
        typeof parsed.lastProcessedActivityAt === "number"
          ? parsed.lastProcessedActivityAt
          : null,
      lastCheckedAt:
        typeof parsed.lastCheckedAt === "number" ? parsed.lastCheckedAt : null,
      runtime: normalizeRuntime(parsed.runtime, parsed),
      autoChatFight: normalizeAutoChatFightState(parsed.autoChatFight),
    };
  } catch (err) {
    logError("[community-scheduler] Failed to read state:", err);
    return emptyState();
  }
}

function normalizeRuntime(runtime, parsed) {
  const src =
    runtime && typeof runtime === "object" && !Array.isArray(runtime)
      ? runtime
      : {};
  return {
    startedAt: typeof src.startedAt === "number" ? src.startedAt : null,
    lastCheckedAt:
      typeof src.lastCheckedAt === "number"
        ? src.lastCheckedAt
        : typeof parsed.lastCheckedAt === "number"
          ? parsed.lastCheckedAt
          : null,
    lastProcessedActivitySlot:
      typeof src.lastProcessedActivitySlot === "string"
        ? src.lastProcessedActivitySlot
        : typeof parsed.lastProcessedActivitySlot === "string"
          ? parsed.lastProcessedActivitySlot
          : null,
    timerStartedAt:
      typeof src.timerStartedAt === "number" ? src.timerStartedAt : null,
    tickCount: typeof src.tickCount === "number" ? src.tickCount : 0,
    lastTickAt: typeof src.lastTickAt === "number" ? src.lastTickAt : null,
  };
}

function pruneState(state, keepDays = 14) {
  const entries = Object.entries(state.sent || {});
  let sent = state.sent || {};
  if (entries.length > keepDays) {
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    sent = Object.fromEntries(entries.slice(-keepDays));
  }
  const runtime = normalizeRuntime(state.runtime, state);
  return {
    sent,
    lastMessageKey: state.lastMessageKey || null,
    lastActivityType: state.lastActivityType || null,
    recentActivityTypes: Array.isArray(state.recentActivityTypes)
      ? state.recentActivityTypes.slice(-8)
      : [],
    lastProcessedActivitySlot: state.lastProcessedActivitySlot || null,
    lastProcessedActivityAt:
      typeof state.lastProcessedActivityAt === "number"
        ? state.lastProcessedActivityAt
        : null,
    lastCheckedAt:
      typeof state.lastCheckedAt === "number" ? state.lastCheckedAt : null,
    runtime,
    autoChatFight: pruneAutoProcessedSlots(
      normalizeAutoChatFightState(state.autoChatFight),
      keepDays
    ),
  };
}

function saveState(stateFile, state) {
  ensureParentDir(stateFile);
  writeJsonFileAtomic(stateFile, pruneState(state));
}

function getZonedClock(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  const hour = Number.parseInt(map.hour, 10);
  const minute = Number.parseInt(map.minute, 10);
  return {
    dayKey: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
  };
}

function slotTotalMinutes(slot) {
  return slot.hour * 60 + slot.minute;
}

function didCrossSlot(prevClock, nowClock, slot) {
  if (!prevClock || !nowClock) {
    return false;
  }
  if (prevClock.dayKey !== nowClock.dayKey) {
    return false;
  }
  const target = slotTotalMinutes(slot);
  return prevClock.totalMinutes < target && nowClock.totalMinutes >= target;
}

function wasSent(state, dayKey, slotId) {
  const list = state.sent && state.sent[dayKey];
  return Array.isArray(list) && list.includes(slotId);
}

function markSent(state, dayKey, slotId) {
  if (!state.sent[dayKey]) {
    state.sent[dayKey] = [];
  }
  if (!state.sent[dayKey].includes(slotId)) {
    state.sent[dayKey].push(slotId);
  }
}

function hashPick(dayKey, slotId, length) {
  let hash = 0;
  const input = `${dayKey}:${slotId}`;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return length > 0 ? hash % length : 0;
}

function messageKey(text) {
  return String(text || "").slice(0, 80);
}

function pickMessage(slotId, dayKey, options = {}) {
  const poolName =
    (options.poolName) ||
    (options.slot && options.slot.pool) ||
    slotId;
  const pool = MESSAGE_POOLS[poolName] || MESSAGE_POOLS[slotId] || [];
  if (!pool.length) {
    return null;
  }
  let index = hashPick(dayKey, slotId, pool.length);
  let text = pool[index];
  const avoidKey = options.avoidKey;
  if (avoidKey && pool.length > 1 && messageKey(text) === avoidKey) {
    index = (index + 1) % pool.length;
    text = pool[index];
  }
  return text;
}

function createCommunityScheduler(options = {}) {
  const enabled =
    options.enabled !== undefined
      ? Boolean(options.enabled)
      : parseEnabledFlag(process.env.COMMUNITY_AUTO_MESSAGES_ENABLED);
  const chatId =
    options.chatId !== undefined
      ? options.chatId
      : process.env.TELEGRAM_CHAT_ID && String(process.env.TELEGRAM_CHAT_ID).trim();
  const timeZone =
    (options.timeZone || process.env.COMMUNITY_TIMEZONE || DEFAULT_TIMEZONE).trim() ||
    DEFAULT_TIMEZONE;
  const slots = options.slots || resolveSlotsFromEnv();
  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const tickMs = options.tickMs === undefined ? DEFAULT_TICK_MS : options.tickMs;
  const getNow = typeof options.now === "function" ? options.now : () => new Date();
  const sendMessage =
    typeof options.sendMessage === "function" ? options.sendMessage : null;
  const skipIfRecentMs =
    options.skipIfRecentActivityMs !== undefined
      ? options.skipIfRecentActivityMs
      : parsePositiveInt(
          process.env.COMMUNITY_SKIP_IF_RECENT_ACTIVITY_MINUTES,
          0
        ) * 60_000;
  const wasActiveFn =
    typeof options.wasActiveWithin === "function"
      ? options.wasActiveWithin
      : wasActiveWithin;

  const autoConfig =
    options.autoChatFightConfig ||
    parseAutoChatFightConfig(process.env, options.autoChatFightOptions || {});
  const activityConfig =
    options.activityEngineConfig ||
    parseActivityEngineConfig(process.env, options.activityEngineOptions || {});
  const chatFight =
    options.chatFight || chatFightRuntime;
  const announceChatFight =
    typeof options.announceChatFight === "function"
      ? options.announceChatFight
      : null;
  const announceTrivia =
    typeof options.announceTrivia === "function"
      ? options.announceTrivia
      : null;
  const autoRandom =
    typeof options.autoChatFightRandom === "function"
      ? options.autoChatFightRandom
      : Math.random;
  const activityRandom =
    typeof options.activityRandom === "function"
      ? options.activityRandom
      : Math.random;
  // Bare identifiers — do not .bind(global). Production timer is core work.
  const setIntervalFn =
    typeof options.setIntervalFn === "function"
      ? options.setIntervalFn
      : function productionSetInterval(fn, delay) {
          return setInterval(fn, delay);
        };
  const clearIntervalFn =
    typeof options.clearIntervalFn === "function"
      ? options.clearIntervalFn
      : function productionClearInterval(id) {
          clearInterval(id);
        };
  const writeStateFn =
    typeof options.writeState === "function"
      ? options.writeState
      : (file, st) => saveState(file, st);
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function"
      ? options.setTimeoutFn
      : function productionSetTimeout(fn, delay) {
          return setTimeout(fn, delay);
        };
  const clearTimeoutFn =
    typeof options.clearTimeoutFn === "function"
      ? options.clearTimeoutFn
      : function productionClearTimeout(id) {
          clearTimeout(id);
        };
  const probeDelayMs =
    options.probeDelayMs !== undefined
      ? Number(options.probeDelayMs)
      : typeof options.setIntervalFn === "function"
        ? 0
        : 5000;

  let timer = null;
  let probeTimer = null;
  let probeFired = false;
  let lastStopReason = null;
  let lastCheckedAt = null;
  let startedAt = null;
  let timerStartedAt = null;
  let tickCount = 0;
  let lastTickAt = null;
  /** @type {"ok"|"error"|"unknown"} */
  let persistStatus = "unknown";
  let state = loadState(stateFile);
  if (!state.autoChatFight) {
    state.autoChatFight = emptyAutoChatFightState();
  }
  if (!state.runtime || typeof state.runtime !== "object") {
    state.runtime = {
      startedAt: null,
      lastCheckedAt: null,
      lastProcessedActivitySlot: null,
      timerStartedAt: null,
      tickCount: 0,
      lastTickAt: null,
    };
  }

  function schedulerWanted() {
    const remindersWanted = enabled && !activityConfig.enabled;
    const autoWanted = autoConfig.enabled && !activityConfig.enabled;
    const engineWanted = activityConfig.enabled;
    return remindersWanted || autoWanted || engineWanted;
  }

  function syncRuntimeFields() {
    if (!state.runtime || typeof state.runtime !== "object") {
      state.runtime = {
        startedAt: null,
        lastCheckedAt: null,
        lastProcessedActivitySlot: null,
        timerStartedAt: null,
        tickCount: 0,
        lastTickAt: null,
      };
    }
    if (startedAt) {
      state.runtime.startedAt = startedAt.getTime();
    }
    if (timerStartedAt) {
      state.runtime.timerStartedAt = timerStartedAt.getTime();
    }
    if (lastCheckedAt) {
      const ms = lastCheckedAt.getTime();
      state.lastCheckedAt = ms;
      state.runtime.lastCheckedAt = ms;
    }
    state.runtime.lastProcessedActivitySlot =
      state.lastProcessedActivitySlot || null;
    state.runtime.tickCount = tickCount;
    state.runtime.lastTickAt = lastTickAt ? lastTickAt.getTime() : null;
  }

  function noteTimerPulse() {
    const pulseNow = getNow();
    tickCount += 1;
    lastTickAt = pulseNow;
    if (state.runtime) {
      state.runtime.tickCount = tickCount;
      state.runtime.lastTickAt = pulseNow.getTime();
    }
    if (tickCount === 1) {
      log("[community-scheduler] first timer pulse");
    }
    // Persist first pulse immediately, then every 5 pulses, plus every slot.
    if (tickCount === 1 || tickCount % 5 === 0) {
      persist();
    }
  }

  function persist() {
    try {
      syncRuntimeFields();
      writeStateFn(stateFile, state);
      if (!fs.existsSync(stateFile)) {
        throw new Error("state-file-missing-after-write");
      }
      persistStatus = "ok";
      return true;
    } catch (_err) {
      persistStatus = "error";
      logError("[community-scheduler] state persist failed");
      return false;
    }
  }

  async function sendSlot(slot, dayKey) {
    const text = pickMessage(slot.id, dayKey, {
      slot,
      avoidKey: state.lastMessageKey,
    });
    if (!text || !sendMessage) {
      return { ok: false, text: null };
    }
    try {
      const ok = await sendMessage(chatId, text);
      return { ok: Boolean(ok), text };
    } catch (err) {
      logError("[community-scheduler] send failed:", err);
      return { ok: false, text };
    }
  }

  async function processActivityEngine(prevClock, nowClock, now) {
    if (!activityConfig.enabled) {
      return { enabled: false, results: [] };
    }
    if (!chatId) {
      return { enabled: true, results: [{ reason: "missing-chat-id" }] };
    }
    const results = [];
    const nowMs = now.getTime();
    for (const slot of activityConfig.slots) {
      if (!didCrossSlot(prevClock, nowClock, slot)) {
        continue;
      }
      const result = await processCommunityActivitySlot({
        chatId,
        slot,
        dayKey: nowClock.dayKey,
        config: activityConfig,
        state,
        chatFight,
        sendMessage,
        announceChatFight,
        announceTrivia,
        nowMs,
        random: activityRandom,
        wasActiveWithinFn: wasActiveFn,
      });
      persist();
      results.push({ slot: slot.id, ...result });
    }
    return { enabled: true, results };
  }

  async function processAutoChatFight(prevClock, nowClock, now) {
    // When unified activity engine is on, it owns ChatFight selection.
    if (activityConfig.enabled) {
      return { enabled: false, started: [], skipped: [], deferredToEngine: true };
    }
    if (!autoConfig.enabled) {
      return { enabled: false, started: [], skipped: [] };
    }
    if (!chatId) {
      return { enabled: true, started: [], skipped: ["missing-chat-id"] };
    }
    if (!announceChatFight) {
      return { enabled: true, started: [], skipped: ["missing-announcer"] };
    }

    const started = [];
    const skipped = [];
    const nowMs = now.getTime();

    for (const slot of autoConfig.slots) {
      if (!didCrossSlot(prevClock, nowClock, slot)) {
        continue;
      }

      const result = await tryStartAutoChatFight({
        chatId,
        slot,
        dayKey: nowClock.dayKey,
        config: autoConfig,
        autoState: state.autoChatFight,
        chatFight,
        announce: announceChatFight,
        nowMs,
        random: autoRandom,
      });
      persist();

      if (result.started) {
        started.push(slot.id);
      } else if (result.reason && result.reason !== "already-processed") {
        skipped.push({ slot: slot.id, reason: result.reason });
      }
    }

    return { enabled: true, started, skipped };
  }

  async function processWeeklyWinners() {
    if (!chatId || typeof sendMessage !== "function") {
      return { skipped: "missing-chat-or-sender" };
    }
    try {
      return await processWeeklyWinnersBoundary({
        chatId,
        sendMessageFn: sendMessage,
        winnersFile: options.weeklyWinnersFile,
        pointsFile: options.pointsFile,
        now: getNow,
      });
    } catch (err) {
      logError(
        "[weekly-winners] boundary processing failed:",
        err && err.message ? err.message : err
      );
      return { posted: false, reason: "error" };
    }
  }

  async function tick() {
    const remindersWanted = enabled && !activityConfig.enabled;
    const autoWanted = autoConfig.enabled && !activityConfig.enabled;
    const engineWanted = activityConfig.enabled;
    const wanted = remindersWanted || autoWanted || engineWanted;

    // Weekly Top 3 announce uses the same sendMessage channel as community
    // activity. A disabled scheduler must not send anything — including
    // weekly-winners. Startup recovery in index.js beforeScheduler remains
    // the announce path when the scheduler itself never starts.
    let weeklyWinners = { skipped: "scheduler-disabled" };
    if (wanted) {
      weeklyWinners = await processWeeklyWinners();
    }

    if (!wanted) {
      return { skipped: "disabled", weeklyWinners };
    }
    if (!chatId) {
      return { skipped: "missing-chat-id", weeklyWinners };
    }

    const now = getNow();
    const nowClock = getZonedClock(now, timeZone);

    if (lastCheckedAt === null) {
      lastCheckedAt = now;
      state.lastCheckedAt = now.getTime();
      persist();
      return { skipped: "startup-seed", dayKey: nowClock.dayKey, weeklyWinners };
    }

    const prevClock = getZonedClock(lastCheckedAt, timeZone);
    lastCheckedAt = now;
    state.lastCheckedAt = now.getTime();
    if (state.runtime) {
      state.runtime.lastCheckedAt = now.getTime();
    }

    const fired = [];
    const skippedRecent = [];

    if (remindersWanted && sendMessage) {
      for (const slot of slots) {
        if (!didCrossSlot(prevClock, nowClock, slot)) {
          continue;
        }
        if (wasSent(state, nowClock.dayKey, slot.id)) {
          continue;
        }

        if (skipIfRecentMs > 0 && wasActiveFn(skipIfRecentMs, now.getTime())) {
          markSent(state, nowClock.dayKey, slot.id);
          persist();
          skippedRecent.push(slot.id);
          continue;
        }

        const result = await sendSlot(slot, nowClock.dayKey);
        if (result.ok) {
          markSent(state, nowClock.dayKey, slot.id);
          state.lastMessageKey = messageKey(result.text);
          persist();
          fired.push(slot.id);
        }
      }
    }

    const activity = await processActivityEngine(prevClock, nowClock, now);
    const autoFight = await processAutoChatFight(prevClock, nowClock, now);

    return {
      dayKey: nowClock.dayKey,
      fired,
      skippedRecent,
      activity,
      autoFight,
      weeklyWinners,
    };
  }

  function start() {
    const autoWanted = autoConfig.enabled && !activityConfig.enabled;
    const engineWanted = activityConfig.enabled;
    if (!schedulerWanted()) {
      log(
        "[community-scheduler] Disabled (reminders off, auto-fight off, activity engine off)"
      );
      log("[activity-engine] disabled");
      return;
    }
    if (!chatId) {
      log("[community-scheduler] Disabled (TELEGRAM_CHAT_ID missing)");
      return;
    }
    if (timer) {
      return;
    }
    startedAt = getNow();
    // Guaranteed startup seed + disk write BEFORE the timer starts.
    lastCheckedAt = startedAt;
    state.lastCheckedAt = startedAt.getTime();
    persist();
    log(`[activity-engine] state-file=${path.resolve(stateFile)}`);

    if (enabled && !activityConfig.enabled && sendMessage) {
      log(
        `[community-scheduler] Enabled — timezone=${timeZone} slots=${slots
          .map((s) => `${s.id}@${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`)
          .join(",")}`
      );
    }
    if (engineWanted) {
      log(
        `[activity-engine] Enabled — 24/7=${activityConfig.twentyFourSeven} interval=${activityConfig.intervalMinutes}m slots=${activityConfig.slots.length}`
      );
    } else {
      log("[activity-engine] disabled");
    }
    if (autoWanted && announceChatFight) {
      const envInterval =
        process.env.AUTO_CHATFIGHT_INTERVAL_MINUTES || "unset";
      log(
        `[auto-chatfight] Enabled — interval=${autoConfig.intervalMinutes}m env=${envInterval} chance=${autoConfig.chancePercent}% slots=${autoConfig.slots.length}`
      );
    } else if (!autoConfig.enabled) {
      log("[auto-chatfight] disabled");
    } else if (activityConfig.enabled) {
      log("[auto-chatfight] deferred to activity engine");
    }

    // Timer creation must not depend on the initial tick succeeding.
    if (typeof setIntervalFn !== "function") {
      logError("[community-scheduler] timer function unavailable");
      return;
    }

    log(
      `[community-scheduler] before timer create interval=${tickMs} typeof=${typeof setIntervalFn}`
    );
    try {
      timerStartedAt = getNow();
      tickCount = 0;
      lastTickAt = null;
      if (state.runtime) {
        const startedMs =
          timerStartedAt && typeof timerStartedAt.getTime === "function"
            ? timerStartedAt.getTime()
            : Date.now();
        state.runtime.timerStartedAt = startedMs;
        state.runtime.tickCount = 0;
        state.runtime.lastTickAt = null;
      }

      timer = setIntervalFn(() => {
        try {
          noteTimerPulse();
        } catch (err) {
          logError("[community-scheduler] tick error:", err);
        }
        return Promise.resolve()
          .then(() => tick())
          .catch((err) => logError("[community-scheduler] tick error:", err));
      }, tickMs);

      let referenced = "n/a";
      if (timer && typeof timer.hasRef === "function") {
        referenced = timer.hasRef() ? "true" : "false";
      }
      log(
        `[community-scheduler] timer created running=${Boolean(timer)} referenced=${referenced}`
      );
      persist();
      log("[community-scheduler] after timer create");
      log(`[community-scheduler] timer started interval=${tickMs}ms`);

      if (engineWanted && probeDelayMs > 0 && typeof setTimeoutFn === "function") {
        probeFired = false;
        probeTimer = setTimeoutFn(() => {
          probeTimer = null;
          probeFired = true;
          log("[community-scheduler] timer probe fired");
        }, probeDelayMs);
      }
    } catch (err) {
      logError("[community-scheduler] timer create failed");
      return;
    }

    Promise.resolve()
      .then(() => tick())
      .catch((err) => logError("[community-scheduler] tick error:", err));
  }

  function stop(reason) {
    const why = reason ? String(reason) : "explicit";
    lastStopReason = why;
    log(`[community-scheduler] stop called reason=${why}`);
    if (probeTimer) {
      clearTimeoutFn(probeTimer);
      probeTimer = null;
    }
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
      log("[community-scheduler] timer stopped");
    }
    clearLiveCommunityScheduler(api);
  }

  function getState() {
    return JSON.parse(JSON.stringify(state));
  }

  function resetLastChecked() {
    lastCheckedAt = null;
  }

  function setLastChecked(date) {
    lastCheckedAt = date;
  }

  function isTimerRunning() {
    return timer != null;
  }

  function getLastCheckedAt() {
    return lastCheckedAt;
  }

  function getDiagnostics(nowInput) {
    const now = nowInput || getNow();
    const nowClock = getZonedClock(now, timeZone);
    const stateExists = fs.existsSync(stateFile);
    let lastCheckedLabel = "none";
    if (lastCheckedAt) {
      const mins = Math.max(
        0,
        Math.floor((now.getTime() - lastCheckedAt.getTime()) / 60_000)
      );
      lastCheckedLabel = `${mins} min ago`;
    } else if (state.lastCheckedAt) {
      const mins = Math.max(
        0,
        Math.floor((now.getTime() - state.lastCheckedAt) / 60_000)
      );
      lastCheckedLabel = `${mins} min ago (persisted)`;
    }
    let lastTickLabel = "none";
    if (lastTickAt) {
      const secs = Math.max(
        0,
        Math.floor((now.getTime() - lastTickAt.getTime()) / 1000)
      );
      lastTickLabel = `${secs} sec ago`;
    }
    const lastSlot = state.lastProcessedActivitySlot || "none";
    let statePersistence = "unknown";
    if (persistStatus === "ok") {
      statePersistence = "ok";
    } else if (persistStatus === "error") {
      statePersistence = "error";
    } else if (stateExists) {
      statePersistence = "ok";
    } else {
      statePersistence = "missing";
    }
    let timerReferenced = null;
    if (timer && typeof timer.hasRef === "function") {
      timerReferenced = Boolean(timer.hasRef());
    }
    return {
      activityEngineEnabled: Boolean(activityConfig.enabled),
      twentyFourSeven: Boolean(activityConfig.twentyFourSeven),
      activityIntervalMinutes: activityConfig.intervalMinutes,
      activitySlots: activityConfig.slots.length,
      timerRunning: isTimerRunning(),
      timerIntervalMs: tickMs,
      timerTicks: tickCount,
      lastTick: lastTickLabel,
      timerReferenced,
      probeFired,
      lastStopReason,
      lastChecked: lastCheckedLabel,
      lastProcessedActivitySlot: lastSlot,
      stateFile: stateExists ? "available" : "missing",
      stateFilePath: path.resolve(stateFile),
      statePersistence,
      nextActivitySlot: nextActivitySlotLabel(activityConfig, nowClock) || "none",
      startedAt: startedAt ? startedAt.toISOString() : null,
      timerStartedAt: timerStartedAt ? timerStartedAt.toISOString() : null,
      schedulerWanted: schedulerWanted(),
    };
  }

  const api = {
    enabled,
    chatId,
    timeZone,
    slots,
    stateFile,
    tickMs,
    skipIfRecentMs,
    autoConfig,
    activityConfig,
    start,
    stop,
    tick,
    getState,
    resetLastChecked,
    setLastChecked,
    isTimerRunning,
    getLastCheckedAt,
    getTickCount: () => tickCount,
    getLastTickAt: () => lastTickAt,
    getDiagnostics,
    didCrossSlot,
    getZonedClock,
    pickMessage,
    wasSent,
    MESSAGE_POOLS,
  };
  return api;
}

function startCommunityScheduler(telegram, options = {}) {
  const fight = options.chatFight || chatFightRuntime;
  if (typeof fight.setEditMessageHandler === "function") {
    fight.setEditMessageHandler(async (chatId, messageId, text, extra) => {
      const opts = {
        disable_web_page_preview: true,
      };
      if (extra && extra.reply_markup) {
        opts.reply_markup = extra.reply_markup;
      } else if (extra) {
        Object.assign(opts, extra);
      }
      await telegram.editMessageText(chatId, messageId, undefined, text, opts);
    });
  }

  try {
    const { getTriviaRuntime } = require("./trivia");
    const { wireTriviaRuntime } = require("../commands/trivia");
    const trivia = options.triviaRuntime || getTriviaRuntime();
    wireTriviaRuntime(trivia, { telegram });
  } catch (_err) {
    /* trivia optional during early boot/tests */
  }

  const scheduler = createCommunityScheduler({
    ...options,
    chatFight: fight,
    sendMessage: async (chatId, text) => {
      await telegram.sendMessage(chatId, text, {
        disable_web_page_preview: true,
      });
      return true;
    },
    announceChatFight: async (chatId, teaser, keyboard) => {
      const extra = {
        disable_web_page_preview: true,
      };
      if (keyboard && keyboard.reply_markup) {
        extra.reply_markup = keyboard.reply_markup;
      } else if (keyboard) {
        Object.assign(extra, keyboard);
      }
      return telegram.sendMessage(chatId, teaser, extra);
    },
    announceTrivia: async (chatId, text, keyboard) => {
      const extra = {
        disable_web_page_preview: true,
      };
      if (keyboard && keyboard.reply_markup) {
        extra.reply_markup = keyboard.reply_markup;
      } else if (keyboard) {
        Object.assign(extra, keyboard);
      }
      return telegram.sendMessage(chatId, text, extra);
    },
  });
  liveCommunityScheduler = scheduler;
  try {
    scheduler.start();
  } catch (err) {
    logError(
      "[community-scheduler] Failed to start:",
      err && err.message ? err.message : err
    );
  }
  return scheduler;
}

function getCommunitySchedulerDiagnostics(now) {
  if (liveCommunityScheduler && typeof liveCommunityScheduler.getDiagnostics === "function") {
    return liveCommunityScheduler.getDiagnostics(now);
  }
  const activityConfig = parseActivityEngineConfig(process.env);
  const timeZone =
    (process.env.COMMUNITY_TIMEZONE || DEFAULT_TIMEZONE).trim() ||
    DEFAULT_TIMEZONE;
  const clock = getZonedClock(now || new Date(), timeZone);
  const stateFile = DEFAULT_STATE_FILE;
  const stateExists = fs.existsSync(stateFile);
  let state = emptyState();
  if (stateExists) {
    state = loadState(stateFile);
  }
  return {
    activityEngineEnabled: Boolean(activityConfig.enabled),
    twentyFourSeven: Boolean(activityConfig.twentyFourSeven),
    activityIntervalMinutes: activityConfig.intervalMinutes,
    activitySlots: activityConfig.slots.length,
    timerRunning: false,
    timerIntervalMs: DEFAULT_TICK_MS,
    timerTicks: 0,
    lastTick: "none",
    timerReferenced: null,
    probeFired: false,
    lastStopReason: null,
    lastChecked: state.lastCheckedAt
      ? `${Math.max(0, Math.floor(((now || new Date()).getTime() - state.lastCheckedAt) / 60_000))} min ago (persisted)`
      : "none",
    lastProcessedActivitySlot: state.lastProcessedActivitySlot || "none",
    stateFile: stateExists ? "available" : "missing",
    stateFilePath: path.resolve(stateFile),
    statePersistence: stateExists ? "ok" : "missing",
    nextActivitySlot: nextActivitySlotLabel(activityConfig, clock) || "none",
    startedAt: null,
    timerStartedAt: null,
    schedulerWanted:
      parseEnabledFlag(process.env.COMMUNITY_AUTO_MESSAGES_ENABLED) ||
      parseEnabledFlag(process.env.AUTO_CHATFIGHT_ENABLED) ||
      activityConfig.enabled,
  };
}

module.exports = {
  DEFAULT_STATE_FILE,
  DEFAULT_TIMEZONE,
  DEFAULT_SLOTS,
  DEFAULT_ACTIVE_START_HOUR,
  DEFAULT_ACTIVE_END_HOUR,
  DEFAULT_TICK_MS,
  MESSAGE_POOLS,
  ACTIVITY_MESSAGES,
  parseEnabledFlag,
  parsePositiveInt,
  buildIntervalSlots,
  resolveSlotsFromEnv,
  resolveDefaultStateFile,
  createCommunityScheduler,
  startCommunityScheduler,
  getLiveCommunityScheduler,
  getCommunitySchedulerDiagnostics,
  getZonedClock,
  didCrossSlot,
  pickMessage,
  loadState,
  saveState,
  emptyState,
  nextActivitySlotLabel,
};
