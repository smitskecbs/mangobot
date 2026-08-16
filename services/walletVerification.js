/**
 * One-time Telegram wallet-link tokens and signMessage challenges.
 *
 * Tokens: cryptographically random, hashed at rest, 10 minute TTL, one-use.
 * Challenges: server-generated message + nonce, 5 minute TTL, one-use.
 * Never stores raw tokens, signatures, private keys, or IP addresses.
 */

const crypto = require("node:crypto");
const { decodeBase58 } = require("../utils/base58");
const { verifyEd25519Detached } = require("../utils/ed25519");
const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const {
  mutateWalletStore,
  pruneExpired,
  applyVerifiedWallet,
  normalizeUserId,
  resolveWalletFile,
} = require("./walletLinks");

const LINK_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;
const NONCE_BYTES = 16;
const CHALLENGE_ID_BYTES = 16;
const CHALLENGE_DOMAIN = "mangomeme.fun";
const DEFAULT_CONNECT_URL = "https://mangomeme.fun/wallet-connect";

const CHALLENGE_LIMIT = Object.freeze({ max: 10, windowMs: 10 * 60 * 1000 });
const VERIFY_LIMIT = Object.freeze({ max: 10, windowMs: 10 * 60 * 1000 });

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function getWalletConnectBaseUrl(options = {}) {
  if (typeof options.walletConnectUrl === "string" && options.walletConnectUrl.trim()) {
    return options.walletConnectUrl.trim().replace(/\/+$/, "");
  }
  const fromEnv =
    typeof process.env.MANGO_WALLET_CONNECT_URL === "string"
      ? process.env.MANGO_WALLET_CONNECT_URL.trim()
      : "";
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }
  return DEFAULT_CONNECT_URL;
}

function createMemoryRateLimiter() {
  /** @type {Map<string, number[]>} */
  const windows = new Map();

  function isLimited(key, max, windowMs, now) {
    const ts = Number.isFinite(now) ? now : Date.now();
    const recent = (windows.get(key) || []).filter((t) => t > ts - windowMs);
    if (recent.length >= max) {
      windows.set(key, recent);
      return true;
    }
    recent.push(ts);
    windows.set(key, recent);
    return false;
  }

  return {
    hitChallenge(tokenKey, now) {
      return isLimited(
        `c:${tokenKey}`,
        CHALLENGE_LIMIT.max,
        CHALLENGE_LIMIT.windowMs,
        now
      );
    },
    hitVerify(challengeKey, now) {
      return isLimited(
        `v:${challengeKey}`,
        VERIFY_LIMIT.max,
        VERIFY_LIMIT.windowMs,
        now
      );
    },
  };
}

const defaultRateLimiter = createMemoryRateLimiter();

function resolveLimiter(options = {}) {
  return options.rateLimiter || defaultRateLimiter;
}

function invalidateUnusedTokensForUser(store, uid) {
  for (const [hash, record] of Object.entries(store.linkTokens || {})) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (String(record.telegramUserId) === uid && !record.usedAt) {
      delete store.linkTokens[hash];
    }
  }
}

/**
 * Create a one-time opaque verification link for a Telegram user.
 * Previous unused tokens for this user are invalidated.
 *
 * @param {string|number} telegramUserId
 * @param {{ now?: number, walletFile?: string, walletConnectUrl?: string }} [options]
 * @returns {{ token: string, url: string, expiresAt: number, tokenHash: string }}
 */
function createLinkToken(telegramUserId, options = {}) {
  const uid = normalizeUserId(telegramUserId);
  if (!uid) {
    throw new Error("telegramUserId is required");
  }

  const now = options.now === undefined ? Date.now() : options.now;
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = now + LINK_TTL_MS;
  const baseUrl = getWalletConnectBaseUrl(options);
  const url = `${baseUrl}?t=${encodeURIComponent(rawToken)}`;

  mutateWalletStore((store) => {
    pruneExpired(store, now);
    invalidateUnusedTokensForUser(store, uid);
    store.linkTokens[tokenHash] = {
      telegramUserId: uid,
      createdAt: now,
      expiresAt,
      usedAt: null,
    };
  }, options.walletFile);

  return { token: rawToken, url, expiresAt, tokenHash };
}

function lookupLinkToken(store, rawToken, now) {
  if (typeof rawToken !== "string" || !rawToken.trim()) {
    return { status: "expired" };
  }
  if (rawToken.length > 128) {
    return { status: "expired" };
  }

  const tokenHash = hashToken(rawToken.trim());
  const record = store.linkTokens[tokenHash];
  if (!record || typeof record !== "object") {
    return { status: "expired", tokenHash };
  }
  if (record.usedAt) {
    return { status: "used", tokenHash, record };
  }
  if (typeof record.expiresAt !== "number" || record.expiresAt <= now) {
    return { status: "expired", tokenHash, record };
  }
  return { status: "ok", tokenHash, record };
}

function buildChallengeMessage({ nonce, issuedAt, expiresAt }) {
  const issuedIso = new Date(issuedAt).toISOString();
  const expiresIso = new Date(expiresAt).toISOString();
  return [
    "ManGo Wallet Verification",
    "",
    "Verify ownership of this wallet for your ManGo Telegram account.",
    "",
    `Domain: ${CHALLENGE_DOMAIN}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedIso}`,
    `Expires At: ${expiresIso}`,
    "",
    "No transaction will be sent.",
    "This signature does not give ManGo control of your wallet.",
  ].join("\n");
}

