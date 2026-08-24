/**
 * Combined ManGo Shop persistence: Loot + title ownership + purchases.
 * Fresh disk read under exclusive lock, atomic write, fail-closed corrupt JSON.
 * Tests use temp files; runtime file is gitignored.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");

const DEFAULT_SHOP_FILE = path.resolve(__dirname, "..", "data", "mango-shop.json");
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

let shopFileOverride = null;
let autoTestShopFile = null;

function setMangoShopFileForTests(filePath) {
  shopFileOverride = filePath || null;
}

function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_MANGO_SHOP === "1") {
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

function getAutoTestShopFile() {
  if (!autoTestShopFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-shop-"));
    autoTestShopFile = path.join(dir, "mango-shop.json");
  }
  return autoTestShopFile;
}

function resolveShopFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (shopFileOverride) {
    return shopFileOverride;
  }
  if (isLikelyTestProcess()) {
    return getAutoTestShopFile();
  }
  return DEFAULT_SHOP_FILE;
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
    users: {},
    transactions: {},
    purchases: {},
    referenceIndex: {},
  };
}

function asObjectMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeLoot(raw) {
  const balance = Number.isInteger(raw && raw.balance) ? raw.balance : 0;
  const lifetimeEarned = Number.isInteger(raw && raw.lifetimeEarned)
    ? raw.lifetimeEarned
    : 0;
  const lifetimeSpent = Number.isInteger(raw && raw.lifetimeSpent)
    ? raw.lifetimeSpent
    : 0;
  return {
    balance: Math.max(0, balance),
    lifetimeEarned: Math.max(0, lifetimeEarned),
    lifetimeSpent: Math.max(0, lifetimeSpent),
    updatedAt:
      typeof (raw && raw.updatedAt) === "number" && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : 0,
  };
}

function normalizeOwnedTitles(raw) {
  const owned = {};
  for (const [titleId, row] of Object.entries(asObjectMap(raw))) {
    if (!titleId || !row || typeof row !== "object") {
      continue;
    }
    owned[String(titleId)] = {
      purchasedAt:
        typeof row.purchasedAt === "number" && Number.isFinite(row.purchasedAt)
          ? row.purchasedAt
          : 0,
      purchaseId: typeof row.purchaseId === "string" ? row.purchaseId : null,
    };
  }
  return owned;
}

function normalizeUser(raw) {
  const ownedTitles = normalizeOwnedTitles(raw && raw.ownedTitles);
  let activeTitle =
    typeof (raw && raw.activeTitle) === "string" && raw.activeTitle
      ? raw.activeTitle
      : null;
  if (activeTitle && !ownedTitles[activeTitle]) {
    activeTitle = null;
  }
  return {
    loot: normalizeLoot(raw && raw.loot),
    ownedTitles,
    activeTitle,
  };
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid-shape");
  }
  const store = emptyStore();
  if (raw.version != null && raw.version !== STORE_VERSION) {
    store.version = STORE_VERSION;
  }
  for (const [userId, row] of Object.entries(asObjectMap(raw.users))) {
    store.users[String(userId)] = normalizeUser(row);
  }
  store.transactions = asObjectMap(raw.transactions);
  store.purchases = asObjectMap(raw.purchases);
  store.referenceIndex = asObjectMap(raw.referenceIndex);
  return store;
}

function readShopSnapshot(shopFile, options = {}) {
  const filePath = resolveShopFile(shopFile);
  try {
    if (!fs.existsSync(filePath)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      if (options.strict) {
        throw new Error("empty");
      }
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return emptyStore();
    }
    logError("Error reading mango-shop.json:", err);
    if (options.strict) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read mango-shop.json: ${message}`);
    }
    throw new Error(
      `Failed to read mango-shop.json: ${err && err.message ? err.message : String(err)}`
    );
  }
}

function ensureShopFileExists(shopFile) {
  const filePath = resolveShopFile(shopFile);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(emptyStore(), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return;
    }
    const message = err && err.message ? err.message : String(err);
    throw new Error(`Failed to initialize mango-shop.json: ${message}`);
  }
}

function acquireShopLock(shopFile) {
  const filePath = resolveShopFile(shopFile);
  ensureShopFileExists(filePath);

  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;
  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(filePath, LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire mango-shop.json lock: ${message}`);
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
  throw new Error(`Failed to acquire mango-shop.json lock: ${message}`);
}

function withShopStore(mutator, shopFile, options = {}) {
  if (typeof mutator !== "function") {
    throw new TypeError("withShopStore requires a mutator function");
  }
  const persist = options.persist !== false;
  const filePath = resolveShopFile(shopFile);
  const release = acquireShopLock(filePath);
  try {
    const data = readShopSnapshot(filePath, { strict: true });
    const before = persist ? JSON.stringify(data) : null;
    const result = mutator(data);
    if (persist) {
      const after = JSON.stringify(data);
      if (after !== before) {
        try {
          writeJsonFileAtomic(filePath, data);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          throw new Error(`Failed to write mango-shop.json: ${message}`);
        }
      }
    }
    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release mango-shop.json lock:", err);
    }
  }
}

function mutateShopStore(mutator, shopFile) {
  return withShopStore(mutator, shopFile, { persist: true });
}

function loadShopStore(shopFile) {
  return withShopStore(
    (store) => JSON.parse(JSON.stringify(store)),
    shopFile,
    { persist: false }
  );
}

function ensureUser(store, userId) {
  const id = String(userId);
  if (!store.users[id]) {
    store.users[id] = normalizeUser(null);
  }
  return store.users[id];
}

module.exports = {
  STORE_VERSION,
  DEFAULT_SHOP_FILE,
  emptyStore,
  resolveShopFile,
  setMangoShopFileForTests,
  readShopSnapshot,
  loadShopStore,
  withShopStore,
  mutateShopStore,
  ensureUser,
  normalizeUser,
};
