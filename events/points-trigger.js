/**
 * Award points when users send daily trigger words (gmango, gnango, gm, gn).
 * Silent by default; only announces rank-ups.
 */

const {
  detectTrigger,
  awardTriggerPoints,
  getAutomaticTriggerReply,
} = require("../services/points");

module.exports = (bot) => {
  bot.on("text", (ctx) => {
    const trigger = detectTrigger(ctx.message.text);

    if (!trigger) {
      return;
    }

    const userName = ctx.from.first_name || ctx.from.username || "friend";
    const result = awardTriggerPoints(ctx.from.id, userName, trigger);
    const reply = getAutomaticTriggerReply(result, userName);

    if (reply) {
      ctx.reply(reply);
    }
  });
};
