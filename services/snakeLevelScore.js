/**
 * Shared Snake difficulty scoring + submission validation.
 * Mirrors website src/snakeLevels.ts score contract (tested in both repos).
 *
 * Historic Classic (Level 1) values — do not change:
 *   mango = 10, collected 5-mango bonus mango = 50.
 * Levels 2–4 multiply both by the level id.
 *
 * The timed bonus mango is optional in play, so the server recomputes from
 * mangoCount + bonusMangoesEaten + level rather than mangoCount alone.
 */

const BASE_MANGO_POINTS = 10;
const BASE_BONUS_POINTS = 50;
const BONUS_EVERY = 5;
const DEFAULT_LEVEL = 1;
const MAX_MANGO_COUNT = 5000;
const MAX_SCORE = 100_000;

const LEVEL_DEFS = Object.freeze({
  1: Object.freeze({
    id: 1,
    emoji: "🥭",
    shortName: "Classic",
    fullName: "🥭 Level 1 — Classic",
    leaderboardTag: "🥭 L1",
    multiplier: 1,
  }),
  2: Object.freeze({
    id: 2,
    emoji: "🧱",
    shortName: "Walls",
    fullName: "🧱 Level 2 — Walls",
    leaderboardTag: "🧱 L2",
    multiplier: 2,
  }),
  3: Object.freeze({
    id: 3,
    emoji: "🎯",
    shortName: "Center",
    fullName: "🎯 Level 3 — Center",
    leaderboardTag: "🎯 L3",
    multiplier: 3,
  }),
  4: Object.freeze({
    id: 4,
    emoji: "🔥",
    shortName: "Danger Zone",
    fullName: "🔥 Level 4 — Danger Zone",
    leaderboardTag: "🔥 L4",
    multiplier: 4,
  }),
});

function isSnakeDifficultyLevel(value) {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function parseSnakeLevel(raw) {
  if (typeof raw === "boolean" || raw === null || raw === undefined || raw === "") {
    return null;
  }

  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || !isSnakeDifficultyLevel(parsed)) {
    return null;
  }

  return parsed;
}

function normalizeSnakeLevel(raw) {
  return parseSnakeLevel(raw) || DEFAULT_LEVEL;
}

function parseFiniteInteger(raw) {
  if (typeof raw === "boolean" || raw === null || raw === undefined || raw === "") {
    return null;
  }

  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
      return null;
    }
    return raw;
  }

  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

function scoreForMango(level) {
  return BASE_MANGO_POINTS * normalizeSnakeLevel(level);
}

function scoreForFiveMangoBonus(level) {
  return BASE_BONUS_POINTS * normalizeSnakeLevel(level);
}

function maxBonusMangoesForCount(mangoCount) {
  if (!Number.isInteger(mangoCount) || mangoCount < 0) {
    return 0;
  }
  return Math.floor(mangoCount / BONUS_EVERY);
}

function calculateSnakeScore(input = {}) {
  const mangoCount =
    Number.isInteger(input.mangoCount) && input.mangoCount > 0 ? input.mangoCount : 0;
  const level = normalizeSnakeLevel(input.level);
  const maxBonus = maxBonusMangoesForCount(mangoCount);
  const bonusRaw = input.bonusMangoesEaten;
  const bonusMangoesEaten =
    Number.isInteger(bonusRaw) && bonusRaw >= 0 ? Math.min(bonusRaw, maxBonus) : 0;

  return mangoCount * scoreForMango(level) + bonusMangoesEaten * scoreForFiveMangoBonus(level);
}

function fieldProvided(value) {
  return value !== undefined && value !== null && value !== "";
}

function getSnakeLevelDef(raw) {
  return LEVEL_DEFS[normalizeSnakeLevel(raw)];
}

function formatSnakeLevelTag(level) {
  const parsed = parseSnakeLevel(level);
  return parsed ? LEVEL_DEFS[parsed].leaderboardTag : "";
}

