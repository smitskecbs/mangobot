/**
 * /points — show a user's lifetime and weekly points.
 */

const {
  loadPoints,
  getUserRecord,
  getRank,
  getEffectiveWeeklyPoints,
  formatClaimedTodayLines,
  formatBounchUnlocksLine,
} = require("../services/points");
const {
  isPrivateChat,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");

function handlePoints(ctx, options = {}) {
  const data = loadPoints(options.pointsFile);
  const user = getUserRecord(data, ctx.from.id);
  const name = ctx.from.first_name || "friend";
  const rank = getRank(user.points);
  const weeklyPoints = getEffectiveWeeklyPoints(user);
  const claimedToday = formatClaimedTodayLines(user);
  const bounchUnlocks = formatBounchUnlocksLine(user);
  const lifetimeLabel = user.points === 1 ? "point" : "points";
  const weeklyLabel = weeklyPoints === 1 ? "point" : "points";

  const text = `🥭 ${name}

Lifetime points: ${user.points} ${lifetimeLabel}
Weekly points: ${weeklyPoints} ${weeklyLabel}
Rank: ${rank.emoji} ${rank.title}

Claimed today:
${claimedToday}

${bounchUnlocks}`;

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getPrivateMenuKeyboard());
  }
  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("points", handlePoints);
};

module.exports.handlePoints = handlePoints;
