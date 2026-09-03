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
const { handleCheckers } = require("./checkers");
const { handleTrivia } = require("./trivia");
const { handleMangoBomb } = require("./mangobomb");
const { handleBlackjack } = require("./blackjack");
const { handleWallet } = require("./wallet");
const { handleRewards } = require("./rewards");
const { handlePresale } = require("./presale");
const { handleCommunityBuilder } = require("./communitybuilder");
const { handleShop } = require("./shop");
const { handleDailyQuest } = require("./dailyquest");
const { formatShopProgressBlock } = require("../services/mangoShop");
const {
  handleStreak,
  handleStreakRecord,
  handleMyStreak,
} = require("./streak");
const {
  MENU_LABELS,
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
  isGameMenuCallback,
  isPrivateHubCallback,
  formatGroupMenuText,
  formatGroupRankingsText,
  formatGroupGamesText,
  formatGroupProfileText,
} = require("../utils/botMenu");
const {
  isAllowedGameTopic,
  GAMES_TOPIC_REQUIRED_MESSAGE,
} = require("../utils/gameTopic");
const { sanitizePvpDisplayName } = require("../services/pvpSessionManager");
const {
  rememberSentGroupMenu,
  rememberCallbackGroupMenu,
  rememberGroupMenuOwner,
  getGroupMenuOwner,
  callbackMenuMessageId,
  formatMenuUnauthorizedToast,
  MENU_EXPIRED_GENERIC,
} = require("../utils/menuOwnership");

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
    GROUP_MENU_CALLBACK.CHECKERS,
    GROUP_MENU_CALLBACK.TRIVIA,
    GROUP_MENU_CALLBACK.MANGOBOMB,
    GROUP_MENU_CALLBACK.BLACKJACK,
    GROUP_MENU_CALLBACK.BUILDER,
    GROUP_MENU_CALLBACK.SHOP,
    GROUP_MENU_CALLBACK.DAILY_QUEST,
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

function attachSentMenuOwnership(ctx, result) {
  if (result && typeof result.then === "function") {
    return result.then((sent) => {
      rememberSentGroupMenu(ctx, sent);
      return sent;
    });
  }
  rememberSentGroupMenu(ctx, result);
  return result;
}

/**
 * Edit the menu message in place; fall back to a new reply if edit fails.
 * @param {object} ctx
 * @param {string} text
 * @param {object} extra
 */
async function showMenuView(ctx, text, extra) {
  if (typeof ctx.editMessageText === "function") {
    try {
      const edited = await ctx.editMessageText(text, extra);
      rememberCallbackGroupMenu(ctx);
      if (edited && edited.message_id != null) {
        rememberSentGroupMenu(ctx, edited);
      }
      return edited;
    } catch (_err) {
      // Message not editable (e.g. too old) — reply instead.
    }
  }
  const sent = await ctx.reply(text, extra);
  rememberSentGroupMenu(ctx, sent);
  return sent;
}

async function assertGroupMenuOwner(ctx) {
  const clickerId = ctx && ctx.from ? ctx.from.id : null;
  const chatId = ctx && ctx.chat ? ctx.chat.id : null;
  const messageId = callbackMenuMessageId(ctx);
  const record = getGroupMenuOwner(chatId, messageId);
  if (
    record &&
    clickerId != null &&
    String(record.ownerUserId) === String(clickerId)
  ) {
    const refreshed = rememberGroupMenuOwner(
      chatId,
      messageId,
      clickerId,
      ctx.from || record.displayName
    );
    return { ok: true, record: refreshed || record };
  }
  const toast = record
    ? formatMenuUnauthorizedToast(record.displayName)
    : MENU_EXPIRED_GENERIC;
  if (ctx && typeof ctx.answerCbQuery === "function") {
    await ctx.answerCbQuery(toast).catch(() => {});
  }
  return { ok: false };
}

/**
 * @param {object} ctx
 */
function handleMenu(ctx) {
  if (isPrivateChat(ctx)) {
    return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard(ctx));
  }

  const displayName = sanitizePvpDisplayName(ctx && ctx.from);
  if (isGroupChat(ctx)) {
    return attachSentMenuOwnership(
      ctx,
      ctx.reply(formatGroupMenuText(displayName), getGroupMenuExtra(ctx))
    );
  }

  return ctx.reply(formatGroupMenuText(displayName));
}

/**
 * Private My Profile submenu.
 * @param {object} ctx
 */
function handlePrivateProfile(ctx, options = {}) {
  if (!isPrivateChat(ctx)) {
    return undefined;
  }
  const block =
    ctx.from && typeof formatShopProgressBlock === "function"
      ? formatShopProgressBlock(ctx.from.id, options)
      : "";
  const text = block ? `${GROUP_PROFILE_TEXT}\n\n${block}` : GROUP_PROFILE_TEXT;
  return ctx.reply(text, getPrivateProfileMenuExtra());
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
    return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard(ctx));
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

  const gate = await assertGroupMenuOwner(ctx);
  if (!gate.ok) {
    return;
  }
  const displayName = gate.record.displayName;

  if (isGameMenuCallback(data)) {
    const topicOk = await isAllowedGameTopic(ctx, {
      ...options,
      allowAdminTopicBypass: false,
    });
    if (!topicOk) {
      try {
        if (typeof ctx.answerCbQuery === "function") {
          await ctx.answerCbQuery(GAMES_TOPIC_REQUIRED_MESSAGE, {
            show_alert: true,
          });
        }
      } catch (_err) {
        /* best-effort */
      }
      return;
    }
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
      return showMenuView(
        ctx,
        formatGroupRankingsText(displayName),
        getGroupRankingsMenuExtra()
      );
    }
    if (data === GROUP_MENU_CALLBACK.GAMES) {
      return showMenuView(
        ctx,
        formatGroupGamesText(displayName),
        getGroupGamesMenuExtra(ctx)
      );
    }
    if (
      data === GROUP_MENU_CALLBACK.PROFILE ||
      data === GROUP_MENU_CALLBACK.PROGRESS
    ) {
      return showMenuView(
        ctx,
        formatGroupProfileText(displayName),
        getGroupProfileMenuExtra(ctx)
      );
    }
    if (data === GROUP_MENU_CALLBACK.BACK) {
      return showMenuView(
        ctx,
        formatGroupMenuText(displayName),
        getGroupMenuExtra(ctx)
      );
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
  if (data === GROUP_MENU_CALLBACK.CHECKERS) {
    return handleCheckers(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.TRIVIA) {
    return handleTrivia(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.MANGOBOMB) {
    return handleMangoBomb(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.BLACKJACK) {
    return handleBlackjack(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.BUILDER) {
    return handleCommunityBuilder(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.SHOP) {
    return handleShop(ctx, options);
  }
  if (data === GROUP_MENU_CALLBACK.DAILY_QUEST) {
    return handleDailyQuest(ctx, options);
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

  bot.hears(MENU_LABELS.COMMUNITY_BUILDER, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleCommunityBuilder(ctx);
  });

  bot.hears(MENU_LABELS.SHOP, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleShop(ctx);
  });

  bot.hears(MENU_LABELS.DAILY_QUEST, (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }
    return handleDailyQuest(ctx);
  });
};

module.exports.handleMenu = handleMenu;
module.exports.handleGroupMenuCallback = handleGroupMenuCallback;
module.exports.handlePrivateProfile = handlePrivateProfile;
module.exports.handlePrivateHubCallback = handlePrivateHubCallback;
module.exports.showMenuView = showMenuView;
