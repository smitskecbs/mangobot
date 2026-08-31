/**
 * Private-chat reply keyboard and group game-link gate helpers.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("../services/points");

const MENU_LABELS = Object.freeze({
  MY_PROFILE: "👤 My Profile",
  WALLET: "👛 Wallet",
  REWARDS: "🎁 Rewards",
  HELP: "ℹ️ Help",
  COMMUNITY_BUILDER: "🤝 Community Builder",
  SHOP: "🏪 ManGo Shop",
  DAILY_QUEST: "🎯 Daily Quest",
  PHASE2: "🚀 Phase 2 Control Center",
  ADMIN: "🛠 Admin",
  SNAKE: "🎮 Play Snake",
  BOUNCH: "🏀 Play Bounch",
  POINTS: "🥭 My Points",
  MY_STREAK: "🔥 My Streak",
  PRESALE: "🥭 Presale",
  LEADERBOARD: "🏆 Leaderboard",
  WEEKLY: "📅 Weekly",
});

const MENU_LABEL_LIST = Object.freeze(Object.values(MENU_LABELS));

const GROUP_MENU_TITLE = "🥭 ManGo Menu";
const GROUP_MENU_BODY = "Choose what you want to explore.";
const GROUP_RANKINGS_TITLE = "🏆 Rankings";
const GROUP_RANKINGS_BODY = "Check community progress and weekly competition.";
const GROUP_GAMES_TITLE = "🎮 Games";
const GROUP_GAMES_BODY = "Play, compete and challenge the community.";
const GROUP_PROFILE_TITLE = "👤 My Profile";
const GROUP_PROFILE_BODY =
  "Check your XP, streak, wallet status and rewards.";

const GROUP_MENU_TEXT = `${GROUP_MENU_TITLE}\n\n${GROUP_MENU_BODY}`;

const GROUP_RANKINGS_TEXT = `${GROUP_RANKINGS_TITLE}\n\n${GROUP_RANKINGS_BODY}`;

const GROUP_GAMES_TEXT = `${GROUP_GAMES_TITLE}\n\n${GROUP_GAMES_BODY}`;

const GROUP_PROFILE_TEXT = `${GROUP_PROFILE_TITLE}\n\n${GROUP_PROFILE_BODY}`;

const GROUP_PROGRESS_TEXT = GROUP_PROFILE_TEXT;

const PRIVATE_MENU_HINT =
  "🥭 Use the menu below to open your profile, wallet, daily quest, shop, or play.";

const GROUP_MENU_CALLBACK = Object.freeze({
  RANKINGS: "gmenu:rankings",
  GAMES: "gmenu:games",
  PROFILE: "gmenu:profile",
  PROGRESS: "gmenu:progress",
  WALLET: "gmenu:wallet",
  REWARDS: "gmenu:rewards",
  PRESALE: "gmenu:presale",
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
  MANGOBOMB: "gmenu:mangobomb",
  BLACKJACK: "gmenu:blackjack",
  BUILDER: "gmenu:builder",
  SHOP: "gmenu:shop",
  DAILY_QUEST: "gmenu:dquest",
});

const PRIVATE_HUB_CALLBACK = Object.freeze({
  PROFILE_BACK: "phub:back",
  POINTS: "phub:points",
  STREAK: "phub:streak",
  WALLET_STATUS: "phub:wallet",
  REWARDS: "phub:rewards",
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
 * Prefix a menu heading with the owner's display name. Never interpolates ids.
 * @param {string} title
 * @param {string} body
 * @param {string|null|undefined} displayName
 * @returns {string}
 */
function formatOwnedMenuText(title, body, displayName) {
  const name =
    typeof displayName === "string" ? displayName.replace(/\s+/g, " ").trim() : "";
  const heading = name ? `${title} — ${name}` : title;
  return `${heading}\n\n${body}`;
}

function formatGroupMenuText(displayName) {
  return formatOwnedMenuText(GROUP_MENU_TITLE, GROUP_MENU_BODY, displayName);
}

function formatGroupRankingsText(displayName) {
  return formatOwnedMenuText(
    GROUP_RANKINGS_TITLE,
    GROUP_RANKINGS_BODY,
    displayName
  );
}

