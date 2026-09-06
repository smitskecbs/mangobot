/**
 * Admin-only /walletcleanup (preview) and /walletcleanup_confirm (rescan then kick+unban).
 * Preview never removes anyone. Confirm never trusts a cached preview.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const {
  scanWalletCleanup,
  confirmWalletCleanup,
  formatWalletCleanupPreview,
  formatWalletCleanupConfirm,
  parseWalletCleanupCallback,
  walletCleanupNavButtons,
  WALLET_CLEANUP_CALLBACK_PREFIX,
} = require("../services/walletCleanup");
const { formatWalletGraceSummary } = require("../services/walletGrace");

const ADMIN_ONLY = "This command is admin only.";
const PRIVATE_ONLY = "Open a private chat with the bot to run wallet cleanup.";
const CONFIRM_HINT =
  "This command removes members with no connected wallet. It rescans first. Preview with /walletcleanup.";

function isMessageNotModified(err) {
  const desc = err && (err.description || err.message || "");
  return String(desc).toLowerCase().includes("message is not modified");
}

function cleanupKeyboard(page, lastPage) {
  const row = walletCleanupNavButtons(page, lastPage);
  if (!row.length) {
    return undefined;
  }
  return { reply_markup: { inline_keyboard: [row] } };
}

function resolveGetChatMember(ctx, options = {}) {
  if (typeof options.getChatMember === "function") {
    return options.getChatMember;
  }
  if (ctx && ctx.telegram && typeof ctx.telegram.getChatMember === "function") {
    return (chatId, userId) => ctx.telegram.getChatMember(chatId, userId);
  }
  return null;
}

function resolveBanUnban(ctx, options = {}) {
  const banChatMember =
    typeof options.banChatMember === "function"
      ? options.banChatMember
      : ctx && ctx.telegram && typeof ctx.telegram.banChatMember === "function"
        ? (chatId, userId) => ctx.telegram.banChatMember(chatId, userId)
        : null;
  const unbanChatMember =
    typeof options.unbanChatMember === "function"
      ? options.unbanChatMember
      : ctx && ctx.telegram && typeof ctx.telegram.unbanChatMember === "function"
        ? (chatId, userId, extra) => ctx.telegram.unbanChatMember(chatId, userId, extra)
        : null;
  return { banChatMember, unbanChatMember };
}

function appendGraceSummary(text, options = {}) {
  try {
    const summary = formatWalletGraceSummary({
      membersFile: options.membersFile,
      now: options.now,
    });
    if (summary) {
      return `${text}\n\n${summary}`;
    }
  } catch (_err) {
    /* preview-only; cleanup text still sends */
  }
  return text;
}

function scanOptions(ctx, options = {}) {
  return {
    ...options,
    getChatMember: resolveGetChatMember(ctx, options),
  };
}

async function safeAnswerCbQuery(ctx, extra) {
  if (!ctx || typeof ctx.answerCbQuery !== "function") {
    return;
  }
  try {
    if (extra) {
      await ctx.answerCbQuery(extra.text || "", extra);
    } else {
      await ctx.answerCbQuery();
    }
  } catch (_err) {
    /* already answered */
  }
}

function callbackDataFromCtx(ctx) {
  if (ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string") {
    return ctx.callbackQuery.data;
  }
  if (ctx && ctx.match && typeof ctx.match[0] === "string") {
    return ctx.match[0];
  }
  return "";
}

async function handleWalletCleanup(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    if (!isAdmin(ctx.from.id)) {
      return undefined;
    }
    return ctx.reply(PRIVATE_ONLY);
  }
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply(ADMIN_ONLY);
  }
  const scan = await scanWalletCleanup(scanOptions(ctx, options));
  const built = formatWalletCleanupPreview(scan, {
    page: options.page || 0,
    pageSize: options.pageSize,
  });
  const extra = cleanupKeyboard(built.page, built.lastPage) || {};
  return ctx.reply(appendGraceSummary(built.text, options), extra);
}

async function handleWalletCleanupCallback(ctx, options = {}) {
  if (!ctx || !ctx.from || !ctx.callbackQuery) {
    return undefined;
  }
  const parsed = parseWalletCleanupCallback(callbackDataFromCtx(ctx));
  if (!parsed) {
    await safeAnswerCbQuery(ctx);
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    await safeAnswerCbQuery(ctx);
    if (isAdmin(ctx.from.id)) {
      return ctx.reply(PRIVATE_ONLY);
    }
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    await safeAnswerCbQuery(ctx, { text: ADMIN_ONLY, show_alert: true });
    return ctx.reply(ADMIN_ONLY);
  }
  await safeAnswerCbQuery(ctx);
  const scan = await scanWalletCleanup(scanOptions(ctx, options));
  const built = formatWalletCleanupPreview(scan, {
    page: parsed.page,
    pageSize: options.pageSize,
  });
  const extra = cleanupKeyboard(built.page, built.lastPage) || {};
  const previewText = appendGraceSummary(built.text, options);
  if (typeof ctx.editMessageText !== "function") {
    return ctx.reply(previewText, extra);
  }
  try {
    return await ctx.editMessageText(previewText, extra);
  } catch (err) {
    if (isMessageNotModified(err)) {
      return undefined;
    }
    return ctx.reply(previewText, extra);
  }
}

async function handleWalletCleanupConfirm(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    if (!isAdmin(ctx.from.id)) {
      return undefined;
    }
    return ctx.reply(PRIVATE_ONLY);
  }
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply(ADMIN_ONLY);
  }
  const { banChatMember, unbanChatMember } = resolveBanUnban(ctx, options);
  const result = await confirmWalletCleanup({
    ...scanOptions(ctx, options),
    banChatMember,
    unbanChatMember,
  });
  const text = `${CONFIRM_HINT}\n\n${formatWalletCleanupConfirm(result)}`;
  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("walletcleanup", (ctx) => handleWalletCleanup(ctx));
  bot.command("walletcleanup_confirm", (ctx) => handleWalletCleanupConfirm(ctx));
  bot.action(new RegExp(`^${WALLET_CLEANUP_CALLBACK_PREFIX}\\d{1,4}$`), (ctx) =>
    handleWalletCleanupCallback(ctx)
  );
};

module.exports.handleWalletCleanup = handleWalletCleanup;
module.exports.handleWalletCleanupCallback = handleWalletCleanupCallback;
module.exports.handleWalletCleanupConfirm = handleWalletCleanupConfirm;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.PRIVATE_ONLY = PRIVATE_ONLY;
