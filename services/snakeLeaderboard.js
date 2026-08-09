/**
 * Snake score leaderboard — Telegram display for snake-highscores.json.
 */

const {
  getScoresFilePath,
  getDisplayLeaderboard,
} = require("./snakeScores");
const {
  buildPrivateDeepLink,
  getConfiguredBotUsername,
} = require("../utils/botMenu");

const MEDALS = ["🥇", "🥈", "🥉"];

function formatRankPrefix(index) {
  return MEDALS[index] || `${index + 1}.`;
}

function getTopSnakeScores(limit = 10, scoresFile = getScoresFilePath()) {
  return getDisplayLeaderboard(scoresFile, limit);
}

/**
 * @param {string} [scoresFile]
 * @param {string|null} [botUsername] omit for TELEGRAM_BOT_USERNAME; pass null to omit CTA
 */
function formatSnakeLeaderboardMessage(
  scoresFile = getScoresFilePath(),
  botUsername = getConfiguredBotUsername()
) {
  const scores = getTopSnakeScores(10, scoresFile);
  const playUrl = buildPrivateDeepLink(botUsername, "snake");

  if (scores.length === 0) {
    let text = `🐍 ManGo Snake Leaderboard

No scores yet.`;
    if (playUrl) {
      text += `

Be the first to set a score:
${playUrl}`;
    }
    return text;
  }

  const lines = scores.map((entry, index) => {
    const prefix = formatRankPrefix(index);
    return `${prefix} ${entry.name} — ${entry.score}`;
  });

  let text = `🐍 ManGo Snake Leaderboard

${lines.join("\n")}`;

  if (playUrl) {
    text += `

🎮 Play:
${playUrl}`;
  }

  return text;
}

module.exports = {
  getTopSnakeScores,
  formatSnakeLeaderboardMessage,
};
