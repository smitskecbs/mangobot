/**
 * Private Community Builder hub: invite link, referrals, builder leaderboard.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("../services/points");
const { parseCommandArg } = require("../utils/telegramReplyTarget");
const { pruneTimestampMap } = require("../utils/boundedMap");
const {
  isPrivateChat,
  isGroupChat,
  getPrivateMenuKeyboard,
  resolveBotUsername,
  buildPrivateDeepLink,
  GROUP_MENU_CALLBACK,
} = require("../utils/botMenu");
const {
  builderSummary,
  paginateReferrals,
  getBuilderLeaderboard,
  getBuilderStats,
  getOrCreateInviteLink,
  formatBuilderLeaderboard,
  shareBuilderLeaderboard,
  normalizeBuilderPeriod,
  BUILDER_PERIOD,
  REFERRALS_PAGE_SIZE,
} = require("../services/communityBuilder");
const { getActiveTitle, formatTitleLabel } = require("../services/mangoShop");

const BUILDER_CALLBACK = Object.freeze({
  HOME: "cbuild:home",
  INVITE: "cbuild:invite",
  REFS: "cbuild:refs",
  BOARD: "cbuild:board",
  OPEN_BOARD: "cbuild:openboard",
  BACK: "cbuild:back",
  PERIODS: "cb:lb:pick",
  WEEKLY: "cb:lb:w",
  MONTHLY: "cb:lb:m",
  ALLTIME: "cb:lb:a",
  SHARE_WEEKLY: "cb:share:w",
  SHARE_MONTHLY: "cb:share:m",
  SHARE_ALLTIME: "cb:share:a",
});

const GROUP_BOARD_CALLBACK = Object.freeze({
  WEEKLY: "cblb:w",
  MONTHLY: "cblb:m",
  ALLTIME: "cblb:a",
});

const BUILDER_REFS_PREFIX = "cbuild:r:";
const BUILDER_START_PAYLOAD = "builder";

const GROUP_BUILDER_TEXT =
  "Open ManGo Bot privately to use Community Builder and get your personal invite link.";

const PERMISSION_NEEDED_TEXT =
  "Couldn't create your invite link. The bot needs permission to invite users in the ManGo group.";

const OPEN_BOARD_COOLDOWN_MS = 60_000;
const OPEN_BOARD_COOLDOWN_TEXT = "Builder Board was just opened in the group. 🥭";
const OPEN_BOARD_OPENED_TEXT = "Opened in the ManGo group.";
const OPEN_BOARD_FAILED_TEXT = "Couldn't open the Builder Board right now.";
const OPEN_BOARD_COOLDOWN_MAX_KEYS = 5_000;

const openBoardOpenedAt = new Map();

function nowMsFromOptions(options = {}) {
  return Number.isFinite(options.now) ? options.now : Date.now();
}

function resetOpenBoardCooldownForTests() {
  openBoardOpenedAt.clear();
}

function isOpenBoardOnCooldown(userId, nowMs) {
  pruneTimestampMap(
    openBoardOpenedAt,
    nowMs,
    OPEN_BOARD_COOLDOWN_MS,
    OPEN_BOARD_COOLDOWN_MAX_KEYS
  );
  const last = openBoardOpenedAt.get(String(userId));
  return Number.isFinite(last) && nowMs - last < OPEN_BOARD_COOLDOWN_MS;
}

function markOpenBoardOpened(userId, nowMs) {
  pruneTimestampMap(
    openBoardOpenedAt,
    nowMs,
    OPEN_BOARD_COOLDOWN_MS,
    OPEN_BOARD_COOLDOWN_MAX_KEYS
  );
  openBoardOpenedAt.set(String(userId), nowMs);
}

function clearOpenBoardOpened(userId) {
  openBoardOpenedAt.delete(String(userId));
}

function mark(ok) {
  return ok ? "✅" : "⬜";
}

function milestoneIcon(row) {
  if (row.active) {
    return "✅";
  }
  if (row.wallet) {
    return "🟡";
  }
  return "▫️";
}

function communityTitleLabel(userId, options = {}) {
  try {
    const title = getActiveTitle(userId, options.shopFile);
    return title ? formatTitleLabel(title) : "None";
  } catch (_err) {
    return "None";
  }
}

function builderHomeText(summary) {
  return [
    "🤝 Community Builder",
    "",
    "Grow the ManGo community by inviting real members. 🥭",
    "",
    `Builder Points: ${summary.builderPoints}`,
    `Community Title: ${summary.activeTitleLabel || "None"}`,
    `Valid referrals: ${summary.validReferrals}`,
  ].join("\n");
}

function builderHomeExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📨 My Invite Link", BUILDER_CALLBACK.INVITE)],
    [Markup.button.callback("👥 My Referrals", BUILDER_CALLBACK.REFS)],
    [Markup.button.callback("🏆 Builder Leaderboard", BUILDER_CALLBACK.BOARD)],
    [Markup.button.callback("🏆 Open Builder Board", BUILDER_CALLBACK.OPEN_BOARD)],
    [Markup.button.callback("⬅️ Back", BUILDER_CALLBACK.BACK)],
  ]);
}

function periodChooserText() {
  return [
    "🏆 Community Builder Leaderboard",
    "",
    "Choose a period.",
  ].join("\n");
}

function periodChooserExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📅 Weekly", BUILDER_CALLBACK.WEEKLY)],
    [Markup.button.callback("🗓 Monthly", BUILDER_CALLBACK.MONTHLY)],
    [Markup.button.callback("🌍 All-time", BUILDER_CALLBACK.ALLTIME)],
    [Markup.button.callback("⬅️ Back", BUILDER_CALLBACK.HOME)],
  ]);
}

function periodFromCallback(data) {
  if (data === BUILDER_CALLBACK.WEEKLY || data === BUILDER_CALLBACK.SHARE_WEEKLY) {
    return BUILDER_PERIOD.WEEKLY;
  }
  if (data === BUILDER_CALLBACK.MONTHLY || data === BUILDER_CALLBACK.SHARE_MONTHLY) {
    return BUILDER_PERIOD.MONTHLY;
  }
  if (data === BUILDER_CALLBACK.ALLTIME || data === BUILDER_CALLBACK.SHARE_ALLTIME) {
    return BUILDER_PERIOD.ALLTIME;
  }
  return null;
}

function shareCallbackForPeriod(period) {
  if (period === BUILDER_PERIOD.WEEKLY) {
    return BUILDER_CALLBACK.SHARE_WEEKLY;
  }
  if (period === BUILDER_PERIOD.MONTHLY) {
    return BUILDER_CALLBACK.SHARE_MONTHLY;
  }
  return BUILDER_CALLBACK.SHARE_ALLTIME;
}

function mangoGroupChatId(options = {}) {
  if (options.chatId != null && String(options.chatId).trim()) {
    return String(options.chatId).trim();
  }
  return typeof process.env.TELEGRAM_CHAT_ID === "string"
    ? process.env.TELEGRAM_CHAT_ID.trim()
    : "";
}

function isTargetMangoGroup(ctx, options = {}) {
  const expected = mangoGroupChatId(options);
  const got = ctx && ctx.chat && ctx.chat.id != null ? String(ctx.chat.id).trim() : "";
  return Boolean(expected && got && expected === got);
}

function isMessageNotModifiedError(err) {
  const desc = err && (err.description || err.message || "");
  return String(desc).toLowerCase().includes("message is not modified");
}

function groupLeaderboardExtra() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📅 Weekly", GROUP_BOARD_CALLBACK.WEEKLY),
      Markup.button.callback("🗓 Monthly", GROUP_BOARD_CALLBACK.MONTHLY),
    ],
    [Markup.button.callback("🌍 All-time", GROUP_BOARD_CALLBACK.ALLTIME)],
  ]);
}

function periodFromGroupCallback(data) {
  if (data === GROUP_BOARD_CALLBACK.WEEKLY) {
    return BUILDER_PERIOD.WEEKLY;
  }
  if (data === GROUP_BOARD_CALLBACK.MONTHLY) {
    return BUILDER_PERIOD.MONTHLY;
  }
  if (data === GROUP_BOARD_CALLBACK.ALLTIME) {
    return BUILDER_PERIOD.ALLTIME;
  }
  return null;
}

function isGroupBoardCallback(data) {
  return Boolean(periodFromGroupCallback(data));
}

function inviteSuccessText(inviteUrl, reused) {
  const intro = reused
    ? "📨 Your personal ManGo invite link:"
    : "📨 Your personal ManGo invite link:";
  return [
    intro,
    "",
    inviteUrl,
    "",
    "Share this link. You earn Builder Points when real members join through it.",
  ].join("\n");
}

function referralsText(pageData) {
  if (!pageData.total) {
    return [
      "👥 Your Referrals",
      "",
      "No valid referrals yet.",
      "Share your personal invite link to start building.",
    ].join("\n");
  }
  const lines = ["👥 Your Referrals", ""];
  for (const row of pageData.rows) {
    lines.push(`${milestoneIcon(row)} ${row.displayName}`);
    lines.push(`   Joined ${mark(row.joined)}`);
    lines.push(`   Wallet ${mark(row.wallet)}`);
    lines.push(`   Active ${mark(row.active)}`);
    lines.push("");
  }
  if (pageData.lastPage > 0) {
    lines.push(`Page ${pageData.page + 1}/${pageData.lastPage + 1}`);
  }
  return lines.join("\n").trimEnd();
}

function referralsExtra(pageData) {
  const rows = [];
  if (pageData.lastPage > 0) {
    const nav = [];
    if (pageData.page > 0) {
      nav.push(
        Markup.button.callback("⬅️ Previous", `${BUILDER_REFS_PREFIX}${pageData.page - 1}`)
      );
    }
    if (pageData.page < pageData.lastPage) {
      nav.push(
        Markup.button.callback("Next ➡️", `${BUILDER_REFS_PREFIX}${pageData.page + 1}`)
      );
    }
    if (nav.length) {
      rows.push(nav);
    }
  }
  rows.push([Markup.button.callback("⬅️ Back", BUILDER_CALLBACK.HOME)]);
  return Markup.inlineKeyboard(rows);
}

function leaderboardText(rows, period = BUILDER_PERIOD.ALLTIME) {
  return formatBuilderLeaderboard(rows, period, "private");
}

function leaderboardExtra(period = BUILDER_PERIOD.ALLTIME, admin = false) {
  const rows = [];
  if (admin) {
    rows.push([
      Markup.button.callback("📣 Share in Group", shareCallbackForPeriod(period)),
    ]);
  }
  rows.push([Markup.button.callback("⬅️ Periods", BUILDER_CALLBACK.PERIODS)]);
  return Markup.inlineKeyboard(rows);
}

function statsText(stats) {
  const lines = [
    "🤝 Community Builder stats",
    "",
    `Unique referrals: ${stats.uniqueReferrals}`,
    `Wallet-linked: ${stats.walletLinked}`,
    `Active: ${stats.active}`,
    `Builders: ${stats.totalBuilders}`,
    `This week BP: ${stats.weekBp || 0}`,
    `This month BP: ${stats.monthBp || 0}`,
    `All-time BP: ${stats.allTimeBp || 0}`,
  ];
  if (stats.top && stats.top.length) {
    lines.push("", "Top:");
    for (const row of stats.top.slice(0, 5)) {
      lines.push(`${row.rank}. ${row.displayName} — ${row.points} BP`);
    }
  }
  return lines.join("\n");
}

function parseRefsPage(data) {
  if (data === BUILDER_CALLBACK.REFS) {
    return 0;
  }
  if (typeof data === "string" && data.startsWith(BUILDER_REFS_PREFIX)) {
    const n = Number.parseInt(data.slice(BUILDER_REFS_PREFIX.length), 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }
  return null;
}

function isBuilderCallback(data) {
  return (
    data === BUILDER_CALLBACK.HOME ||
    data === BUILDER_CALLBACK.INVITE ||
    data === BUILDER_CALLBACK.REFS ||
    data === BUILDER_CALLBACK.BOARD ||
    data === BUILDER_CALLBACK.OPEN_BOARD ||
    data === BUILDER_CALLBACK.BACK ||
    data === BUILDER_CALLBACK.PERIODS ||
    data === BUILDER_CALLBACK.WEEKLY ||
    data === BUILDER_CALLBACK.MONTHLY ||
    data === BUILDER_CALLBACK.ALLTIME ||
    data === BUILDER_CALLBACK.SHARE_WEEKLY ||
    data === BUILDER_CALLBACK.SHARE_MONTHLY ||
    data === BUILDER_CALLBACK.SHARE_ALLTIME ||
    (typeof data === "string" && data.startsWith(BUILDER_REFS_PREFIX))
  );
}

function groupBuilderExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, BUILDER_START_PAYLOAD);
  if (!url) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("🤝 Community Builder", GROUP_MENU_CALLBACK.BUILDER)],
    ]);
  }
  return Markup.inlineKeyboard([
    [Markup.button.url("🤝 Open Community Builder", url)],
  ]);
}

async function showMenuView(ctx, text, extra) {
  if (typeof ctx.editMessageText === "function") {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (_err) {
      // Message not editable — reply instead.
    }
  }
  return ctx.reply(text, extra);
}

function handleCommunityBuilder(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (isGroupChat(ctx)) {
    return ctx.reply(GROUP_BUILDER_TEXT, groupBuilderExtra(ctx));
  }
  if (!isPrivateChat(ctx)) {
    return undefined;
  }
  const summary = builderSummary(ctx.from.id, options);
  summary.activeTitleLabel = communityTitleLabel(ctx.from.id, options);
  return ctx.reply(builderHomeText(summary), builderHomeExtra());
}

function handleBuilderBoard(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (isGroupChat(ctx)) {
    return handleGroupBuilderBoard(ctx, options);
  }
  if (!isPrivateChat(ctx)) {
    return undefined;
  }
  const arg = parseCommandArg(ctx);
  const parsed = arg ? normalizeBuilderPeriod(arg) : BUILDER_PERIOD.ALLTIME;
  if (arg && !parsed) {
    return ctx.reply("Use /builderboard weekly, monthly, or alltime.");
  }
  const chosen = parsed || BUILDER_PERIOD.ALLTIME;
  const board = getBuilderLeaderboard({ ...options, period: chosen });
  return ctx.reply(
    leaderboardText(board, chosen),
    leaderboardExtra(chosen, isAdmin(ctx.from.id))
  );
}

function handleGroupBuilderBoard(ctx, options = {}) {
  if (ctx.from && ctx.from.is_bot) {
    return undefined;
  }
  if (!isTargetMangoGroup(ctx, options)) {
    return ctx.reply("Open the ManGo group to view the Builder leaderboard.");
  }
  const arg = parseCommandArg(ctx);
  const parsed = arg ? normalizeBuilderPeriod(arg) : BUILDER_PERIOD.ALLTIME;
  if (arg && !parsed) {
    return ctx.reply("Use /builderboard weekly, monthly, or alltime.");
  }
  const chosen = parsed || BUILDER_PERIOD.ALLTIME;
  const board = getBuilderLeaderboard({ ...options, period: chosen });
  return ctx.reply(leaderboardText(board, chosen), groupLeaderboardExtra());
}

async function handleGroupLeaderboardCallback(ctx, options = {}) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";
  const period = periodFromGroupCallback(data);
  if (!period) {
    return;
  }

  try {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery();
    }
  } catch (_err) {
    /* already answered */
  }

  if (!ctx.from || ctx.from.is_bot) {
    return;
  }
  if (!isGroupChat(ctx) || !isTargetMangoGroup(ctx, options)) {
    return;
  }

  const board = getBuilderLeaderboard({ ...options, period });
  const text = leaderboardText(board, period);
  if (typeof ctx.editMessageText !== "function") {
    return ctx.reply(text, groupLeaderboardExtra());
  }
  try {
    await ctx.editMessageText(text, groupLeaderboardExtra());
  } catch (err) {
    if (!isMessageNotModifiedError(err)) {
      const { error: logError } = require("../utils/logger");
      logError(
        "[community-builder] group leaderboard edit failed:",
        err && err.message ? err.message : err
      );
    }
  }
}

