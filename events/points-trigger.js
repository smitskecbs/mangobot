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

module.exports = (bot) => {
  bot.on("text", (ctx) => {
    if (!ctx.from) {
      return;
    }

    const text = ctx.message.text;
    const userName = ctx.from.first_name || ctx.from.username || "friend";
    const userId = ctx.from.id;

    let activityResult = null;
    if (!ctx.from.is_bot && !isCommandText(text)) {
      activityResult = awardDailyActivityPoint(userId, userName);
    }

    const trigger = detectTrigger(text);
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
