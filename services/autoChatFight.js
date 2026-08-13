/**
 * Auto ChatFight — config + start orchestration for the community scheduler.
 * Uses the shared ChatFight runtime (same state as /chatfight).
 *
 * Note: does not import communityScheduler (avoids circular deps).
 * Slot builders mirror scheduler helpers with the same semantics.
 */

const {
  FIGHT_TYPES,
  ALL_FIGHT_TYPES,
  chatFightRuntime,
  getRevealKeyboard,
} = require("./chatFight");
const { log, error: logError } = require("../utils/logger");

const DEFAULT_AUTO_INTERVAL_MINUTES = 120;
const DEFAULT_AUTO_GAP_MINUTES = 120;
const DEFAULT_AUTO_CHANCE_PERCENT = 100;
const DEFAULT_ACTIVE_START_HOUR = 9;
const DEFAULT_ACTIVE_END_HOUR = 22;

const TYPE_ALIAS_TO_FIGHT = Object.freeze({
  type: FIGHT_TYPES.TYPE_RUSH,
  rush: FIGHT_TYPES.TYPE_RUSH,
  typerush: FIGHT_TYPES.TYPE_RUSH,
  type_rush: FIGHT_TYPES.TYPE_RUSH,
  math: FIGHT_TYPES.MATH_RUSH,
  mathrush: FIGHT_TYPES.MATH_RUSH,
  math_rush: FIGHT_TYPES.MATH_RUSH,
  emoji: FIGHT_TYPES.EMOJI_GUESS,
  emojiguess: FIGHT_TYPES.EMOJI_GUESS,
  emoji_guess: FIGHT_TYPES.EMOJI_GUESS,
  unscramble: FIGHT_TYPES.UNSCRAMBLE,
  missing: FIGHT_TYPES.MISSING_LETTER,
  missing_letter: FIGHT_TYPES.MISSING_LETTER,
  missingletter: FIGHT_TYPES.MISSING_LETTER,
  memory: FIGHT_TYPES.MEMORY,
  quicktap: FIGHT_TYPES.QUICK_TAP,
  quick_tap: FIGHT_TYPES.QUICK_TAP,
  tap: FIGHT_TYPES.QUICK_TAP,
});

function parseAutoEnabledFlag(raw) {
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
    slots.push({ hour, minute });
  }
  return slots;
}

function parseChancePercent(raw, fallback = DEFAULT_AUTO_CHANCE_PERCENT) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 100) {
    return 100;
  }
  return n;
}

/**
 * @param {string|undefined} raw
 * @returns {string[]} FIGHT_TYPES values
 */
function parseAutoFightTypes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return [...ALL_FIGHT_TYPES];
  }
  const parts = String(raw)
    .split(/[,|\s]+/)
    .map((p) => p.trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .filter(Boolean);
  const types = [];
  for (const part of parts) {
    const compact = part.replace(/_/g, "");
    const mapped =
      TYPE_ALIAS_TO_FIGHT[part] ||
      TYPE_ALIAS_TO_FIGHT[compact] ||
      (ALL_FIGHT_TYPES.includes(part) ? part : null);
    if (mapped && !types.includes(mapped)) {
      types.push(mapped);
    }
  }
  return types.length ? types : [...ALL_FIGHT_TYPES];
}

function resolveActiveHoursFromEnv(env = process.env) {
  return {
    startHour: parseHour(
      env.COMMUNITY_ACTIVE_START_HOUR,
      DEFAULT_ACTIVE_START_HOUR
    ),
    endHour: parseHour(
      env.COMMUNITY_ACTIVE_END_HOUR,
      DEFAULT_ACTIVE_END_HOUR
    ),
  };
}

function buildAutoChatFightSlots(intervalMinutes, startHour, endHour) {
  return buildIntervalSlots(intervalMinutes, startHour, endHour).map((s) =>
    Object.freeze({
      id: `acf${String(s.hour).padStart(2, "0")}${String(s.minute).padStart(2, "0")}`,
      hour: s.hour,
      minute: s.minute,
      label: `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`,
    })
  );
}

