/**
 * /snake — personal signed play link (private only) or private deep-link gate (groups).
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
 * @param {{ secret?: string, ttlSeconds?: number, now?: number, name?: string }} [options]
 */
function handleSnake(ctx, options = {}) {
  if (!isPrivateChat(ctx)) {
    return ctx.reply(
      getGroupGameMessage("snake"),
      getGroupGameGateExtra(ctx, "snake")
    );
  }

  const userId = ctx.from && ctx.from.id;
  const displayName =
    options.name !== undefined
      ? options.name
      : ctx.from && ctx.from.first_name;
  return ctx.reply(
    getGameCommandReply(userId, "snake", { ...options, name: displayName }),
    getPrivateMenuKeyboard()
  );
}

module.exports = (bot) => {
  bot.command("snake", (ctx) => handleSnake(ctx));
};

module.exports.handleSnake = handleSnake;
