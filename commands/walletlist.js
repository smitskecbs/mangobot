/**
 * Admin-only /walletlist — private overview of linked vs unlinked members.
 * Pagination callbacks carry only a page index. No full wallets. No uids.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const {
  buildWalletListPage,
  parseWalletListCallback,
  walletListCallbackData,
  walletListNavButtons,
  WALLET_LIST_CALLBACK_PREFIX,
} = require("../services/walletList");

const ADMIN_ONLY = "This command is admin only.";
const GROUP_WALLET_LIST_TEXT =
  "Open a private chat with the bot to view the wallet overview.";

function isMessageNotModified(err) {
  const desc = err && (err.description || err.message || "");
  return String(desc).toLowerCase().includes("message is not modified");
}

function walletListKeyboard(page, lastPage) {
  const row = walletListNavButtons(page, lastPage);
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

async function renderWalletList(options = {}) {
  const built = await buildWalletListPage(options);
  const extra = { parse_mode: "HTML" };
  const keyboard = walletListKeyboard(built.page, built.lastPage);
  if (keyboard) {
    Object.assign(extra, keyboard);
  }
  return {
    text: built.text,
    extra,
    built,
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
    /* already answered or query expired */
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

async function handleWalletList(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    if (!isAdmin(ctx.from.id)) {
      return undefined;
    }
    return ctx.reply(GROUP_WALLET_LIST_TEXT);
  }
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply(ADMIN_ONLY);
  }
  const rendered = await renderWalletList({
    page: 0,
    pointsFile: options.pointsFile,
    walletFile: options.walletFile,
    pageSize: options.pageSize,
    chatId: options.chatId,
    getChatMember: resolveGetChatMember(ctx, options),
    membershipByUserId: options.membershipByUserId,
  });
  return ctx.reply(rendered.text, rendered.extra);
}

async function handleWalletListCallback(ctx, options = {}) {
  if (!ctx || !ctx.from || !ctx.callbackQuery) {
    return undefined;
  }
  const parsed = parseWalletListCallback(callbackDataFromCtx(ctx));
  if (!parsed) {
    await safeAnswerCbQuery(ctx);
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    await safeAnswerCbQuery(ctx);
    if (isAdmin(ctx.from.id)) {
      return ctx.reply(GROUP_WALLET_LIST_TEXT);
    }
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    await safeAnswerCbQuery(ctx, { text: ADMIN_ONLY, show_alert: true });
    return ctx.reply(ADMIN_ONLY);
  }
  await safeAnswerCbQuery(ctx);
  const rendered = await renderWalletList({
    page: parsed.page,
    pointsFile: options.pointsFile,
    walletFile: options.walletFile,
    pageSize: options.pageSize,
    chatId: options.chatId,
    getChatMember: resolveGetChatMember(ctx, options),
    membershipByUserId: options.membershipByUserId,
  });
  if (typeof ctx.editMessageText !== "function") {
    return ctx.reply(rendered.text, rendered.extra);
  }
  try {
    return await ctx.editMessageText(rendered.text, rendered.extra);
  } catch (err) {
    if (isMessageNotModified(err)) {
      return undefined;
    }
    return ctx.reply(rendered.text, rendered.extra);
  }
}

module.exports = (bot) => {
  bot.command("walletlist", (ctx) => handleWalletList(ctx));
  bot.action(new RegExp(`^${WALLET_LIST_CALLBACK_PREFIX}\\d{1,4}$`), (ctx) =>
    handleWalletListCallback(ctx)
  );
};

module.exports.handleWalletList = handleWalletList;
module.exports.handleWalletListCallback = handleWalletListCallback;
module.exports.GROUP_WALLET_LIST_TEXT = GROUP_WALLET_LIST_TEXT;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.renderWalletList = renderWalletList;
module.exports.walletListKeyboard = walletListKeyboard;
module.exports.walletListCallbackData = walletListCallbackData;
