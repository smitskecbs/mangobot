/**
 * /weekly — top 10 weekly points leaders.
 */

const { loadPoints, getEffectiveWeeklyPoints } = require("../services/points");
const {
  getWeeklyTop,
  formatWeeklyLines,
} = require("../services/leaderboard");

module.exports = (bot) => {
  bot.command("weekly", (ctx) => {
    const data = loadPoints();
    const top = getWeeklyTop(data.users, getEffectiveWeeklyPoints);

    if (top.length === 0) {
      ctx.reply(
        "🥭 Weekly leaderboard is empty. Type gmango, gnango, gm or gn to earn points!"
      );
      return;
    }

    const lines = formatWeeklyLines(top);
    ctx.reply(`🥭 Weekly ManGo Leaders\n\n${lines.join("\n")}`);
  });
};
