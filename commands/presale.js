/**
 * /presale — coming-soon status. No payment, treasury, or allocation.
 *
 * Group: private deep-link only.
 * Private: Coming soon copy while PRESALE_LIVE=false.
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
  PRESALE_LIVE,
  getPresalePublicStatus,
} = require("../services/presaleParticipation");

const GROUP_PRESALE_TEXT = "🥭 View presale info privately.";

const PRESALE_COMING_SOON_TEXT = `🥭 ManGo Presale

The presale is not live yet.

Your verified wallet will be used to securely link future presale participation to your ManGo profile.

No payment is required yet.`;

const PRESALE_CALLBACK = Object.freeze({
  INFO: "psale:info",
  BACK: "psale:back",
});

function getGroupPresaleExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "presale");
  if (!url) {
    return {};
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Presale", url)]]);
}

function buildPrivatePresaleExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Presale Info", PRESALE_CALLBACK.INFO)],
    [Markup.button.callback("⬅️ Back", PRESALE_CALLBACK.BACK)],
  ]);
}

function privatePresaleBody() {
  const status = getPresalePublicStatus();
  if (!PRESALE_LIVE || !status.live) {
    return PRESALE_COMING_SOON_TEXT;
  }
  return `🥭 ManGo Presale\n\nStatus: ${status.userLine}`;
}

function handlePresale(ctx) {
  if (!ctx || !ctx.from) {
    return undefined;
  }

  if (!isPrivateChat(ctx)) {
    if (isGroupChat(ctx)) {
      return ctx.reply(GROUP_PRESALE_TEXT, getGroupPresaleExtra(ctx));
    }
    return ctx.reply(GROUP_PRESALE_TEXT);
  }

  return ctx.reply(privatePresaleBody(), buildPrivatePresaleExtra());
}

function isPresaleCallback(data) {
  return data === PRESALE_CALLBACK.INFO || data === PRESALE_CALLBACK.BACK;
}

async function handlePresaleCallback(ctx) {
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

  return ctx.reply(privatePresaleBody(), buildPrivatePresaleExtra());
}

module.exports = (bot) => {
  bot.command("presale", (ctx) => handlePresale(ctx));
  bot.action(/^psale:(info|back)$/, (ctx) => handlePresaleCallback(ctx));
};

module.exports.handlePresale = handlePresale;
module.exports.handlePresaleCallback = handlePresaleCallback;
module.exports.GROUP_PRESALE_TEXT = GROUP_PRESALE_TEXT;
module.exports.PRESALE_COMING_SOON_TEXT = PRESALE_COMING_SOON_TEXT;
module.exports.PRESALE_CALLBACK = PRESALE_CALLBACK;
module.exports.getGroupPresaleExtra = getGroupPresaleExtra;