function parseAutoChatFightConfig(env = process.env, options = {}) {
  const enabled =
    options.enabled !== undefined
      ? Boolean(options.enabled)
      : parseAutoEnabledFlag(env.AUTO_CHATFIGHT_ENABLED);
  const intervalMinutes = parsePositiveInt(
    options.intervalMinutes !== undefined
      ? options.intervalMinutes
      : env.AUTO_CHATFIGHT_INTERVAL_MINUTES,
    DEFAULT_AUTO_INTERVAL_MINUTES
  );
  const minGapRaw =
    env.AUTO_CHATFIGHT_MIN_GAP_MINUTES !== undefined &&
    String(env.AUTO_CHATFIGHT_MIN_GAP_MINUTES).trim() !== ""
      ? env.AUTO_CHATFIGHT_MIN_GAP_MINUTES
      : env.AUTO_CHATFIGHT_MIN_ACTIVITY_GAP_MINUTES;
  const minGapMinutes = parsePositiveInt(
    options.minGapMinutes !== undefined
      ? options.minGapMinutes
      : minGapRaw,
    DEFAULT_AUTO_GAP_MINUTES
  );
  const chancePercent = parseChancePercent(
    options.chancePercent !== undefined
      ? options.chancePercent
      : env.AUTO_CHATFIGHT_CHANCE_PERCENT,
    DEFAULT_AUTO_CHANCE_PERCENT
  );
  const types = options.types || parseAutoFightTypes(env.AUTO_CHATFIGHT_TYPES);
  const hours = resolveActiveHoursFromEnv(env);
  const startHour =
    options.startHour !== undefined ? options.startHour : hours.startHour;
  const endHour =
    options.endHour !== undefined ? options.endHour : hours.endHour;
  const slots =
    options.slots || buildAutoChatFightSlots(intervalMinutes, startHour, endHour);

  return {
    enabled,
    intervalMinutes,
    minGapMinutes,
    minGapMs: minGapMinutes * 60_000,
    chancePercent,
    types,
    startHour,
    endHour,
    slots,
  };
}

function emptyAutoChatFightState() {
  return {
    processedSlots: {},
    lastStartedAt: null,
    lastType: null,
  };
}

function normalizeAutoChatFightState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyAutoChatFightState();
  }
  const processedSlots =
    raw.processedSlots &&
    typeof raw.processedSlots === "object" &&
    !Array.isArray(raw.processedSlots)
      ? raw.processedSlots
      : {};
  return {
    processedSlots,
    lastStartedAt:
      typeof raw.lastStartedAt === "number" && Number.isFinite(raw.lastStartedAt)
        ? raw.lastStartedAt
        : null,
    lastType: typeof raw.lastType === "string" ? raw.lastType : null,
  };
}

function wasAutoSlotProcessed(autoState, dayKey, slotId) {
  const list = autoState.processedSlots && autoState.processedSlots[dayKey];
  return Array.isArray(list) && list.includes(slotId);
}

function markAutoSlotProcessed(autoState, dayKey, slotId) {
  if (!autoState.processedSlots[dayKey]) {
    autoState.processedSlots[dayKey] = [];
  }
  if (!autoState.processedSlots[dayKey].includes(slotId)) {
    autoState.processedSlots[dayKey].push(slotId);
  }
}

