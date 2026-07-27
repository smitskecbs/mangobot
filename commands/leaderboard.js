/**
 * /leaderboard — top 10 lifetime points leaders.
 */

const { loadPoints, getRank } = require("../services/points");
const {
  getLifetimeTop,
  formatLifetimeLines,
} = require("../services/leaderboard");

module.exports = (bot) => {
  bot.command("leaderboard", (ctx) => {
    const data = loadPoints();
    const top = getLifetimeTop(data.users);

    if (top.length === 0) {
      ctx.reply(
        "🥭 Leaderboard is empty. Type gmango, gnango, gm or gn to earn points!"
      );
      return;
    }

    const lines = formatLifetimeLines(top, getRank);
    ctx.reply(`🥭 ManGo Leaderboard — Top 10\n\n${lines.join("\n")}`);
  });
};
