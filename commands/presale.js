/**
 * /presale — private hub. Group: private deep-link only.
 * Live UX is gated by PRESALE_ENABLED + treasury. Default remains Coming soon.
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
const { getVerifiedWalletForUser } = require("../services/walletLinks");
const { createLinkToken } = require("../services/walletVerification");
const { createPresaleSession } = require("../services/presaleSessions");
const {
  getPresaleStatus,
  getPresaleParticipation,
} = require("../services/presaleLedger");
const { isPresaleLive } = require("../services/presaleConfig");
const { shortenWallet } = require("../utils/solanaWallet");
const {
  MANGO_PER_SOL_HUMAN,
  MIN_SOL_HUMAN,
  MAX_WALLET_SOL_HUMAN,
  PRESALE_MANGO_HUMAN,
  formatLamportsAsSol,
} = require("../services/presaleConstants");

const GROUP_PRESALE_TEXT = `🥭 ManGo Presale

Open the presale privately.`;

const PRESALE_COMING_SOON_TEXT = `🥭 ManGo Presale

The presale is not live yet.

Your verified wallet will be used to securely link future presale participation to your ManGo profile.

No payment is required yet.`;

const PRESALE_CALLBACK = Object.freeze({
  INFO: "psale:info",
  BACK: "psale:back",
  JOIN: "psale:join",
  CONNECT: "psale:connect",
});

function getGroupPresaleExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "presale");
  if (!url) {
    return {};
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Presale", url)]]);
}

function comingSoonExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Presale Info", PRESALE_CALLBACK.INFO)],
    [Markup.button.callback("⬅️ Back", PRESALE_CALLBACK.BACK)],
  ]);
}

function unverifiedExtra(connectUrl) {
  const rows = [];
  if (connectUrl) {
    rows.push([Markup.button.url("Connect Wallet", connectUrl)]);
  }
  rows.push([Markup.button.callback("⬅️ Back", PRESALE_CALLBACK.BACK)]);
  return Markup.inlineKeyboard(rows);
}

function verifiedExtra(joinEnabled) {
  const rows = [];
  if (joinEnabled) {
    rows.push([Markup.button.callback("Join Presale", PRESALE_CALLBACK.JOIN)]);
  }
  rows.push([Markup.button.callback("⬅️ Back", PRESALE_CALLBACK.BACK)]);
  return Markup.inlineKeyboard(rows);
}

function createConnectUrl(userId, options = {}) {
  try {
    if (userId === undefined || userId === null || userId === "") {
      return null;
    }
    return createLinkToken(userId, options).url;
  } catch {
    return null;
  }
}

function buildPrivatePresaleView(ctx, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  if (!isPresaleLive(now, options.env)) {
    return { text: PRESALE_COMING_SOON_TEXT, extra: comingSoonExtra() };
  }

  const userId = ctx.from.id;
  const verified = getVerifiedWalletForUser(userId, options.walletFile);
  if (!verified) {
    return {
      text: `🥭 ManGo Presale

Wallet verification required.

Connect your Solana wallet to join the presale.`,
      extra: unverifiedExtra(createConnectUrl(userId, options)),
    };
  }

  const status = getPresaleStatus({ ...options, now });
  const participation = getPresaleParticipation(userId, options.presaleFile);
  const joinEnabled = !status.soldOut;
  const text = [
    "🥭 ManGo Presale",
    "",
    "Wallet: ✅ Verified",
    `Wallet: ${shortenWallet(verified.wallet)}`,
    "",
    "Rate:",
    `1 SOL = ${MANGO_PER_SOL_HUMAN.toString()} MANGO`,
    "",
    "Minimum:",
    `${MIN_SOL_HUMAN} SOL`,
    "",
    "Maximum per wallet:",
    `${MAX_WALLET_SOL_HUMAN} SOL`,
    "",
    "Your contribution:",
    `${formatLamportsAsSol(participation.confirmedLamports)} SOL`,
    "",
    "Your allocation:",
    `${participation.allocation || "0"} MANGO`,
    "",
    "Remaining presale:",
    `${status.remainingMango} / ${PRESALE_MANGO_HUMAN.toString()} MANGO`,
    status.soldOut ? "\nPresale is sold out." : "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n\n\n/g, "\n\n");

  return { text, extra: verifiedExtra(joinEnabled) };
}

function handlePresale(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }

  if (!isPrivateChat(ctx)) {
    if (isGroupChat(ctx)) {
      return ctx.reply(GROUP_PRESALE_TEXT, getGroupPresaleExtra(ctx));
    }
    return ctx.reply(GROUP_PRESALE_TEXT);
  }

  const view = buildPrivatePresaleView(ctx, options);
  return ctx.reply(view.text, view.extra);
}

function isPresaleCallback(data) {
  return (
    data === PRESALE_CALLBACK.INFO ||
    data === PRESALE_CALLBACK.BACK ||
    data === PRESALE_CALLBACK.JOIN ||
    data === PRESALE_CALLBACK.CONNECT
  );
}

async function handlePresaleCallback(ctx, options = {}) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";

  if (!isPresaleCallback(data)) {
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
    return ctx.reply(GROUP_PRESALE_TEXT, getGroupPresaleExtra(ctx));
  }

  if (data === PRESALE_CALLBACK.BACK) {
    return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard());
  }

  if (data === PRESALE_CALLBACK.JOIN) {
    const now = options.now === undefined ? Date.now() : options.now;
    if (!isPresaleLive(now, options.env)) {
      return ctx.reply(PRESALE_COMING_SOON_TEXT, comingSoonExtra());
    }
    const created = createPresaleSession(ctx.from.id, options);
    if (!created.ok) {
      if (created.reason === "unverified") {
        const view = buildPrivatePresaleView(ctx, options);
        return ctx.reply(view.text, view.extra);
      }
      return ctx.reply("Presale is not live.", comingSoonExtra());
    }
    return ctx.reply(
      "🥭 Open the ManGo presale page to choose an amount and confirm in your wallet.\n\nMANGO is not delivered in the payment transaction.",
      Markup.inlineKeyboard([
        [Markup.button.url("Open Presale Page", created.url)],
        [Markup.button.callback("⬅️ Back", PRESALE_CALLBACK.BACK)],
      ])
    );
  }

  const view = buildPrivatePresaleView(ctx, options);
  return ctx.reply(view.text, view.extra);
}

module.exports = (bot) => {
  bot.command("presale", (ctx) => handlePresale(ctx));
  bot.action(/^psale:(info|back|join|connect)$/, (ctx) => handlePresaleCallback(ctx));
};

module.exports.handlePresale = handlePresale;
module.exports.handlePresaleCallback = handlePresaleCallback;
module.exports.GROUP_PRESALE_TEXT = GROUP_PRESALE_TEXT;
module.exports.PRESALE_COMING_SOON_TEXT = PRESALE_COMING_SOON_TEXT;
module.exports.PRESALE_CALLBACK = PRESALE_CALLBACK;
module.exports.getGroupPresaleExtra = getGroupPresaleExtra;
module.exports.buildPrivatePresaleView = buildPrivatePresaleView;
