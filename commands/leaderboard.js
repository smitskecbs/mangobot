/**
 * /leaderboard — top 10 lifetime points leaders.
 */

const { loadPoints, getRank } = require("../services/points");
const {
  getLifetimeTop,
  formatLifetimeLines,
} = require("../services/leaderboard");
const {
  isPrivateChat,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");

function handleLeaderboard(ctx, options = {}) {
  const data = loadPoints(options.pointsFile);
  const top = getLifetimeTop(data.users);

  let text;
  if (top.length === 0) {
    text =
      "🥭 Leaderboard is empty. Type gmango, gnango, gm or gn to earn points!";
  } else {
    const lines = formatLifetimeLines(top, getRank);
    text = `🥭 ManGo Leaderboard — Top 10\n\n${lines.join("\n")}`;
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getPrivateMenuKeyboard());
  }
  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("leaderboard", handleLeaderboard);
};

module.exports.handleLeaderboard = handleLeaderboard;