function handleBuilderStats(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    return ctx.reply("Open a private chat with the bot to view builder stats.");
  }
  return ctx.reply(statsText(getBuilderStats(options)));
}

async function handleBuilderCallback(ctx, options = {}) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";
  if (!isBuilderCallback(data)) {
    return;
  }

  try {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery();
    }
  } catch (_err) {
    /* already answered */
  }

  if (!isPrivateChat(ctx) || !ctx.from) {
    if (isGroupChat(ctx)) {
      return ctx.reply(GROUP_BUILDER_TEXT, groupBuilderExtra(ctx));
    }
    return;
  }

  if (data === BUILDER_CALLBACK.BACK) {
    const { PRIVATE_MENU_HINT } = require("../utils/botMenu");
    return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard());
  }

  if (data === BUILDER_CALLBACK.HOME) {
    const summary = builderSummary(ctx.from.id, options);
    summary.activeTitleLabel = communityTitleLabel(ctx.from.id, options);
    return showMenuView(ctx, builderHomeText(summary), builderHomeExtra());
  }

  if (data === BUILDER_CALLBACK.INVITE) {
    const result = await getOrCreateInviteLink(ctx.from, {
      ...options,
      telegram: ctx.telegram,
      botId: ctx.botInfo && ctx.botInfo.id,
    });
    const text =
      result && result.ok
        ? inviteSuccessText(result.inviteUrl, result.reused)
        : (result && result.message) || PERMISSION_NEEDED_TEXT;
    return showMenuView(
      ctx,
      text,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", BUILDER_CALLBACK.HOME)]])
    );
  }

  if (data === BUILDER_CALLBACK.OPEN_BOARD) {
    return handleOpenBuilderBoard(ctx, options);
  }

  if (data === BUILDER_CALLBACK.BOARD || data === BUILDER_CALLBACK.PERIODS) {
    return showMenuView(ctx, periodChooserText(), periodChooserExtra());
  }

  const sharePeriod = periodFromCallback(data);
  if (
    data === BUILDER_CALLBACK.SHARE_WEEKLY ||
    data === BUILDER_CALLBACK.SHARE_MONTHLY ||
    data === BUILDER_CALLBACK.SHARE_ALLTIME
  ) {
    if (!isAdmin(ctx.from.id)) {
      return ctx.reply("Only admins can share the leaderboard in the group.");
    }
    const result = await shareBuilderLeaderboard(sharePeriod, {
      ...options,
      adminUserId: ctx.from.id,
      telegram: ctx.telegram,
      shareToGroup: true,
    });
    if (!result.ok) {
      return ctx.reply("Couldn't share the leaderboard right now.");
    }
    return ctx.reply("Shared in the ManGo group.");
  }

  if (
    data === BUILDER_CALLBACK.WEEKLY ||
    data === BUILDER_CALLBACK.MONTHLY ||
    data === BUILDER_CALLBACK.ALLTIME
  ) {
    const period = periodFromCallback(data);
    const rows = getBuilderLeaderboard({ ...options, period });
    return showMenuView(
      ctx,
      leaderboardText(rows, period),
      leaderboardExtra(period, isAdmin(ctx.from.id))
    );
  }

  const page = parseRefsPage(data);
  if (page != null) {
    const pageData = paginateReferrals(ctx.from.id, page, options);
    return showMenuView(ctx, referralsText(pageData), referralsExtra(pageData));
  }
}

