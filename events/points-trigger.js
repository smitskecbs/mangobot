/**
 * Award points when users send daily trigger words (gmango, gnango, gm, gn).
 */

const { TRIGGERS, awardTriggerPoints } = require("../services/points");

module.exports = (bot) => {
  bot.on("text", (ctx) => {
    const text = ctx.message.text.trim().toLowerCase();
    const pointsToAdd = TRIGGERS[text];

    if (pointsToAdd === undefined) {
      return;
    }

    const userName = ctx.from.first_name || ctx.from.username || "friend";
    const result = awardTriggerPoints(ctx.from.id, userName, text);

    if (!result.awarded) {
      ctx.reply("🥭 Already claimed today. Try another ManGo trigger!");
    }
  });
};
