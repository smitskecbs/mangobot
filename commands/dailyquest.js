/**
 * 🎯 Daily Quest — private, menu-driven.
 * Callbacks: dquest:home | dquest:refresh | dquest:shop
 */

const { Markup } = require("telegraf");
const {
  isPrivateChat,
  isGroupChat,
  resolveBotUsername,
  buildPrivateDeepLink,
} = require("../utils/botMenu");
const { logError } = require("../utils/logger");
const {
  getDailyQuestSnapshot,
  ACTIVITY_LOOT,
  FULL_COMPLETION_LOOT,
  BASE_DAILY_MAX,
  setDailyQuestMessenger,
} = require("../services/dailyQuest");

const GROUP_QUEST_TEXT =
  "Open a private chat with the bot to use Daily Quest.";

const DQUEST_CALLBACK = Object.freeze({
  HOME: "dquest:home",
  REFRESH: "dquest:refresh",
  SHOP: "dquest:shop",
});

function parseDailyQuestCallback(data) {
  if (data === DQUEST_CALLBACK.HOME || data === DQUEST_CALLBACK.REFRESH) {
    return { action: "home" };
  }
  if (data === DQUEST_CALLBACK.SHOP) {
    return { action: "shop" };
  }
  return null;
}

function btn(label, data) {
  return Markup.button.callback(label, data);
}

function questOptions(options = {}) {
  return {
    shopFile: options.shopFile,
    walletFile: options.walletFile,
    pointsFile: options.pointsFile,
    now: options.now,
  };
}

function groupQuestExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "dailyquest");
  if (!url) {
    return undefined;
  }
  return Markup.inlineKeyboard([[Markup.button.url("🎯 Open Daily Quest", url)]]);
}

function lockedKeyboard() {
  return Markup.inlineKeyboard([
    [btn("👛 Wallet", "phub:wallet")],
    [btn("⬅️ Back", "phub:back")],
  ]);
}

function homeKeyboard() {
  return Markup.inlineKeyboard([
    [btn("🔄 Refresh", DQUEST_CALLBACK.REFRESH)],
    [btn("🏪 ManGo Shop", DQUEST_CALLBACK.SHOP)],
    [btn("⬅️ Back", "phub:back")],
  ]);
}

function markLine(done) {
  return done ? "✅ Completed" : "❌ Not completed";
}

function buildLockedText() {
  return [
    "🎯 Daily Quest",
    "",
    "🔒 Loot earning locked",
    "",
    "Link a Solana wallet to your ManGo profile first.",
  ].join("\n");
}

function buildHomeText(userId, options) {
  const snap = getDailyQuestSnapshot(userId, options);
  if (!snap.lootUnlocked) {
    return buildLockedText();
  }
  const xpDone = snap.xp.completed;
  const xpLine = xpDone
    ? `✅ ${snap.xp.progress} / ${snap.xp.target} XP`
    : `❌ ${snap.xp.progress} / ${snap.xp.target} XP`;
  return [
    "🎯 Daily Quest",
    "",
    "Complete today's activities and earn ManGo Loot. 🥭",
    "",
    "💬 Community Activity",
    markLine(snap.community.completed),
    `Reward: +${ACTIVITY_LOOT} Loot`,
    "",
    "🎮 Play a Bot Game",
    markLine(snap.game.completed),
    "Play one Telegram bot game:",
    "• Trivia",
    "• Tic-Tac-Toe",
    "• Connect Four",
    "• ChatFight",
    "• ManGo Bomb",
    "Snake and Bounch do not count for this Daily Quest.",
    `Reward: +${ACTIVITY_LOOT} Loot`,
    "",
    "⭐ Earn XP",
    xpLine,
    `Reward: +${ACTIVITY_LOOT} Loot`,
    "",
    "Daily completion:",
    `${snap.completedToday} / 3`,
    "",
    "Full completion bonus:",
    `🎁 +${FULL_COMPLETION_LOOT} Loot`,
    "",
    "🔥 Streak:",
    `${snap.streak} days`,
    "",
    "Today's Loot:",
    `${Math.min(snap.lootAwardedToday, BASE_DAILY_MAX)} / ${BASE_DAILY_MAX}`,
  ].join("\n");
}

async function showQuestView(ctx, text, extra) {
  if (ctx && ctx.callbackQuery && typeof ctx.editMessageText === "function") {
    try {
      await ctx.editMessageText(text, extra || undefined);
      return;
    } catch (err) {
      logError("[daily-quest] edit failed:", err && err.message ? err.message : err);
    }
  }
  if (ctx && typeof ctx.reply === "function") {
    await ctx.reply(text, extra || undefined);
  }
}

async function answerCb(ctx, text) {
  if (ctx && typeof ctx.answerCbQuery === "function") {
    await ctx.answerCbQuery(text || "").catch(() => {});
  }
}

function handleDailyQuest(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (isGroupChat(ctx) || !isPrivateChat(ctx)) {
    return ctx.reply(GROUP_QUEST_TEXT, groupQuestExtra(ctx));
  }
  const opts = questOptions(options);
  const snap = getDailyQuestSnapshot(ctx.from.id, opts);
  const extra = snap.lootUnlocked ? homeKeyboard() : lockedKeyboard();
  return ctx.reply(buildHomeText(ctx.from.id, opts), extra);
}

async function handleDailyQuestCallback(ctx, options = {}) {
  if (!ctx || !ctx.from || !ctx.callbackQuery) {
    return;
  }
  const parsed = parseDailyQuestCallback(ctx.callbackQuery.data);
  if (!parsed) {
    await answerCb(ctx, "This action is no longer available.");
    return;
  }
  if (!isPrivateChat(ctx)) {
    await answerCb(ctx);
    return ctx.reply(GROUP_QUEST_TEXT, groupQuestExtra(ctx));
  }
  const opts = questOptions(options);
  if (parsed.action === "shop") {
    await answerCb(ctx);
    const { handleShop } = require("./shop");
    return handleShop(ctx, opts);
  }
  await answerCb(ctx);
  const snap = getDailyQuestSnapshot(ctx.from.id, opts);
  const extra = snap.lootUnlocked ? homeKeyboard() : lockedKeyboard();
  return showQuestView(ctx, buildHomeText(ctx.from.id, opts), extra);
}

module.exports = (bot) => {
  if (bot && bot.telegram && typeof bot.telegram.sendMessage === "function") {
    setDailyQuestMessenger((userId, text) =>
      bot.telegram.sendMessage(userId, text)
    );
  }
  bot.action(/^dquest:/, (ctx) => handleDailyQuestCallback(ctx));
};

module.exports.handleDailyQuest = handleDailyQuest;
module.exports.handleDailyQuestCallback = handleDailyQuestCallback;
module.exports.parseDailyQuestCallback = parseDailyQuestCallback;
module.exports.GROUP_QUEST_TEXT = GROUP_QUEST_TEXT;
module.exports.DQUEST_CALLBACK = DQUEST_CALLBACK;
module.exports.buildHomeText = buildHomeText;
module.exports.homeKeyboard = homeKeyboard;