async function handleOpenBuilderBoard(ctx, options = {}) {
  if (!ctx.from || ctx.from.is_bot) {
    return;
  }

  const nowMs = nowMsFromOptions(options);
  const userId = ctx.from.id;
  if (isOpenBoardOnCooldown(userId, nowMs)) {
    return ctx.reply(OPEN_BOARD_COOLDOWN_TEXT);
  }

  const chatId = mangoGroupChatId(options);
  const telegram = ctx.telegram;
  if (!chatId || !telegram || typeof telegram.sendMessage !== "function") {
    return ctx.reply(OPEN_BOARD_FAILED_TEXT);
  }

  const board = getBuilderLeaderboard({
    ...options,
    period: BUILDER_PERIOD.ALLTIME,
  });
  const text = leaderboardText(board, BUILDER_PERIOD.ALLTIME);
  const extra = groupLeaderboardExtra();
  markOpenBoardOpened(userId, nowMs);
  try {
    await telegram.sendMessage(chatId, text, extra);
  } catch (err) {
    clearOpenBoardOpened(userId);
    const { error: logError } = require("../utils/logger");
    logError(
      "[community-builder] open builder board failed:",
      err && err.message ? err.message : err
    );
    return ctx.reply(OPEN_BOARD_FAILED_TEXT);
  }
  return ctx.reply(OPEN_BOARD_OPENED_TEXT);
}