function formatGroupGamesText(displayName) {
  return formatOwnedMenuText(GROUP_GAMES_TITLE, GROUP_GAMES_BODY, displayName);
}

function formatGroupProfileText(displayName) {
  return formatOwnedMenuText(
    GROUP_PROFILE_TITLE,
    GROUP_PROFILE_BODY,
    displayName
  );
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

function keyboardUserId(ctxOrUserId) {
  if (ctxOrUserId === undefined || ctxOrUserId === null) {
    return null;
  }
  if (typeof ctxOrUserId === "object") {
    return ctxOrUserId.from && ctxOrUserId.from.id !== undefined
      ? ctxOrUserId.from.id
      : null;
  }
  return ctxOrUserId;
}

function getPrivateMenuKeyboard(ctxOrUserId) {
  const rows = [
    [MENU_LABELS.MY_PROFILE, MENU_LABELS.WALLET],
    [MENU_LABELS.REWARDS, MENU_LABELS.HELP],
    [MENU_LABELS.DAILY_QUEST, MENU_LABELS.SHOP],
    [MENU_LABELS.COMMUNITY_BUILDER],
    [MENU_LABELS.SNAKE, MENU_LABELS.BOUNCH],
  ];
  if (isAdmin(keyboardUserId(ctxOrUserId))) {
    rows.push([MENU_LABELS.ADMIN]);
  }
  return Markup.keyboard(rows).resize();
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
function privateDeepLinkButton(ctx, label, payload, fallbackCallback) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, payload);
  if (url) {
    return Markup.button.url(label, url);
  }
  return Markup.button.callback(label, fallbackCallback);
}

function getGroupMenuExtra(ctx) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🏆 Rankings", GROUP_MENU_CALLBACK.RANKINGS),
      Markup.button.callback("🎮 Games", GROUP_MENU_CALLBACK.GAMES),
    ],
    [
      Markup.button.callback("👤 My Profile", GROUP_MENU_CALLBACK.PROFILE),
      privateDeepLinkButton(ctx, "👛 Wallet", "wallet", GROUP_MENU_CALLBACK.WALLET),
    ],
    [
      privateDeepLinkButton(ctx, "🎁 Rewards", "rewards", GROUP_MENU_CALLBACK.REWARDS),
      Markup.button.callback("ℹ️ Help", GROUP_MENU_CALLBACK.HELP),
    ],
    [
      privateDeepLinkButton(
        ctx,
        "🎯 Daily Quest",
        "dailyquest",
        GROUP_MENU_CALLBACK.DAILY_QUEST
      ),
      privateDeepLinkButton(
        ctx,
        "🏪 ManGo Shop",
        "shop",
        GROUP_MENU_CALLBACK.SHOP
      ),
    ],
    [
      privateDeepLinkButton(
        ctx,
        "🤝 Community Builder",
        "builder",
        GROUP_MENU_CALLBACK.BUILDER
      ),
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
 * Games submenu — Snake/Bounch deep-links; TTT/C4/Trivia/ManGo Bomb callbacks.
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
    Markup.button.callback("🧠 Trivia", GROUP_MENU_CALLBACK.TRIVIA),
    Markup.button.callback("ManGo Bomb", GROUP_MENU_CALLBACK.MANGOBOMB),
  ]);
  rows.push([
    Markup.button.callback("🃏 Blackjack", GROUP_MENU_CALLBACK.BLACKJACK),
  ]);
  rows.push([Markup.button.callback("⬅️ Back", GROUP_MENU_CALLBACK.BACK)]);

  return Markup.inlineKeyboard(rows);
}

/**
 * Personal profile deep-links (token minted only in private /start).
 * @param {object} [ctx]
 * @param {string} [backCallback]
 * @returns {object}
 */
