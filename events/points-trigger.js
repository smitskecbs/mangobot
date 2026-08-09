/**
 * Text pipeline: daily activity (silent) then gm/gn trigger awards.
 * Rank-ups may announce; activity itself never posts "+1".
 */

const {
  isCommandText,
  detectTrigger,
  awardDailyActivityPoint,
  awardTriggerPoints,
  getCombinedRankUpReply,
} = require("../services/points");
const {
  isPrivateChat,
  isPrivateMenuLabel,
} = require("../utils/botMenu");

/**
 * Private reply-keyboard taps are UI actions, not community messages.
 * @param {object} ctx
 * @param {string} text
 * @returns {boolean}
 */
function shouldSkipCommunityActivity(ctx, text) {
  if (isCommandText(text)) {
    return true;
  }
  return isPrivateChat(ctx) && isPrivateMenuLabel(text);
}

module.exports = (bot) => {
  bot.on("text", (ctx) => {
    if (!ctx.from) {
      return;
    }

    const text = ctx.message.text;
    const userName = ctx.from.first_name || ctx.from.username || "friend";
    const userId = ctx.from.id;
    const skipActivity = shouldSkipCommunityActivity(ctx, text);
    const isMenuTap = isPrivateChat(ctx) && isPrivateMenuLabel(text);

    let activityResult = null;
    if (!ctx.from.is_bot && !skipActivity) {
      activityResult = awardDailyActivityPoint(userId, userName);
    }

    const trigger = isMenuTap ? null : detectTrigger(text);
    let triggerResult = null;
    if (trigger) {
      triggerResult = awardTriggerPoints(userId, userName, trigger);
    }

    const reply = getCombinedRankUpReply(activityResult, triggerResult, userName);
    if (reply) {
      ctx.reply(reply);
    }
  });
};

module.exports.shouldSkipCommunityActivity = shouldSkipCommunityActivity;
