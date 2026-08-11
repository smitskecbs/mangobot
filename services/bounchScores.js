/**
 * Shared Bounch level storage — leaderboard logic used by the API and Telegram bot.
 */

const fs = require("fs");
const path = require("path");
const { error: logError } = require("../utils/logger");
const { appendHighscoreAnnouncementPlayCta } = require("../utils/botMenu");
const {
  normalizeVerifiedTelegramUserId,
  applyVerifiedTelegramUserId,
} = require("../utils/scoreIdentity");
const { shouldHideScoreLeaderboardEntry } = require("../utils/admin");

const MIN_LEVEL = 1;
const MAX_LEVEL = 7;
const MAX_NAME_LENGTH = 24;
const LEADERBOARD_LIMIT = 10;
const PLAY_URL = "https://www.mangomeme.fun/mango-labs";

function getScoresFilePath() {
  return (
    process.env.BOUNCH_SCORES_FILE ||
    path.join(__dirname, "..", "bounch-highscores.json")
  );
}

function createEmptyScores() {
  return {
    globalBestLevel: 0,
    globalBestLevelName: "",
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

function parseLevel(raw) {
  const level = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);

  if (!Number.isFinite(level) || !Number.isInteger(level)) {
    return null;
  }

  if (level < MIN_LEVEL || level > MAX_LEVEL) {
    return null;
  }

  return level;
}

function migratePlayerEntry(entry) {
  const bestLevel = Number.parseInt(String(entry.bestLevel ?? 0), 10);
  const updatedAt =
    typeof entry.updatedAt === "string" && entry.updatedAt
      ? entry.updatedAt
      : new Date().toISOString();
  const gamesPlayed = Number.parseInt(String(entry.gamesPlayed ?? 1), 10);

  const migrated = {
    name: entry.name,
    bestLevel,
    lastLevel: Number.isFinite(Number.parseInt(String(entry.lastLevel ?? bestLevel), 10))
      ? Number.parseInt(String(entry.lastLevel ?? bestLevel), 10)
      : bestLevel,
    gamesPlayed: Number.isFinite(gamesPlayed) && gamesPlayed > 0 ? gamesPlayed : 1,
    updatedAt,
    lastPlayedAt:
      typeof entry.lastPlayedAt === "string" && entry.lastPlayedAt
        ? entry.lastPlayedAt
        : updatedAt,
  };

  const telegramUserId = normalizeVerifiedTelegramUserId(entry.telegramUserId);
  if (telegramUserId) {
    migrated.telegramUserId = telegramUserId;
  }

  return migrated;
}

function createPlayerEntry(name, level, now, verifiedTelegramUserId) {
  const entry = {
    name,
    bestLevel: level,
    lastLevel: level,
    gamesPlayed: 1,
    updatedAt: now,
    lastPlayedAt: now,
  };
  applyVerifiedTelegramUserId(entry, verifiedTelegramUserId);
  return entry;
}

function sortLeaderboard(leaderboard) {
  return [...leaderboard].sort((a, b) => {
    if (b.bestLevel !== a.bestLevel) {
      return b.bestLevel - a.bestLevel;
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

    const bestLevel = Number.parseInt(String(entry.bestLevel ?? 0), 10);
    if (!Number.isFinite(bestLevel) || bestLevel < MIN_LEVEL) {
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
      bestLevel,
      updatedAt,
      lastLevel: entry.lastLevel,
      gamesPlayed: entry.gamesPlayed,
      lastPlayedAt: entry.lastPlayedAt,
      telegramUserId: entry.telegramUserId,
    });
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    if (
      candidate.bestLevel > existing.bestLevel ||
      (candidate.bestLevel === existing.bestLevel &&
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
    data.globalBestLevel = 0;
    data.globalBestLevelName = "";
    data.updatedAt = new Date().toISOString();
    return;
  }

  const top = data.leaderboard[0];
  data.globalBestLevel = top.bestLevel;
  data.globalBestLevelName = top.name;
  data.updatedAt = top.updatedAt;
}

function migrateInMemory(data) {
  if (!data || typeof data !== "object") {
    return createEmptyScores();
  }

  if (Array.isArray(data.leaderboard)) {
    const migrated = {
      globalBestLevel: 0,
      globalBestLevelName: "",
      updatedAt:
        typeof data.updatedAt === "string" && data.updatedAt
          ? data.updatedAt
          : new Date().toISOString(),
      leaderboard: normalizeLeaderboardEntries(data.leaderboard),
    };

    syncGlobalFields(migrated);
    return migrated;
  }

  return createEmptyScores();
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
    bestLevel: entry.bestLevel,
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
    name = "",
    level = 0,
    bestLevel = 0,
    isNewGlobal = false,
    rank = 0,
    gamesPlayed = 0,
    lastLevel = 0,
    lastPlayedAt = null,
    reason,
  } = options;

  const response = {
    ok: true,
    posted,
    personalBest,
    personalBestImproved,
    name,
    level,
    bestLevel,
    isNewGlobal,
    globalBestLevel: data.globalBestLevel,
    globalBestLevelName: data.globalBestLevelName,
    rank,
    gamesPlayed,
    lastLevel,
    lastPlayedAt,
    leaderboard: formatLeaderboardResponse(data),
  };

  if (reason) {
    response.reason = reason;
  }

  return response;
}

function buildGlobalBestMessage(name, level, botUsername) {
  const base = `🏆 New Bounch global best!

🥭 ${name}
🎮 Level ${level}

Can anyone beat this?`;
  return appendHighscoreAnnouncementPlayCta(base, "bounch", botUsername);
}

function buildPersonalBestMessage(name, level, rank, botUsername) {
  const base = `🥭 New Bounch personal best!

🥭 ${name}
🎮 Level ${level}

Current rank: #${rank}`;
  return appendHighscoreAnnouncementPlayCta(base, "bounch", botUsername);
}

/**
 * Submit a cleared level and update the leaderboard.
 * options.verifiedTelegramUserId — only from signed game identity.uid (never request body).
 * Returns { data, result } on success or { error } on validation failure.
 */
function submitLevel(scoresFile, rawName, rawLevel, options = {}) {
  const name = sanitizeName(rawName);
  if (!name) {
    return { error: "Invalid name." };
  }

  const level = parseLevel(rawLevel);
  if (level === null) {
    return { error: "Invalid level." };
  }

  const verifiedTelegramUserId =
    options && options.verifiedTelegramUserId !== undefined
      ? options.verifiedTelegramUserId
      : undefined;

  const data = readScoresFile(scoresFile);
  const previousGlobalBestLevel = data.globalBestLevel || 0;
  const nameKey = normalizeNameKey(name);
  const now = new Date().toISOString();
  const playerIndex = findPlayerIndex(data.leaderboard, nameKey);

  let personalBest = false;

  if (playerIndex === -1) {
    data.leaderboard.push(
      createPlayerEntry(name, level, now, verifiedTelegramUserId)
    );
    personalBest = true;
  } else {
    const existing = data.leaderboard[playerIndex];
    const updatedPlayer = {
      name,
      bestLevel: existing.bestLevel,
      lastLevel: level,
      gamesPlayed: (existing.gamesPlayed ?? 1) + 1,
      updatedAt: existing.updatedAt,
      lastPlayedAt: now,
    };
    if (existing.telegramUserId !== undefined) {
      updatedPlayer.telegramUserId = existing.telegramUserId;
    }
    applyVerifiedTelegramUserId(updatedPlayer, verifiedTelegramUserId);

    if (level > existing.bestLevel) {
      updatedPlayer.bestLevel = level;
      updatedPlayer.updatedAt = now;
      personalBest = true;
    }

    data.leaderboard[playerIndex] = updatedPlayer;
  }

  data.leaderboard = sortLeaderboard(data.leaderboard).slice(0, LEADERBOARD_LIMIT);
  syncGlobalFields(data);

  const rank = findPlayerIndex(data.leaderboard, nameKey) + 1;
  const isNewGlobal =
    personalBest && rank === 1 && level > previousGlobalBestLevel;

  writeScoresFile(scoresFile, data);

  const finalPlayerIndex = findPlayerIndex(data.leaderboard, nameKey);
  const player =
    finalPlayerIndex >= 0
      ? data.leaderboard[finalPlayerIndex]
      : createPlayerEntry(name, level, now, verifiedTelegramUserId);

  return {
    data,
    result: {
      personalBest,
      personalBestImproved: personalBest,
      isNewGlobal,
      rank,
      name,
      level,
      bestLevel: player.bestLevel,
      gamesPlayed: player.gamesPlayed,
      lastLevel: player.lastLevel,
      lastPlayedAt: player.lastPlayedAt,
      telegramUserId: player.telegramUserId || null,
    },
  };
}

function getDisplayLeaderboard(
  scoresFile = getScoresFilePath(),
  limit = LEADERBOARD_LIMIT
) {
  const data = readScoresFile(scoresFile);
  return data.leaderboard
    .filter((entry) => !shouldHideScoreLeaderboardEntry(entry))
    .slice(0, limit)
    .map((entry) => ({
      name: entry.name,
      bestLevel: entry.bestLevel,
    }));
}

module.exports = {
  MIN_LEVEL,
  MAX_LEVEL,
  MAX_NAME_LENGTH,
  LEADERBOARD_LIMIT,
  PLAY_URL,
  getScoresFilePath,
  createEmptyScores,
  normalizeNameKey,
  sanitizeName,
  parseLevel,
  sortLeaderboard,
  migrateInMemory,
  migratePlayerEntry,
  createPlayerEntry,
  readScoresFile,
  writeScoresFile,
  submitLevel,
  getDisplayLeaderboard,
  formatLeaderboardResponse,
  buildApiResponse,
  buildGlobalBestMessage,
  buildPersonalBestMessage,
  syncGlobalFields,
};
