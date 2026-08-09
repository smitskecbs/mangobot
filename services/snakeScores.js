/**
 * Shared Snake score storage — leaderboard logic used by the API and Telegram bot.
 */

const fs = require("fs");
const path = require("path");
const { error: logError } = require("../utils/logger");
const { appendHighscoreAnnouncementPlayCta } = require("../utils/botMenu");

const MAX_SCORE = 100_000;
const MAX_NAME_LENGTH = 24;
const LEADERBOARD_LIMIT = 10;
const PLAY_URL = "https://www.mangomeme.fun/mango-labs.html";

function getScoresFilePath() {
  return (
    process.env.SNAKE_SCORES_FILE ||
    path.join(__dirname, "..", "snake-highscores.json")
  );
}

function createEmptyScores() {
  return {
    globalHighScore: 0,
    globalHighScoreName: "",
    updatedAt: new Date().toISOString(),
    leaderboard: [],
  };
}

function normalizeNameKey(name) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function sanitizeName(raw) {
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
  const safe = trimmed.replace(/[^\w\s-]/gi, "").replace(/\s+/g, " ").trim();

  return safe || null;
}

function parseScore(raw) {
  const score = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);

  if (!Number.isFinite(score) || !Number.isInteger(score)) {
    return null;
  }

  if (score <= 0 || score > MAX_SCORE) {
    return null;
  }

  return score;
}

function migratePlayerEntry(entry) {
  const score = Number.parseInt(String(entry.score ?? 0), 10);
  const updatedAt =
    typeof entry.updatedAt === "string" && entry.updatedAt
      ? entry.updatedAt
      : new Date().toISOString();
  const gamesPlayed = Number.parseInt(String(entry.gamesPlayed ?? 1), 10);

  return {
    name: entry.name,
    score,
    lastScore: Number.isFinite(Number.parseInt(String(entry.lastScore ?? score), 10))
      ? Number.parseInt(String(entry.lastScore ?? score), 10)
      : score,
    gamesPlayed: Number.isFinite(gamesPlayed) && gamesPlayed > 0 ? gamesPlayed : 1,
    updatedAt,
    lastPlayedAt:
      typeof entry.lastPlayedAt === "string" && entry.lastPlayedAt
        ? entry.lastPlayedAt
        : updatedAt,
  };
}

function createPlayerEntry(name, score, now) {
  return {
    name,
    score,
    lastScore: score,
    gamesPlayed: 1,
    updatedAt: now,
    lastPlayedAt: now,
  };
}

function sortLeaderboard(leaderboard) {
  return [...leaderboard].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function normalizeLeaderboardEntries(leaderboard) {
  if (!Array.isArray(leaderboard)) {
    return [];
  }

  const byKey = new Map();

  for (const entry of leaderboard) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const score = Number.parseInt(String(entry.score ?? 0), 10);
    if (!Number.isFinite(score) || score <= 0) {
      continue;
    }

    const rawName = typeof entry.name === "string" ? entry.name : "";
    const displayName = rawName.trim().replace(/\s+/g, " ");
    if (!displayName) {
      continue;
    }

    const key = normalizeNameKey(displayName);
    const updatedAt =
      typeof entry.updatedAt === "string" && entry.updatedAt
        ? entry.updatedAt
        : new Date().toISOString();
    const candidate = migratePlayerEntry({
      name: displayName,
      score,
      updatedAt,
      lastScore: entry.lastScore,
      gamesPlayed: entry.gamesPlayed,
      lastPlayedAt: entry.lastPlayedAt,
    });
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    if (
      candidate.score > existing.score ||
      (candidate.score === existing.score &&
        new Date(candidate.updatedAt).getTime() >
          new Date(existing.updatedAt).getTime())
    ) {
      byKey.set(key, candidate);
    }
  }

  return sortLeaderboard([...byKey.values()]).slice(0, LEADERBOARD_LIMIT);
}

function syncGlobalFields(data) {
  if (!data.leaderboard.length) {
    data.globalHighScore = 0;
    data.globalHighScoreName = "";
    data.updatedAt = new Date().toISOString();
    return;
  }

  const top = data.leaderboard[0];
  data.globalHighScore = top.score;
  data.globalHighScoreName = top.name;
  data.updatedAt = top.updatedAt;
}

function migrateInMemory(data) {
  if (!data || typeof data !== "object") {
    return createEmptyScores();
  }

  if (Array.isArray(data.leaderboard)) {
    const migrated = {
      globalHighScore: 0,
      globalHighScoreName: "",
      updatedAt:
        typeof data.updatedAt === "string" && data.updatedAt
          ? data.updatedAt
          : new Date().toISOString(),
      leaderboard: normalizeLeaderboardEntries(data.leaderboard),
    };

    syncGlobalFields(migrated);
    return migrated;
  }

  const score = Number.parseInt(String(data.globalHighScore ?? 0), 10);
  const legacyName =
    typeof data.globalHighScoreName === "string" && data.globalHighScoreName.trim()
      ? data.globalHighScoreName.trim()
      : typeof data.name === "string" && data.name.trim()
        ? data.name.trim()
        : "ManGo Player";
  const updatedAt =
    typeof data.updatedAt === "string" && data.updatedAt
      ? data.updatedAt
      : new Date().toISOString();

  if (!Number.isFinite(score) || score <= 0) {
    return createEmptyScores();
  }

  const migrated = {
    globalHighScore: score,
    globalHighScoreName: legacyName,
    updatedAt,
    leaderboard: [
      migratePlayerEntry({
        name: legacyName,
        score,
        updatedAt,
      }),
    ],
  };

  syncGlobalFields(migrated);
  return migrated;
}

