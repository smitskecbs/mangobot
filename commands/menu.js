/**
 * /menu — private reply keyboard, or compact inline group menu with submenus.
 * Rankings / Help use public replies; Snake/Bounch/Points/Streak use private deep-links.
 * Tic-Tac-Toe / Connect Four / Trivia reuse command handlers (same admin policy).
 */

const { handlePoints } = require("./points");
const { handleSnake } = require("./snake");
const { handleBounch } = require("./bounch");
const { handleLeaderboard } = require("./leaderboard");
const { handleWeekly } = require("./weekly");
const { handleWeeklyWinners } = require("./weeklywinners");
const { handleHelp } = require("./help");
const { handleTicTacToe } = require("./tictactoe");
const { handleConnectFour } = require("./connect4");
const { handleTrivia } = require("./trivia");
const {
  handleStreak,
  handleStreakRecord,
  handleMyStreak,
} = require("./streak");
const {
  MENU_LABELS,
  GROUP_MENU_TEXT,
  GROUP_RANKINGS_TEXT,
  GROUP_GAMES_TEXT,
  GROUP_PROGRESS_TEXT,
  PRIVATE_MENU_HINT,
  GROUP_MENU_CALLBACK,
  isPrivateChat,
  isGroupChat,
  getPrivateMenuKeyboard,
  getGroupMenuExtra,
  getGroupRankingsMenuExtra,
  getGroupGamesMenuExtra,
  getGroupProgressMenuExtra,
  isGroupMenuCallback,
  isGroupMenuNavCallback,
} = require("../utils/botMenu");

const GROUP_MENU_ACTION_RE = new RegExp(
  `^(${[
    GROUP_MENU_CALLBACK.RANKINGS,
    GROUP_MENU_CALLBACK.GAMES,
    GROUP_MENU_CALLBACK.PROGRESS,
    GROUP_MENU_CALLBACK.BACK,
    GROUP_MENU_CALLBACK.LEADERBOARD,
    GROUP_MENU_CALLBACK.WEEKLY,
    GROUP_MENU_CALLBACK.WEEKLY_WINNERS,
    GROUP_MENU_CALLBACK.STREAK,
    GROUP_MENU_CALLBACK.STREAK_RECORD,
    GROUP_MENU_CALLBACK.HELP,
    GROUP_MENU_CALLBACK.TICTACTOE,
    GROUP_MENU_CALLBACK.CONNECT4,
    GROUP_MENU_CALLBACK.TRIVIA,
  ].join("|")})$`
);

/**
 * Edit the menu message in place; fall back to a new reply if edit fails.
 * @param {object} ctx
 * @param {string} text
 * @param {object} extra
 */
async function showMenuView(ctx, text, extra) {
  if (typeof ctx.editMessageText === "function") {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (_err) {
      // Message not editable (e.g. too old) — reply instead.
    }
  }
  return ctx.reply(text, extra);
}

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
 * @param {object} [options]
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

  if (isGroupMenuNavCallback(data)) {
    if (data === GROUP_MENU_CALLBACK.RANKINGS) {
      return showMenuView(ctx, GROUP_RANKINGS_TEXT, getGroupRankingsMenuExtra());
    }
    if (data === GROUP_MENU_CALLBACK.GAMES) {
      return showMenuView(ctx, GROUP_GAMES_TEXT, getGroupGamesMenuExtra(ctx));
    }
    if (data === GROUP_MENU_CALLBACK.PROGRESS) {
      return showMenuView(
        ctx,
        GROUP_PROGRESS_TEXT,
        getGroupProgressMenuExtra(ctx)
      );
    }
    if (data === GROUP_MENU_CALLBACK.BACK) {
      return showMenuView(ctx, GROUP_MENU_TEXT, getGroupMenuExtra(ctx));
    }
  }

  if (data === GROUP_MENU_CALLBACK.LEADERBOARD) {
    return handleLeaderboard(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.WEEKLY) {
    return handleWeekly(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.WEEKLY_WINNERS) {
    return handleWeeklyWinners(ctx, options);
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
  if (data === GROUP_MENU_CALLBACK.TICTACTOE) {
    return handleTicTacToe(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.CONNECT4) {
    return handleConnectFour(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.TRIVIA) {
    return handleTrivia(ctx, options);
  }
}

module.exports = (bot) => {
  bot.command("menu", handleMenu);

  bot.action(GROUP_MENU_ACTION_RE, (ctx) => handleGroupMenuCallback(ctx));

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
module.exports.showMenuView = showMenuView;