function pruneAutoProcessedSlots(autoState, keepDays = 14) {
  const entries = Object.entries(autoState.processedSlots || {});
  if (entries.length <= keepDays) {
    return autoState;
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const kept = entries.slice(-keepDays);
  return {
    ...autoState,
    processedSlots: Object.fromEntries(kept),
  };
}

function formatTypeLabel(type) {
  if (type === FIGHT_TYPES.TYPE_RUSH) return "type";
  if (type === FIGHT_TYPES.MATH_RUSH) return "math";
  if (type === FIGHT_TYPES.EMOJI_GUESS) return "emoji";
  if (type === FIGHT_TYPES.UNSCRAMBLE) return "unscramble";
  if (type === FIGHT_TYPES.MISSING_LETTER) return "missing";
  if (type === FIGHT_TYPES.MEMORY) return "memory";
  if (type === FIGHT_TYPES.QUICK_TAP) return "tap";
  return String(type || "");
}

function nextAutoSlotLabel(config, nowClock) {
  if (!config.slots || !config.slots.length || !nowClock) {
    return null;
  }
  for (const slot of config.slots) {
    const target = slot.hour * 60 + slot.minute;
    if (nowClock.totalMinutes < target) {
      return slot.label;
    }
  }
  return null;
}

/**
 * Attempt one auto ChatFight for a crossed slot.
 * Marks slot processed for skip/chance/send-failure (no retry spam).
 * Does NOT start cooldown on skip/failure.
 *
 * @returns {Promise<{ started: boolean, reason?: string, type?: string }>}
 */
async function tryStartAutoChatFight({
  chatId,
  slot,
  dayKey,
  config,
  autoState,
  chatFight = chatFightRuntime,
  announce,
  nowMs,
  random = Math.random,
} = {}) {
  const label = (slot && slot.label) || (slot && slot.id) || "?";

  if (!config || !config.enabled) {
    return { started: false, reason: "disabled" };
  }
  if (!chatId) {
    return { started: false, reason: "missing-chat-id" };
  }
  if (!slot || wasAutoSlotProcessed(autoState, dayKey, slot.id)) {
    return { started: false, reason: "already-processed" };
  }

  function finishSkip(reason) {
    markAutoSlotProcessed(autoState, dayKey, slot.id);
    log(`[auto-chatfight] skipped reason=${reason} slot=${label}`);
    return { started: false, reason };
  }

  if (typeof chatFight.isFightOpen === "function" && chatFight.isFightOpen()) {
    return finishSkip("active-fight");
  }
  try {
    const { isTicTacToeBusy } = require("./communityGameState");
    if (isTicTacToeBusy()) {
      return finishSkip("active-pvp");
    }
  } catch (_err) {
    /* ignore */
  }
  if (typeof chatFight.isOnCooldown === "function" && chatFight.isOnCooldown()) {
    return finishSkip("cooldown");
  }

  const lastAuto = autoState.lastStartedAt;
  if (
    lastAuto != null &&
    config.minGapMs > 0 &&
    nowMs - lastAuto < config.minGapMs
  ) {
    return finishSkip("min-gap");
  }

  const roll = Math.floor(random() * 100);
  if (roll >= config.chancePercent) {
    return finishSkip("chance");
  }

  if (typeof announce !== "function") {
    return finishSkip("missing-announcer");
  }

  const started = chatFight.startFight({
    chatId,
    type: null,
    types: config.types,
    avoidType: autoState.lastType,
    source: "auto",
  });

  if (!started.ok) {
    return finishSkip(started.reason || "start-failed");
  }

  try {
    const sent = await announce(
      chatId,
      started.teaser,
      started.revealKeyboard || getRevealKeyboard()
    );
    const messageId =
      sent && (sent.message_id != null ? sent.message_id : sent.messageId);
    if (messageId != null && typeof chatFight.setFightMessageId === "function") {
      chatFight.setFightMessageId(messageId);
    }
  } catch (_err) {
    logError("[auto-chatfight] start failed");
    if (typeof chatFight.abortUnpublishedFight === "function") {
      chatFight.abortUnpublishedFight();
    }
    markAutoSlotProcessed(autoState, dayKey, slot.id);
    return { started: false, reason: "send-failed" };
  }

  markAutoSlotProcessed(autoState, dayKey, slot.id);
  autoState.lastStartedAt = nowMs;
  autoState.lastType = started.fight && started.fight.type;
  log(
    `[auto-chatfight] started type=${formatTypeLabel(autoState.lastType)} slot=${label}`
  );
  return {
    started: true,
    type: autoState.lastType,
    reason: "started",
  };
}

module.exports = {
  DEFAULT_AUTO_INTERVAL_MINUTES,
  DEFAULT_AUTO_GAP_MINUTES,
  DEFAULT_AUTO_CHANCE_PERCENT,
  parseAutoEnabledFlag,
  parseChancePercent,
  parseAutoFightTypes,
  parseAutoChatFightConfig,
  buildAutoChatFightSlots,
  emptyAutoChatFightState,
  normalizeAutoChatFightState,
  wasAutoSlotProcessed,
  markAutoSlotProcessed,
  pruneAutoProcessedSlots,
  formatTypeLabel,
  nextAutoSlotLabel,
  tryStartAutoChatFight,
  resolveActiveHoursFromEnv,
};
