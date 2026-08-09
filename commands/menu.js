/**
 * Private reply-keyboard menu: route exact labels to existing command handlers.
 * Registered under commands/ so it loads before events/points-trigger.js.
 */

const { handlePoints } = require("./points");
const { handleSnake } = require("./snake");
const { handleBounch } = require("./bounch");
const { handleLeaderboard } = require("./leaderboard");
const { handleWeekly } = require("./weekly");
const { handleHelp } = require("./help");
const { MENU_LABELS, isPrivateChat } = require("../utils/botMenu");

module.exports = (bot) => {
  bot.hears(MENU_LABELS.POINTS, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handlePoints(ctx);
  });

  bot.hears(MENU_LABELS.SNAKE, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleSnake(ctx);
  });

  bot.hears(MENU_LABELS.BOUNCH, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleBounch(ctx);
  });

  bot.hears(MENU_LABELS.LEADERBOARD, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleLeaderboard(ctx);
  });

  bot.hears(MENU_LABELS.WEEKLY, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleWeekly(ctx);
  });

  bot.hears(MENU_LABELS.HELP, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleHelp(ctx);
  });
};
