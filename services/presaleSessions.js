/**
 * Purpose-bound presale sessions. Not wallet-verification tokens.
 * crypto.randomBytes(32) → base64url, SHA-256 at rest, no uid in URL.
 */

const crypto = require("node:crypto");
const { getVerifiedWalletForUser, normalizeUserId } = require("./walletLinks");
const { mutatePresaleStore, loadPresaleStore } = require("./presaleStore");
const {
  SESSION_TTL_MS,
  TOKEN_BYTES,
  PURPOSE_PRESALE,
  DEFAULT_PRESALE_URL,
} = require("./presaleConstants");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function getPresaleBaseUrl(options = {}) {
  if (typeof options.presaleUrl === "string" && options.presaleUrl.trim()) {
    return options.presaleUrl.trim().replace(/\/+$/, "");
  }
  const fromEnv =
    typeof process.env.MANGO_PRESALE_URL === "string"
      ? process.env.MANGO_PRESALE_URL.trim()
      : "";
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }
  return DEFAULT_PRESALE_URL;
}

function pruneExpiredSessions(store, now, blockHeight, options = {}) {
  const ts = Number.isFinite(now) ? now : Date.now();
  const excludeIds = new Set(
    Array.isArray(options.excludeOrderIds) ? options.excludeOrderIds.map(String) : []
  );
  for (const [hash, record] of Object.entries(store.sessions || {})) {
    if (!record || typeof record !== "object") {
      delete store.sessions[hash];
      continue;
    }
    if (typeof record.expiresAt !== "number" || record.expiresAt <= ts) {
      delete store.sessions[hash];
    }
  }
  for (const [id, order] of Object.entries(store.orders || {})) {
    if (!order || typeof order !== "object") {
      delete store.orders[id];
      continue;
    }
    if (excludeIds.has(String(id)) || excludeIds.has(String(order.id))) {
      continue;
    }
    if (
      (order.status === "reserved" || order.status === "prepared") &&
      (typeof order.expiresAt !== "number" || order.expiresAt <= ts)
    ) {
      order.status = "expired";
    }
  }
}

function invalidateUnusedSessionsForUser(store, uid) {
  for (const [hash, record] of Object.entries(store.sessions || {})) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (String(record.telegramUserId) === uid) {
      delete store.sessions[hash];
    }
  }
}

function createPresaleSession(telegramUserId, options = {}) {
  const uid = normalizeUserId(telegramUserId);
  if (!uid) {
    return { ok: false, reason: "invalid-user", error: "Invalid request." };
  }
  const verified = getVerifiedWalletForUser(uid, options.walletFile);
  if (!verified || !verified.wallet) {
    return { ok: false, reason: "unverified", error: "Wallet verification required." };
  }

  const now = options.now === undefined ? Date.now() : options.now;
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = now + SESSION_TTL_MS;
  const baseUrl = getPresaleBaseUrl(options);
  const url = `${baseUrl}/${encodeURIComponent(rawToken)}`;

  mutatePresaleStore((store) => {
    pruneExpiredSessions(store, now);
    invalidateUnusedSessionsForUser(store, uid);
    store.sessions[tokenHash] = {
      purpose: PURPOSE_PRESALE,
      telegramUserId: uid,
      expectedWallet: verified.wallet,
      createdAt: now,
      expiresAt,
    };
  }, options.presaleFile);

  return {
    ok: true,
    token: rawToken,
    url,
    expiresAt,
    tokenHash,
    expectedWallet: verified.wallet,
  };
}

function lookupPresaleSession(rawToken, options = {}) {
  if (typeof rawToken !== "string" || !rawToken || rawToken.length > 128) {
    return { status: "invalid" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(rawToken)) {
    return { status: "invalid" };
  }
  const now = options.now === undefined ? Date.now() : options.now;
  const tokenHash = hashToken(rawToken);
  const store = loadPresaleStore(options.presaleFile);
  const record = store.sessions[tokenHash];
  if (!record || typeof record !== "object") {
    return { status: "invalid", tokenHash };
  }
  if (record.purpose !== PURPOSE_PRESALE) {
    return { status: "wrong-purpose", tokenHash };
  }
  if (typeof record.expiresAt !== "number" || record.expiresAt <= now) {
    return { status: "expired", tokenHash, record };
  }
  return { status: "ok", tokenHash, record };
}

module.exports = {
  hashToken,
  getPresaleBaseUrl,
  pruneExpiredSessions,
  createPresaleSession,
  lookupPresaleSession,
};
