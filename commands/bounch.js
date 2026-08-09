/**
 * /bounch — personal signed play link (private only) or private deep-link gate (groups).
 */

const { getGameCommandReply } = require("../utils/gameLinks");
const {
  isPrivateChat,
  getPrivateMenuKeyboard,
  getGroupGameMessage,
  getGroupGameGateExtra,
} = require("../utils/botMenu");

/**
 * @param {object} ctx
 * @param {{ secret?: string, ttlSeconds?: number, now?: number }} [options]
 */
function handleBounch(ctx, options = {}) {
  if (!isPrivateChat(ctx)) {
    return ctx.reply(
      getGroupGameMessage("bounch"),
      getGroupGameGateExtra(ctx, "bounch")
    );
  }

  const userId = ctx.from && ctx.from.id;
  return ctx.reply(
    getGameCommandReply(userId, "bounch", options),
    getPrivateMenuKeyboard()
  );
}

module.exports = (bot) => {
  bot.command("bounch", (ctx) => handleBounch(ctx));
};

module.exports.handleBounch = handleBounch;
