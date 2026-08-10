/**
 * Automatic community messages to TELEGRAM_CHAT_ID (group only).
 *
 * Disabled unless COMMUNITY_AUTO_MESSAGES_ENABLED=true.
 * Never catch up missed slots after restart — only fire when a slot boundary is crossed.
 * Persists sent slots in data/community-scheduler.json (not points.json).
 */

const fs = require("fs");
const path = require("path");
const { writeJsonFileAtomic } = require("../utils/json");
const { log, error: logError } = require("../utils/logger");

const DEFAULT_STATE_FILE = path.join(
  __dirname,
  "..",
  "data",
  "community-scheduler.json"
);

const DEFAULT_TIMEZONE = "Europe/Amsterdam";
const DEFAULT_TICK_MS = 60_000;

/** Local wall-clock slots in COMMUNITY_TIMEZONE (default Europe/Amsterdam). */
const DEFAULT_SLOTS = Object.freeze([
  Object.freeze({ id: "morning", hour: 9, minute: 0 }),
  Object.freeze({ id: "afternoon", hour: 14, minute: 0 }),
  Object.freeze({ id: "evening", hour: 20, minute: 0 }),
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
});

function parseEnabledFlag(raw) {
  if (typeof raw !== "string") {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function emptyState() {
  return { sent: {} };
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
    return { sent: parsed.sent };
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
  return { sent: Object.fromEntries(kept) };
}

function saveState(stateFile, state) {
  ensureParentDir(stateFile);
  writeJsonFileAtomic(stateFile, pruneState(state));
}

/**
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{ dayKey: string, hour: number, minute: number, totalMinutes: number }}
 */
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

/**
 * True when local time crossed the slot boundary between prev and now (same local day).
 * Day changes never catch up missed slots (restart/sleep safe).
 */
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

function pickMessage(slotId, dayKey) {
  const pool = MESSAGE_POOLS[slotId] || [];
  if (!pool.length) {
    return null;
  }
  return pool[hashPick(dayKey, slotId, pool.length)];
}

/**
 * @param {object} [options]
 */
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
  const slots = options.slots || DEFAULT_SLOTS;
  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const tickMs = options.tickMs === undefined ? DEFAULT_TICK_MS : options.tickMs;
  const getNow = typeof options.now === "function" ? options.now : () => new Date();
  const sendMessage =
    typeof options.sendMessage === "function" ? options.sendMessage : null;

  let timer = null;
  let lastCheckedAt = null;
  let state = loadState(stateFile);

  async function sendSlot(slot, dayKey) {
    const text = pickMessage(slot.id, dayKey);
    if (!text || !sendMessage) {
      return false;
    }
    try {
      const ok = await sendMessage(chatId, text);
      return Boolean(ok);
    } catch (err) {
      logError("[community-scheduler] send failed:", err);
      return false;
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
      // Startup / first tick: do not catch up missed slots.
      lastCheckedAt = now;
      return { skipped: "startup-seed", dayKey: nowClock.dayKey };
    }

    const prevClock = getZonedClock(lastCheckedAt, timeZone);
    lastCheckedAt = now;

    const fired = [];
    for (const slot of slots) {
      if (!didCrossSlot(prevClock, nowClock, slot)) {
        continue;
      }
      if (wasSent(state, nowClock.dayKey, slot.id)) {
        continue;
      }

      const ok = await sendSlot(slot, nowClock.dayKey);
      if (ok) {
        markSent(state, nowClock.dayKey, slot.id);
        try {
          saveState(stateFile, state);
        } catch (err) {
          logError("[community-scheduler] Failed to persist state:", err);
        }
        fired.push(slot.id);
      }
    }

    return { dayKey: nowClock.dayKey, fired };
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

    // Seed without sending, then poll.
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

/**
 * Wire scheduler to a Telegraf telegram API.
 * @param {object} telegram Telegraf bot.telegram
 * @param {object} [options]
 */
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
  MESSAGE_POOLS,
  parseEnabledFlag,
  createCommunityScheduler,
  startCommunityScheduler,
  getZonedClock,
  didCrossSlot,
  pickMessage,
  loadState,
  saveState,
  emptyState,
};
