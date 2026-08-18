/**
 * /wallet and /mywallet — Solana wallet hub and management.
 *
 * Group: private deep-link only (no wallet dump).
 * Private: connect+verify (website) or enter public address (Telegram-only).
 * Manual addresses are registered, not cryptographically verified.
 * Callbacks are opaque — never uid or wallet address.
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
  normalizeSolanaPublicKey,
} = require("../utils/solanaWallet");
const {
  getLinkedWalletForUser,
  getVerifiedWalletForUser,
  disconnectWallet,
  registerManualWallet,
  beginWalletAddressInput,
  getPendingWalletInput,
  clearPendingWalletInput,
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
  ENTER: "w:enter",
  CHANGE: "w:chg",
  INPUT_CANCEL: "w:ic",
});

const WALLET_HUB_CALLBACK = Object.freeze({
  OPEN: "whub:open",
  MANAGE: "whub:manage",
  REWARDS: "whub:rewards",
  PRESALE: "whub:presale",
  BACK: "whub:back",
});

const GROUP_WALLET_TEXT = "🥭 Manage your wallet privately.";

const UNVERIFIED_TEXT = `💳 My Wallet

No wallet registered yet.

Choose how you want to add your wallet:`;

const ENTER_WALLET_PROMPT = `Send your Solana wallet address below.

⚠️ Make sure the address is correct.
Rewards and Mystery Gifts may be sent to this wallet.

Never send your seed phrase or private key.`;

const INVALID_WALLET_TEXT =
  "❌ That doesn't look like a valid Solana wallet address. Try again or cancel.";

const WALLET_TAKEN_TEXT = "This wallet is already linked to another ManGo profile.";

const DISCONNECT_PROMPT = "Disconnect your verified wallet?";
const REMOVE_PROMPT = "Remove your registered wallet?";
const DISCONNECT_CANCELLED = "Wallet disconnect cancelled.";
const INPUT_CANCELLED = "Wallet address entry cancelled.";
const DISCONNECT_DONE = "🥭 Your Solana wallet has been disconnected.";
const CONNECT_UNAVAILABLE =
  "🥭 Wallet link is temporarily unavailable. Please try again later.";

function isSlashCommand(text) {
  return typeof text === "string" && text.trim().startsWith("/");
}

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

function statusLine(record) {
  if (record && record.verified) {
    return "Status: 🟢 Verified";
  }
  if (record && record.wallet) {
    return "Status: 🟡 Registered";
  }
  return "Status: ⬜ None";
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
  return ["💳 My Wallet", "", `Wallet: ${short}`, "Status: 🟢 Verified"].join("\n");
}

function buildRegisteredHubText(record) {
  const short = shortenWallet(record.wallet);
  return ["💳 My Wallet", "", `Wallet: ${short}`, "Status: 🟡 Registered"].join("\n");
}

function buildRegisteredSuccessText(record) {
  const short = shortenWallet(record.wallet);
  return [
    "✅ Wallet registered",
    "",
    short,
    "",
    "This wallet can now be used for ManGo rewards and Mystery Gifts.",
    "",
    "Status: 🟡 Registered",
  ].join("\n");
}

function getGroupWalletExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "wallet");
  if (!url) {
    return {};
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Wallet", url)]]);
}

function buildEmptyHubExtra(url) {
  const rows = [];
  if (url) {
    rows.push([Markup.button.url("🌐 Connect & Verify", url)]);
  }
  rows.push([Markup.button.callback("⌨️ Enter Wallet Address", WALLET_CALLBACK.ENTER)]);
  rows.push([Markup.button.callback("⬅️ Back", WALLET_HUB_CALLBACK.BACK)]);
  return Markup.inlineKeyboard(rows);
}

function buildRegisteredHubExtra(url) {
  const rows = [];
  if (url) {
    rows.push([Markup.button.url("🌐 Verify Wallet", url)]);
  }
  rows.push([Markup.button.callback("✏️ Change Wallet", WALLET_CALLBACK.CHANGE)]);
  rows.push([Markup.button.callback("🗑 Remove Wallet", WALLET_CALLBACK.DISCONNECT)]);
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
  return buildEmptyHubExtra(url);
}

function buildVerifiedExtra(replaceUrl) {
  const rows = [];
  if (replaceUrl) {
    rows.push([Markup.button.url("Replace Wallet", replaceUrl)]);
  }
  rows.push([Markup.button.callback("✏️ Change Wallet", WALLET_CALLBACK.CHANGE)]);
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

function buildInputCancelExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Cancel", WALLET_CALLBACK.INPUT_CANCEL)],
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
  const record = getLinkedWalletForUser(userId, options.walletFile);
  const url = createConnectUrl(userId, options);

  if (!record) {
    return ctx.reply(UNVERIFIED_TEXT, privateExtra(buildEmptyHubExtra(url)));
  }

  if (!record.verified) {
    return ctx.reply(buildRegisteredHubText(record), privateExtra(buildRegisteredHubExtra(url)));
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
    data === WALLET_CALLBACK.ENTER ||
    data === WALLET_CALLBACK.CHANGE ||
    data === WALLET_CALLBACK.INPUT_CANCEL ||
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
  const record = getLinkedWalletForUser(userId, options.walletFile);
  const url = createConnectUrl(userId, options);
  if (!record) {
    return safeEdit(ctx, UNVERIFIED_TEXT, buildEmptyHubExtra(url));
  }
  if (!record.verified) {
    return safeEdit(ctx, buildRegisteredHubText(record), buildRegisteredHubExtra(url));
  }
  return safeEdit(ctx, buildVerifiedHubText(record), buildVerifiedHubExtra());
}

function startAddressInput(ctx, purpose, options = {}) {
  const userId = ctx.from.id;
  const chatId = ctx.chat && ctx.chat.id;
  beginWalletAddressInput(userId, chatId, purpose, options.walletFile, options.now);
  return safeEdit(ctx, ENTER_WALLET_PROMPT, buildInputCancelExtra());
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

  if (data === WALLET_CALLBACK.ENTER) {
    return startAddressInput(ctx, "register", options);
  }

  if (data === WALLET_CALLBACK.CHANGE) {
    const record = getLinkedWalletForUser(userId, options.walletFile);
    if (!record) {
      return showWalletHub(ctx, options);
    }
    return startAddressInput(ctx, "change", options);
  }

  if (data === WALLET_CALLBACK.INPUT_CANCEL) {
    clearPendingWalletInput(userId, options.walletFile, options.now);
    const url = createConnectUrl(userId, options);
    const record = getLinkedWalletForUser(userId, options.walletFile);
    if (!record) {
      return safeEdit(ctx, INPUT_CANCELLED, buildEmptyHubExtra(url));
    }
    if (!record.verified) {
      return safeEdit(ctx, INPUT_CANCELLED, buildRegisteredHubExtra(url));
    }
    return safeEdit(ctx, INPUT_CANCELLED, buildVerifiedHubExtra());
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
    const record = getLinkedWalletForUser(userId, options.walletFile);
    if (!record) {
      return ctx.reply(UNVERIFIED_TEXT, getPrivateMenuKeyboard());
    }
    const prompt = record.verified ? DISCONNECT_PROMPT : REMOVE_PROMPT;
    return safeEdit(ctx, prompt, buildDisconnectConfirmExtra());
  }

  if (data === WALLET_CALLBACK.CANCEL) {
    const record = getLinkedWalletForUser(userId, options.walletFile);
    if (!record) {
      return safeEdit(ctx, DISCONNECT_CANCELLED);
    }
    if (!record.verified) {
      const url = createConnectUrl(userId, options);
      return safeEdit(ctx, buildRegisteredHubText(record), buildRegisteredHubExtra(url));
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

/**
 * Consume the next private text message while address input is pending.
 * Always return a boolean so callers can still next() the Telegraf chain.
 */
