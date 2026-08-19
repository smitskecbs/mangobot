/**
 * Persistent Telegram ↔ verified Solana wallet mappings.
 *
 * File: data/wallet-links.json
 * Shared by mangobot.service and mango-highscore.service.
 * All reads and writes use an exclusive cross-process lock + a fresh disk
 * snapshot. There is no process-local cached store.
 * Never stores private keys, seed phrases, signatures, or IP addresses.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");
const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");

function resolveDefaultWalletFile() {
  return path.resolve(__dirname, "..", "data", "wallet-links.json");
}

const DEFAULT_WALLET_FILE = resolveDefaultWalletFile();

let walletFileOverride = null;
let autoTestWalletFile = null;

function setWalletFileForTests(filePath) {
  walletFileOverride = filePath || null;
}

function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_WALLET_LINKS === "1") {
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

function getAutoTestWalletFile() {
  if (!autoTestWalletFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-isolate-"));
    autoTestWalletFile = path.join(dir, "wallet-links.json");
  }
  return autoTestWalletFile;
}

function resolveWalletFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (walletFileOverride) {
    return walletFileOverride;
  }
  const fromEnv =
    typeof process.env.WALLET_LINKS_FILE === "string"
      ? process.env.WALLET_LINKS_FILE.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  if (isLikelyTestProcess()) {
    return getAutoTestWalletFile();
  }
  return DEFAULT_WALLET_FILE;
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

const WALLET_INPUT_TTL_MS = 10 * 60 * 1000;
const REGISTRATION_MANUAL = "manual";
const REGISTRATION_SIGNATURE = "signature";

function emptyStore() {
  return {
    users: {},
    wallets: {},
    linkTokens: {},
    challenges: {},
    pendingWalletInputs: {},
  };
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return store;
  }
  if (raw.users && typeof raw.users === "object" && !Array.isArray(raw.users)) {
    store.users = raw.users;
  }
  if (raw.wallets && typeof raw.wallets === "object" && !Array.isArray(raw.wallets)) {
    store.wallets = raw.wallets;
  }
  if (
    raw.linkTokens &&
    typeof raw.linkTokens === "object" &&
    !Array.isArray(raw.linkTokens)
  ) {
    store.linkTokens = raw.linkTokens;
  }
  if (
    raw.challenges &&
    typeof raw.challenges === "object" &&
    !Array.isArray(raw.challenges)
  ) {
    store.challenges = raw.challenges;
  }
  if (
    raw.pendingWalletInputs &&
    typeof raw.pendingWalletInputs === "object" &&
    !Array.isArray(raw.pendingWalletInputs)
  ) {
    store.pendingWalletInputs = raw.pendingWalletInputs;
  }
  return store;
}

function readWalletSnapshot(walletFile, options = {}) {
  try {
    const raw = fs.readFileSync(walletFile, "utf8").trim();
    if (!raw) {
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return emptyStore();
    }
    logError("Error reading wallet-links.json:", err);
    if (options.strict) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read wallet-links.json: ${message}`);
    }
    return emptyStore();
  }
}

function ensureWalletFileExists(walletFile) {
  const dir = path.dirname(walletFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(walletFile, `${JSON.stringify(emptyStore(), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return;
    }
    const message = err && err.message ? err.message : String(err);
    throw new Error(`Failed to initialize wallet-links.json: ${message}`);
  }
}

function acquireWalletLock(walletFile) {
  ensureWalletFileExists(walletFile);

  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;

  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(walletFile, LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire wallet-links.json lock: ${message}`);
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
  throw new Error(`Failed to acquire wallet-links.json lock: ${message}`);
}

/**
 * Exclusive cross-process access.
 * Always lock → fresh disk read → mutator → atomic write if persist and changed → unlock.
 * There is no process-local store cache.
 *
 * @template T
 * @param {(data: ReturnType<typeof emptyStore>) => T} mutator
 * @param {string} [walletFile]
 * @param {{ persist?: boolean }} [options]
 * @returns {T}
 */
