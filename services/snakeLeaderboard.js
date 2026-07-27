/**
 * Snake score leaderboard — read-only access to snake-highscores.json.
 *
 * Matches the structure written by highscore-server.js:
 *   { globalHighScore: number, name: string, updatedAt: string }
 */

const fs = require("fs");
const path = require("path");
const { error: logError } = require("../utils/logger");

const SCORES_FILE =
  process.env.SNAKE_SCORES_FILE ||
  path.join(__dirname, "..", "snake-highscores.json");

const PLAY_URL = "https://www.mangomeme.fun/mango-labs.html";

const MEDALS = ["🥇", "🥈", "🥉"];

function formatRankPrefix(index) {
  return MEDALS[index] || `${index + 1}.`;
}

/**
 * Read snake-highscores.json without writing or resetting the file.
 */
function readScoresData() {
  try {
    if (!fs.existsSync(SCORES_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(SCORES_FILE, "utf8").trim();
    if (!raw) {
      return null;
    }

    return JSON.parse(raw);
  } catch (err) {
    logError("Error reading snake-highscores.json:", err);
    return null;
  }
}

/**
 * Extract leaderboard entries from the highscore-server.js JSON shape.
 */
function parseScoreEntries(data) {
  if (!data || typeof data !== "object") {
    return [];
  }

  const score = Number.parseInt(String(data.globalHighScore ?? 0), 10);
  if (!Number.isFinite(score) || score <= 0) {
    return [];
  }

  const name =
    typeof data.name === "string" && data.name.trim()
      ? data.name.trim()
      : "ManGo Player";

  return [{ name, score }];
}

/**
 * Return up to 10 snake scores, highest first.
 */
function getTopSnakeScores(limit = 10) {
  const data = readScoresData();
  if (!data) {
    return [];
  }

  return parseScoreEntries(data)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function formatSnakeLeaderboardMessage() {
  const scores = getTopSnakeScores();

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
