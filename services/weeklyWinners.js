/**
 * Weekly Top 3 winners — persistent snapshot of the last fully closed week.
 *
 * Week key = Monday 00:00 UTC date (YYYY-MM-DD), same as getWeekId() in points.js.
 *
 * Rolling `current.standings` is updated from live points and before lazy
 * weekly resets so Top 3 is not lost when weekId rolls / awards wipe scores.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { log, error: logError } = require("../utils/logger");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const {
  getWeekId,
  loadPoints,
  readPointsSnapshot,
} = require("./points");
const { sanitizePvpDisplayName } = require("./pvpSessionManager");

function resolveDefaultWinnersFile() {
  return path.resolve(__dirname, "..", "data", "weekly-winners.json");
}

const DEFAULT_WINNERS_FILE = resolveDefaultWinnersFile();
const TOP_N = 3;

/** Test/prod override (also WEEKLY_WINNERS_FILE env). */
let winnersFileOverride = null;

/** Lazy temp file when tests would otherwise hit the production path. */
let autoTestWinnersFile = null;

function setWeeklyWinnersFileForTests(filePath) {
  winnersFileOverride = filePath || null;
}

/**
 * Detect `node tests/...` / `*.test.js` so award paths never touch production.
 * Production `node index.js` does not match.
 */
function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_WEEKLY_WINNERS === "1") {
    return true;
  }
  for (const arg of process.argv) {
    if (typeof arg !== "string") {
      continue;
    }
    const norm = arg.replace(/\\/g, "/");
    if (norm.includes("/tests/") || /\.test\.js$/i.test(norm)) {
      return true;
    }
  }
  return false;
}

function getAutoTestWinnersFile() {
  if (!autoTestWinnersFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-ww-isolate-"));
    autoTestWinnersFile = path.join(dir, "weekly-winners.json");
  }
  return autoTestWinnersFile;
}

function resolveWinnersFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (winnersFileOverride) {
    return winnersFileOverride;
  }
  const fromEnv =
    typeof process.env.WEEKLY_WINNERS_FILE === "string"
      ? process.env.WEEKLY_WINNERS_FILE.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  // Structural isolation: never let test processes write the repo production file.
  if (isLikelyTestProcess()) {
    return getAutoTestWinnersFile();
  }
  return DEFAULT_WINNERS_FILE;
}

