/**
 * /menu — private reply keyboard, or compact inline group menu with submenus.
 * Rankings / Help use public replies; Snake/Bounch/Points/Streak/Wallet/Rewards
 * use private deep-links. Tic-Tac-Toe / Connect Four / Trivia / ManGo Bomb reuse command handlers.
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
const { handleMangoBomb } = require("./mangobomb");
const { handleWallet } = require("./wallet");
const { handleRewards } = require("./rewards");
const { handlePresale } = require("./presale");
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
  GROUP_PROFILE_TEXT,
  PRIVATE_MENU_HINT,
  GROUP_MENU_CALLBACK,
  PRIVATE_HUB_CALLBACK,
  isPrivateChat,
  isGroupChat,
  getPrivateMenuKeyboard,
  getPrivateProfileMenuExtra,
  getGroupMenuExtra,
  getGroupRankingsMenuExtra,
  getGroupGamesMenuExtra,
  getGroupProfileMenuExtra,
  isGroupMenuCallback,
  isGroupMenuNavCallback,
  isPrivateHubCallback,
} = require("../utils/botMenu");

const GROUP_MENU_ACTION_RE = new RegExp(
  `^(${[
    GROUP_MENU_CALLBACK.RANKINGS,
    GROUP_MENU_CALLBACK.GAMES,
    GROUP_MENU_CALLBACK.PROFILE,
    GROUP_MENU_CALLBACK.PROGRESS,
    GROUP_MENU_CALLBACK.WALLET,
    GROUP_MENU_CALLBACK.REWARDS,
    GROUP_MENU_CALLBACK.PRESALE,
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
    GROUP_MENU_CALLBACK.MANGOBOMB,
  ].join("|")})$`
);

const PRIVATE_HUB_ACTION_RE = new RegExp(
  `^(${[
    PRIVATE_HUB_CALLBACK.PROFILE_BACK,
    PRIVATE_HUB_CALLBACK.POINTS,
    PRIVATE_HUB_CALLBACK.STREAK,
    PRIVATE_HUB_CALLBACK.WALLET_STATUS,
    PRIVATE_HUB_CALLBACK.REWARDS,
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
 * Private My Profile submenu.
 * @param {object} ctx
 */
function handlePrivateProfile(ctx) {
  if (!isPrivateChat(ctx)) {
    return undefined;
  }
  return ctx.reply(GROUP_PROFILE_TEXT, getPrivateProfileMenuExtra());
}

/**
 * @param {object} ctx
 * @param {object} [options]
 */
async function handlePrivateHubCallback(ctx, options = {}) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";

  if (!isPrivateHubCallback(data)) {
    return;
  }

  try {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery();
    }
  } catch {
    // Non-fatal: still try to deliver the private reply.
  }

  if (!isPrivateChat(ctx)) {
    return;
  }

  if (data === PRIVATE_HUB_CALLBACK.PROFILE_BACK) {
    return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard());
  }
  if (data === PRIVATE_HUB_CALLBACK.POINTS) {
    return handlePoints(ctx, options);
  }
  if (data === PRIVATE_HUB_CALLBACK.STREAK) {
    return handleMyStreak(ctx, options);
  }
  if (data === PRIVATE_HUB_CALLBACK.WALLET_STATUS) {
    return handleWallet(ctx, options);
  }
  if (data === PRIVATE_HUB_CALLBACK.REWARDS) {
    return handleRewards(ctx, options);
  }
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
    if (
      data === GROUP_MENU_CALLBACK.PROFILE ||
      data === GROUP_MENU_CALLBACK.PROGRESS
    ) {
      return showMenuView(
        ctx,
        GROUP_PROFILE_TEXT,
        getGroupProfileMenuExtra(ctx)
      );
    }
    if (data === GROUP_MENU_CALLBACK.BACK) {
      return showMenuView(ctx, GROUP_MENU_TEXT, getGroupMenuExtra(ctx));
    }
  }

  if (data === GROUP_MENU_CALLBACK.WALLET) {
    return handleWallet(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.REWARDS) {
    return handleRewards(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.PRESALE) {
    return handlePresale(ctx, options);
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
  if (data === GROUP_MENU_CALLBACK.MANGOBOMB) {
    return handleMangoBomb(ctx, options);
  }
}

module.exports = (bot) => {
  bot.command("menu", handleMenu);

  bot.action(GROUP_MENU_ACTION_RE, (ctx) => handleGroupMenuCallback(ctx));
  bot.action(PRIVATE_HUB_ACTION_RE, (ctx) => handlePrivateHubCallback(ctx));

  bot.hears(MENU_LABELS.MY_PROFILE, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handlePrivateProfile(ctx);
  });

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

  bot.hears(MENU_LABELS.WALLET, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleWallet(ctx);
  });

  bot.hears(MENU_LABELS.REWARDS, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleRewards(ctx);
  });

  bot.hears(MENU_LABELS.PRESALE, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handlePresale(ctx);
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
module.exports.handlePrivateProfile = handlePrivateProfile;
module.exports.handlePrivateHubCallback = handlePrivateHubCallback;
module.exports.showMenuView = showMenuView;
