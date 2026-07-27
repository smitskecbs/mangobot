/**
 * Snake score leaderboard — Telegram display for snake-highscores.json.
 */

const {
  getScoresFilePath,
  getDisplayLeaderboard,
  PLAY_URL,
} = require("./snakeScores");

const MEDALS = ["🥇", "🥈", "🥉"];

function formatRankPrefix(index) {
  return MEDALS[index] || `${index + 1}.`;
}

function getTopSnakeScores(limit = 10, scoresFile = getScoresFilePath()) {
  return getDisplayLeaderboard(scoresFile, limit);
}

function formatSnakeLeaderboardMessage(scoresFile = getScoresFilePath()) {
  const scores = getTopSnakeScores(10, scoresFile);

  if (scores.length === 0) {
    return `🐍 ManGo Snake Leaderboard

No scores yet.

Be the first to set a score:
${PLAY_URL}`;
  }

  const lines = scores.map((entry, index) => {
    const prefix = formatRankPrefix(index);
    return `${prefix} ${entry.name} — ${entry.score}`;
  });

  return `🐍 ManGo Snake Leaderboard

${lines.join("\n")}

🎮 Play:
${PLAY_URL}`;
}

module.exports = {
  getTopSnakeScores,
  formatSnakeLeaderboardMessage,
};
