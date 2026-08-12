/**
 * /chatfightstatus — admin-only operational status (no answers/secrets).
 */

const { isAdmin } = require("../services/points");
const { canManageGroup } = require("../utils/admin");
const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const { getRuntimeStatus } = require("../services/chatFight");
const {
  parseAutoChatFightConfig,
  formatTypeLabel,
  nextAutoSlotLabel,
} = require("../services/autoChatFight");
const {
  parseActivityEngineConfig,
  nextActivitySlotLabel,
} = require("../services/communityActivityEngine");
const {
  getZonedClock,
  DEFAULT_TIMEZONE,
  loadState,
  DEFAULT_STATE_FILE,
  getCommunitySchedulerDiagnostics,
} = require("../services/communityScheduler");

function typeListLabel(types) {
  return (types || [])
    .map((t) => formatTypeLabel(t))
    .filter(Boolean)
    .join(", ");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatLastAuto(autoState) {
  if (!autoState || autoState.lastStartedAt == null) {
    return "never";
  }
  const mins = Math.max(
    0,
    Math.floor((Date.now() - autoState.lastStartedAt) / 60_000)
  );
  return `${mins} min ago`;
}

/**
 * @param {object} ctx
 * @param {object} [options]
 */
async function handleChatFightStatus(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return;
  }

  const isAdminFn =
    typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;
  const canManageFn =
    typeof options.canManageGroupFn === "function"
      ? options.canManageGroupFn
      : canManageGroup;
  const getStatus =
    typeof options.getRuntimeStatusFn === "function"
      ? options.getRuntimeStatusFn
      : getRuntimeStatus;
  const autoConfig =
    options.autoConfig || parseAutoChatFightConfig(process.env);
  const activityConfig =
    options.activityConfig || parseActivityEngineConfig(process.env);

  let allowed = false;
  if (isPrivateChat(ctx)) {
    allowed = Boolean(isAdminFn(ctx.from.id));
  } else if (isGroupChat(ctx)) {
    try {
      allowed = Boolean(
        await canManageFn(ctx, {
          isAdminFn,
          getChatMember: options.getChatMember,
        })
      );
    } catch (_err) {
      allowed = false;
    }
  }

  if (!allowed) {
    return ctx.reply("⚔️ ChatFight status is admin only.");
  }

  const runtime = getStatus();
  const timeZone =
    (process.env.COMMUNITY_TIMEZONE || DEFAULT_TIMEZONE).trim() ||
    DEFAULT_TIMEZONE;
  const now = options.now ? options.now() : new Date();
  const clock = getZonedClock(now, timeZone);
  const nextAuto = nextAutoSlotLabel(autoConfig, clock);
  const nextActivity = nextActivitySlotLabel(activityConfig, clock);

  const diagnostics =
    typeof options.getDiagnosticsFn === "function"
      ? options.getDiagnosticsFn(now)
      : getCommunitySchedulerDiagnostics(now);

  let state = { autoChatFight: {} };
  try {
    state = loadState(options.stateFile || DEFAULT_STATE_FILE);
  } catch (_err) {
    state = { autoChatFight: {} };
  }

  let currentLabel = "none";
  if (runtime.currentFight === "waiting") {
    currentLabel = "waiting";
  } else if (runtime.currentFight === "prepare") {
    currentLabel = "prepare";
  } else if (runtime.currentFight === "active") {
    currentLabel = "active";
  } else if (runtime.currentFight && runtime.currentFight !== "none") {
    currentLabel = runtime.currentFight;
  }

  const cooldownText =
    runtime.cooldownRemainingMs > 0
      ? `${runtime.cooldownRemainingMinutes} min remaining`
      : "none";

  const envInterval = process.env.AUTO_CHATFIGHT_INTERVAL_MINUTES || "unset";
  const effectiveInterval = activityConfig.enabled
    ? activityConfig.intervalMinutes
    : autoConfig.intervalMinutes;

  const lastProcessed =
    diagnostics.lastProcessedActivitySlot ||
    state.lastProcessedActivitySlot ||
    "none";

  const text = `⚔️ ChatFight status

Auto enabled: ${autoConfig.enabled || activityConfig.autoFightEnabled ? "yes" : "no"}
Configured auto interval: ${envInterval}
Effective interval: ${effectiveInterval} min
Activity engine enabled: ${activityConfig.enabled ? "yes" : "no"}
24/7: ${activityConfig.twentyFourSeven ? "yes" : "no"}
Activity interval: ${activityConfig.intervalMinutes} min
Activity slots: ${activityConfig.slots.length}
Scheduler timer running: ${diagnostics.timerRunning ? "yes" : "no"}
Last checked: ${diagnostics.lastChecked}
Last processed activity slot: ${lastProcessed}
State file: ${diagnostics.stateFile}
Next activity slot: ${diagnostics.nextActivitySlot || nextActivity || "none"}
Auto fight min gap: ${activityConfig.autoFightMinGapMinutes} min
Active hours: ${pad2(autoConfig.startHour)}:00–${pad2(autoConfig.endHour)}:00
Current fight: ${currentLabel}
Cooldown: ${cooldownText}
Last auto fight: ${formatLastAuto(state.autoChatFight)}
Next auto slot: ${nextAuto || "none today"}
Enabled race types: ${typeListLabel(autoConfig.types) || "type, math, emoji, ..."}`;

  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("chatfightstatus", (ctx) =>
    Promise.resolve(handleChatFightStatus(ctx)).catch(() => undefined)
  );
};

module.exports.handleChatFightStatus = handleChatFightStatus;
