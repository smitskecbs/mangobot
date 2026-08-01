/**
 * Community points system — storage, triggers, ranks, and weekly tracking.
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

function loadPoints() {
  const data = readJsonFile(POINTS_FILE, () => ({ users: {} }), "points.json");

  if (!data || typeof data !== "object" || !data.users || typeof data.users !== "object") {
    logError("points.json has invalid structure, resetting...");
    const fresh = { users: {} };
    savePoints(fresh);
    return fresh;
  }

  return data;
}

function savePoints(data) {
  writeJsonFile(POINTS_FILE, data);
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

function getUserRecord(data, userId) {
  return (
    data.users[String(userId)] || {
      points: 0,
      weeklyPoints: 0,
      weekId: null,
      name: "Unknown",
      triggerDate: null,
      triggersUsed: [],
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

function awardTriggerPoints(userId, userName, trigger) {
  const data = loadPoints();
  const id = String(userId);
  const pointsToAdd = TRIGGERS[trigger];

  if (!data.users[id]) {
    data.users[id] = {
      points: 0,
      weeklyPoints: 0,
      weekId: getWeekId(),
      name: userName,
      triggerDate: getTodayDate(),
      triggersUsed: [],
    };
  }

  const user = data.users[id];
  user.name = userName;
  resetTriggersIfNewDay(user);
  resetWeeklyIfNewWeek(user);

  if (user.triggersUsed.includes(trigger)) {
    return { awarded: false, points: user.points, pointsToAdd };
  }

  user.points += pointsToAdd;
  user.weeklyPoints += pointsToAdd;
  user.triggersUsed.push(trigger);
  savePoints(data);
  return { awarded: true, points: user.points, pointsToAdd };
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
  detectTrigger,
  getTriggersClaimedToday,
  getUserRecord,
  getEffectiveWeeklyPoints,
  awardTriggerPoints,
  resetWeeklyForAll,
};
