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
  getZonedClock,
  DEFAULT_TIMEZONE,
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
  const config =
    options.autoConfig || parseAutoChatFightConfig(process.env);

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
  const nextSlot = nextAutoSlotLabel(config, clock);

  let currentLabel = "none";
  if (runtime.currentFight === "waiting") {
    currentLabel = "waiting";
  } else if (runtime.currentFight === "active") {
    currentLabel = "active";
  } else if (runtime.currentFight && runtime.currentFight !== "none") {
    currentLabel = runtime.currentFight;
  }

  const cooldownText =
    runtime.cooldownRemainingMs > 0
      ? `${runtime.cooldownRemainingMinutes} min remaining`
      : "none";

  const text = `⚔️ ChatFight status

Auto enabled: ${config.enabled ? "yes" : "no"}
Auto interval: ${config.intervalMinutes} min
Active hours: ${pad2(config.startHour)}:00–${pad2(config.endHour)}:00
Current fight: ${currentLabel}
Cooldown: ${cooldownText}
Next auto slot: ${nextSlot || "none today"}
Enabled types: ${typeListLabel(config.types) || "type, math, emoji"}`;

  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("chatfightstatus", (ctx) =>
    Promise.resolve(handleChatFightStatus(ctx)).catch(() => undefined)
  );
};

module.exports.handleChatFightStatus = handleChatFightStatus;
