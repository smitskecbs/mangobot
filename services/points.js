/**
 * Community points system — storage, triggers, ranks, weekly tracking, and daily activity.
 *
 * All points.json mutations go through mutatePoints(): exclusive cross-process lock +
 * atomic write. Read-only helpers never write.
 */

const fs = require("fs");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const {
  canEarnXp,
  XP_WALLET_REQUIRED,
  XP_WALLET_LOCKED_POINTS_LINE,
  XP_WALLET_GAME_LOCKED_TEXT,
} = require("./xpWalletGate");

const POINTS_FILE = path.join(__dirname, "..", "points.json");

const TRIGGERS = {
  gmango: 2,
  gnango: 2,
  gm: 1,
  gn: 1,
};

/** Longer triggers first so "gmango" wins over "gm". */
const TRIGGER_DETECT_ORDER = ["gmango", "gnango", "gm", "gn"];

const TRIGGER_LABELS = Object.freeze({
  gmango: "GMango",
  gnango: "GNango",
  gm: "GM",
  gn: "GN",
});

/**
 * Cross-process lock options for points.json.
 * realpath:false so a missing file can still be locked via sibling .lock.
 * Note: proper-lockfile lockSync does not support `retries`; we poll manually.
 */
const POINTS_LOCK_OPTIONS = Object.freeze({
  stale: 10_000,
  realpath: false,
});

const LOCK_RETRY = Object.freeze({
  attempts: 100,
  minTimeoutMs: 20,
  maxTimeoutMs: 500,
  factor: 1.5,
});

function sleepSync(ms) {
  const delay = Math.max(0, Math.ceil(ms));
  if (delay === 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

/**
 * Acquire an exclusive lock, waiting when another process holds it.
 * @param {string} pointsFile
 * @returns {() => void} release
 */
function acquirePointsLock(pointsFile) {
  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;

  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(pointsFile, POINTS_LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire points.json lock: ${message}`);
      }
      sleepSync(timeoutMs);
      timeoutMs = Math.min(
        LOCK_RETRY.maxTimeoutMs,
        Math.ceil(timeoutMs * LOCK_RETRY.factor)
      );
    }
  }

  const message =
    lastError && lastError.message ? lastError.message : "lock retries exhausted";
  throw new Error(`Failed to acquire points.json lock: ${message}`);
}

function getTodayDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * UTC calendar day immediately before `today` (`YYYY-MM-DD`).
 * @param {string} today
 * @returns {string}
 */
function utcYesterday(today) {
  const raw = typeof today === "string" ? today : getTodayDate();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    return getTodayDate();
  }
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function emptyStreak() {
  return { current: 0, longest: 0, lastActiveDate: null };
}

/**
 * Lazy-normalize streak from a points record. Does not mutate.
 * @param {object|null|undefined} user
 * @returns {{ current: number, longest: number, lastActiveDate: string|null }}
 */
function readStreak(user) {
  if (!user || typeof user !== "object" || !user.streak || typeof user.streak !== "object") {
    return emptyStreak();
  }
  let current = user.streak.current;
  let longest = user.streak.longest;
  if (typeof current !== "number" || !Number.isInteger(current) || current < 0) {
    current = 0;
  }
  if (typeof longest !== "number" || !Number.isInteger(longest) || longest < 0) {
    longest = 0;
  }
  const last = user.streak.lastActiveDate;
  const lastActiveDate =
    typeof last === "string" && /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null;
  return { current, longest, lastActiveDate };
}

function ensureStreak(user) {
  const normalized = readStreak(user);
  user.streak = {
    current: normalized.current,
    longest: normalized.longest,
    lastActiveDate: normalized.lastActiveDate,
  };
  return user.streak;
}

/**
 * Apply community-active streak rules for a successful daily-activity claim.
 * Mutates user.streak. Same-day claims are no-ops.
 * @param {object} user
 * @param {string} [today]
 * @returns {{ current: number, longest: number, lastActiveDate: string|null, incremented: boolean }}
 */
function applyDailyActivityStreak(user, today = getTodayDate()) {
  const streak = ensureStreak(user);
  if (streak.lastActiveDate === today) {
    return { ...streak, incremented: false };
  }
  if (streak.lastActiveDate && streak.lastActiveDate === utcYesterday(today)) {
    streak.current += 1;
  } else {
    streak.current = 1;
  }
  if (streak.current > streak.longest) {
    streak.longest = streak.current;
  }
  streak.lastActiveDate = today;
  return { ...streak, incremented: true };
}

/**
 * Legacy same-day activity claimed before streaks existed:
 * activityDate === today, current === 0, lastActiveDate === null.
 * Safe to grant streak 1 without extra XP.
 * @param {object|null|undefined} user
 * @param {string} [today]
 * @returns {boolean}
 */
function needsSameDayStreakRepair(user, today = getTodayDate()) {
  if (!user || typeof user !== "object") {
    return false;
  }
  if (user.activityDate !== today) {
    return false;
  }
  const streak = readStreak(user);
  return streak.current === 0 && streak.lastActiveDate === null;
}

/**
 * Repair legacy same-day activity onto streak 1. No XP. Mutates user.streak.
 * @param {object} user
 * @param {string} [today]
 */
function applySameDayStreakRepair(user, today = getTodayDate()) {
  const streak = ensureStreak(user);
  streak.current = 1;
  if (streak.longest < 1) {
    streak.longest = 1;
  }
  streak.lastActiveDate = today;
  return { ...streak, repaired: true };
}

/**
 * One-shot startup repair: activityDate === today + no streak → streak 1.
 * No XP. Skips owner/admin. No write when nothing changes.
 * @param {string} [pointsFile]
 * @param {string} [todayDate]
 * @returns {{ repaired: number, written: boolean }}
 */
function repairCurrentDayStreaks(pointsFile = POINTS_FILE, todayDate) {
  const today = todayDate || getTodayDate();
  const snapshot = readPointsSnapshot(pointsFile);
  let need = 0;
  for (const [userId, user] of Object.entries(snapshot.users || {})) {
    if (isCommunityCompetitionExcluded(userId)) {
      continue;
    }
    if (needsSameDayStreakRepair(user, today)) {
      need += 1;
    }
  }
  if (need === 0) {
    return { repaired: 0, written: false };
  }

  return mutatePoints((data) => {
    let repaired = 0;
    for (const [userId, user] of Object.entries(data.users || {})) {
      if (isCommunityCompetitionExcluded(userId)) {
        continue;
      }
      if (needsSameDayStreakRepair(user, today)) {
        applySameDayStreakRepair(user, today);
        repaired += 1;
      }
    }
    return { repaired, written: repaired > 0 };
  }, pointsFile);
}

function excludedAwardResult(userId, pointsFile, extra = {}) {
  const data = readPointsSnapshot(pointsFile);
  const user = data.users[String(userId)];
  const points = user && typeof user.points === "number" ? user.points : 0;
  return {
    awarded: false,
    reason: "excluded",
    points,
    pointsToAdd: 0,
    rankUp: false,
    rank: getRank(points),
    ...extra,
  };
}

function getWeekId(date = new Date()) {
  const now = new Date(date);
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getMonth(), diff));
  return monday.toISOString().slice(0, 10);
}

function emptyPointsData() {
  return { users: {} };
}

/**
 * Read-only snapshot. Never writes. Invalid/missing → empty structure in memory.
 * @param {string} [pointsFile]
 * @returns {{ users: Record<string, object> }}
 */
function readPointsSnapshot(pointsFile = POINTS_FILE, options = {}) {
  try {
    if (!fs.existsSync(pointsFile)) {
      return emptyPointsData();
    }

    const raw = fs.readFileSync(pointsFile, "utf8").trim();
    if (!raw) {
      return emptyPointsData();
    }

    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !data.users || typeof data.users !== "object") {
      if (options.strict) {
        throw new Error("Failed to read points.json: invalid-shape");
      }
      return emptyPointsData();
    }

    return data;
  } catch (err) {
    if (options.strict && err && err.code !== "ENOENT") {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read points.json: ${message}`);
    }
    logError(`Error reading ${path.basename(pointsFile)}:`, err);
    return emptyPointsData();
  }
}