function withWalletStore(mutator, walletFile, options = {}) {
  if (typeof mutator !== "function") {
    throw new TypeError("withWalletStore requires a mutator function");
  }

  const persist = options.persist !== false;
  const filePath = resolveWalletFile(walletFile);
  const release = acquireWalletLock(filePath);

  try {
    const data = readWalletSnapshot(filePath, { strict: true });
    const before = persist ? JSON.stringify(data) : null;
    const result = mutator(data);

    if (persist) {
      const after = JSON.stringify(data);
      if (after !== before) {
        try {
          writeJsonFileAtomic(filePath, data);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          throw new Error(`Failed to write wallet-links.json: ${message}`);
        }
      }
    }

    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release wallet-links.json lock:", err);
    }
  }
}

/**
 * Exclusive cross-process mutation.
 * @template T
 * @param {(data: ReturnType<typeof emptyStore>) => T} mutator
 * @param {string} [walletFile]
 * @returns {T}
 */
function mutateWalletStore(mutator, walletFile) {
  return withWalletStore(mutator, walletFile, { persist: true });
}

function loadWalletStore(walletFile) {
  return withWalletStore(
    (store) => normalizeStore(JSON.parse(JSON.stringify(store))),
    walletFile,
    { persist: false }
  );
}

function normalizeUserId(userId) {
  if (userId === undefined || userId === null) {
    return "";
  }
  const uid = String(userId).trim();
  return uid;
}

function pruneExpired(store, now) {
  if (!store) {
    return;
  }
  const ts = Number.isFinite(now) ? now : Date.now();

  if (store.linkTokens) {
    for (const [hash, record] of Object.entries(store.linkTokens)) {
      if (!record || typeof record !== "object") {
        delete store.linkTokens[hash];
        continue;
      }
      if (typeof record.expiresAt !== "number" || record.expiresAt <= ts) {
        delete store.linkTokens[hash];
      }
    }
  }

  if (store.challenges) {
    for (const [id, record] of Object.entries(store.challenges)) {
      if (!record || typeof record !== "object") {
        delete store.challenges[id];
        continue;
      }
      if (typeof record.expiresAt !== "number" || record.expiresAt <= ts) {
        delete store.challenges[id];
      }
    }
  }

  if (store.pendingWalletInputs) {
    for (const [uid, record] of Object.entries(store.pendingWalletInputs)) {
      if (!record || typeof record !== "object") {
        delete store.pendingWalletInputs[uid];
        continue;
      }
      if (typeof record.expiresAt !== "number" || record.expiresAt <= ts) {
        delete store.pendingWalletInputs[uid];
      }
    }
  }
}

/**
 * @param {object} record
 * @returns {{ wallet: string, verified: boolean, verifiedAt: number, updatedAt: number, registeredAt: number, registrationMethod: string }|null}
 */
function publicWalletRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const wallet = normalizeSolanaPublicKey(record.wallet);
  if (!wallet) {
    return null;
  }
  const verifiedAt = Number(record.verifiedAt) || 0;
  const updatedAt = Number(record.updatedAt) || 0;
  const registeredAt = Number(record.registeredAt) || verifiedAt || updatedAt;
  const verified = verifiedAt > 0;
  const registrationMethod =
    record.registrationMethod === REGISTRATION_MANUAL
      ? REGISTRATION_MANUAL
      : verified
        ? REGISTRATION_SIGNATURE
        : REGISTRATION_MANUAL;
  return {
    wallet,
    verified,
    verifiedAt,
    updatedAt,
    registeredAt,
    registrationMethod,
  };
}

/**
 * Resolve a linked wallet from an already-loaded store. No extra disk lock.
 * Used by /walletlist so pagination does not re-lock wallet-links.json per member.
 * @param {ReturnType<typeof emptyStore>|null|undefined} store
 * @param {string|number} userId
 * @returns {{ wallet: string, verified: boolean, verifiedAt: number, updatedAt: number, registeredAt: number, registrationMethod: string }|null}
 */
function getLinkedWalletFromStore(store, userId) {
  const uid = normalizeUserId(userId);
  if (!uid || !store || !store.users) {
    return null;
  }
  return publicWalletRecord(store.users[uid]);
}

/** Any linked payout wallet (manual registered or signature verified). */
function getLinkedWalletForUser(userId, walletFile) {
  return getLinkedWalletFromStore(loadWalletStore(walletFile), userId);
}

