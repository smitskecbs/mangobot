/**
 * /resetweekly — admin-only weekly points reset.
 */

const { isAdmin, resetWeeklyForAll } = require("../services/points");

module.exports = (bot) => {
  bot.command("resetweekly", (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      ctx.reply("This command is admin only.");
      return;
    }

    resetWeeklyForAll();
    ctx.reply("🥭 Weekly points reset for all users.");
  });
};