const BUILDER_ACTION_RE =
  /^(cbuild:(home|invite|refs|board|openboard|back)|cbuild:r:\d+|cb:lb:(pick|w|m|a)|cb:share:(w|m|a))$/;
const GROUP_BOARD_ACTION_RE = /^cblb:[wma]$/;

module.exports = (bot) => {
  bot.command("communitybuilder", (ctx) => handleCommunityBuilder(ctx));
  bot.command("builderboard", (ctx) => handleBuilderBoard(ctx));
  bot.command("builderstats", (ctx) => handleBuilderStats(ctx));
  bot.action(BUILDER_ACTION_RE, (ctx) => handleBuilderCallback(ctx));
  bot.action(GROUP_BOARD_ACTION_RE, (ctx) => handleGroupLeaderboardCallback(ctx));
};

module.exports.handleCommunityBuilder = handleCommunityBuilder;
module.exports.handleBuilderBoard = handleBuilderBoard;
module.exports.handleBuilderStats = handleBuilderStats;
module.exports.handleBuilderCallback = handleBuilderCallback;
module.exports.handleGroupLeaderboardCallback = handleGroupLeaderboardCallback;
module.exports.resetOpenBoardCooldownForTests = resetOpenBoardCooldownForTests;
module.exports.BUILDER_CALLBACK = BUILDER_CALLBACK;
module.exports.GROUP_BOARD_CALLBACK = GROUP_BOARD_CALLBACK;
module.exports.OPEN_BOARD_COOLDOWN_MS = OPEN_BOARD_COOLDOWN_MS;
module.exports.OPEN_BOARD_COOLDOWN_TEXT = OPEN_BOARD_COOLDOWN_TEXT;
module.exports.OPEN_BOARD_OPENED_TEXT = OPEN_BOARD_OPENED_TEXT;
module.exports.BUILDER_REFS_PREFIX = BUILDER_REFS_PREFIX;
module.exports.BUILDER_START_PAYLOAD = BUILDER_START_PAYLOAD;
module.exports.GROUP_BUILDER_TEXT = GROUP_BUILDER_TEXT;
module.exports.builderHomeText = builderHomeText;
module.exports.referralsText = referralsText;
module.exports.leaderboardText = leaderboardText;
module.exports.periodChooserText = periodChooserText;
module.exports.statsText = statsText;
module.exports.groupBuilderExtra = groupBuilderExtra;
module.exports.REFERRALS_PAGE_SIZE = REFERRALS_PAGE_SIZE;
