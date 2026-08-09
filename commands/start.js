/**
 * /start — welcome, private menu, and deep-link payloads (snake / bounch).
 */

const { handleSnake } = require("./snake");
const { handleBounch } = require("./bounch");
const {
  isPrivateChat,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");

const WELCOME_MESSAGE = "🥭 Welcome to ManGo Bot!\n\nType /help for commands.";

/**
 * @param {object} ctx
 * @param {{ secret?: string, ttlSeconds?: number, now?: number }} [options]
 */
function handleStart(ctx, options = {}) {
  const payload =
    typeof ctx.startPayload === "string" ? ctx.startPayload.trim().toLowerCase() : "";

  if (isPrivateChat(ctx)) {
    if (payload === "snake") {
      return handleSnake(ctx, options);
    }
    if (payload === "bounch") {
      return handleBounch(ctx, options);
    }

    return ctx.reply(WELCOME_MESSAGE, getPrivateMenuKeyboard());
  }

  // Groups / other chats: never mint personal signed game tokens from /start.
  return ctx.reply(WELCOME_MESSAGE);
}

module.exports = (bot) => {
  bot.start((ctx) => handleStart(ctx));
};

module.exports.handleStart = handleStart;
module.exports.WELCOME_MESSAGE = WELCOME_MESSAGE;
