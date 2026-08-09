/**
 * /snake — personal signed play link and leaderboard pointer.
 */

const { getGameCommandReply } = require("../utils/gameLinks");

module.exports = (bot) => {
  bot.command("snake", (ctx) => {
    const userId = ctx.from && ctx.from.id;
    return ctx.reply(getGameCommandReply(userId, "snake"));
  });
};
