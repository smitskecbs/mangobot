/**
 * Persistent presale ledger + sessions + orders.
 * Cross-process exclusive lock, fresh disk read, atomic write.
 * Tests isolate to temp files and never touch production data/.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");

function resolveDefaultPresaleFile() {
  return path.resolve(__dirname, "..", "data", "presale-participation.json");
}

const DEFAULT_PRESALE_FILE = resolveDefaultPresaleFile();

let presaleFileOverride = null;
let autoTestPresaleFile = null;

function setPresaleFileForTests(filePath) {
  presaleFileOverride = filePath || null;
}

function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_PRESALE === "1") {
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

function getAutoTestPresaleFile() {
  if (!autoTestPresaleFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-presale-isolate-"));
    autoTestPresaleFile = path.join(dir, "presale-participation.json");
  }
  return autoTestPresaleFile;
}

function resolvePresaleFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (presaleFileOverride) {
    return presaleFileOverride;
  }
  const fromEnv =
    typeof process.env.PRESALE_PARTICIPATION_FILE === "string"
      ? process.env.PRESALE_PARTICIPATION_FILE.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  if (isLikelyTestProcess()) {
    return getAutoTestPresaleFile();
  }
  return DEFAULT_PRESALE_FILE;
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

function emptyStore() {
  return {
    version: 1,
    totals: {
      confirmedLamports: "0",
      reservedLamports: "0",
      allocatedMangoBaseUnits: "0",
      reservedMangoBaseUnits: "0",
    },
    users: {},
    usedTransactions: {},
    sessions: {},
    orders: {},
  };
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return store;
  }
  if (raw.version === 1) {
    store.version = 1;
  }
  if (raw.totals && typeof raw.totals === "object") {
    if (typeof raw.totals.confirmedLamports === "string") {
      store.totals.confirmedLamports = raw.totals.confirmedLamports;
    }
    if (typeof raw.totals.reservedLamports === "string") {
      store.totals.reservedLamports = raw.totals.reservedLamports;
    }
    if (typeof raw.totals.allocatedMangoBaseUnits === "string") {
      store.totals.allocatedMangoBaseUnits = raw.totals.allocatedMangoBaseUnits;
    }
    if (typeof raw.totals.reservedMangoBaseUnits === "string") {
      store.totals.reservedMangoBaseUnits = raw.totals.reservedMangoBaseUnits;
    }
  }
  if (raw.users && typeof raw.users === "object" && !Array.isArray(raw.users)) {
    store.users = raw.users;
  }
  if (
    raw.usedTransactions &&
    typeof raw.usedTransactions === "object" &&
    !Array.isArray(raw.usedTransactions)
  ) {
    store.usedTransactions = raw.usedTransactions;
  }
  if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
    store.sessions = raw.sessions;
  }
  if (raw.orders && typeof raw.orders === "object" && !Array.isArray(raw.orders)) {
    store.orders = raw.orders;
  }
  return store;
}

function readPresaleSnapshot(presaleFile, options = {}) {
  try {
    const raw = fs.readFileSync(presaleFile, "utf8").trim();
    if (!raw) {
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return emptyStore();
    }
    logError("Error reading presale-participation.json:", err);
    if (options.strict) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read presale-participation.json: ${message}`);
    }
    return emptyStore();
  }
}

function ensurePresaleFileExists(presaleFile) {
  const dir = path.dirname(presaleFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(presaleFile, `${JSON.stringify(emptyStore(), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return;
    }
    const message = err && err.message ? err.message : String(err);
    throw new Error(`Failed to initialize presale-participation.json: ${message}`);
  }
}

function acquirePresaleLock(presaleFile) {
  ensurePresaleFileExists(presaleFile);

  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;

  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(presaleFile, LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire presale-participation.json lock: ${message}`);
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
  throw new Error(`Failed to acquire presale-participation.json lock: ${message}`);
}

function withPresaleStore(mutator, presaleFile, options = {}) {
  if (typeof mutator !== "function") {
    throw new TypeError("withPresaleStore requires a mutator function");
  }

  const persist = options.persist !== false;
  const filePath = resolvePresaleFile(presaleFile);
  const release = acquirePresaleLock(filePath);

  try {
    const data = readPresaleSnapshot(filePath, { strict: true });
    const before = persist ? JSON.stringify(data) : null;
    const result = mutator(data);

    if (persist) {
      const after = JSON.stringify(data);
      if (after !== before) {
        try {
          writeJsonFileAtomic(filePath, data);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          throw new Error(`Failed to write presale-participation.json: ${message}`);
        }
      }
    }

    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release presale-participation.json lock:", err);
    }
  }
}

function mutatePresaleStore(mutator, presaleFile) {
  return withPresaleStore(mutator, presaleFile, { persist: true });
}

function loadPresaleStore(presaleFile) {
  try {
    return withPresaleStore(
      (store) => normalizeStore(JSON.parse(JSON.stringify(store))),
      presaleFile,
      { persist: false }
    );
  } catch {
    return emptyStore();
  }
}

module.exports = {
  DEFAULT_PRESALE_FILE,
  emptyStore,
  normalizeStore,
  resolvePresaleFile,
  setPresaleFileForTests,
  loadPresaleStore,
  mutatePresaleStore,
  withPresaleStore,
};
