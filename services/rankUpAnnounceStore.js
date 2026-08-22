/**
 * Exact-once rank-up announcement claims.
 * Separate from points.json so XP/rank persistence is never rolled back.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");

const DEFAULT_FILE = path.resolve(
  __dirname,
  "..",
  "data",
  "rank-up-announcements.json"
);
const STORE_VERSION = 1;
const CLAIM_TTL_MS = 15 * 60 * 1000;

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

let fileOverride = null;
let autoTestFile = null;

function setRankUpAnnounceFileForTests(filePath) {
  fileOverride = filePath || null;
}

function isLikelyTestProcess() {
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

function getAutoTestFile() {
  if (!autoTestFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-rank-up-"));
    autoTestFile = path.join(dir, "rank-up-announcements.json");
  }
  return autoTestFile;
}

function resolveRankUpFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (fileOverride) {
    return fileOverride;
  }
  if (isLikelyTestProcess()) {
    return getAutoTestFile();
  }
  return DEFAULT_FILE;
}

function sleepSync(ms) {
  const delay = Math.max(0, Math.ceil(ms));
  if (delay === 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    announcements: {},
  };
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return store;
  }
  if (raw.announcements && typeof raw.announcements === "object" && !Array.isArray(raw.announcements)) {
    store.announcements = raw.announcements;
  }
  return store;
}

function readSnapshot(filePath, options = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      if (options.strict) {
        throw new Error("rank-up-announcements.json is empty");
      }
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (options.strict && err && err.code !== "ENOENT") {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read rank-up-announcements.json: ${message}`);
    }
    logError("Error reading rank-up-announcements.json:", err);
    return emptyStore();
  }
}

function acquireLock(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    writeJsonFileAtomic(filePath, emptyStore());
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
        throw new Error(`Failed to acquire rank-up-announcements.json lock: ${message}`);
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
  throw new Error(`Failed to acquire rank-up-announcements.json lock: ${message}`);
}

function mutateRankUpStore(mutator, explicitFile) {
  if (typeof mutator !== "function") {
    throw new TypeError("mutateRankUpStore requires a mutator function");
  }
  const filePath = resolveRankUpFile(explicitFile);
  const release = acquireLock(filePath);
  try {
    const data = readSnapshot(filePath, { strict: true });
    const result = mutator(data);
    writeJsonFileAtomic(filePath, data);
    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release rank-up-announcements.json lock:", err);
    }
  }
}

function loadRankUpStore(explicitFile) {
  return readSnapshot(resolveRankUpFile(explicitFile));
}

function rankUpEventId(userId, rankTitle) {
  return `rank:${String(userId)}:${String(rankTitle)}`;
}

function claimRankUpAnnouncement(userId, rankTitle, options = {}) {
  const eventId = rankUpEventId(userId, rankTitle);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return mutateRankUpStore((store) => {
    const current = store.announcements[eventId];
    if (current && (current.state === "sent" || Number(current.announcedAt) > 0)) {
      return { ok: false, reason: "already-announced", eventId, announced: true };
    }
    const claimedAt = current && Number(current.claimedAt) ? Number(current.claimedAt) : 0;
    if (
      current &&
      current.state === "sending" &&
      claimedAt > 0 &&
      now - claimedAt < CLAIM_TTL_MS
    ) {
      return { ok: false, reason: "in-flight", eventId };
    }
    store.announcements[eventId] = {
      state: "sending",
      claimedAt: now,
      announcedAt: null,
    };
    return { ok: true, eventId };
  }, options.storeFile);
}

function finishRankUpAnnouncement(userId, rankTitle, success, options = {}) {
  const eventId = rankUpEventId(userId, rankTitle);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return mutateRankUpStore((store) => {
    const current = store.announcements[eventId] || {};
    if (success) {
      store.announcements[eventId] = {
        state: "sent",
        claimedAt: null,
        announcedAt: now,
      };
      return { ok: true, eventId, announced: true };
    }
    store.announcements[eventId] = {
      state: "pending",
      claimedAt: null,
      announcedAt: current.announcedAt || null,
    };
    return { ok: true, eventId, announced: false };
  }, options.storeFile);
}

module.exports = {
  STORE_VERSION,
  CLAIM_TTL_MS,
  DEFAULT_FILE,
  isLikelyTestProcess,
  setRankUpAnnounceFileForTests,
  resolveRankUpFile,
  loadRankUpStore,
  mutateRankUpStore,
  rankUpEventId,
  claimRankUpAnnouncement,
  finishRankUpAnnouncement,
};
