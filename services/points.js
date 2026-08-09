/**
 * Community points system — storage, triggers, ranks, weekly tracking, and daily activity.
 */

const path = require("path");
const { readJsonFile, writeJsonFile, ensureJsonFile } = require("../utils/json");
const { error: logError } = require("../utils/logger");

const POINTS_FILE = path.join(__dirname, "..", "points.json");

const TRIGGERS = {
  gmango: 2,
  gnango: 2,
  gm: 1,
  gn: 1,
};

/** Longer triggers first so "gmango" wins over "gm". */
const TRIGGER_DETECT_ORDER = ["gmango", "gnango", "gm", "gn"];

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getWeekId(date = new Date()) {
  const now = new Date(date);
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getMonth(), diff));
  return monday.toISOString().slice(0, 10);
}

function loadPoints(pointsFile = POINTS_FILE) {
  const data = readJsonFile(pointsFile, () => ({ users: {} }), path.basename(pointsFile));

  if (!data || typeof data !== "object" || !data.users || typeof data.users !== "object") {
    logError(`${path.basename(pointsFile)} has invalid structure, resetting...`);
    const fresh = { users: {} };
    savePoints(fresh, pointsFile);
    return fresh;
  }

  return data;
}

function savePoints(data, pointsFile = POINTS_FILE) {
  writeJsonFile(pointsFile, data);
}

function ensurePointsFile() {
  ensureJsonFile(POINTS_FILE, () => ({ users: {} }));
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
 * Multi-line "Claimed today" block for /points (activity + claimed triggers).
 */
function formatClaimedTodayLines(user) {
  const lines = [
    hasClaimedDailyActivity(user) ? "✅ Daily activity" : "⬜ Daily activity",
  ];

  for (const trigger of getTriggersClaimedToday(user)) {
    lines.push(`✅ ${trigger}`);
  }

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
    }
  );
}

function resetWeeklyIfNewWeek(user) {
  const currentWeek = getWeekId();
  if (user.weekId !== currentWeek) {
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
 * At most one rank-up reply per text message (activity + optional trigger).
 * Prefers the later award so the final rank is announced.
 */
function getCombinedRankUpReply(activityResult, triggerResult, userName) {
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
    };
  }
  return data.users[id];
}

/**
 * Award 1 lifetime/weekly point for the first normal chat message of the UTC day.
 * Silent by design — callers should not announce "+1 activity".
 */
function awardDailyActivityPoint(userId, userName, pointsFile = POINTS_FILE) {
  const data = loadPoints(pointsFile);
  const id = String(userId);
  const today = getTodayDate();
  const user = ensureUserRecord(data, id, userName);

  user.name = userName;
  resetWeeklyIfNewWeek(user);

  if (user.activityDate === today) {
    return {
      awarded: false,
      points: user.points,
      pointsToAdd: 1,
      rankUp: false,
      rank: getRank(user.points),
    };
  }

  const pointsBefore = user.points;
  user.points += 1;
  user.weeklyPoints += 1;
  user.activityDate = today;
  savePoints(data, pointsFile);

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
  };
}

function awardTriggerPoints(userId, userName, trigger, pointsFile = POINTS_FILE) {
  const data = loadPoints(pointsFile);
  const id = String(userId);
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

  const user = ensureUserRecord(data, id, userName);
  user.name = userName;
  resetTriggersIfNewDay(user);
  resetWeeklyIfNewWeek(user);

  if (user.triggersUsed.includes(trigger)) {
    return {
      awarded: false,
      points: user.points,
      pointsToAdd,
      rankUp: false,
      rank: getRank(user.points),
    };
  }

  const pointsBefore = user.points;
  user.points += pointsToAdd;
  user.weeklyPoints += pointsToAdd;
  user.triggersUsed.push(trigger);
  savePoints(data, pointsFile);

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
}

function resetWeeklyForAll() {
  const data = loadPoints();
  const currentWeek = getWeekId();

  for (const user of Object.values(data.users)) {
    user.weeklyPoints = 0;
    user.weekId = currentWeek;
  }

  savePoints(data);
}

ensurePointsFile();

module.exports = {
  TRIGGERS,
  loadPoints,
  savePoints,
  isAdmin,
  getRank,
  isCommandText,
  detectTrigger,
  buildRankUpMessage,
  getAutomaticTriggerReply,
  getCombinedRankUpReply,
  getTriggersClaimedToday,
  hasClaimedDailyActivity,
  formatClaimedTodayLines,
  getUserRecord,
  getEffectiveWeeklyPoints,
  awardDailyActivityPoint,
  awardTriggerPoints,
  resetWeeklyForAll,
};
