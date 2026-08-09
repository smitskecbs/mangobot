/**
 * Signed ManGo Labs play-link helpers for Telegram game commands.
 */

const { createGameToken } = require("./gameToken");
const { error: logError } = require("./logger");

const LABS_BASE_URL = "https://www.mangomeme.fun/mango-labs";
const GAME_LINK_UNAVAILABLE_MESSAGE =
  "🥭 Game link is temporarily unavailable. Please try again later.";

/**
 * @param {string|number} userId
 * @param {"snake"|"bounch"} game
 * @param {{ secret?: string, ttlSeconds?: number, now?: number }} [options]
 * @returns {{ ok: true, url: string } | { ok: false }}
 */
function buildSignedGameUrl(userId, game, options = {}) {
  try {
    if (userId === undefined || userId === null || userId === "") {
      return { ok: false };
    }

    const token = createGameToken(String(userId), game, options);
    const url = new URL(LABS_BASE_URL);
    url.searchParams.set("game", game);
    url.searchParams.set("t", token);

    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false };
  }
}

function buildSnakeReply(playUrl) {
  return `🐍 ManGo Snake

🎮 Play:
${playUrl}

🏆 Global leaderboard:
/snakehighscore

🥭 Think you can beat the top score?`;
}

function buildBounchReply(playUrl) {
  return `🏀 ManGo Bounch

Clear levels and climb the board.

🎮 Play:
${playUrl}

🏆 Global leaderboard:
/bounchhighscore

🥭 How far can you bounce?`;
}

/**
 * Build the Telegram reply for /snake or /bounch.
 * Never throws; never includes secrets in the returned message.
 *
 * @param {string|number} userId
 * @param {"snake"|"bounch"} game
 * @param {{ secret?: string, ttlSeconds?: number, now?: number }} [options]
 * @returns {string}
 */
function getGameCommandReply(userId, game, options = {}) {
  const built = buildSignedGameUrl(userId, game, options);

  if (!built.ok) {
    logError(`Failed to create ${game} game link`);
    return GAME_LINK_UNAVAILABLE_MESSAGE;
  }

  if (game === "snake") {
    return buildSnakeReply(built.url);
  }

  if (game === "bounch") {
    return buildBounchReply(built.url);
  }

  logError("Failed to create game link for unsupported game");
  return GAME_LINK_UNAVAILABLE_MESSAGE;
}

module.exports = {
  LABS_BASE_URL,
  GAME_LINK_UNAVAILABLE_MESSAGE,
  buildSignedGameUrl,
  buildSnakeReply,
  buildBounchReply,
  getGameCommandReply,
};
