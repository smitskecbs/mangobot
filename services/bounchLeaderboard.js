/**
 * Bounch level leaderboard — Telegram display for bounch-highscores.json.
 */

const {
  getScoresFilePath,
  getDisplayLeaderboard,
  PLAY_URL,
} = require("./bounchScores");

const MEDALS = ["🥇", "🥈", "🥉"];

function formatRankPrefix(index) {
  return MEDALS[index] || `${index + 1}.`;
}

function getTopBounchLevels(limit = 10, scoresFile = getScoresFilePath()) {
  return getDisplayLeaderboard(scoresFile, limit);
}

function formatBounchLeaderboardMessage(scoresFile = getScoresFilePath()) {
  const scores = getTopBounchLevels(10, scoresFile);

  if (scores.length === 0) {
    return `🏀 ManGo Bounch Leaderboard

No clears yet.

Be the first to clear a level:
${PLAY_URL}`;
  }

  const lines = scores.map((entry, index) => {
    const prefix = formatRankPrefix(index);
    return `${prefix} ${entry.name} — Level ${entry.bestLevel}`;
  });

  return `🏀 ManGo Bounch Leaderboard

${lines.join("\n")}

🎮 Play:
${PLAY_URL}`;
}

module.exports = {
  getTopBounchLevels,
  formatBounchLeaderboardMessage,
};
