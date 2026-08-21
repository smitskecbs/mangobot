/**
 * Community Builder persistent store.
 * Fresh disk read under exclusive lock, atomic write, fail-closed corrupt JSON.
 * Invite URLs are stored for reuse and never logged.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");

const DEFAULT_BUILDER_FILE = path.resolve(
  __dirname,
  "..",
  "data",
  "community-builders.json"
);
const STORE_VERSION = 1;

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

let builderFileOverride = null;
let autoTestBuilderFile = null;

function setCommunityBuilderFileForTests(filePath) {
  builderFileOverride = filePath || null;
}

function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_COMMUNITY_BUILDER === "1") {
    return true;
  }
  for (const arg of process.argv) {
    if (typeof arg !== "string") {
      continue;
    }
    const norm = arg.replace(/\\/g, "/");
    if (norm.includes("/tests/") || /\.test\.js$/i.test(arg)) {
      return true;
    }
  }
  return false;
}

function getAutoTestBuilderFile() {
  if (!autoTestBuilderFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-community-builder-"));
    autoTestBuilderFile = path.join(dir, "community-builders.json");
  }
  return autoTestBuilderFile;
}

function resolveBuilderFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (builderFileOverride) {
    return builderFileOverride;
  }
  const fromEnv =
    typeof process.env.COMMUNITY_BUILDER_FILE === "string"
      ? process.env.COMMUNITY_BUILDER_FILE.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  if (isLikelyTestProcess()) {
    return getAutoTestBuilderFile();
  }
  return DEFAULT_BUILDER_FILE;
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
    builders: {},
    referrals: {},
    inviteLinks: {},
  };
}

function asObjectMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return store;
  }
  store.builders = asObjectMap(raw.builders);
  store.referrals = asObjectMap(raw.referrals);
  store.inviteLinks = asObjectMap(raw.inviteLinks);
  return store;
}

function readBuilderSnapshot(builderFile, options = {}) {
  const filePath = resolveBuilderFile(builderFile);
  try {
    if (!fs.existsSync(filePath)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      if (options.strict) {
        throw new Error("community-builders.json is empty");
      }
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (options.strict && err && err.code !== "ENOENT") {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read community-builders.json: ${message}`);
    }
    logError("Error reading community-builders.json:", err);
    return emptyStore();
  }
}

function acquireBuilderLock(builderFile) {
  const dir = path.dirname(builderFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(builderFile)) {
    writeJsonFileAtomic(builderFile, emptyStore());
  }

  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;
  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(builderFile, LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire community-builders.json lock: ${message}`);
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
  throw new Error(`Failed to acquire community-builders.json lock: ${message}`);
}

function mutateBuilderStore(mutator, builderFile) {
  if (typeof mutator !== "function") {
    throw new TypeError("mutateBuilderStore requires a mutator function");
  }
  const filePath = resolveBuilderFile(builderFile);
  const release = acquireBuilderLock(filePath);
  try {
    const data = readBuilderSnapshot(filePath, { strict: true });
    const result = mutator(data);
    try {
      writeJsonFileAtomic(filePath, data);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to write community-builders.json: ${message}`);
    }
    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release community-builders.json lock:", err);
    }
  }
}

function loadBuilderStore(builderFile) {
  return readBuilderSnapshot(builderFile);
}

module.exports = {
  STORE_VERSION,
  DEFAULT_BUILDER_FILE,
  emptyStore,
  resolveBuilderFile,
  setCommunityBuilderFileForTests,
  loadBuilderStore,
  readBuilderSnapshot,
  mutateBuilderStore,
};
