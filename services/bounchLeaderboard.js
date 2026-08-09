/**
 * Bounch level leaderboard — Telegram display for bounch-highscores.json.
 */

const {
  getScoresFilePath,
  getDisplayLeaderboard,
} = require("./bounchScores");
const {
  buildPrivateDeepLink,
  getConfiguredBotUsername,
} = require("../utils/botMenu");

const MEDALS = ["🥇", "🥈", "🥉"];

function formatRankPrefix(index) {
  return MEDALS[index] || `${index + 1}.`;
}

function getTopBounchLevels(limit = 10, scoresFile = getScoresFilePath()) {
  return getDisplayLeaderboard(scoresFile, limit);
}

/**
 * @param {string} [scoresFile]
 * @param {string|null} [botUsername] omit for TELEGRAM_BOT_USERNAME; pass null to omit CTA
 */
function formatBounchLeaderboardMessage(
  scoresFile = getScoresFilePath(),
  botUsername = getConfiguredBotUsername()
) {
  const scores = getTopBounchLevels(10, scoresFile);
  const playUrl = buildPrivateDeepLink(botUsername, "bounch");

  if (scores.length === 0) {
    let text = `🏀 ManGo Bounch Leaderboard

No clears yet.`;
    if (playUrl) {
      text += `

Be the first to clear a level:
${playUrl}`;
    }
    return text;
  }

  const lines = scores.map((entry, index) => {
    const prefix = formatRankPrefix(index);
    return `${prefix} ${entry.name} — Level ${entry.bestLevel}`;
  });

  let text = `🏀 ManGo Bounch Leaderboard

${lines.join("\n")}`;

  if (playUrl) {
    text += `

🎮 Play:
${playUrl}`;
  }

  return text;
}

module.exports = {
  getTopBounchLevels,
  formatBounchLeaderboardMessage,
};
