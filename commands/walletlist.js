/**
 * Admin-only /walletlist — private overview of linked vs unlinked members.
 * Pagination callbacks carry only a page index. No full wallets. No uids.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const {
  buildWalletListPage,
  parseWalletListCallback,
  walletListCallbackData,
  WALLET_LIST_CALLBACK_PREFIX,
} = require("../services/walletList");

const ADMIN_ONLY = "This command is admin only.";
const GROUP_WALLET_LIST_TEXT =
  "Open a private chat with the bot to view the wallet overview.";

function walletListKeyboard(page, lastPage) {
  if (lastPage <= 0) {
    return undefined;
  }
  const row = [];
  if (page > 0) {
    row.push(Markup.button.callback("« Previous", walletListCallbackData(page - 1)));
  }
  if (page < lastPage) {
    row.push(Markup.button.callback("Next »", walletListCallbackData(page + 1)));
  }
  if (!row.length) {
    return undefined;
  }
  return Markup.inlineKeyboard([row]);
}

function renderWalletList(options = {}) {
  const built = buildWalletListPage(options);
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

function handleWalletList(ctx, options = {}) {
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
  const rendered = renderWalletList({
    page: 0,
    pointsFile: options.pointsFile,
    walletFile: options.walletFile,
    pageSize: options.pageSize,
  });
  return ctx.reply(rendered.text, rendered.extra);
}

async function handleWalletListCallback(ctx, options = {}) {
  if (!ctx || !ctx.from || !ctx.callbackQuery) {
    return undefined;
  }
  const parsed = parseWalletListCallback(ctx.callbackQuery.data);
  if (!parsed) {
    return undefined;
  }
  if (typeof ctx.answerCbQuery === "function") {
    await ctx.answerCbQuery();
  }
  if (!isPrivateChat(ctx)) {
    if (isAdmin(ctx.from.id)) {
      return ctx.reply(GROUP_WALLET_LIST_TEXT);
    }
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply(ADMIN_ONLY);
  }
  const rendered = renderWalletList({
    page: parsed.page,
    pointsFile: options.pointsFile,
    walletFile: options.walletFile,
    pageSize: options.pageSize,
  });
  if (typeof ctx.editMessageText === "function") {
    return ctx.editMessageText(rendered.text, rendered.extra);
  }
  return ctx.reply(rendered.text, rendered.extra);
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
