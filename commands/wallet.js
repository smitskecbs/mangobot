/**
 * /wallet and /mywallet — Solana wallet verification status and connect links.
 *
 * Group: private deep-link only (no wallet dump).
 * Private: status + connect / replace / disconnect (disconnect requires confirm).
 * Callbacks are opaque: w:d / w:dy / w:dn — never uid or wallet address.
 */

const { Markup } = require("telegraf");
const {
  isPrivateChat,
  isGroupChat,
  getPrivateMenuKeyboard,
  resolveBotUsername,
  buildPrivateDeepLink,
} = require("../utils/botMenu");
const {
  shortenWallet,
  formatVerifiedDate,
} = require("../utils/solanaWallet");
const {
  getVerifiedWalletForUser,
  disconnectWallet,
} = require("../services/walletLinks");
const { createLinkToken } = require("../services/walletVerification");

const WALLET_CALLBACK = Object.freeze({
  DISCONNECT: "w:d",
  CONFIRM: "w:dy",
  CANCEL: "w:dn",
});

const GROUP_WALLET_TEXT = "🥭 Manage your wallet privately.";

const UNVERIFIED_TEXT = `🥭 ManGo Wallet

No wallet connected yet.

Connect and verify a Solana wallet to link it to your ManGo profile.`;

const DISCONNECT_PROMPT = "Disconnect your verified wallet?";

const DISCONNECT_CANCELLED = "Wallet disconnect cancelled.";

const DISCONNECT_DONE = "🥭 Your Solana wallet has been disconnected.";

const CONNECT_UNAVAILABLE =
  "🥭 Wallet link is temporarily unavailable. Please try again later.";

function buildVerifiedText(record) {
  const short = shortenWallet(record.wallet);
  const date = formatVerifiedDate(record.verifiedAt);
  const dateLine = date ? `Verified: ${date}` : "Verified:";
  return `🥭 Your ManGo Wallet

✅ Verified
Wallet: ${short}
${dateLine}`;
}

function getGroupWalletExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "wallet");
  if (!url) {
    return {};
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Wallet", url)]]);
}

function buildConnectExtra(url) {
  if (!url) {
    return undefined;
  }
  return Markup.inlineKeyboard([[Markup.button.url("Connect Wallet", url)]]);
}

function buildVerifiedExtra(replaceUrl) {
  const rows = [];
  if (replaceUrl) {
    rows.push([Markup.button.url("Replace Wallet", replaceUrl)]);
  }
  rows.push([
    Markup.button.callback("Disconnect Wallet", WALLET_CALLBACK.DISCONNECT),
  ]);
  return Markup.inlineKeyboard(rows);
}

function buildDisconnectConfirmExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Yes, disconnect", WALLET_CALLBACK.CONFIRM)],
    [Markup.button.callback("Cancel", WALLET_CALLBACK.CANCEL)],
  ]);
}

function createConnectUrl(userId, options = {}) {
  try {
    if (userId === undefined || userId === null || userId === "") {
      return null;
    }
    const created = createLinkToken(userId, options);
    return created.url;
  } catch {
    return null;
  }
}

function privateExtra(inlineExtra) {
  if (inlineExtra) {
    return inlineExtra;
  }
  return getPrivateMenuKeyboard();
}

function handleWallet(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }

  if (!isPrivateChat(ctx)) {
    if (isGroupChat(ctx)) {
      return ctx.reply(GROUP_WALLET_TEXT, getGroupWalletExtra(ctx));
    }
    return ctx.reply(GROUP_WALLET_TEXT);
  }

  const userId = ctx.from.id;
  const record = getVerifiedWalletForUser(userId, options.walletFile);
  const url = createConnectUrl(userId, options);

  if (!record) {
    if (!url) {
      return ctx.reply(CONNECT_UNAVAILABLE, getPrivateMenuKeyboard());
    }
    return ctx.reply(UNVERIFIED_TEXT, privateExtra(buildConnectExtra(url)));
  }

  return ctx.reply(buildVerifiedText(record), privateExtra(buildVerifiedExtra(url)));
}

function isWalletCallback(data) {
  return (
    data === WALLET_CALLBACK.DISCONNECT ||
    data === WALLET_CALLBACK.CONFIRM ||
    data === WALLET_CALLBACK.CANCEL
  );
}

async function safeEdit(ctx, text, extra) {
  if (typeof ctx.editMessageText === "function") {
    try {
      return await ctx.editMessageText(text, extra || undefined);
    } catch {
      // Message not editable — reply instead.
    }
  }
  return ctx.reply(text, extra);
}

async function handleWalletCallback(ctx, options = {}) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";

  if (!isWalletCallback(data)) {
    return;
  }

  try {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery();
    }
  } catch {
    // still try to handle
  }

  if (!isPrivateChat(ctx)) {
    return ctx.reply(GROUP_WALLET_TEXT, getGroupWalletExtra(ctx));
  }

  const userId = ctx.from && ctx.from.id;
  if (!userId) {
    return;
  }

  if (data === WALLET_CALLBACK.DISCONNECT) {
    const record = getVerifiedWalletForUser(userId, options.walletFile);
    if (!record) {
      return ctx.reply(UNVERIFIED_TEXT, getPrivateMenuKeyboard());
    }
    return safeEdit(ctx, DISCONNECT_PROMPT, buildDisconnectConfirmExtra());
  }

  if (data === WALLET_CALLBACK.CANCEL) {
    const record = getVerifiedWalletForUser(userId, options.walletFile);
    if (!record) {
      return safeEdit(ctx, DISCONNECT_CANCELLED);
    }
    const url = createConnectUrl(userId, options);
    return safeEdit(ctx, buildVerifiedText(record), buildVerifiedExtra(url));
  }

  if (data === WALLET_CALLBACK.CONFIRM) {
    disconnectWallet(userId, options.walletFile);
    const url = createConnectUrl(userId, options);
    return safeEdit(ctx, DISCONNECT_DONE, buildConnectExtra(url));
  }
}

module.exports = (bot) => {
  bot.command("wallet", (ctx) => handleWallet(ctx));
  bot.command("mywallet", (ctx) => handleWallet(ctx));
  bot.action(/^w:d(y|n)?$/, (ctx) => handleWalletCallback(ctx));
};

module.exports.handleWallet = handleWallet;
module.exports.handleWalletCallback = handleWalletCallback;
module.exports.WALLET_CALLBACK = WALLET_CALLBACK;
module.exports.GROUP_WALLET_TEXT = GROUP_WALLET_TEXT;
module.exports.UNVERIFIED_TEXT = UNVERIFIED_TEXT;
module.exports.DISCONNECT_PROMPT = DISCONNECT_PROMPT;
module.exports.DISCONNECT_DONE = DISCONNECT_DONE;
module.exports.DISCONNECT_CANCELLED = DISCONNECT_CANCELLED;
module.exports.buildVerifiedText = buildVerifiedText;
module.exports.createConnectUrl = createConnectUrl;
module.exports.getGroupWalletExtra = getGroupWalletExtra;