const LOCK_OPTIONS = Object.freeze({
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

function acquireWinnersLock(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "{}\n", "utf8");
  }

  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;
  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(filePath, LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      if (!err || err.code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire weekly-winners lock: ${message}`);
      }
      sleepSync(timeoutMs);
      timeoutMs = Math.min(
        LOCK_RETRY.maxTimeoutMs,
        Math.ceil(timeoutMs * LOCK_RETRY.factor)
      );
    }
  }
  const message =
    lastError && lastError.message ? lastError.message : String(lastError);
  throw new Error(`Failed to acquire weekly-winners lock: ${message}`);
}

function emptyState() {
  return {
    version: 1,
    lastFinalizedWeek: null,
    latest: null,
    current: {
      week: null,
      standings: {},
      updatedAt: null,
    },
  };
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const state = {
    version: 1,
    lastFinalizedWeek:
      typeof raw.lastFinalizedWeek === "string" ? raw.lastFinalizedWeek : null,
    latest: null,
    current: {
      week: null,
      standings: {},
      updatedAt: null,
    },
  };

  if (raw.latest && typeof raw.latest === "object") {
    const winners = Array.isArray(raw.latest.winners)
      ? raw.latest.winners
          .filter((w) => w && typeof w === "object")
          .slice(0, TOP_N)
          .map((w) => ({
            telegramUserId: String(w.telegramUserId || ""),
            name: sanitizePvpDisplayName(w.name || "Player"),
            weeklyPoints:
              typeof w.weeklyPoints === "number" && w.weeklyPoints > 0
                ? w.weeklyPoints
                : 0,
          }))
          .filter((w) => w.telegramUserId && w.weeklyPoints > 0)
      : [];
    state.latest = {
      week: typeof raw.latest.week === "string" ? raw.latest.week : null,
      finalizedAt:
        typeof raw.latest.finalizedAt === "number" ? raw.latest.finalizedAt : null,
      announced: Boolean(raw.latest.announced),
      winners,
    };
  }

  if (raw.current && typeof raw.current === "object") {
    state.current.week =
      typeof raw.current.week === "string" ? raw.current.week : null;
    state.current.updatedAt =
      typeof raw.current.updatedAt === "number" ? raw.current.updatedAt : null;
    const standings =
      raw.current.standings && typeof raw.current.standings === "object"
        ? raw.current.standings
        : {};
    for (const [uid, entry] of Object.entries(standings)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (isCommunityCompetitionExcluded(uid)) {
        continue;
      }
      const pts =
        typeof entry.weeklyPoints === "number" ? entry.weeklyPoints : 0;
      if (pts <= 0) {
        continue;
      }
      state.current.standings[String(uid)] = {
        name: sanitizePvpDisplayName(entry.name || "Player"),
        weeklyPoints: pts,
      };
    }
  }

  return state;
}

function readWinnersState(filePath = DEFAULT_WINNERS_FILE) {
  try {
    if (!fs.existsSync(filePath)) {
      return emptyState();
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return emptyState();
    }
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    logError(
      "[weekly-winners] read failed:",
      err && err.message ? err.message : err
    );
    return emptyState();
  }
}

function writeWinnersState(state, filePath = DEFAULT_WINNERS_FILE) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeJsonFileAtomic(filePath, state);
}

/**
 * Previous Monday UTC week id (YYYY-MM-DD).
 * @param {string} [weekId]
 * @returns {string}
 */
function getPreviousWeekId(weekId = getWeekId()) {
  const d = new Date(`${weekId}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date();
    fallback.setUTCDate(fallback.getUTCDate() - 7);
    return getWeekId(fallback);
  }
  d.setUTCDate(d.getUTCDate() - 7);
  return getWeekId(d);
}

/**
 * ISO week number for display (Monday-based week id).
 * @param {string} weekMondayIso
 * @returns {number|null}
 */
function getIsoWeekNumber(weekMondayIso) {
  const monday = new Date(`${weekMondayIso}T00:00:00.000Z`);
  if (Number.isNaN(monday.getTime())) {
    return null;
  }
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const diffMs = thursday.getTime() - yearStart.getTime();
  const dayOfYear = Math.floor(diffMs / 86400000) + 1;
  return Math.floor((dayOfYear - 1) / 7) + 1;
}

/**
 * Rank standings map → Top N. Owner already excluded when recording.
 * Sort matches /weekly getWeeklyTop: weeklyPoints desc only (stable for ties).
 * @param {Record<string, {name:string, weeklyPoints:number}>} standings
 * @param {number} [limit]
 */
function rankWeeklyStandings(standings, limit = TOP_N) {
  return Object.entries(standings || {})
    .filter(([uid, entry]) => {
      if (isCommunityCompetitionExcluded(uid)) {
        return false;
      }
      return (
        entry && typeof entry.weeklyPoints === "number" && entry.weeklyPoints > 0
      );
    })
    .map(([telegramUserId, entry]) => ({
      telegramUserId: String(telegramUserId),
      name: sanitizePvpDisplayName(entry.name || "Player"),
      weeklyPoints: entry.weeklyPoints,
    }))
    .sort((a, b) => b.weeklyPoints - a.weeklyPoints)
    .slice(0, limit);
}

function formatWeeklyWinnersMessage(latest) {
  if (!latest || !Array.isArray(latest.winners) || latest.winners.length === 0) {
    return `🏆 ManGo Weekly Winners

No qualifying players in the previous week.`;
  }

  const weekNum = latest.week ? getIsoWeekNumber(latest.week) : null;
  const weekLine =
    weekNum != null
      ? `Week ${weekNum}`
      : latest.week
        ? `Week ${latest.week}`
        : "Previous week";
  const medals = ["🥇", "🥈", "🥉"];
  const lines = latest.winners.slice(0, TOP_N).map((w, i) => {
    const prefix = medals[i] || `${i + 1}.`;
    const name = sanitizePvpDisplayName(w.name || "Player");
    return `${prefix} ${name} — ${w.weeklyPoints} XP`;
  });

  return `🏆 ManGo Weekly Winners

${weekLine}

${lines.join("\n")}

A new weekly race is underway. 🥭`;
}

function upsertStanding(standings, userId, name, weeklyPoints) {
  const uid = String(userId);
  if (isCommunityCompetitionExcluded(uid)) {
    return;
  }
  const pts = typeof weeklyPoints === "number" ? weeklyPoints : 0;
  if (pts <= 0) {
    delete standings[uid];
    return;
  }
  standings[uid] = {
    name: sanitizePvpDisplayName(name || "Player"),
    weeklyPoints: pts,
  };
}

/**
 * Record a user's weekly score into the rolling current snapshot.
 * Safe no-op on excluded users / IO errors (must never break XP awards).
 */
function noteWeeklyStanding(
  userId,
  name,
  weekId,
  weeklyPoints,
  winnersFile
) {
  if (userId == null || !weekId) {
    return;
  }
  if (isCommunityCompetitionExcluded(userId)) {
    return;
  }

  const filePath = resolveWinnersFile(winnersFile);
  let release;
  try {
    release = acquireWinnersLock(filePath);
    const state = readWinnersState(filePath);
    const nowMs = Date.now();

    if (!state.current.week) {
      state.current.week = weekId;
      state.current.standings = {};
    }

    if (state.current.week === weekId) {
      upsertStanding(state.current.standings, userId, name, weeklyPoints);
      state.current.updatedAt = nowMs;
      writeWinnersState(state, filePath);
    }
  } catch (err) {
    logError(
      "[weekly-winners] noteWeeklyStanding failed:",
      err && err.message ? err.message : err
    );
  } finally {
    if (typeof release === "function") {
      try {
        release();
      } catch (_err) {
        /* ignore */
      }
    }
  }
}

function mergeStandingsFromPointsUsers(standings, users, weekId) {
  for (const [uid, user] of Object.entries(users || {})) {
    if (!user || typeof user !== "object") {
      continue;
    }
    if (isCommunityCompetitionExcluded(uid)) {
      continue;
    }
    if (user.weekId !== weekId) {
      continue;
    }
    const pts = typeof user.weeklyPoints === "number" ? user.weeklyPoints : 0;
    if (pts <= 0) {
      continue;
    }
    const existing = standings[uid];
    const existingPts =
      existing && typeof existing.weeklyPoints === "number"
        ? existing.weeklyPoints
        : 0;
    if (pts >= existingPts) {
      upsertStanding(standings, uid, user.name, pts);
    }
  }
}

function buildCurrentStandingsFromLive(users, weekId) {
  const standings = {};
  mergeStandingsFromPointsUsers(standings, users, weekId);
  return standings;
}

/**
 * Sync rolling standings from points.json and finalize closed weeks.
 * Idempotent. Returns announce payload when a new Top 3 needs posting.
 */
function syncAndFinalizeWeeklyWinners(options = {}) {
  const winnersFile = resolveWinnersFile(options.winnersFile);
  const pointsFile = options.pointsFile;
  const now =
    typeof options.now === "function" ? options.now() : options.now || new Date();
  const currentWeek = getWeekId(now);
  const emptyResult = {
    finalized: false,
    needAnnounce: false,
    week: null,
    text: null,
    winners: null,
  };

  let release;
  try {
    release = acquireWinnersLock(winnersFile);
    const state = readWinnersState(winnersFile);
    const points = pointsFile
      ? readPointsSnapshot(pointsFile)
      : loadPoints();
    const users = points.users || {};
    const nowMs =
      now instanceof Date ? now.getTime() : new Date(now).getTime();

    const previousWeek = getPreviousWeekId(currentWeek);

    if (!state.current.week) {
      // Prefer unfinalized previous-week scores still on disk (missed boundary).
      const prevLive = buildCurrentStandingsFromLive(users, previousWeek);
      if (
        state.lastFinalizedWeek !== previousWeek &&
        Object.keys(prevLive).length > 0
      ) {
        state.current.week = previousWeek;
        state.current.standings = prevLive;
      } else {
        state.current.week = currentWeek;
        state.current.standings = buildCurrentStandingsFromLive(
          users,
          currentWeek
        );
      }
      state.current.updatedAt = nowMs;
      writeWinnersState(state, winnersFile);
    }

    if (state.current.week === currentWeek) {
      mergeStandingsFromPointsUsers(
        state.current.standings,
        users,
        currentWeek
      );
      state.current.updatedAt = nowMs;

      // Offline recovery: previous week still on disk, never finalized.
      if (state.lastFinalizedWeek !== previousWeek) {
        const recovered = buildCurrentStandingsFromLive(users, previousWeek);
        if (Object.keys(recovered).length > 0) {
          const winners = rankWeeklyStandings(recovered, TOP_N);
          state.latest = {
            week: previousWeek,
            finalizedAt: nowMs,
            announced: false,
            winners,
          };
          state.lastFinalizedWeek = previousWeek;
          writeWinnersState(state, winnersFile);
          log(
            `[weekly-winners] recovered+finalized week=${previousWeek} winners=${winners.length}`
          );
          return {
            finalized: true,
            needAnnounce: true,
            week: previousWeek,
            text: formatWeeklyWinnersMessage(state.latest),
            winners,
          };
        }
      }

      writeWinnersState(state, winnersFile);

      const needAnnounce =
        state.latest &&
        state.latest.week &&
        state.latest.announced === false;
      if (needAnnounce) {
        return {
          finalized: false,
          needAnnounce: true,
          week: state.latest.week,
          text: formatWeeklyWinnersMessage(state.latest),
          winners: state.latest.winners,
        };
      }
      return emptyResult;
    }

    const closedWeek = state.current.week;
    mergeStandingsFromPointsUsers(state.current.standings, users, closedWeek);

    if (state.lastFinalizedWeek === closedWeek) {
      state.current.week = currentWeek;
      state.current.standings = buildCurrentStandingsFromLive(users, currentWeek);
      state.current.updatedAt = nowMs;
      writeWinnersState(state, winnersFile);

      const needAnnounce =
        state.latest &&
        state.latest.week === closedWeek &&
        state.latest.announced === false;
      if (needAnnounce) {
        return {
          finalized: false,
          needAnnounce: true,
          week: closedWeek,
          text: formatWeeklyWinnersMessage(state.latest),
          winners: state.latest.winners,
        };
      }
      return emptyResult;
    }

    const winners = rankWeeklyStandings(state.current.standings, TOP_N);
    state.latest = {
      week: closedWeek,
      finalizedAt: nowMs,
      announced: false,
      winners,
    };
    state.lastFinalizedWeek = closedWeek;
    state.current.week = currentWeek;
    state.current.standings = buildCurrentStandingsFromLive(users, currentWeek);
    state.current.updatedAt = nowMs;
    writeWinnersState(state, winnersFile);

    log(
      `[weekly-winners] finalized week=${closedWeek} winners=${winners.length}`
    );

    return {
      finalized: true,
      needAnnounce: true,
      week: closedWeek,
      text: formatWeeklyWinnersMessage(state.latest),
      winners,
    };
  } catch (err) {
    logError(
      "[weekly-winners] syncAndFinalize failed:",
      err && err.message ? err.message : err
    );
    return emptyResult;
  } finally {
    if (typeof release === "function") {
      try {
        release();
      } catch (_err) {
        /* ignore */
      }
    }
  }
}

function markWeeklyWinnersAnnounced(weekId, winnersFile) {
  if (!weekId) {
    return false;
  }
  const filePath = resolveWinnersFile(winnersFile);
  let release;
  try {
    release = acquireWinnersLock(filePath);
    const state = readWinnersState(filePath);
    if (!state.latest || state.latest.week !== weekId) {
      return false;
    }
    if (state.latest.announced) {
      return true;
    }
    state.latest.announced = true;
    writeWinnersState(state, filePath);
    return true;
  } catch (err) {
    logError(
      "[weekly-winners] markAnnounced failed:",
      err && err.message ? err.message : err
    );
    return false;
  } finally {
    if (typeof release === "function") {
      try {
        release();
      } catch (_err) {
        /* ignore */
      }
    }
  }
}

/**
 * Finalize if needed, announce once to community chat.
 */
async function processWeeklyWinnersBoundary(options = {}) {
  const result = syncAndFinalizeWeeklyWinners(options);
  if (!result.needAnnounce || !result.text || !result.week) {
    return { ...result, posted: false };
  }

  const chatId =
    options.chatId != null
      ? options.chatId
      : process.env.TELEGRAM_CHAT_ID
        ? String(process.env.TELEGRAM_CHAT_ID).trim()
        : null;

  const sendFn =
    typeof options.sendMessageFn === "function"
      ? options.sendMessageFn
      : options.telegram && typeof options.telegram.sendMessage === "function"
        ? (c, t) =>
            options.telegram.sendMessage(c, t, {
              disable_web_page_preview: true,
            })
        : null;

  if (!chatId || typeof sendFn !== "function") {
    return { ...result, posted: false, reason: "missing-chat-or-sender" };
  }

  try {
    await Promise.resolve(sendFn(chatId, result.text));
    markWeeklyWinnersAnnounced(result.week, options.winnersFile);
    log(`[weekly-winners] announced week=${result.week}`);
    return { ...result, posted: true };
  } catch (err) {
    logError(
      "[weekly-winners] announce failed:",
      err && err.message ? err.message : err
    );
    return { ...result, posted: false, reason: "send-failed" };
  }
}

function getLatestWeeklyWinners(winnersFile) {
  const state = readWinnersState(resolveWinnersFile(winnersFile));
  return state.latest;
}

/**
 * One-shot maintenance: rebuild current.standings from points.json for the
 * current UTC week only. Preserves latest / lastFinalizedWeek / announced.
 * Does NOT auto-run on bot startup.
 *
 * Semantics match /weekly: user.weekId must equal getWeekId(); owner excluded.
 *
 * @param {object} [options]
 * @param {string} [options.winnersFile]
 * @param {string} [options.pointsFile]
 * @param {Date|Function|number} [options.now]
 * @returns {{ ok: boolean, week: string|null, standingCount: number, preservedLatest: boolean, reason?: string }}
 */
function reconstructCurrentStandingsFromPoints(options = {}) {
  const winnersFile = resolveWinnersFile(options.winnersFile);
  const pointsFile = options.pointsFile;
  const now =
    typeof options.now === "function" ? options.now() : options.now || new Date();
  const currentWeek = getWeekId(now);

  let release;
  try {
    release = acquireWinnersLock(winnersFile);
    const state = readWinnersState(winnersFile);
    const beforeLatest = state.latest
      ? JSON.stringify(state.latest)
      : null;
    const beforeFinalized = state.lastFinalizedWeek;

    const points = pointsFile
      ? readPointsSnapshot(pointsFile)
      : loadPoints();
    const standings = buildCurrentStandingsFromLive(
      points.users || {},
      currentWeek
    );

    state.current = {
      week: currentWeek,
      standings,
      updatedAt:
        now instanceof Date ? now.getTime() : new Date(now).getTime(),
    };
    writeWinnersState(state, winnersFile);

    const afterLatest = state.latest ? JSON.stringify(state.latest) : null;
    return {
      ok: true,
      week: currentWeek,
      standingCount: Object.keys(standings).length,
      preservedLatest: beforeLatest === afterLatest,
      preservedFinalized: beforeFinalized === state.lastFinalizedWeek,
    };
  } catch (err) {
    logError(
      "[weekly-winners] reconstructCurrentStandings failed:",
      err && err.message ? err.message : err
    );
    return {
      ok: false,
      week: null,
      standingCount: 0,
      preservedLatest: false,
      reason: err && err.message ? err.message : String(err),
    };
  } finally {
    if (typeof release === "function") {
      try {
        release();
      } catch (_err) {
        /* ignore */
      }
    }
  }
}

module.exports = {
  TOP_N,
  DEFAULT_WINNERS_FILE,
  resolveDefaultWinnersFile,
  setWeeklyWinnersFileForTests,
  resolveWinnersFile,
  isLikelyTestProcess,
  emptyState,
  normalizeState,
  readWinnersState,
  writeWinnersState,
  getPreviousWeekId,
  getIsoWeekNumber,
  rankWeeklyStandings,
  formatWeeklyWinnersMessage,
  noteWeeklyStanding,
  syncAndFinalizeWeeklyWinners,
  markWeeklyWinnersAnnounced,
  processWeeklyWinnersBoundary,
  getLatestWeeklyWinners,
  reconstructCurrentStandingsFromPoints,
};
