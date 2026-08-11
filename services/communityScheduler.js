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

const DEFAULT_STATE_FILE = path.join(
  __dirname,
  "..",
  "data",
  "community-scheduler.json"
);

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
  return { sent: {}, lastMessageKey: null };
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
    };
  } catch (err) {
    logError("[community-scheduler] Failed to read state:", err);
    return emptyState();
  }
}

function pruneState(state, keepDays = 14) {
  const entries = Object.entries(state.sent || {});
  if (entries.length <= keepDays) {
    return state;
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const kept = entries.slice(-keepDays);
  return {
    sent: Object.fromEntries(kept),
    lastMessageKey: state.lastMessageKey || null,
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

  let timer = null;
  let lastCheckedAt = null;
  let state = loadState(stateFile);

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

  async function tick() {
    if (!enabled) {
      return { skipped: "disabled" };
    }
    if (!chatId) {
      return { skipped: "missing-chat-id" };
    }
    if (!sendMessage) {
      return { skipped: "missing-sender" };
    }

    const now = getNow();
    const nowClock = getZonedClock(now, timeZone);

    if (lastCheckedAt === null) {
      lastCheckedAt = now;
      return { skipped: "startup-seed", dayKey: nowClock.dayKey };
    }

    const prevClock = getZonedClock(lastCheckedAt, timeZone);
    lastCheckedAt = now;

    const fired = [];
    const skippedRecent = [];

    for (const slot of slots) {
      if (!didCrossSlot(prevClock, nowClock, slot)) {
        continue;
      }
      if (wasSent(state, nowClock.dayKey, slot.id)) {
        continue;
      }

      if (skipIfRecentMs > 0 && wasActiveFn(skipIfRecentMs, now.getTime())) {
        markSent(state, nowClock.dayKey, slot.id);
        try {
          saveState(stateFile, state);
        } catch (err) {
          logError("[community-scheduler] Failed to persist state:", err);
        }
        skippedRecent.push(slot.id);
        continue;
      }

      const result = await sendSlot(slot, nowClock.dayKey);
      if (result.ok) {
        markSent(state, nowClock.dayKey, slot.id);
        state.lastMessageKey = messageKey(result.text);
        try {
          saveState(stateFile, state);
        } catch (err) {
          logError("[community-scheduler] Failed to persist state:", err);
        }
        fired.push(slot.id);
      }
    }

    return {
      dayKey: nowClock.dayKey,
      fired,
      skippedRecent,
    };
  }

  function start() {
    if (!enabled) {
      log("[community-scheduler] Disabled (COMMUNITY_AUTO_MESSAGES_ENABLED != true)");
      return;
    }
    if (!chatId) {
      log("[community-scheduler] Disabled (TELEGRAM_CHAT_ID missing)");
      return;
    }
    if (!sendMessage) {
      log("[community-scheduler] Disabled (no sendMessage)");
      return;
    }

    log(
      `[community-scheduler] Enabled — timezone=${timeZone} slots=${slots
        .map((s) => `${s.id}@${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`)
        .join(",")}`
    );

    tick().catch((err) => logError("[community-scheduler] tick error:", err));
    timer = setInterval(() => {
      tick().catch((err) => logError("[community-scheduler] tick error:", err));
    }, tickMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
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

  return {
    enabled,
    chatId,
    timeZone,
    slots,
    stateFile,
    skipIfRecentMs,
    start,
    stop,
    tick,
    getState,
    resetLastChecked,
    setLastChecked,
    didCrossSlot,
    getZonedClock,
    pickMessage,
    wasSent,
    MESSAGE_POOLS,
  };
}

function startCommunityScheduler(telegram, options = {}) {
  const scheduler = createCommunityScheduler({
    ...options,
    sendMessage: async (chatId, text) => {
      await telegram.sendMessage(chatId, text, {
        disable_web_page_preview: true,
      });
      return true;
    },
  });
  scheduler.start();
  return scheduler;
}

module.exports = {
  DEFAULT_STATE_FILE,
  DEFAULT_TIMEZONE,
  DEFAULT_SLOTS,
  DEFAULT_ACTIVE_START_HOUR,
  DEFAULT_ACTIVE_END_HOUR,
  MESSAGE_POOLS,
  ACTIVITY_MESSAGES,
  parseEnabledFlag,
  parsePositiveInt,
  buildIntervalSlots,
  resolveSlotsFromEnv,
  createCommunityScheduler,
  startCommunityScheduler,
  getZonedClock,
  didCrossSlot,
  pickMessage,
  loadState,
  saveState,
  emptyState,
};