/**
 * Read-only load for commands/leaderboards. Does not repair the file on disk.
 * @param {string} [pointsFile]
 */
function loadPoints(pointsFile = POINTS_FILE) {
  return readPointsSnapshot(pointsFile);
}

/**
 * Exclusive cross-process mutation of points.json.
 * Lock → read → mutator(data) → atomic write → release (always).
 *
 * @template T
 * @param {(data: { users: Record<string, object> }) => T} mutator
 * @param {string} [pointsFile]
 * @returns {T}
 */
function mutatePoints(mutator, pointsFile = POINTS_FILE) {
  if (typeof mutator !== "function") {
    throw new TypeError("mutatePoints requires a mutator function");
  }

  const release = acquirePointsLock(pointsFile);

  try {
    const data = readPointsSnapshot(pointsFile, { strict: true });
    const result = mutator(data);

    try {
      writeJsonFileAtomic(pointsFile, data);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to write points.json: ${message}`);
    }

    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release points.json lock:", err);
    }
  }
}

/**
 * Replace points.json contents under lock (legacy/test helper).
 * Prefer mutatePoints for read-modify-write.
 *
 * @param {{ users: Record<string, object> }} data
 * @param {string} [pointsFile]
 */
function savePoints(data, pointsFile = POINTS_FILE) {
  if (!data || typeof data !== "object" || !data.users || typeof data.users !== "object") {
    throw new Error("savePoints requires an object with a users map");
  }

  mutatePoints((current) => {
    current.users = data.users;
  }, pointsFile);
}

function ensurePointsFile(pointsFile = POINTS_FILE) {
  if (fs.existsSync(pointsFile)) {
    return;
  }

  mutatePoints(() => undefined, pointsFile);
}

function isAdmin(userId) {
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId) return false;
  return String(userId) === String(adminId);
}

function getRank(points) {
  if (points >= 600) return { emoji: "👑", title: "Legend" };
  if (points >= 300) return { emoji: "🛡", title: "Guardian" };
  if (points >= 150) return { emoji: "🥭", title: "Mango Tree" };
  if (points >= 75) return { emoji: "🌳", title: "Tree" };
  if (points >= 25) return { emoji: "🌿", title: "Sprout" };
  return { emoji: "🌱", title: "Seed" };
}

/**
 * Telegram commands start with "/" and must not earn daily activity points.
 */
function isCommandText(text) {
  return typeof text === "string" && text.trim().startsWith("/");
}

/**
 * Detect a daily trigger as a whole word (case-insensitive).
 * Allows emoji/punctuation around the word; rejects matches inside other words.
 */
function detectTrigger(text) {
  if (typeof text !== "string") {
    return null;
  }

  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const trigger of TRIGGER_DETECT_ORDER) {
    if (new RegExp(`\\b${trigger}\\b`).test(normalized)) {
      return trigger;
    }
  }

  return null;
}

function getTriggersClaimedToday(user) {
  if (user.triggerDate !== getTodayDate()) {
    return [];
  }
  return user.triggersUsed || [];
}

/**
 * Whether the user already claimed the daily activity point (UTC calendar day).
 * Missing/null activityDate means not claimed today.
 */
function hasClaimedDailyActivity(user) {
  if (!user || typeof user !== "object") {
    return false;
  }
  return user.activityDate === getTodayDate();
}

/**
 * Read-only: Snake daily play XP claimed today (UTC).
 * Missing/null game or snakePlayDate → not claimed. Does not mutate.
 */
function hasClaimedSnakeToday(user) {
  if (!user || typeof user !== "object" || !user.game || typeof user.game !== "object") {
    return false;
  }
  return user.game.snakePlayDate === getTodayDate();
}

/**
 * Read-only: Bounch daily play XP claimed today (UTC).
 * Missing/null game or bounchPlayDate → not claimed. Does not mutate.
 */
function hasClaimedBounchToday(user) {
  if (!user || typeof user !== "object" || !user.game || typeof user.game !== "object") {
    return false;
  }
  return user.game.bounchPlayDate === getTodayDate();
}

/**
 * Read-only display value for Bounch unlock progress (0–7).
 * Missing/malformed → 0. Does not mutate user or points.json.
 */
function getBounchUnlockedMaxForDisplay(user) {
  if (!user || typeof user !== "object" || !user.game || typeof user.game !== "object") {
    return 0;
  }
  const raw = user.game.bounchUnlockedMax;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return 0;
  }
  if (raw > 7) {
    return 7;
  }
  return raw;
}

/**
 * Single line for /points Bounch unlock progress.
 */
function formatBounchUnlocksLine(user) {
  return `🎮 Bounch unlocks: ${getBounchUnlockedMaxForDisplay(user)} / 7`;
}

/**
 * Multi-line "Claimed today" block for /points (activity + triggers + games).
 * Read-only — does not mutate user or points.json.
 */
function formatClaimedTodayLines(user) {
  const lines = [
    hasClaimedDailyActivity(user) ? "✅ Daily activity" : "⬜ Daily activity",
  ];

  const claimed = getTriggersClaimedToday(user);
  for (const trigger of TRIGGER_DETECT_ORDER) {
    const label = TRIGGER_LABELS[trigger] || trigger;
    lines.push(claimed.includes(trigger) ? `✅ ${label}` : `⬜ ${label}`);
  }

  lines.push(hasClaimedSnakeToday(user) ? "✅ Snake" : "⬜ Snake");
  lines.push(hasClaimedBounchToday(user) ? "✅ Bounch" : "⬜ Bounch");
  lines.push(
    `🎮 PvP wins today: ${getPvpRewardedWinsToday(user)} / ${PVP_DAILY_WIN_CAP}`
  );

  return lines.join("\n");
}

function formatLastActiveLabel(lastActiveDate, today = getTodayDate()) {
  if (!lastActiveDate) {
    return null;
  }
  if (lastActiveDate === today) {
    return "Today ✅";
  }
  if (lastActiveDate === utcYesterday(today)) {
    return "Yesterday";
  }
  return lastActiveDate;
}

function formatPersonalStreakMessage(user) {
  const streak = readStreak(user);
  const last = formatLastActiveLabel(streak.lastActiveDate);
  const lines = [
    "🔥 Your ManGo Streak",
    "",
    `Current streak: ${streak.current} days`,
    `Longest streak: ${streak.longest} days`,
  ];
  if (last) {
    lines.push(`Last active: ${last}`);
  }
  lines.push("");
  if (streak.current === 0) {
    lines.push("Send a message in the ManGo community to start one.");
  } else {
    lines.push("Keep showing up. 🥭");
  }
  return lines.join("\n");
}

function formatPointsCard(user, options = {}) {
  const points = user && typeof user.points === "number" ? user.points : 0;
  const rank = getRank(points);
  const weeklyPoints = getEffectiveWeeklyPoints(user || {});
  const streak = readStreak(user);
  const walletVerified = Boolean(options && options.walletVerified);
  const walletRegistered = Boolean(options && options.walletRegistered);
  const walletLine = walletVerified
    ? "Wallet: ✅ Verified"
    : walletRegistered
      ? "Wallet: 🟡 Registered"
      : "Wallet: ⬜ Not linked";
  const lines = [
    "🥭 Your ManGo Progress",
    "",
    `XP: ${points}`,
    `Weekly XP: ${weeklyPoints}`,
    `Rank: ${rank.emoji} ${rank.title}`,
    "",
    `🔥 Current streak: ${streak.current} days`,
    `🏆 Longest streak: ${streak.longest} days`,
    "",
    walletLine,
  ];
  if (!walletVerified && !walletRegistered) {
    lines.push("", XP_WALLET_LOCKED_POINTS_LINE);
  }
  lines.push(
    "",
    "Claimed today:",
    formatClaimedTodayLines(user),
    "",
    formatBounchUnlocksLine(user)
  );
  return lines.join("\n");
}

function getUserRecord(data, userId) {
  return (
    data.users[String(userId)] || {
      points: 0,
      weeklyPoints: 0,
      weekId: null,
      name: "Unknown",
      triggerDate: null,
      triggersUsed: [],
      activityDate: null,
      streak: emptyStreak(),
    }
  );
}

/**
 * Preserve weekly standing before lazy week roll wipes weeklyPoints.
 * Lazy-requires weeklyWinners to avoid circular load issues.
 * @param {string|number} userId
 * @param {object} user
 */
function noteWeeklyStandingSafe(userId, user) {
  if (userId == null || !user || !user.weekId) {
    return;
  }
  try {
    const { noteWeeklyStanding } = require("./weeklyWinners");
    noteWeeklyStanding(
      userId,
      user.name,
      user.weekId,
      typeof user.weeklyPoints === "number" ? user.weeklyPoints : 0
    );
  } catch (err) {
    logError(
      "[points] noteWeeklyStanding failed:",
      err && err.message ? err.message : err
    );
  }
}

/**
 * Lazy UTC-week roll. Captures prior-week score before wipe (Top 3 safety).
 * @param {object} user
 * @param {string|number} [userId]
 */
function resetWeeklyIfNewWeek(user, userId) {
  const currentWeek = getWeekId();
  if (user.weekId != null && user.weekId !== currentWeek) {
    if (userId != null) {
      noteWeeklyStandingSafe(userId, user);
    }
    user.weekId = currentWeek;
    user.weeklyPoints = 0;
  }
  if (user.weeklyPoints === undefined) {
    user.weeklyPoints = 0;
  }
  if (user.weekId === undefined) {
    user.weekId = currentWeek;
  }
}

function getEffectiveWeeklyPoints(user) {
  if (user.weekId !== getWeekId()) {
    return 0;
  }
  return user.weeklyPoints || 0;
}

function resetTriggersIfNewDay(user) {
  const today = getTodayDate();
  if (user.triggerDate !== today) {
    user.triggerDate = today;
    user.triggersUsed = [];
  }
}

function buildRankUpMessage(userName, rank) {
  return `🥭 ${userName} reached ${rank.emoji} ${rank.title}!`;
}

/**
 * Automatic group feedback: only a short rank-up message, otherwise silent.
 */
function getAutomaticTriggerReply(result, userName) {
  if (result && result.awarded && result.rankUp && result.rank) {
    return buildRankUpMessage(userName, result.rank);
  }
  return null;
}

/**
 * At most one rank-up reply per text message (activity + optional trigger + optional fight).
 * Prefers the later award so the final rank is announced (fight > trigger > activity).
 */
function getCombinedRankUpReply(
  activityResult,
  triggerResult,
  userName,
  fightResult = null
) {
  const fightReply = getAutomaticTriggerReply(fightResult, userName);
  if (fightReply) {
    return fightReply;
  }
  const triggerReply = getAutomaticTriggerReply(triggerResult, userName);
  if (triggerReply) {
    return triggerReply;
  }
  return getAutomaticTriggerReply(activityResult, userName);
}

function ensureUserRecord(data, id, userName) {
  if (!data.users[id]) {
    data.users[id] = {
      points: 0,
      weeklyPoints: 0,
      weekId: getWeekId(),
      name: userName,
      triggerDate: getTodayDate(),
      triggersUsed: [],
      activityDate: null,
      streak: emptyStreak(),
    };
  }
  return data.users[id];
}

/**
 * Ensure optional game XP state exists on a user record (in-memory defaults).
 * @param {object} user
 * @returns {{ snakePlayDate: string|null, bounchPlayDate: string|null, bounchUnlockedMax: number }}
 */
function ensureGameState(user) {
  if (!user.game || typeof user.game !== "object") {
    user.game = {
      snakePlayDate: null,
      bounchPlayDate: null,
      bounchUnlockedMax: 0,
    };
  }

  if (!Object.prototype.hasOwnProperty.call(user.game, "snakePlayDate")) {
    user.game.snakePlayDate = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user.game, "bounchPlayDate")) {
    user.game.bounchPlayDate = null;
  }

  let unlockedMax = user.game.bounchUnlockedMax;
  if (typeof unlockedMax !== "number" || !Number.isInteger(unlockedMax) || unlockedMax < 0) {
    unlockedMax = 0;
  }
  if (unlockedMax > 7) {
    unlockedMax = 7;
  }
  user.game.bounchUnlockedMax = unlockedMax;

  return user.game;
}

function emptyGameXpPayload() {
  return { awarded: 0, dailyPlay: 0, unlock: 0 };
}

function publicGameXpFromAward(result) {
  const payload = emptyGameXpPayload();
  if (result && result.xp) {
    payload.awarded = result.xp.awarded || 0;
    payload.dailyPlay = result.xp.dailyPlay || 0;
    payload.unlock = result.xp.unlock || 0;
  }
  if (result && result.reason === XP_WALLET_REQUIRED) {
    payload.walletRequired = true;
    payload.message = XP_WALLET_GAME_LOCKED_TEXT;
  }
  return payload;
}

function walletLockedSnapshot(userId, pointsFile, extra = {}) {
  const data = readPointsSnapshot(pointsFile);
  const user = data.users[String(userId)];
  const points = user && typeof user.points === "number" ? user.points : 0;
  const rank = getRank(points);
  return {
    awarded: false,
    reason: XP_WALLET_REQUIRED,
    points,
    pointsToAdd: 0,
    rankUp: false,
    rank,
    previousRank: rank,
    xp: emptyGameXpPayload(),
    ...extra,
  };
}

function buildGameXpResult(pointsBefore, pointsAfter, dailyPlay, unlock) {
  const pointsToAdd = dailyPlay + unlock;
  const previousRank = getRank(pointsBefore);
  const rank = getRank(pointsAfter);
  return {
    awarded: pointsToAdd > 0,
    points: pointsAfter,
    pointsToAdd,
    xp: {
      awarded: pointsToAdd,
      dailyPlay,
      unlock,
    },
    rankUp: previousRank.title !== rank.title,
    rank,
    previousRank,
  };
}

/**
 * First verified Snake play per UTC day → +1 XP.
 */
function awardSnakeGameXp(userId, userName, pointsFile = POINTS_FILE, walletFile) {
  if (!canEarnXp(userId, walletFile)) {
    return walletLockedSnapshot(userId, pointsFile);
  }

  return mutatePoints((data) => {
    const id = String(userId);
    const user = ensureUserRecord(data, id, userName);
    user.name = userName;
    resetWeeklyIfNewWeek(user, id);
    const game = ensureGameState(user);
    const today = getTodayDate();
    const pointsBefore = user.points;

    let dailyPlay = 0;
    if (game.snakePlayDate !== today) {
      dailyPlay = 1;
      game.snakePlayDate = today;
      user.points += 1;
      user.weeklyPoints += 1;
      noteWeeklyStandingSafe(id, user);
    }

    return buildGameXpResult(pointsBefore, user.points, dailyPlay, 0);
  }, pointsFile);
}

/**
 * Verified Bounch play: +1 first UTC day + unlock XP for newly reached levels 1..7.
 * Direct level L unlocks 1..L when above current bounchUnlockedMax.
 */
function awardBounchGameXp(userId, userName, level, pointsFile = POINTS_FILE, walletFile) {
  if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 7) {
    return {
      awarded: false,
      points: 0,
      pointsToAdd: 0,
      xp: emptyGameXpPayload(),
      rankUp: false,
      rank: getRank(0),
    };
  }

  if (!canEarnXp(userId, walletFile)) {
    return walletLockedSnapshot(userId, pointsFile);
  }

  return mutatePoints((data) => {
    const id = String(userId);
    const user = ensureUserRecord(data, id, userName);
    user.name = userName;
    resetWeeklyIfNewWeek(user, id);
    const game = ensureGameState(user);
    const today = getTodayDate();
    const pointsBefore = user.points;

    let dailyPlay = 0;
    if (game.bounchPlayDate !== today) {
      dailyPlay = 1;
      game.bounchPlayDate = today;
    }

    let unlock = 0;
    if (level > game.bounchUnlockedMax) {
      unlock = level - game.bounchUnlockedMax;
      game.bounchUnlockedMax = level;
    }

    const pointsToAdd = dailyPlay + unlock;
    if (pointsToAdd > 0) {
      user.points += pointsToAdd;
      user.weeklyPoints += pointsToAdd;
      noteWeeklyStandingSafe(id, user);
    }

    return buildGameXpResult(pointsBefore, user.points, dailyPlay, unlock);
  }, pointsFile);
}

/**
 * Award 1 lifetime/weekly point for the first normal chat message of the UTC day.
 * Silent by design — callers should not announce "+1 activity".
 */
function awardDailyActivityPoint(userId, userName, pointsFile = POINTS_FILE, todayDate, walletFile) {
  if (isCommunityCompetitionExcluded(userId)) {
    return excludedAwardResult(userId, pointsFile);
  }

  const today = todayDate || getTodayDate();

  return mutatePoints((data) => {
    const id = String(userId);
    const user = ensureUserRecord(data, id, userName);

    user.name = userName;
    resetWeeklyIfNewWeek(user, id);

    if (user.activityDate === today) {
      const repaired = needsSameDayStreakRepair(user, today);
      if (repaired) {
        applySameDayStreakRepair(user, today);
      }
      return {
        awarded: false,
        points: user.points,
        pointsToAdd: 1,
        rankUp: false,
        rank: getRank(user.points),
        streak: { ...readStreak(user) },
        streakRepaired: repaired,
      };
    }

    if (!canEarnXp(userId, walletFile)) {
      user.activityDate = today;
      const streak = applyDailyActivityStreak(user, today);
      return {
        awarded: false,
        reason: XP_WALLET_REQUIRED,
        points: user.points,
        pointsToAdd: 0,
        rankUp: false,
        rank: getRank(user.points),
        previousRank: getRank(user.points),
        streak,
      };
    }

    const pointsBefore = user.points;
    user.points += 1;
    user.weeklyPoints += 1;
    user.activityDate = today;
    const streak = applyDailyActivityStreak(user, today);
    noteWeeklyStandingSafe(id, user);

    const previousRank = getRank(pointsBefore);
    const rank = getRank(user.points);
    const rankUp = previousRank.title !== rank.title;

    return {
      awarded: true,
      points: user.points,
      pointsToAdd: 1,
      rankUp,
      rank,
      previousRank,
      streak,
    };
  }, pointsFile);
}

function awardTriggerPoints(userId, userName, trigger, pointsFile = POINTS_FILE, walletFile) {
  const pointsToAdd = TRIGGERS[trigger];

  if (pointsToAdd === undefined) {
    return {
      awarded: false,
      points: 0,
      pointsToAdd: 0,
      rankUp: false,
      rank: getRank(0),
    };
  }

  if (isCommunityCompetitionExcluded(userId)) {
    return excludedAwardResult(userId, pointsFile, { pointsToAdd: 0 });
  }

  return mutatePoints((data) => {
    const id = String(userId);
    const user = ensureUserRecord(data, id, userName);
    user.name = userName;
    resetTriggersIfNewDay(user);
    resetWeeklyIfNewWeek(user, id);

    if (user.triggersUsed.includes(trigger)) {
      return {
        awarded: false,
        points: user.points,
        pointsToAdd,
        rankUp: false,
        rank: getRank(user.points),
      };
    }

    if (!canEarnXp(userId, walletFile)) {
      return {
        awarded: false,
        reason: XP_WALLET_REQUIRED,
        points: user.points,
        pointsToAdd: 0,
        rankUp: false,
        rank: getRank(user.points),
        previousRank: getRank(user.points),
      };
    }

    const pointsBefore = user.points;
    user.points += pointsToAdd;
    user.weeklyPoints += pointsToAdd;
    user.triggersUsed.push(trigger);
    noteWeeklyStandingSafe(id, user);

    const previousRank = getRank(pointsBefore);
    const rank = getRank(user.points);
    const rankUp = previousRank.title !== rank.title;

    return {
      awarded: true,
      points: user.points,
      pointsToAdd,
      rankUp,
      rank,
      previousRank,
    };
  }, pointsFile);
}

/**
 * ChatFight win: +2 lifetime XP and +2 weeklyPoints.
 * Call only after an in-process winner claim; does not enforce fight state itself.
 */
function awardChatFightXp(userId, userName, pointsFile = POINTS_FILE, walletFile) {
  const pointsToAdd = 2;

  if (isCommunityCompetitionExcluded(userId)) {
    return excludedAwardResult(userId, pointsFile, { pointsToAdd: 0 });
  }

  if (!canEarnXp(userId, walletFile)) {
    return walletLockedSnapshot(userId, pointsFile, { pointsToAdd: 0 });
  }

  return mutatePoints((data) => {
    const id = String(userId);
    const user = ensureUserRecord(data, id, userName);
    user.name = userName;
    resetWeeklyIfNewWeek(user, id);

    const pointsBefore = user.points;
    user.points += pointsToAdd;
    user.weeklyPoints += pointsToAdd;
    noteWeeklyStandingSafe(id, user);

    const previousRank = getRank(pointsBefore);
    const rank = getRank(user.points);
    const rankUp = previousRank.title !== rank.title;

    return {
      awarded: true,
      points: user.points,
      pointsToAdd,
      rankUp,
      rank,
      previousRank,
    };
  }, pointsFile);
}

/** Trivia sole-winner round XP. */
const TRIVIA_ROUND_WIN_XP = 3;
/** Trivia shared-#1 tie XP. */
const TRIVIA_TIE_XP = 2;
/** Max rewarded Trivia rounds per UTC day per user. */
const TRIVIA_DAILY_REWARD_CAP = 2;

/**
 * Ensure optional trivia XP state exists (backward compatible).
 * @param {object} user
 * @returns {{ rewardDate: string|null, rewardedRounds: number }}
 */
function ensureTriviaState(user) {
  if (!user.trivia || typeof user.trivia !== "object") {
    user.trivia = {
      rewardDate: null,
      rewardedRounds: 0,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(user.trivia, "rewardDate")) {
    user.trivia.rewardDate = null;
  }
  let rounds = user.trivia.rewardedRounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 0) {
    rounds = 0;
  }
  user.trivia.rewardedRounds = rounds;
  return user.trivia;
}

function resetTriviaIfNewDay(user) {
  const today = getTodayDate();
  ensureTriviaState(user);
  if (user.trivia.rewardDate !== today) {
    user.trivia.rewardDate = today;
    user.trivia.rewardedRounds = 0;
  }
}

function getTriviaRewardedRoundsToday(user) {
  if (!user || typeof user !== "object" || !user.trivia || typeof user.trivia !== "object") {
    return 0;
  }
  if (user.trivia.rewardDate !== getTodayDate()) {
    return 0;
  }
  const rounds = user.trivia.rewardedRounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 0) {
    return 0;
  }
  return rounds;
}

/**
 * Trivia round reward XP with per-UTC-day rewarded-round cap.
 * @param {string|number} userId
 * @param {string} userName
 * @param {number} pointsToAdd
 * @param {string} [pointsFile]
 */
function awardTriviaRoundXp(
  userId,
  userName,
  pointsToAdd,
  pointsFile = POINTS_FILE,
  walletFile
) {
  const amount =
    typeof pointsToAdd === "number" && Number.isInteger(pointsToAdd) && pointsToAdd > 0
      ? pointsToAdd
      : TRIVIA_ROUND_WIN_XP;

  if (isCommunityCompetitionExcluded(userId)) {
    return excludedAwardResult(userId, pointsFile, {
      pointsToAdd: 0,
      rewardedRoundsToday: 0,
      dailyCap: TRIVIA_DAILY_REWARD_CAP,
    });
  }

  if (!canEarnXp(userId, walletFile)) {
    return walletLockedSnapshot(userId, pointsFile, {
      pointsToAdd: 0,
      rewardedRoundsToday: 0,
      dailyCap: TRIVIA_DAILY_REWARD_CAP,
    });
  }

  return mutatePoints((data) => {
    const id = String(userId);
    const user = ensureUserRecord(data, id, userName);
    user.name = userName;
    resetWeeklyIfNewWeek(user, id);
    resetTriviaIfNewDay(user);

    if (user.trivia.rewardedRounds >= TRIVIA_DAILY_REWARD_CAP) {
      return {
        awarded: false,
        reason: "daily-cap",
        points: user.points,
        pointsToAdd: 0,
        rewardedRoundsToday: user.trivia.rewardedRounds,
        dailyCap: TRIVIA_DAILY_REWARD_CAP,
        rankUp: false,
        rank: getRank(user.points),
      };
    }

    const pointsBefore = user.points;
    user.points += amount;
    user.weeklyPoints += amount;
    user.trivia.rewardedRounds += 1;
    noteWeeklyStandingSafe(id, user);

    const previousRank = getRank(pointsBefore);
    const rank = getRank(user.points);
    const rankUp = previousRank.title !== rank.title;

    return {
      awarded: true,
      points: user.points,
      pointsToAdd: amount,
      rewardedRoundsToday: user.trivia.rewardedRounds,
      dailyCap: TRIVIA_DAILY_REWARD_CAP,
      rankUp,
      rank,
      previousRank,
    };
  }, pointsFile);
}

/** @deprecated Use awardTriviaRoundXp — kept name alias for clarity in older call sites. */
function awardTriviaWinXp(userId, userName, pointsFile = POINTS_FILE) {
  return awardTriviaRoundXp(userId, userName, TRIVIA_ROUND_WIN_XP, pointsFile);
}

/** ManGo Bomb participation XP (awarded once when a round actually starts). */
const MANGO_BOMB_PARTICIPATE_XP = 1;
/** ManGo Bomb survival XP per explosion while still alive. */
const MANGO_BOMB_SURVIVE_XP = 1;
/** ManGo Bomb winner bonus XP. */
const MANGO_BOMB_WIN_XP = 5;
/** Max rewarded ManGo Bomb rounds per UTC day per user. */
const MANGO_BOMB_DAILY_ROUND_CAP = 1;

/**
 * Ensure optional ManGo Bomb XP state exists (backward compatible).
 * @param {object} user
 * @returns {{ rewardDate: string|null, rewardedRounds: number, rewardedRoundId: string|null }}
 */
function ensureMangoBombState(user) {
  if (!user.mangoBomb || typeof user.mangoBomb !== "object") {
    user.mangoBomb = {
      rewardDate: null,
      rewardedRounds: 0,
      rewardedRoundId: null,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(user.mangoBomb, "rewardDate")) {
    user.mangoBomb.rewardDate = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user.mangoBomb, "rewardedRoundId")) {
    user.mangoBomb.rewardedRoundId = null;
  }
  let rounds = user.mangoBomb.rewardedRounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 0) {
    rounds = 0;
  }
  user.mangoBomb.rewardedRounds = rounds;
  return user.mangoBomb;
}

function resetMangoBombIfNewDay(user) {
  const today = getTodayDate();
  ensureMangoBombState(user);
  if (user.mangoBomb.rewardDate !== today) {
    user.mangoBomb.rewardDate = today;
    user.mangoBomb.rewardedRounds = 0;
    user.mangoBomb.rewardedRoundId = null;
  }
}

/**
 * Read-only: rewarded ManGo Bomb rounds today (UTC). Missing/legacy → 0.
 */
function getMangoBombRewardedRoundsToday(user) {
  if (!user || typeof user !== "object" || !user.mangoBomb || typeof user.mangoBomb !== "object") {
    return 0;
  }
  if (user.mangoBomb.rewardDate !== getTodayDate()) {
    return 0;
  }
  const rounds = user.mangoBomb.rewardedRounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 0) {
    return 0;
  }
  return rounds;
}

/**
 * ManGo Bomb XP with one rewarded round per UTC day.
 * Later awards in the same roundId still pay; a new round the same day is capped.
 */
function awardMangoBombXp(
  userId,
  userName,
  pointsToAdd,
  roundId,
  pointsFile = POINTS_FILE,
  walletFile
) {
  const amount =
    typeof pointsToAdd === "number" && Number.isInteger(pointsToAdd) && pointsToAdd > 0
      ? pointsToAdd
      : 0;
  const rid = roundId == null ? "" : String(roundId);

  if (!amount || !rid) {
    const data = readPointsSnapshot(pointsFile);
    const user = data.users[String(userId)];
    const points = user && typeof user.points === "number" ? user.points : 0;
    return {
      awarded: false,
      reason: "invalid",
      points,
      pointsToAdd: 0,
      rankUp: false,
      rank: getRank(points),
      previousRank: getRank(points),
      rewardedRoundsToday: 0,
      dailyCap: MANGO_BOMB_DAILY_ROUND_CAP,
    };
  }

  if (isCommunityCompetitionExcluded(userId)) {
    return excludedAwardResult(userId, pointsFile, {
      pointsToAdd: 0,
      rewardedRoundsToday: 0,
      dailyCap: MANGO_BOMB_DAILY_ROUND_CAP,
    });
  }

  if (!canEarnXp(userId, walletFile)) {
    return walletLockedSnapshot(userId, pointsFile, {
      pointsToAdd: 0,
      rewardedRoundsToday: 0,
      dailyCap: MANGO_BOMB_DAILY_ROUND_CAP,
    });
  }

  return mutatePoints((data) => {
    const id = String(userId);
    const user = ensureUserRecord(data, id, userName);
    user.name = userName;
    resetWeeklyIfNewWeek(user, id);
    resetMangoBombIfNewDay(user);

    if (
      user.mangoBomb.rewardedRounds >= MANGO_BOMB_DAILY_ROUND_CAP &&
      user.mangoBomb.rewardedRoundId !== rid
    ) {
      return {
        awarded: false,
        reason: "daily-cap",
        points: user.points,
        pointsToAdd: 0,
        rewardedRoundsToday: user.mangoBomb.rewardedRounds,
        dailyCap: MANGO_BOMB_DAILY_ROUND_CAP,
        rankUp: false,
        rank: getRank(user.points),
        previousRank: getRank(user.points),
      };
    }

    if (user.mangoBomb.rewardedRounds === 0) {
      user.mangoBomb.rewardedRounds = 1;
      user.mangoBomb.rewardedRoundId = rid;
    }

    const pointsBefore = user.points;
    user.points += amount;
    user.weeklyPoints += amount;
    noteWeeklyStandingSafe(id, user);

    const previousRank = getRank(pointsBefore);
    const rank = getRank(user.points);
    const rankUp = previousRank.title !== rank.title;

    return {
      awarded: true,
      points: user.points,
      pointsToAdd: amount,
      rewardedRoundsToday: user.mangoBomb.rewardedRounds,
      dailyCap: MANGO_BOMB_DAILY_ROUND_CAP,
      rankUp,
      rank,
      previousRank,
    };
  }, pointsFile);
}

/** PvP board-game win XP (Tic-Tac-Toe, later Connect Four). */
const PVP_WIN_XP = 3;
/** Max rewarded PvP wins per UTC day per user. */
const PVP_DAILY_WIN_CAP = 3;

/**
 * Ensure optional pvp XP state exists (backward compatible).
 * @param {object} user
 * @returns {{ date: string|null, rewardedWins: number }}
 */
function ensurePvpState(user) {
  if (!user.pvp || typeof user.pvp !== "object") {
    user.pvp = {
      date: null,
      rewardedWins: 0,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(user.pvp, "date")) {
    user.pvp.date = null;
  }
  let wins = user.pvp.rewardedWins;
  if (typeof wins !== "number" || !Number.isInteger(wins) || wins < 0) {
    wins = 0;
  }
  user.pvp.rewardedWins = wins;
  return user.pvp;
}

function resetPvpIfNewDay(user) {
  const today = getTodayDate();
  ensurePvpState(user);
  if (user.pvp.date !== today) {
    user.pvp.date = today;
    user.pvp.rewardedWins = 0;
  }
}

/**
 * Read-only: rewarded PvP wins today (UTC). Missing/legacy → 0.
 */
function getPvpRewardedWinsToday(user) {
  if (!user || typeof user !== "object" || !user.pvp || typeof user.pvp !== "object") {
    return 0;
  }
  if (user.pvp.date !== getTodayDate()) {
    return 0;
  }
  const wins = user.pvp.rewardedWins;
  if (typeof wins !== "number" || !Number.isInteger(wins) || wins < 0) {
    return 0;
  }
  return wins;
}

/**
 * PvP win XP with per-UTC-day cap. Call only after sync winner claim.
 */
function awardPvpWinXp(userId, userName, pointsFile = POINTS_FILE, walletFile) {
  const pointsToAdd = PVP_WIN_XP;

  if (isCommunityCompetitionExcluded(userId)) {
    return excludedAwardResult(userId, pointsFile, {
      pointsToAdd: 0,
      rewardedWinsToday: 0,
      dailyCap: PVP_DAILY_WIN_CAP,
    });
  }

  if (!canEarnXp(userId, walletFile)) {
    return walletLockedSnapshot(userId, pointsFile, {
      pointsToAdd: 0,
      rewardedWinsToday: 0,
      dailyCap: PVP_DAILY_WIN_CAP,
    });
  }

  return mutatePoints((data) => {
    const id = String(userId);
    const user = ensureUserRecord(data, id, userName);
    user.name = userName;
    resetWeeklyIfNewWeek(user, id);
    resetPvpIfNewDay(user);

    if (user.pvp.rewardedWins >= PVP_DAILY_WIN_CAP) {
      return {
        awarded: false,
        reason: "daily-cap",
        points: user.points,
        pointsToAdd: 0,
        rewardedWinsToday: user.pvp.rewardedWins,
        dailyCap: PVP_DAILY_WIN_CAP,
        rankUp: false,
        rank: getRank(user.points),
      };
    }

    const pointsBefore = user.points;
    user.points += pointsToAdd;
    user.weeklyPoints += pointsToAdd;
    user.pvp.rewardedWins += 1;
    noteWeeklyStandingSafe(id, user);

    const previousRank = getRank(pointsBefore);
    const rank = getRank(user.points);
    const rankUp = previousRank.title !== rank.title;

    return {
      awarded: true,
      points: user.points,
      pointsToAdd,
      rewardedWinsToday: user.pvp.rewardedWins,
      dailyCap: PVP_DAILY_WIN_CAP,
      rankUp,
      rank,
      previousRank,
    };
  }, pointsFile);
}

function resetWeeklyForAll(pointsFile = POINTS_FILE) {
  mutatePoints((data) => {
    const currentWeek = getWeekId();

    for (const user of Object.values(data.users)) {
      user.weeklyPoints = 0;
      user.weekId = currentWeek;
    }
  }, pointsFile);
}

ensurePointsFile();

module.exports = {
  TRIGGERS,
  TRIGGER_DETECT_ORDER,
  TRIGGER_LABELS,
  POINTS_LOCK_OPTIONS,
  loadPoints,
  savePoints,
  mutatePoints,
  readPointsSnapshot,
  isAdmin,
  getRank,
  getTodayDate,
  getWeekId,
  utcYesterday,
  isCommandText,
  detectTrigger,
  buildRankUpMessage,
  getAutomaticTriggerReply,
  getCombinedRankUpReply,
  getTriggersClaimedToday,
  hasClaimedDailyActivity,
  hasClaimedSnakeToday,
  hasClaimedBounchToday,
  getBounchUnlockedMaxForDisplay,
  formatBounchUnlocksLine,
  formatClaimedTodayLines,
  formatPersonalStreakMessage,
  formatLastActiveLabel,
  formatPointsCard,
  getUserRecord,
  getEffectiveWeeklyPoints,
  awardDailyActivityPoint,
  awardTriggerPoints,
  awardChatFightXp,
  awardTriviaRoundXp,
  awardTriviaWinXp,
  TRIVIA_ROUND_WIN_XP,
  TRIVIA_TIE_XP,
  TRIVIA_DAILY_REWARD_CAP,
  ensureTriviaState,
  getTriviaRewardedRoundsToday,
  awardMangoBombXp,
  MANGO_BOMB_PARTICIPATE_XP,
  MANGO_BOMB_SURVIVE_XP,
  MANGO_BOMB_WIN_XP,
  MANGO_BOMB_DAILY_ROUND_CAP,
  ensureMangoBombState,
  getMangoBombRewardedRoundsToday,
  awardPvpWinXp,
  PVP_WIN_XP,
  PVP_DAILY_WIN_CAP,
  ensurePvpState,
  getPvpRewardedWinsToday,
  awardSnakeGameXp,
  awardBounchGameXp,
  ensureGameState,
  emptyGameXpPayload,
  publicGameXpFromAward,
  XP_WALLET_REQUIRED,
  canEarnXp,
  resetWeeklyForAll,
  readStreak,
  ensureStreak,
  applyDailyActivityStreak,
  needsSameDayStreakRepair,
  applySameDayStreakRepair,
  repairCurrentDayStreaks,
  emptyStreak,
};
