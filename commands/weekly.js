/**
 * /weekly — top 10 weekly points leaders.
 */

const { loadPoints, getEffectiveWeeklyPoints } = require("../services/points");
const {
  getWeeklyTop,
  formatWeeklyLines,
} = require("../services/leaderboard");
const {
  isPrivateChat,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");

function handleWeekly(ctx, options = {}) {
  const data = loadPoints(options.pointsFile);
  const top = getWeeklyTop(data.users, getEffectiveWeeklyPoints);

  let text;
  if (top.length === 0) {
    text =
      "🥭 Weekly leaderboard is empty. Type gmango, gnango, gm or gn to earn points!";
  } else {
    const lines = formatWeeklyLines(top);
    text = `🥭 Weekly ManGo Leaders\n\n${lines.join("\n")}`;
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getPrivateMenuKeyboard());
  }
  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("weekly", handleWeekly);
};

module.exports.handleWeekly = handleWeekly;