const ERRORS = Object.freeze({
  expired: "This verification link has expired.",
  used: "This verification link has already been used.",
  invalid: "Invalid request.",
  failed: "Verification failed.",
  taken: "This wallet is already linked to another ManGo profile.",
  rate: "Too many attempts. Try again later.",
});

function errorResult(kind, status) {
  return { ok: false, error: ERRORS[kind] || ERRORS.invalid, status };
}

/**
 * @param {{ token?: unknown, wallet?: unknown }} body
 * @param {{ now?: number, walletFile?: string, rateLimiter?: object }} [options]
 */
function createChallenge(body, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const limiter = resolveLimiter(options);
  const rawToken = typeof body.token === "string" ? body.token.trim() : "";
  const tokenKey = rawToken ? hashToken(rawToken) : "missing";

  if (limiter.hitChallenge(tokenKey, now)) {
    return errorResult("rate", 429);
  }

  const wallet = normalizeSolanaPublicKey(body.wallet);
  if (!wallet) {
    return errorResult("invalid", 400);
  }

  return mutateWalletStore((store) => {
    pruneExpired(store, now);
    const lookup = lookupLinkToken(store, rawToken, now);
    if (lookup.status === "used") {
      return errorResult("used", 400);
    }
    if (lookup.status !== "ok") {
      return errorResult("expired", 400);
    }

    const challengeId = crypto.randomBytes(CHALLENGE_ID_BYTES).toString("base64url");
    const nonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
    const expiresAt = now + CHALLENGE_TTL_MS;
    const message = buildChallengeMessage({ nonce, issuedAt: now, expiresAt });

    store.challenges[challengeId] = {
      tokenHash: lookup.tokenHash,
      wallet,
      message,
      nonce,
      createdAt: now,
      expiresAt,
      usedAt: null,
    };

    return {
      ok: true,
      challengeId,
      message,
      expiresAt,
      status: 200,
    };
  }, options.walletFile);
}

function decodeSignature(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();

  try {
    const fromB64 = Buffer.from(trimmed, "base64");
    if (fromB64.length === 64) {
      return fromB64;
    }
  } catch {
    // continue
  }

  const from58 = decodeBase58(trimmed);
  if (from58 && from58.length === 64) {
    return from58;
  }

  return null;
}

/**
 * @param {{ token?: unknown, wallet?: unknown, challengeId?: unknown, signature?: unknown }} body
 * @param {{ now?: number, walletFile?: string, rateLimiter?: object }} [options]
 */
function verifyWalletSignature(body, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const limiter = resolveLimiter(options);
  const challengeId =
    typeof body.challengeId === "string" ? body.challengeId.trim() : "";
  const verifyKey = challengeId || "missing";

  if (limiter.hitVerify(verifyKey, now)) {
    return errorResult("rate", 429);
  }

  const wallet = normalizeSolanaPublicKey(body.wallet);
  const signature = decodeSignature(body.signature);
  const rawToken = typeof body.token === "string" ? body.token.trim() : "";

  if (!wallet || !signature || !rawToken || !challengeId || challengeId.length > 128) {
    return errorResult("invalid", 400);
  }

  const publicKeyBytes = decodeBase58(wallet);
  if (!publicKeyBytes || publicKeyBytes.length !== 32) {
    return errorResult("invalid", 400);
  }

  return mutateWalletStore((store) => {
    pruneExpired(store, now);

    const challenge = store.challenges[challengeId];
    if (!challenge || typeof challenge !== "object") {
      return errorResult("failed", 400);
    }
    if (challenge.usedAt) {
      return errorResult("failed", 400);
    }
    if (typeof challenge.expiresAt !== "number" || challenge.expiresAt <= now) {
      return errorResult("failed", 400);
    }
    if (challenge.wallet !== wallet) {
      return errorResult("failed", 400);
    }

    const lookup = lookupLinkToken(store, rawToken, now);
    if (lookup.status === "used") {
      return errorResult("used", 400);
    }
    if (lookup.status !== "ok") {
      return errorResult("expired", 400);
    }
    if (lookup.tokenHash !== challenge.tokenHash) {
      return errorResult("failed", 400);
    }

    if (typeof challenge.message !== "string" || !challenge.message) {
      return errorResult("failed", 400);
    }

    const messageBytes = Buffer.from(challenge.message, "utf8");
    const valid = verifyEd25519Detached(messageBytes, signature, publicKeyBytes);
    if (!valid) {
      return errorResult("failed", 400);
    }

    const uid = normalizeUserId(lookup.record.telegramUserId);
    if (!uid) {
      return errorResult("failed", 400);
    }

    const linked = applyVerifiedWallet(store, uid, wallet, now);
    if (!linked.ok) {
      return errorResult("taken", 409);
    }

    lookup.record.usedAt = now;
    challenge.usedAt = now;
    delete challenge.message;
    delete challenge.nonce;

    return { ok: true, status: 200 };
  }, options.walletFile);
}

module.exports = {
  LINK_TTL_MS,
  CHALLENGE_TTL_MS,
  CHALLENGE_DOMAIN,
  DEFAULT_CONNECT_URL,
  CHALLENGE_LIMIT,
  VERIFY_LIMIT,
  ERRORS,
  hashToken,
  createMemoryRateLimiter,
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  buildChallengeMessage,
  getWalletConnectBaseUrl,
  resolveWalletFile,
};