function getGroupProfileMenuExtra(ctx, backCallback = GROUP_MENU_CALLBACK.BACK) {
  const username = resolveBotUsername(ctx);
  const pointsUrl = buildPrivateDeepLink(username, "points");
  const streakUrl = buildPrivateDeepLink(username, "streak");
  const walletUrl = buildPrivateDeepLink(username, "wallet");
  const rewardsUrl = buildPrivateDeepLink(username, "rewards");

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

  const statusRow = [];
  if (walletUrl) {
    statusRow.push(Markup.button.url("Wallet Status", walletUrl));
  }
  if (rewardsUrl) {
    statusRow.push(Markup.button.url("Rewards", rewardsUrl));
  }
  if (statusRow.length) {
    rows.push(statusRow);
  }
  rows.push([Markup.button.callback("⬅️ Back", backCallback)]);

  return Markup.inlineKeyboard(rows);
}

function getGroupProgressMenuExtra(ctx) {
  return getGroupProfileMenuExtra(ctx);
}

function getPrivateProfileMenuExtra() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("My Points", PRIVATE_HUB_CALLBACK.POINTS),
      Markup.button.callback("My Streak", PRIVATE_HUB_CALLBACK.STREAK),
    ],
    [
      Markup.button.callback(
        "Wallet Status",
        PRIVATE_HUB_CALLBACK.WALLET_STATUS
      ),
      Markup.button.callback("Rewards", PRIVATE_HUB_CALLBACK.REWARDS),
    ],
    [Markup.button.callback("⬅️ Back", PRIVATE_HUB_CALLBACK.PROFILE_BACK)],
  ]);
}

function isPrivateHubCallback(data) {
  return (
    data === PRIVATE_HUB_CALLBACK.PROFILE_BACK ||
    data === PRIVATE_HUB_CALLBACK.POINTS ||
    data === PRIVATE_HUB_CALLBACK.STREAK ||
    data === PRIVATE_HUB_CALLBACK.WALLET_STATUS ||
    data === PRIVATE_HUB_CALLBACK.REWARDS
  );
}

function isGroupMenuNavCallback(data) {
  return (
    data === GROUP_MENU_CALLBACK.RANKINGS ||
    data === GROUP_MENU_CALLBACK.GAMES ||
    data === GROUP_MENU_CALLBACK.PROFILE ||
    data === GROUP_MENU_CALLBACK.PROGRESS ||
    data === GROUP_MENU_CALLBACK.BACK
  );
}

function isGroupMenuCallback(data) {
  return (
    isGroupMenuNavCallback(data) ||
    data === GROUP_MENU_CALLBACK.WALLET ||
    data === GROUP_MENU_CALLBACK.REWARDS ||
    data === GROUP_MENU_CALLBACK.PRESALE ||
    data === GROUP_MENU_CALLBACK.LEADERBOARD ||
    data === GROUP_MENU_CALLBACK.WEEKLY ||
    data === GROUP_MENU_CALLBACK.WEEKLY_WINNERS ||
    data === GROUP_MENU_CALLBACK.STREAK ||
    data === GROUP_MENU_CALLBACK.STREAK_RECORD ||
    data === GROUP_MENU_CALLBACK.HELP ||
    data === GROUP_MENU_CALLBACK.TICTACTOE ||
    data === GROUP_MENU_CALLBACK.CONNECT4 ||
    data === GROUP_MENU_CALLBACK.TRIVIA ||
    data === GROUP_MENU_CALLBACK.MANGOBOMB ||
    data === GROUP_MENU_CALLBACK.BLACKJACK ||
    data === GROUP_MENU_CALLBACK.BUILDER ||
    data === GROUP_MENU_CALLBACK.SHOP ||
    data === GROUP_MENU_CALLBACK.DAILY_QUEST
  );
}

module.exports = {
  MENU_LABELS,
  MENU_LABEL_LIST,
  GROUP_MENU_TEXT,
  GROUP_RANKINGS_TEXT,
  GROUP_GAMES_TEXT,
  GROUP_PROFILE_TEXT,
  GROUP_PROGRESS_TEXT,
  formatOwnedMenuText,
  formatGroupMenuText,
  formatGroupRankingsText,
  formatGroupGamesText,
  formatGroupProfileText,
  PRIVATE_MENU_HINT,
  GROUP_MENU_CALLBACK,
  PRIVATE_HUB_CALLBACK,
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
  getGroupProfileMenuExtra,
  getGroupProgressMenuExtra,
  getPrivateProfileMenuExtra,
  isPrivateHubCallback,
  isGroupMenuNavCallback,
  isGroupMenuCallback,
};
