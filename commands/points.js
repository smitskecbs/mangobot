/**
 * /points — show a user's lifetime and weekly points.
 */

const {
  loadPoints,
  getUserRecord,
  getRank,
  getTriggersClaimedToday,
  getEffectiveWeeklyPoints,
} = require("../services/points");

module.exports = (bot) => {
  bot.command("points", (ctx) => {
    const data = loadPoints();
    const user = getUserRecord(data, ctx.from.id);
    const name = ctx.from.first_name || "friend";
    const rank = getRank(user.points);
    const weeklyPoints = getEffectiveWeeklyPoints(user);
    const claimedToday = getTriggersClaimedToday(user);
    const claimedText = claimedToday.length > 0 ? claimedToday.join(", ") : "none";
    const lifetimeLabel = user.points === 1 ? "point" : "points";
    const weeklyLabel = weeklyPoints === 1 ? "point" : "points";

    ctx.reply(`🥭 ${name}

Lifetime points: ${user.points} ${lifetimeLabel}
Weekly points: ${weeklyPoints} ${weeklyLabel}
Rank: ${rank.emoji} ${rank.title}

Claimed today: ${claimedText}`);
  });
};