function handleWalletText(ctx, options = {}) {
  if (!ctx || !ctx.from || !ctx.message) {
    return false;
  }
  if (!isPrivateChat(ctx)) {
    return false;
  }
  const raw = typeof ctx.message.text === "string" ? ctx.message.text : "";
  if (!raw || isSlashCommand(raw)) {
    return false;
  }

  const userId = ctx.from.id;
  const pending = getPendingWalletInput(userId, options.walletFile, options.now);
  if (!pending) {
    return false;
  }
  if (pending.chatId && ctx.chat && String(ctx.chat.id) !== String(pending.chatId)) {
    return false;
  }

  const canonical = normalizeSolanaPublicKey(raw);
  if (!canonical) {
    ctx.reply(INVALID_WALLET_TEXT, buildInputCancelExtra());
    return true;
  }

  const result = registerManualWallet(userId, canonical, options.walletFile, options.now);
  if (!result.ok) {
    if (result.reason === "wallet-taken") {
      ctx.reply(WALLET_TAKEN_TEXT, buildInputCancelExtra());
      return true;
    }
    ctx.reply(INVALID_WALLET_TEXT, buildInputCancelExtra());
    return true;
  }

  const record = getLinkedWalletForUser(userId, options.walletFile);
  const url = createConnectUrl(userId, options);
  if (record && record.verified) {
    ctx.reply(buildVerifiedHubText(record), privateExtra(buildVerifiedHubExtra()));
    return true;
  }
  ctx.reply(buildRegisteredSuccessText(record), privateExtra(buildRegisteredHubExtra(url)));
  return true;
}

module.exports = (bot) => {
  bot.command("wallet", (ctx) => handleWallet(ctx));
  bot.command("mywallet", (ctx) => handleWallet(ctx));
  bot.action(
    /^(w:d(y|n)?|w:enter|w:chg|w:ic|whub:(open|manage|rewards|presale|back))$/,
    (ctx) => handleWalletCallback(ctx)
  );
  bot.on("text", (ctx, next) => {
    handleWalletText(ctx);
    return typeof next === "function" ? next() : undefined;
  });
};

module.exports.handleWallet = handleWallet;
module.exports.handleWalletCallback = handleWalletCallback;
module.exports.handleWalletText = handleWalletText;
module.exports.WALLET_CALLBACK = WALLET_CALLBACK;
module.exports.WALLET_HUB_CALLBACK = WALLET_HUB_CALLBACK;
module.exports.GROUP_WALLET_TEXT = GROUP_WALLET_TEXT;
module.exports.UNVERIFIED_TEXT = UNVERIFIED_TEXT;
module.exports.ENTER_WALLET_PROMPT = ENTER_WALLET_PROMPT;
module.exports.INVALID_WALLET_TEXT = INVALID_WALLET_TEXT;
module.exports.INPUT_CANCELLED = INPUT_CANCELLED;
module.exports.DISCONNECT_PROMPT = DISCONNECT_PROMPT;
module.exports.REMOVE_PROMPT = REMOVE_PROMPT;
module.exports.DISCONNECT_DONE = DISCONNECT_DONE;
module.exports.DISCONNECT_CANCELLED = DISCONNECT_CANCELLED;
module.exports.buildVerifiedText = buildVerifiedText;
module.exports.buildVerifiedHubText = buildVerifiedHubText;
module.exports.buildRegisteredHubText = buildRegisteredHubText;
module.exports.createConnectUrl = createConnectUrl;
module.exports.getGroupWalletExtra = getGroupWalletExtra;
module.exports.statusLine = statusLine;
