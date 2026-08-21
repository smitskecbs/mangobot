/**
 * Private Community Builder hub: invite link, referrals, builder leaderboard.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("../services/points");
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
  REFERRALS_PAGE_SIZE,
} = require("../services/communityBuilder");

const BUILDER_CALLBACK = Object.freeze({
  HOME: "cbuild:home",
  INVITE: "cbuild:invite",
  REFS: "cbuild:refs",
  BOARD: "cbuild:board",
  BACK: "cbuild:back",
});

const BUILDER_REFS_PREFIX = "cbuild:r:";
const BUILDER_START_PAYLOAD = "builder";

const GROUP_BUILDER_TEXT =
  "Open ManGo Bot privately to use Community Builder and get your personal invite link.";

const PERMISSION_NEEDED_TEXT =
  "Couldn't create your invite link. The bot needs permission to invite users in the ManGo group.";

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

function builderHomeText(summary) {
  return [
    "🤝 Community Builder",
    "",
    "Grow the ManGo community by inviting real members. 🥭",
    "",
    `Builder Points: ${summary.builderPoints}`,
    `Valid referrals: ${summary.validReferrals}`,
  ].join("\n");
}

function builderHomeExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📨 My Invite Link", BUILDER_CALLBACK.INVITE)],
    [Markup.button.callback("👥 My Referrals", BUILDER_CALLBACK.REFS)],
    [Markup.button.callback("🏆 Builder Leaderboard", BUILDER_CALLBACK.BOARD)],
    [Markup.button.callback("⬅️ Back", BUILDER_CALLBACK.BACK)],
  ]);
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

function leaderboardText(rows) {
  if (!rows.length) {
    return "🏆 Community Builder Leaderboard\n\nNo Builder Points yet. Invite real members to start.";
  }
  const lines = ["🏆 Community Builder Leaderboard", ""];
  for (const row of rows) {
    const prefix =
      row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : row.rank === 3 ? "🥉" : `${row.rank}.`;
    lines.push(`${prefix} ${row.displayName} — ${row.points} BP`);
  }
  return lines.join("\n");
}

function leaderboardExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Back", BUILDER_CALLBACK.HOME)],
  ]);
}

function statsText(stats) {
  const lines = [
    "🤝 Community Builder stats",
    "",
    `Unique referrals: ${stats.uniqueReferrals}`,
    `Wallet-linked: ${stats.walletLinked}`,
    `Active: ${stats.active}`,
    `Builders: ${stats.totalBuilders}`,
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
    data === BUILDER_CALLBACK.BACK ||
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
  return ctx.reply(builderHomeText(summary), builderHomeExtra());
}

function handleBuilderBoard(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (isGroupChat(ctx)) {
    return ctx.reply(GROUP_BUILDER_TEXT, groupBuilderExtra(ctx));
  }
  if (!isPrivateChat(ctx)) {
    return undefined;
  }
  const rows = getBuilderLeaderboard(options);
  return ctx.reply(leaderboardText(rows), getPrivateMenuKeyboard());
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

  if (data === BUILDER_CALLBACK.BOARD) {
    const rows = getBuilderLeaderboard(options);
    return showMenuView(ctx, leaderboardText(rows), leaderboardExtra());
  }

  const page = parseRefsPage(data);
  if (page != null) {
    const pageData = paginateReferrals(ctx.from.id, page, options);
    return showMenuView(ctx, referralsText(pageData), referralsExtra(pageData));
  }
}

const BUILDER_ACTION_RE = /^(cbuild:(home|invite|refs|board|back)|cbuild:r:\d+)$/;

module.exports = (bot) => {
  bot.command("communitybuilder", (ctx) => handleCommunityBuilder(ctx));
  bot.command("builderboard", (ctx) => handleBuilderBoard(ctx));
  bot.command("builderstats", (ctx) => handleBuilderStats(ctx));
  bot.action(BUILDER_ACTION_RE, (ctx) => handleBuilderCallback(ctx));
};

module.exports.handleCommunityBuilder = handleCommunityBuilder;
module.exports.handleBuilderBoard = handleBuilderBoard;
module.exports.handleBuilderStats = handleBuilderStats;
module.exports.handleBuilderCallback = handleBuilderCallback;
module.exports.BUILDER_CALLBACK = BUILDER_CALLBACK;
module.exports.BUILDER_REFS_PREFIX = BUILDER_REFS_PREFIX;
module.exports.BUILDER_START_PAYLOAD = BUILDER_START_PAYLOAD;
module.exports.GROUP_BUILDER_TEXT = GROUP_BUILDER_TEXT;
module.exports.builderHomeText = builderHomeText;
module.exports.referralsText = referralsText;
module.exports.leaderboardText = leaderboardText;
module.exports.statsText = statsText;
module.exports.groupBuilderExtra = groupBuilderExtra;
module.exports.REFERRALS_PAGE_SIZE = REFERRALS_PAGE_SIZE;