function readScoresFile(scoresFile) {
  try {
    if (!fs.existsSync(scoresFile)) {
      return createEmptyScores();
    }

    const raw = fs.readFileSync(scoresFile, "utf8").trim();
    if (!raw) {
      return createEmptyScores();
    }

    return migrateInMemory(JSON.parse(raw));
  } catch (err) {
    logError(`Error reading ${scoresFile}:`, err);
    return createEmptyScores();
  }
}

function writeScoresFile(scoresFile, data) {
  const tempFile = `${scoresFile}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  fs.writeFileSync(tempFile, payload, "utf8");
  fs.renameSync(tempFile, scoresFile);
}

function formatLeaderboardResponse(data) {
  return data.leaderboard.map((entry) => ({
    name: entry.name,
    score: entry.score,
  }));
}

function findPlayerIndex(leaderboard, nameKey) {
  return leaderboard.findIndex(
    (entry) => normalizeNameKey(entry.name) === nameKey
  );
}

function buildApiResponse(data, options) {
  const {
    posted = false,
    personalBest = false,
    personalBestImproved = personalBest,
    score = 0,
    personalBestScore = 0,
    isNewGlobal = false,
    rank = 0,
    gamesPlayed = 0,
    lastScore = 0,
    lastPlayedAt = null,
    reason,
  } = options;

  const response = {
    ok: true,
    posted,
    personalBest,
    personalBestImproved,
    score,
    personalBestScore,
    isNewGlobal,
    globalHighScore: data.globalHighScore,
    globalHighScoreName: data.globalHighScoreName,
    rank,
    gamesPlayed,
    lastScore,
    lastPlayedAt,
    leaderboard: formatLeaderboardResponse(data),
  };

  if (reason) {
    response.reason = reason;
  }

  return response;
}

function buildGlobalHighscoreMessage(name, score, botUsername) {
  const base = `🐍 NEW GLOBAL HIGHSCORE!

🏆 ${name}
🎮 ${score} points

Can anyone beat this?`;
  return appendHighscoreAnnouncementPlayCta(base, "snake", botUsername);
}

function buildPersonalBestMessage(name, score, rank, botUsername) {
  const base = `🐍 NEW PERSONAL BEST!

🥭 ${name}
🎮 ${score} points

Current rank: #${rank}`;
  return appendHighscoreAnnouncementPlayCta(base, "snake", botUsername);
}

/**
 * Submit a score and update the leaderboard.
 * Returns { data, result } on success or { error } on validation failure.
 */
function submitScore(scoresFile, rawName, rawScore) {
  const name = sanitizeName(rawName);
  if (!name) {
    return { error: "Invalid name." };
  }

  const score = parseScore(rawScore);
  if (score === null) {
    return { error: "Invalid score." };
  }

  const data = readScoresFile(scoresFile);
  const previousGlobalHighScore = data.globalHighScore || 0;
  const nameKey = normalizeNameKey(name);
  const now = new Date().toISOString();
  const playerIndex = findPlayerIndex(data.leaderboard, nameKey);

  let personalBest = false;

  if (playerIndex === -1) {
    data.leaderboard.push(createPlayerEntry(name, score, now));
    personalBest = true;
  } else {
    const existing = data.leaderboard[playerIndex];
    const updatedPlayer = {
      name,
      score: existing.score,
      lastScore: score,
      gamesPlayed: (existing.gamesPlayed ?? 1) + 1,
      updatedAt: existing.updatedAt,
      lastPlayedAt: now,
    };

    if (score > existing.score) {
      updatedPlayer.score = score;
      updatedPlayer.updatedAt = now;
      personalBest = true;
    }

    data.leaderboard[playerIndex] = updatedPlayer;
  }

  data.leaderboard = sortLeaderboard(data.leaderboard).slice(0, LEADERBOARD_LIMIT);
  syncGlobalFields(data);

  const rank = findPlayerIndex(data.leaderboard, nameKey) + 1;
  const isNewGlobal =
    personalBest && rank === 1 && score > previousGlobalHighScore;

  writeScoresFile(scoresFile, data);

  const finalPlayerIndex = findPlayerIndex(data.leaderboard, nameKey);
  const player =
    finalPlayerIndex >= 0 ? data.leaderboard[finalPlayerIndex] : createPlayerEntry(name, score, now);
  const personalBestScore = player.score;

  return {
    data,
    result: {
      personalBest,
      personalBestImproved: personalBest,
      isNewGlobal,
      rank,
      name,
      score,
      personalBestScore,
      gamesPlayed: player.gamesPlayed,
      lastScore: player.lastScore,
      lastPlayedAt: player.lastPlayedAt,
    },
  };
}

function getDisplayLeaderboard(scoresFile = getScoresFilePath(), limit = LEADERBOARD_LIMIT) {
  const data = readScoresFile(scoresFile);
  return data.leaderboard.slice(0, limit).map((entry) => ({
    name: entry.name,
    score: entry.score,
  }));
}

module.exports = {
  MAX_SCORE,
  MAX_NAME_LENGTH,
  LEADERBOARD_LIMIT,
  PLAY_URL,
  getScoresFilePath,
  createEmptyScores,
  normalizeNameKey,
  sanitizeName,
  parseScore,
  sortLeaderboard,
  migrateInMemory,
  migratePlayerEntry,
  createPlayerEntry,
  readScoresFile,
  writeScoresFile,
  submitScore,
  getDisplayLeaderboard,
  formatLeaderboardResponse,
  buildApiResponse,
  buildGlobalHighscoreMessage,
  buildPersonalBestMessage,
  syncGlobalFields,
};
