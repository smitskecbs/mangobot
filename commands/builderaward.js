/**
 * Admin-only /builderaward — reply to a member to grant 1–5 Builder Points.
 * Target comes only from reply-to. Uses ADMIN_USER_ID, not Telegram group admins.
 */

const { isAdmin } = require("../services/points");
const { getReplyTargetUser, parseCommandArg } = require("../utils/telegramReplyTarget");
const { isPrivateChat } = require("../utils/botMenu");
const {
  grantManualBuilderAward,
} = require("../services/communityBuilder");

const ADMIN_ONLY = "This command is admin only.";
const USAGE =
  "Reply to a member's message with /builderaward <points> <reason>.";
const POINTS_TEXT = "Award 1 to 5 Builder Points as a whole number.";
const REASON_TEXT = "Add a short reason (3–120 characters).";

function formatAdminConfirmation(displayName, points, reason) {
  return [
    "🤝 Builder Award",
    "",
    `${displayName} received +${points} BP`,
    "",
    "Reason:",
    reason,
  ].join("\n");
}

function handleBuilderAward(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }

  const target = getReplyTargetUser(ctx);
  if (!target) {
    return ctx.reply(USAGE);
  }

  const result = grantManualBuilderAward(
    {
      adminUserId: ctx.from.id,
      targetUserId: target.id,
      targetDisplayName: target.firstName,
      targetIsBot: false,
      rawArg: parseCommandArg(ctx),
      chatId: ctx.chat && ctx.chat.id,
      messageId: ctx.message && ctx.message.message_id,
    },
    options
  );

  if (!result.ok) {
    if (result.reason === "points") {
      return ctx.reply(POINTS_TEXT);
    }
    if (result.reason === "reason" || result.reason === "reason-length") {
      return ctx.reply(REASON_TEXT);
    }
    if (result.reason === "duplicate") {
      return undefined;
    }
    return ctx.reply(USAGE);
  }

  return ctx.reply(
    formatAdminConfirmation(result.displayName, result.points, result.reason)
  );
}

module.exports = (bot) => {
  bot.command("builderaward", (ctx) => handleBuilderAward(ctx));
};

module.exports.handleBuilderAward = handleBuilderAward;
module.exports.USAGE = USAGE;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.POINTS_TEXT = POINTS_TEXT;
module.exports.REASON_TEXT = REASON_TEXT;
module.exports.formatAdminConfirmation = formatAdminConfirmation;