/**
 * Cryptographically verified wallet only. Legacy records with verifiedAt stay verified.
 * Manual registrations (verifiedAt=0) are not returned.
 * @param {string|number} userId
 * @param {string} [walletFile]
 * @returns {{ wallet: string, verifiedAt: number, updatedAt: number }|null}
 */
function getVerifiedWalletForUser(userId, walletFile) {
  const linked = getLinkedWalletForUser(userId, walletFile);
  if (!linked || !linked.verified) {
    return null;
  }
  return {
    wallet: linked.wallet,
    verifiedAt: linked.verifiedAt,
    updatedAt: linked.updatedAt,
  };
}

function isWalletVerified(userId, walletFile) {
  return getVerifiedWalletForUser(userId, walletFile) !== null;
}

function isWalletRegistered(userId, walletFile) {
  return getLinkedWalletForUser(userId, walletFile) !== null;
}

function getWalletStoreCounts(walletFile) {
  const store = loadWalletStore(walletFile);
  return {
    users: Object.keys(store.users || {}).length,
    wallets: Object.keys(store.wallets || {}).length,
    linkTokens: Object.keys(store.linkTokens || {}).length,
    challenges: Object.keys(store.challenges || {}).length,
    pendingWalletInputs: Object.keys(store.pendingWalletInputs || {}).length,
  };
}

/**
 * Remove the mapping for this Telegram user. No-op if none.
 * @param {string|number} userId
 * @param {string} [walletFile]
 * @returns {{ ok: true, disconnected: boolean }}
 */
function disconnectWallet(userId, walletFile) {
  const uid = normalizeUserId(userId);
  if (!uid) {
    return { ok: true, disconnected: false };
  }

  return mutateWalletStore((store) => {
    pruneExpired(store, Date.now());
    const record = store.users[uid];
    if (!record || typeof record !== "object" || !record.wallet) {
      return { ok: true, disconnected: false };
    }
    const wallet = String(record.wallet);
    delete store.users[uid];
    if (store.wallets[wallet] === uid) {
      delete store.wallets[wallet];
    }
    return { ok: true, disconnected: true };
  }, walletFile);
}

/**
 * Atomic link / replace. Old wallet stays until this succeeds.
 * @param {string} uid
 * @param {string} wallet canonical base58
 * @param {number} now
 * @param {ReturnType<typeof emptyStore>} store
 * @returns {{ ok: true } | { ok: false, reason: "wallet-taken" }}
 */
function applyVerifiedWallet(store, uid, wallet, now) {
  const existingOwner = store.wallets[wallet];
  if (existingOwner && existingOwner !== uid) {
    return { ok: false, reason: "wallet-taken" };
  }

  const previous = store.users[uid];
  if (
    previous &&
    typeof previous === "object" &&
    previous.wallet &&
    previous.wallet !== wallet
  ) {
    if (store.wallets[previous.wallet] === uid) {
      delete store.wallets[previous.wallet];
    }
  }

  const verifiedAt =
    previous && previous.wallet === wallet && Number(previous.verifiedAt)
      ? previous.verifiedAt
      : now;
  const registeredAt =
    previous && Number(previous.registeredAt)
      ? previous.registeredAt
      : previous && Number(previous.verifiedAt)
        ? previous.verifiedAt
        : now;

  store.users[uid] = {
    wallet,
    verifiedAt,
    updatedAt: now,
    registeredAt,
    registrationMethod: REGISTRATION_SIGNATURE,
  };
  store.wallets[wallet] = uid;
  return { ok: true };
}

function replaceUserWalletBinding(store, uid, wallet) {
  const existingOwner = store.wallets[wallet];
  if (existingOwner && existingOwner !== uid) {
    return { ok: false, reason: "wallet-taken" };
  }
  const previous = store.users[uid];
  if (
    previous &&
    typeof previous === "object" &&
    previous.wallet &&
    previous.wallet !== wallet &&
    store.wallets[previous.wallet] === uid
  ) {
    delete store.wallets[previous.wallet];
  }
  return { ok: true, previous };
}

/**
 * Manual public-key registration. Never marks the wallet as cryptographically verified.
 * Changing to a different address clears verifiedAt.
 */
