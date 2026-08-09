/**
 * Private-chat reply keyboard and group game-link gate helpers.
 */

const { Markup } = require("telegraf");

const MENU_LABELS = Object.freeze({
  POINTS: "🥭 My Points",
  SNAKE: "🎮 Play Snake",
  BOUNCH: "🏀 Play Bounch",
  LEADERBOARD: "🏆 Leaderboard",
  WEEKLY: "📅 Weekly",
  HELP: "ℹ️ Help",
});

const MENU_LABEL_LIST = Object.freeze(Object.values(MENU_LABELS));

const GROUP_SNAKE_MESSAGE =
  "🎮 Snake uses a personal game link.\nOpen ManGo Bot privately to play with your profile.";

const GROUP_BOUNCH_MESSAGE =
  "🏀 Bounch uses a personal game link.\nOpen ManGo Bot privately to play with your profile.";

const GROUP_SNAKE_BUTTON_LABEL = "🐍 Play Snake privately";
const GROUP_BOUNCH_BUTTON_LABEL = "🏀 Play Bounch privately";

function isPrivateChat(ctx) {
  return Boolean(ctx && ctx.chat && ctx.chat.type === "private");
}

function isGroupChat(ctx) {
  return Boolean(
    ctx &&
      ctx.chat &&
      (ctx.chat.type === "group" || ctx.chat.type === "supergroup")
  );
}

function isPrivateMenuLabel(text) {
  return typeof text === "string" && MENU_LABEL_LIST.includes(text);
}

/**
 * Prefer live bot username from Telegraf context (ctx.botInfo).
 * @param {object} ctx
 * @returns {string|null}
 */
function getBotUsername(ctx) {
  const username = ctx && ctx.botInfo && ctx.botInfo.username;
  if (typeof username === "string" && username.trim()) {
    return username.trim();
  }
  return null;
}

/**
 * @param {string} username
 * @param {string} payload
 * @returns {string|null}
 */
function buildPrivateDeepLink(username, payload) {
  if (typeof username !== "string" || !username.trim()) {
    return null;
  }
  if (typeof payload !== "string" || !payload.trim()) {
    return null;
  }
  return `https://t.me/${username.trim()}?start=${encodeURIComponent(payload.trim())}`;
}

function getPrivateMenuKeyboard() {
  return Markup.keyboard([
    [MENU_LABELS.POINTS, MENU_LABELS.SNAKE],
    [MENU_LABELS.BOUNCH, MENU_LABELS.LEADERBOARD],
    [MENU_LABELS.WEEKLY, MENU_LABELS.HELP],
  ]).resize();
}

function getGroupGameMessage(game) {
  if (game === "snake") {
    return GROUP_SNAKE_MESSAGE;
  }
  if (game === "bounch") {
    return GROUP_BOUNCH_MESSAGE;
  }
  return GROUP_SNAKE_MESSAGE;
}

/**
 * Inline URL button that deep-links into a private /start payload.
 * Token is NOT created here — only when the user opens the bot privately.
 *
 * @param {object} ctx
 * @param {"snake"|"bounch"} game
 * @returns {object} Telegraf extra / empty object when username unavailable
 */
function getGroupGameGateExtra(ctx, game) {
  const username = getBotUsername(ctx);
  const url = buildPrivateDeepLink(username, game);
  if (!url) {
    return {};
  }

  const label =
    game === "bounch" ? GROUP_BOUNCH_BUTTON_LABEL : GROUP_SNAKE_BUTTON_LABEL;

  return Markup.inlineKeyboard([Markup.button.url(label, url)]);
}

module.exports = {
  MENU_LABELS,
  MENU_LABEL_LIST,
  GROUP_SNAKE_MESSAGE,
  GROUP_BOUNCH_MESSAGE,
  GROUP_SNAKE_BUTTON_LABEL,
  GROUP_BOUNCH_BUTTON_LABEL,
  isPrivateChat,
  isGroupChat,
  isPrivateMenuLabel,
  getBotUsername,
  buildPrivateDeepLink,
  getPrivateMenuKeyboard,
  getGroupGameMessage,
  getGroupGameGateExtra,
};
