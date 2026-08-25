/**
 * /start — welcome, private menu, and deep-link payloads (snake / bounch / points / streak / wallet / rewards / presale / builder).
 */

const { handleSnake } = require("./snake");
const { handleBounch } = require("./bounch");
const { handlePoints } = require("./points");
const { handleMyStreak } = require("./streak");
const { handleWallet } = require("./wallet");
const { handleRewards } = require("./rewards");
const { handlePresale } = require("./presale");
const { handleCommunityBuilder } = require("./communitybuilder");
const { handleShop } = require("./shop");
const { handleDailyQuest } = require("./dailyquest");
const {
  isPrivateChat,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");

const WELCOME_MESSAGE = "🥭 Welcome to ManGo Bot!\n\nType /help for commands.";

/**
 * @param {object} ctx
 * @param {{ secret?: string, ttlSeconds?: number, now?: number, pointsFile?: string }} [options]
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
    if (payload === "points") {
      return handlePoints(ctx, options);
    }
    if (payload === "streak") {
      return handleMyStreak(ctx, options);
    }
    if (payload === "wallet") {
      return handleWallet(ctx, options);
    }
    if (payload === "rewards") {
      return handleRewards(ctx, options);
    }
    if (payload === "presale") {
      return handlePresale(ctx, options);
    }
    if (payload === "builder") {
      return handleCommunityBuilder(ctx, options);
    }
    if (payload === "shop") {
      return handleShop(ctx, options);
    }
    if (payload === "dailyquest") {
      return handleDailyQuest(ctx, options);
    }

    return ctx.reply(WELCOME_MESSAGE, getPrivateMenuKeyboard(ctx));
  }

  // Groups / other chats: never mint personal signed game tokens or show private points.
  return ctx.reply(WELCOME_MESSAGE);
}

module.exports = (bot) => {
  bot.start((ctx) => handleStart(ctx));
};

module.exports.handleStart = handleStart;
module.exports.WELCOME_MESSAGE = WELCOME_MESSAGE;
