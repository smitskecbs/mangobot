/**
 * /bounch — personal signed play link and leaderboard pointer.
 */

const { getGameCommandReply } = require("../utils/gameLinks");

module.exports = (bot) => {
  bot.command("bounch", (ctx) => {
    const userId = ctx.from && ctx.from.id;
    return ctx.reply(getGameCommandReply(userId, "bounch"));
  });
};
