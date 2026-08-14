/**
 * /menu — private reply keyboard, or compact inline group menu.
 * Callback actions for Leaderboard / Weekly / Help are safe for any clicker.
 * My Points / Snake / Bounch use private deep-links (no public personal data).
 */

const { handlePoints } = require("./points");
const { handleSnake } = require("./snake");
const { handleBounch } = require("./bounch");
const { handleLeaderboard } = require("./leaderboard");
const { handleWeekly } = require("./weekly");
const { handleHelp } = require("./help");
const {
  handleStreak,
  handleStreakRecord,
  handleMyStreak,
} = require("./streak");
const {
  MENU_LABELS,
  GROUP_MENU_TEXT,
  PRIVATE_MENU_HINT,
  GROUP_MENU_CALLBACK,
  isPrivateChat,
  isGroupChat,
  getPrivateMenuKeyboard,
  getGroupMenuExtra,
  isGroupMenuCallback,
} = require("../utils/botMenu");

/**
 * @param {object} ctx
 */
function handleMenu(ctx) {
  if (isPrivateChat(ctx)) {
    return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard());
  }

  if (isGroupChat(ctx)) {
    return ctx.reply(GROUP_MENU_TEXT, getGroupMenuExtra(ctx));
  }

  return ctx.reply(GROUP_MENU_TEXT);
}

/**
 * @param {object} ctx
 * @param {{ pointsFile?: string }} [options]
 */
async function handleGroupMenuCallback(ctx, options = {}) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";

  if (!isGroupMenuCallback(data)) {
    return;
  }

  try {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery();
    }
  } catch {
    // Non-fatal: still try to deliver the public reply.
  }

  if (data === GROUP_MENU_CALLBACK.LEADERBOARD) {
    return handleLeaderboard(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.WEEKLY) {
    return handleWeekly(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.STREAK) {
    return handleStreak(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.STREAK_RECORD) {
    return handleStreakRecord(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.HELP) {
    return handleHelp(ctx);
  }
}

module.exports = (bot) => {
  bot.command("menu", handleMenu);

  bot.action(
    new RegExp(
      `^(${GROUP_MENU_CALLBACK.LEADERBOARD}|${GROUP_MENU_CALLBACK.WEEKLY}|${GROUP_MENU_CALLBACK.STREAK}|${GROUP_MENU_CALLBACK.STREAK_RECORD}|${GROUP_MENU_CALLBACK.HELP})$`
    ),
    (ctx) => handleGroupMenuCallback(ctx)
  );

  bot.hears(MENU_LABELS.POINTS, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handlePoints(ctx);
  });

  bot.hears(MENU_LABELS.MY_STREAK, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleMyStreak(ctx);
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

module.exports.handleMenu = handleMenu;
module.exports.handleGroupMenuCallback = handleGroupMenuCallback;
