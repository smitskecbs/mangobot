/**
 * Private-chat reply keyboard and group game-link gate helpers.
 */

const { Markup } = require("telegraf");

const MENU_LABELS = Object.freeze({
  POINTS: "🥭 My Points",
  MY_STREAK: "🔥 My Streak",
  SNAKE: "🎮 Play Snake",
  BOUNCH: "🏀 Play Bounch",
  LEADERBOARD: "🏆 Leaderboard",
  WEEKLY: "📅 Weekly",
  HELP: "ℹ️ Help",
});

const MENU_LABEL_LIST = Object.freeze(Object.values(MENU_LABELS));

const GROUP_MENU_TEXT = `🥭 ManGo Menu

Choose what you want to explore.`;

const GROUP_RANKINGS_TEXT = `🏆 Rankings

Check community progress and weekly competition.`;

const GROUP_GAMES_TEXT = `🎮 Games

Play, compete and challenge the community.`;

const GROUP_PROGRESS_TEXT = `👤 My Progress

Check your XP and activity streak.`;

const PRIVATE_MENU_HINT =
  "🥭 Use the menu below to check points, play, or get help.";

const GROUP_MENU_CALLBACK = Object.freeze({
  RANKINGS: "gmenu:rankings",
  GAMES: "gmenu:games",
  PROGRESS: "gmenu:progress",
  BACK: "gmenu:back",
  LEADERBOARD: "gmenu:lb",
  WEEKLY: "gmenu:weekly",
  WEEKLY_WINNERS: "gmenu:weeklywinners",
  STREAK: "gmenu:streak",
  STREAK_RECORD: "gmenu:streakrecord",
  HELP: "gmenu:help",
  TICTACTOE: "gmenu:tictactoe",
  CONNECT4: "gmenu:connect4",
  TRIVIA: "gmenu:trivia",
});

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
 * Normalize/validate a Telegram bot username for public deep-links.
 * Strips a leading @; rejects malformed values. No secrets involved.
 * @param {unknown} username
 * @returns {string|null}
 */
function normalizeBotUsername(username) {
  if (typeof username !== "string") {
    return null;
  }
  let value = username.trim();
  if (!value) {
    return null;
  }
  if (value.startsWith("@")) {
    value = value.slice(1).trim();
  }
  // Telegram: 5–32 chars, starts with a letter, then letters/digits/underscore.
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) {
    return null;
  }
  return value;
}

/**
 * Bot username from TELEGRAM_BOT_USERNAME (for highscore-server / non-Telegraf).
 * @returns {string|null}
 */
function getConfiguredBotUsername() {
  return normalizeBotUsername(process.env.TELEGRAM_BOT_USERNAME);
}

/**
 * Prefer live bot username from Telegraf context (ctx.botInfo).
 * @param {object} ctx
 * @returns {string|null}
 */
function getBotUsername(ctx) {
  const username = ctx && ctx.botInfo && ctx.botInfo.username;
  return normalizeBotUsername(username);
}

/**
 * Resolve bot username from ctx, then env.
 * @param {object} [ctx]
 * @returns {string|null}
 */
function resolveBotUsername(ctx) {
  return getBotUsername(ctx) || getConfiguredBotUsername();
}

/**
 * @param {string} username
 * @param {string} payload
 * @returns {string|null}
 */
function buildPrivateDeepLink(username, payload) {
  const safeUsername = normalizeBotUsername(username);
  if (!safeUsername) {
    return null;
  }
  if (typeof payload !== "string" || !payload.trim()) {
    return null;
  }
  return `https://t.me/${safeUsername}?start=${encodeURIComponent(payload.trim())}`;
}

/**
 * Public highscore announcement CTA → private /start deep-link (no signed token).
 * Missing/invalid username → null (caller omits CTA; never falls back to Labs URL).
 *
 * @param {"snake"|"bounch"} game
 * @param {string|null|undefined} [username]
 * @returns {string|null}
 */
function buildHighscoreAnnouncementPlayCta(game, username = getConfiguredBotUsername()) {
  if (game !== "snake" && game !== "bounch") {
    return null;
  }
  const url = buildPrivateDeepLink(username, game);
  if (!url) {
    return null;
  }
  return `🎮 Want to challenge it?\nPlay with your profile:\n${url}`;
}

/**
 * Append private play CTA to an announcement body when a valid bot username exists.
 * @param {string} baseText
 * @param {"snake"|"bounch"} game
 * @param {string|null|undefined} [username]
 * @returns {string}
 */
function appendHighscoreAnnouncementPlayCta(
  baseText,
  game,
  username = getConfiguredBotUsername()
) {
  const cta = buildHighscoreAnnouncementPlayCta(game, username);
  if (!cta) {
    return baseText;
  }
  return `${baseText}\n\n${cta}`;
}

function getPrivateMenuKeyboard() {
  return Markup.keyboard([
    [MENU_LABELS.POINTS, MENU_LABELS.MY_STREAK],
    [MENU_LABELS.SNAKE, MENU_LABELS.BOUNCH],
    [MENU_LABELS.HELP],
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

/**
 * Compact group main menu — max 2 buttons per row.
 * @param {object} [_ctx]
 * @returns {object} Telegraf reply extra
 */
function getGroupMenuExtra(_ctx) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🏆 Rankings", GROUP_MENU_CALLBACK.RANKINGS),
      Markup.button.callback("🎮 Games", GROUP_MENU_CALLBACK.GAMES),
    ],
    [
      Markup.button.callback("👤 My Progress", GROUP_MENU_CALLBACK.PROGRESS),
      Markup.button.callback("ℹ️ Help", GROUP_MENU_CALLBACK.HELP),
    ],
  ]);
}