function applyRegisteredWallet(store, uid, wallet, now) {
  const bound = replaceUserWalletBinding(store, uid, wallet);
  if (!bound.ok) {
    return bound;
  }
  const previous = bound.previous;
  const sameWallet = Boolean(previous && previous.wallet === wallet);
  const keepVerified = sameWallet && Number(previous.verifiedAt) > 0;
  const registeredAt =
    previous && Number(previous.registeredAt)
      ? previous.registeredAt
      : now;

  store.users[uid] = {
    wallet,
    verifiedAt: keepVerified ? Number(previous.verifiedAt) : 0,
    updatedAt: now,
    registeredAt,
    registrationMethod: keepVerified ? REGISTRATION_SIGNATURE : REGISTRATION_MANUAL,
  };
  store.wallets[wallet] = uid;
  return { ok: true, verified: keepVerified };
}

function registerManualWallet(userId, wallet, walletFile, now = Date.now()) {
  const uid = normalizeUserId(userId);
  const canonical = normalizeSolanaPublicKey(wallet);
  if (!uid || !canonical) {
    return { ok: false, reason: "invalid" };
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  return mutateWalletStore((store) => {
    pruneExpired(store, ts);
    const applied = applyRegisteredWallet(store, uid, canonical, ts);
    if (!applied.ok) {
      return applied;
    }
    if (store.pendingWalletInputs) {
      delete store.pendingWalletInputs[uid];
    }
    return { ok: true, wallet: canonical, verified: Boolean(applied.verified) };
  }, walletFile);
}

function beginWalletAddressInput(userId, chatId, purpose, walletFile, now = Date.now()) {
  const uid = normalizeUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid" };
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  const intent = purpose === "change" ? "change" : "register";
  return mutateWalletStore((store) => {
    pruneExpired(store, ts);
    if (!store.pendingWalletInputs || typeof store.pendingWalletInputs !== "object") {
      store.pendingWalletInputs = {};
    }
    store.pendingWalletInputs[uid] = {
      chatId: chatId === undefined || chatId === null ? null : String(chatId),
      purpose: intent,
      createdAt: ts,
      expiresAt: ts + WALLET_INPUT_TTL_MS,
    };
    return { ok: true, expiresAt: ts + WALLET_INPUT_TTL_MS };
  }, walletFile);
}

function getPendingWalletInput(userId, walletFile, now = Date.now()) {
  const uid = normalizeUserId(userId);
  if (!uid) {
    return null;
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  const store = loadWalletStore(walletFile);
  const record = store.pendingWalletInputs && store.pendingWalletInputs[uid];
  if (!record || typeof record !== "object") {
    return null;
  }
  if (typeof record.expiresAt !== "number" || record.expiresAt <= ts) {
    return null;
  }
  return {
    chatId: record.chatId || null,
    purpose: record.purpose === "change" ? "change" : "register",
    createdAt: Number(record.createdAt) || 0,
    expiresAt: record.expiresAt,
  };
}

function clearPendingWalletInput(userId, walletFile, now = Date.now()) {
  const uid = normalizeUserId(userId);
  if (!uid) {
    return { ok: true, cleared: false };
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  return mutateWalletStore((store) => {
    pruneExpired(store, ts);
    if (!store.pendingWalletInputs || !store.pendingWalletInputs[uid]) {
      return { ok: true, cleared: false };
    }
    delete store.pendingWalletInputs[uid];
    return { ok: true, cleared: true };
  }, walletFile);
}

module.exports = {
  DEFAULT_WALLET_FILE,
  WALLET_INPUT_TTL_MS,
  REGISTRATION_MANUAL,
  REGISTRATION_SIGNATURE,
  emptyStore,
  resolveWalletFile,
  setWalletFileForTests,
  loadWalletStore,
  mutateWalletStore,
  withWalletStore,
  readWalletSnapshot,
  pruneExpired,
  getLinkedWalletForUser,
  getLinkedWalletFromStore,
  getVerifiedWalletForUser,
  isWalletVerified,
  isWalletRegistered,
  getWalletStoreCounts,
  disconnectWallet,
  applyVerifiedWallet,
  applyRegisteredWallet,
  registerManualWallet,
  beginWalletAddressInput,
  getPendingWalletInput,
  clearPendingWalletInput,
  normalizeUserId,
};
