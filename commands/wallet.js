/**
 * /wallet and /mywallet — Solana wallet hub and management.
 *
 * Group: private deep-link only (no wallet dump).
 * Private: hub + connect / replace / disconnect (disconnect requires confirm).
 * Callbacks are opaque: w:d / w:dy / w:dn / whub:* — never uid or wallet address.
 */

const { Markup } = require("telegraf");
const {
  isPrivateChat,
  isGroupChat,
  getPrivateMenuKeyboard,
  resolveBotUsername,
  buildPrivateDeepLink,
  PRIVATE_MENU_HINT,
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
const { getMemberWalletProfile } = require("../services/memberWalletProfile");
const { formatPresaleWalletLines } = require("../services/presaleParticipation");
const { handleRewards } = require("./rewards");
const { handlePresale } = require("./presale");

const WALLET_CALLBACK = Object.freeze({
  DISCONNECT: "w:d",
  CONFIRM: "w:dy",
  CANCEL: "w:dn",
});

const WALLET_HUB_CALLBACK = Object.freeze({
  OPEN: "whub:open",
  MANAGE: "whub:manage",
  REWARDS: "whub:rewards",
  PRESALE: "whub:presale",
  BACK: "whub:back",
});

const GROUP_WALLET_TEXT = "🥭 Manage your wallet privately.";

const UNVERIFIED_TEXT = `🥭 ManGo Wallet

⬜ No wallet connected

Connect your Solana wallet to unlock ManGo member features.`;

const DISCONNECT_PROMPT = "Disconnect your verified wallet?";

const DISCONNECT_CANCELLED = "Wallet disconnect cancelled.";

const DISCONNECT_DONE = "🥭 Your Solana wallet has been disconnected.";

const CONNECT_UNAVAILABLE =
  "🥭 Wallet link is temporarily unavailable. Please try again later.";

function formatRewardsWalletLines(summary) {
  if (!summary || !summary.pending) {
    return ["Rewards:", "No pending rewards"];
  }
  const pending = summary.pending;
  const delivered = summary.delivered || 0;
  if (delivered > 0) {
    return ["Rewards:", `${pending} pending · ${delivered} delivered`];
  }
  return ["Rewards:", `${pending} pending`];
}

function buildVerifiedText(record, extras = {}) {
  const short = shortenWallet(record.wallet);
  const date = formatVerifiedDate(record.verifiedAt);
  const dateLine = date ? `Verified: ${date}` : "Verified:";
  const presaleLines = formatPresaleWalletLines(extras.presale);
  const rewardLines = formatRewardsWalletLines(extras.rewards);
  return [
    "🥭 Your ManGo Wallet",
    "",
    "✅ Verified",
    `Wallet: ${short}`,
    dateLine,
    "",
    ...presaleLines,
    "",
    ...rewardLines,
  ].join("\n");
}

function buildVerifiedHubText(record) {
  const short = shortenWallet(record.wallet);
  return ["🥭 ManGo Wallet", "", "✅ Verified", `Wallet: ${short}`].join("\n");
}

function getGroupWalletExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "wallet");
  if (!url) {
    return {};
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Wallet", url)]]);
}

function buildUnverifiedHubExtra(url) {
  const rows = [];
  if (url) {
    rows.push([Markup.button.url("Connect Wallet", url)]);
  }
  rows.push([Markup.button.callback("⬅️ Back", WALLET_HUB_CALLBACK.BACK)]);
  return Markup.inlineKeyboard(rows);
}

function buildVerifiedHubExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Manage Wallet", WALLET_HUB_CALLBACK.MANAGE)],
    [Markup.button.callback("Rewards", WALLET_HUB_CALLBACK.REWARDS)],
    [Markup.button.callback("Presale", WALLET_HUB_CALLBACK.PRESALE)],
    [Markup.button.callback("⬅️ Back", WALLET_HUB_CALLBACK.BACK)],
  ]);
}

function buildConnectExtra(url) {
  return buildUnverifiedHubExtra(url);
}