function formatSnakeLeaderboardEntryLine(entry, prefix) {
  const name = entry && typeof entry.name === "string" ? entry.name : "ManGo Player";
  const score = Number.parseInt(String(entry && entry.score), 10) || 0;
  const tag = formatSnakeLevelTag(entry && entry.level);
  if (tag) {
    return `${prefix} ${name} — ${score} pts ${tag}`;
  }
  return `${prefix} ${name} — ${score}`;
}

/**
 * Validate a highscore POST body.
 * Legacy clients send only { name, score } — accepted as before.
 * New clients send mangoCount + level + bonusMangoesEaten; server recomputes score.
 */
function resolveSnakeScoreSubmission(body = {}) {
  const mangoProvided = fieldProvided(body.mangoCount);
  const bonusProvided = fieldProvided(body.bonusMangoesEaten);
  const levelProvided = fieldProvided(body.level);
  const newFormat = mangoProvided || bonusProvided;

  let level = null;
  if (levelProvided) {
    level = parseSnakeLevel(body.level);
    if (level === null) {
      return { error: "Invalid level." };
    }
  }

  if (!newFormat) {
    const rawScore = body.score;
    if (typeof rawScore === "number" && !Number.isFinite(rawScore)) {
      return { error: "Invalid score." };
    }
    const score =
      typeof rawScore === "number" && Number.isInteger(rawScore)
        ? rawScore
        : Number.parseInt(String(rawScore), 10);

    if (!Number.isFinite(score) || !Number.isInteger(score) || score <= 0 || score > MAX_SCORE) {
      return { error: "Invalid score." };
    }

    return {
      score,
      level,
      mangoCount: null,
      bonusMangoesEaten: null,
      recomputed: false,
    };
  }

  const mangoCount = parseFiniteInteger(body.mangoCount);
  if (mangoCount === null || mangoCount < 0 || mangoCount > MAX_MANGO_COUNT) {
    return { error: "Invalid mango count." };
  }

  const effectiveLevel = level || DEFAULT_LEVEL;
  const maxBonus = maxBonusMangoesForCount(mangoCount);

  let bonusMangoesEaten;
  if (bonusProvided) {
    bonusMangoesEaten = parseFiniteInteger(body.bonusMangoesEaten);
    if (bonusMangoesEaten === null || bonusMangoesEaten < 0 || bonusMangoesEaten > maxBonus) {
      return { error: "Invalid bonus count." };
    }
  } else {
    bonusMangoesEaten = 0;
  }

  const expected = calculateSnakeScore({
    mangoCount,
    level: effectiveLevel,
    bonusMangoesEaten,
  });

  if (!Number.isInteger(expected) || expected <= 0 || expected > MAX_SCORE) {
    return { error: "Invalid score." };
  }

  if (fieldProvided(body.score)) {
    if (typeof body.score === "number" && !Number.isFinite(body.score)) {
      return { error: "Invalid score." };
    }
    const claimed = parseFiniteInteger(body.score);
    if (claimed === null || claimed !== expected) {
      return { error: "Invalid score." };
    }
  }

  return {
    score: expected,
    level: effectiveLevel,
    mangoCount,
    bonusMangoesEaten,
    recomputed: true,
  };
}

module.exports = {
  BASE_MANGO_POINTS,
  BASE_BONUS_POINTS,
  BONUS_EVERY,
  DEFAULT_LEVEL,
  MAX_MANGO_COUNT,
  MAX_SCORE,
  LEVEL_DEFS,
  isSnakeDifficultyLevel,
  parseSnakeLevel,
  normalizeSnakeLevel,
  scoreForMango,
  scoreForFiveMangoBonus,
  maxBonusMangoesForCount,
  calculateSnakeScore,
  getSnakeLevelDef,
  formatSnakeLevelTag,
  formatSnakeLeaderboardEntryLine,
  resolveSnakeScoreSubmission,
};
