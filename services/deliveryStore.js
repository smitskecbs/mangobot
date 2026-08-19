/**
 * Delivery session store. Tokens hashed at rest. No private keys.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");

const DEFAULT_DELIVERY_FILE = path.resolve(__dirname, "..", "data", "reward-delivery.json");

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

let deliveryFileOverride = null;
let autoTestDeliveryFile = null;

function setDeliveryFileForTests(filePath) {
  deliveryFileOverride = filePath || null;
}

function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_DELIVERY === "1") {
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

function getAutoTestDeliveryFile() {
  if (!autoTestDeliveryFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-delivery-"));
    autoTestDeliveryFile = path.join(dir, "reward-delivery.json");
  }
  return autoTestDeliveryFile;
}

function resolveDeliveryFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (deliveryFileOverride) {
    return deliveryFileOverride;
  }
  const fromEnv =
    typeof process.env.REWARD_DELIVERY_FILE === "string"
      ? process.env.REWARD_DELIVERY_FILE.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  if (isLikelyTestProcess()) {
    return getAutoTestDeliveryFile();
  }
  return DEFAULT_DELIVERY_FILE;
}

function sleepSync(ms) {
  const delay = Math.max(0, Math.ceil(ms));
  if (delay === 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function emptyStore() {
  return { sessions: {}, usedSignatures: {} };
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return store;
  }
  if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
    store.sessions = raw.sessions;
  }
  if (
    raw.usedSignatures &&
    typeof raw.usedSignatures === "object" &&
    !Array.isArray(raw.usedSignatures)
  ) {
    store.usedSignatures = raw.usedSignatures;
  }
  return store;
}

function readDeliverySnapshot(deliveryFile, options = {}) {
  try {
    if (!fs.existsSync(deliveryFile)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(deliveryFile, "utf8").trim();
    if (!raw) {
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (options.strict && err && err.code !== "ENOENT") {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read reward-delivery.json: ${message}`);
    }
    logError("Error reading reward-delivery.json:", err);
    return emptyStore();
  }
}

function acquireDeliveryLock(deliveryFile) {
  const dir = path.dirname(deliveryFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(deliveryFile)) {
    writeJsonFileAtomic(deliveryFile, emptyStore());
  }

  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;
  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(deliveryFile, LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire reward-delivery.json lock: ${message}`);
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
  throw new Error(`Failed to acquire reward-delivery.json lock: ${message}`);
}

function mutateDeliveryStore(mutator, deliveryFile) {
  if (typeof mutator !== "function") {
    throw new TypeError("mutateDeliveryStore requires a mutator function");
  }
  const filePath = resolveDeliveryFile(deliveryFile);
  const release = acquireDeliveryLock(filePath);
  try {
    const data = readDeliverySnapshot(filePath, { strict: true });
    const result = mutator(data);
    try {
      writeJsonFileAtomic(filePath, data);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to write reward-delivery.json: ${message}`);
    }
    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release reward-delivery.json lock:", err);
    }
  }
}

function loadDeliveryStore(deliveryFile) {
  return readDeliverySnapshot(resolveDeliveryFile(deliveryFile));
}

function pruneExpiredDeliverySessions(store, now) {
  const ts = Number.isFinite(now) ? now : Date.now();
  for (const [hash, record] of Object.entries(store.sessions || {})) {
    if (!record || typeof record !== "object") {
      delete store.sessions[hash];
      continue;
    }
    if (record.status === "consumed" || record.status === "submitted") {
      continue;
    }
    if (record.txSignature) {
      continue;
    }
    if (typeof record.expiresAt !== "number" || record.expiresAt <= ts) {
      delete store.sessions[hash];
    }
  }
}

module.exports = {
  DEFAULT_DELIVERY_FILE,
  setDeliveryFileForTests,
  resolveDeliveryFile,
  loadDeliveryStore,
  mutateDeliveryStore,
  pruneExpiredDeliverySessions,
  emptyStore,
};