function buildVerifiedExtra(replaceUrl) {
  const rows = [];
  if (replaceUrl) {
    rows.push([Markup.button.url("Replace Wallet", replaceUrl)]);
  }
  rows.push([
    Markup.button.callback("Disconnect Wallet", WALLET_CALLBACK.DISCONNECT),
  ]);
  rows.push([Markup.button.callback("⬅️ Back", WALLET_HUB_CALLBACK.OPEN)]);
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

function replyWalletHub(ctx, options = {}) {
  const userId = ctx.from.id;
  const record = getVerifiedWalletForUser(userId, options.walletFile);
  const url = createConnectUrl(userId, options);

  if (!record) {
    if (!url) {
      return ctx.reply(CONNECT_UNAVAILABLE, getPrivateMenuKeyboard());
    }
    return ctx.reply(UNVERIFIED_TEXT, privateExtra(buildUnverifiedHubExtra(url)));
  }

  return ctx.reply(buildVerifiedHubText(record), privateExtra(buildVerifiedHubExtra()));
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

  return replyWalletHub(ctx, options);
}

function isWalletCallback(data) {
  return (
    data === WALLET_CALLBACK.DISCONNECT ||
    data === WALLET_CALLBACK.CONFIRM ||
    data === WALLET_CALLBACK.CANCEL ||
    data === WALLET_HUB_CALLBACK.OPEN ||
    data === WALLET_HUB_CALLBACK.MANAGE ||
    data === WALLET_HUB_CALLBACK.REWARDS ||
    data === WALLET_HUB_CALLBACK.PRESALE ||
    data === WALLET_HUB_CALLBACK.BACK
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

async function showWalletHub(ctx, options = {}) {
  const userId = ctx.from.id;
  const record = getVerifiedWalletForUser(userId, options.walletFile);
  const url = createConnectUrl(userId, options);
  if (!record) {
    if (!url) {
      return safeEdit(ctx, CONNECT_UNAVAILABLE, getPrivateMenuKeyboard());
    }
    return safeEdit(ctx, UNVERIFIED_TEXT, buildUnverifiedHubExtra(url));
  }
  return safeEdit(ctx, buildVerifiedHubText(record), buildVerifiedHubExtra());
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

  if (data === WALLET_HUB_CALLBACK.BACK) {
    return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard());
  }

  if (data === WALLET_HUB_CALLBACK.OPEN) {
    return showWalletHub(ctx, options);
  }

  if (data === WALLET_HUB_CALLBACK.REWARDS) {
    return handleRewards(ctx, options);
  }

  if (data === WALLET_HUB_CALLBACK.PRESALE) {
    return handlePresale(ctx, options);
  }

  if (data === WALLET_HUB_CALLBACK.MANAGE) {
    const record = getVerifiedWalletForUser(userId, options.walletFile);
    if (!record) {
      return showWalletHub(ctx, options);
    }
    const url = createConnectUrl(userId, options);
    const profile = getMemberWalletProfile(userId, {
      walletFile: options.walletFile,
      rewardsFile: options.rewardsFile,
    });
    return safeEdit(
      ctx,
      buildVerifiedText(record, {
        presale: profile.presale,
        rewards: profile.rewards,
      }),
      buildVerifiedExtra(url)
    );
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
    const profile = getMemberWalletProfile(userId, {
      walletFile: options.walletFile,
      rewardsFile: options.rewardsFile,
    });
    return safeEdit(
      ctx,
      buildVerifiedText(record, {
        presale: profile.presale,
        rewards: profile.rewards,
      }),
      buildVerifiedExtra(url)
    );
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
  bot.action(/^(w:d(y|n)?|whub:(open|manage|rewards|presale|back))$/, (ctx) =>
    handleWalletCallback(ctx)
  );
};

module.exports.handleWallet = handleWallet;
module.exports.handleWalletCallback = handleWalletCallback;
module.exports.WALLET_CALLBACK = WALLET_CALLBACK;
module.exports.WALLET_HUB_CALLBACK = WALLET_HUB_CALLBACK;
module.exports.GROUP_WALLET_TEXT = GROUP_WALLET_TEXT;
module.exports.UNVERIFIED_TEXT = UNVERIFIED_TEXT;
module.exports.DISCONNECT_PROMPT = DISCONNECT_PROMPT;
module.exports.DISCONNECT_DONE = DISCONNECT_DONE;
module.exports.DISCONNECT_CANCELLED = DISCONNECT_CANCELLED;
module.exports.buildVerifiedText = buildVerifiedText;
module.exports.buildVerifiedHubText = buildVerifiedHubText;
module.exports.createConnectUrl = createConnectUrl;
module.exports.getGroupWalletExtra = getGroupWalletExtra;
