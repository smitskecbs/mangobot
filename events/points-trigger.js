/**
 * Award points when users send daily trigger words (gmango, gnango, gm, gn).
 */

const { detectTrigger, awardTriggerPoints } = require("../services/points");

module.exports = (bot) => {
  bot.on("text", (ctx) => {
    const trigger = detectTrigger(ctx.message.text);

    if (!trigger) {
      return;
    }

    const userName = ctx.from.first_name || ctx.from.username || "friend";
    const result = awardTriggerPoints(ctx.from.id, userName, trigger);

    if (!result.awarded) {
      ctx.reply("🥭 Already claimed today. Try another ManGo trigger!");
    }
  });
};