/**
 * Rankings submenu — public boards only (no personal deep-links).
 * @returns {object}
 */
function getGroupRankingsMenuExtra() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Leaderboard", GROUP_MENU_CALLBACK.LEADERBOARD),
      Markup.button.callback("Weekly", GROUP_MENU_CALLBACK.WEEKLY),
    ],
    [
      Markup.button.callback(
        "Weekly Winners",
        GROUP_MENU_CALLBACK.WEEKLY_WINNERS
      ),
      Markup.button.callback("Streak", GROUP_MENU_CALLBACK.STREAK),
    ],
    [
      Markup.button.callback("Streak Record", GROUP_MENU_CALLBACK.STREAK_RECORD),
      Markup.button.callback("⬅️ Back", GROUP_MENU_CALLBACK.BACK),
    ],
  ]);
}

/**
 * Games submenu — Snake/Bounch deep-links; TTT/C4/Trivia callbacks.
 * @param {object} [ctx]
 * @returns {object}
 */
function getGroupGamesMenuExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const snakeUrl = buildPrivateDeepLink(username, "snake");
  const bounchUrl = buildPrivateDeepLink(username, "bounch");

  const playRow = [];
  if (snakeUrl) {
    playRow.push(Markup.button.url("Snake", snakeUrl));
  }
  if (bounchUrl) {
    playRow.push(Markup.button.url("Bounch", bounchUrl));
  }

  const rows = [];
  if (playRow.length) {
    rows.push(playRow);
  }
  rows.push([
    Markup.button.callback("Tic-Tac-Toe", GROUP_MENU_CALLBACK.TICTACTOE),
    Markup.button.callback("Connect Four", GROUP_MENU_CALLBACK.CONNECT4),
  ]);
  rows.push([
    Markup.button.callback("Trivia", GROUP_MENU_CALLBACK.TRIVIA),
    Markup.button.callback("⬅️ Back", GROUP_MENU_CALLBACK.BACK),
  ]);

  return Markup.inlineKeyboard(rows);
}

/**
 * Personal progress deep-links (token minted only in private /start).
 * @param {object} [ctx]
 * @returns {object}
 */
function getGroupProgressMenuExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const pointsUrl = buildPrivateDeepLink(username, "points");
  const streakUrl = buildPrivateDeepLink(username, "streak");

  const personalRow = [];
  if (pointsUrl) {
    personalRow.push(Markup.button.url("My Points", pointsUrl));
  }
  if (streakUrl) {
    personalRow.push(Markup.button.url("My Streak", streakUrl));
  }

  const rows = [];
  if (personalRow.length) {
    rows.push(personalRow);
  }
  rows.push([Markup.button.callback("⬅️ Back", GROUP_MENU_CALLBACK.BACK)]);

  return Markup.inlineKeyboard(rows);
}

function isGroupMenuNavCallback(data) {
  return (
    data === GROUP_MENU_CALLBACK.RANKINGS ||
    data === GROUP_MENU_CALLBACK.GAMES ||
    data === GROUP_MENU_CALLBACK.PROGRESS ||
    data === GROUP_MENU_CALLBACK.BACK
  );
}

function isGroupMenuCallback(data) {
  return (
    isGroupMenuNavCallback(data) ||
    data === GROUP_MENU_CALLBACK.LEADERBOARD ||
    data === GROUP_MENU_CALLBACK.WEEKLY ||
    data === GROUP_MENU_CALLBACK.WEEKLY_WINNERS ||
    data === GROUP_MENU_CALLBACK.STREAK ||
    data === GROUP_MENU_CALLBACK.STREAK_RECORD ||
    data === GROUP_MENU_CALLBACK.HELP ||
    data === GROUP_MENU_CALLBACK.TICTACTOE ||
    data === GROUP_MENU_CALLBACK.CONNECT4 ||
    data === GROUP_MENU_CALLBACK.TRIVIA
  );
}

module.exports = {
  MENU_LABELS,
  MENU_LABEL_LIST,
  GROUP_MENU_TEXT,
  GROUP_RANKINGS_TEXT,
  GROUP_GAMES_TEXT,
  GROUP_PROGRESS_TEXT,
  PRIVATE_MENU_HINT,
  GROUP_MENU_CALLBACK,
  GROUP_SNAKE_MESSAGE,
  GROUP_BOUNCH_MESSAGE,
  GROUP_SNAKE_BUTTON_LABEL,
  GROUP_BOUNCH_BUTTON_LABEL,
  isPrivateChat,
  isGroupChat,
  isPrivateMenuLabel,
  normalizeBotUsername,
  getConfiguredBotUsername,
  getBotUsername,
  resolveBotUsername,
  buildPrivateDeepLink,
  buildHighscoreAnnouncementPlayCta,
  appendHighscoreAnnouncementPlayCta,
  getPrivateMenuKeyboard,
  getGroupGameMessage,
  getGroupGameGateExtra,
  getGroupMenuExtra,
  getGroupRankingsMenuExtra,
  getGroupGamesMenuExtra,
  getGroupProgressMenuExtra,
  isGroupMenuNavCallback,
  isGroupMenuCallback,
};
