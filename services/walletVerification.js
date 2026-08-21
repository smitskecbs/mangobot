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
  getVerifiedWalletForUser,
} = require("./walletLinks");

const LINK_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;
const NONCE_BYTES = 16;
const CHALLENGE_ID_BYTES = 16;
const TOKEN_FINGERPRINT_LENGTH = 12;
const BASE64URL_CHARSET = /^[A-Za-z0-9_-]+$/;
const CHALLENGE_DOMAIN = "mangomeme.fun";
const DEFAULT_CONNECT_URL = "https://mangomeme.fun/wallet-connect";

const CHALLENGE_LIMIT = Object.freeze({ max: 10, windowMs: 10 * 60 * 1000 });
const VERIFY_LIMIT = Object.freeze({ max: 10, windowMs: 10 * 60 * 1000 });

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function tokenFingerprint(token) {
  if (typeof token !== "string" || token.length === 0) {
    return "none";
  }
  return hashToken(token).slice(0, TOKEN_FINGERPRINT_LENGTH);
}

function isBase64UrlCharset(token) {
  return typeof token === "string" && token.length > 0 && BASE64URL_CHARSET.test(token);
}

function lookupStatusLabel(status) {
  if (status === "ok") {
    return "hit";
  }
  if (status === "invalid") {
    return "miss";
  }
  if (status === "expired" || status === "used") {
    return status;
  }
  return "miss";
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

function createMemoryRateLimiter(options = {}) {
  /** @type {Map<string, number[]>} */
  const windows = new Map();
  const maxKeys =
    Number.isFinite(options.maxKeys) && options.maxKeys > 0
      ? Math.floor(options.maxKeys)
      : 4000;
  const maxWindowMs = Math.max(CHALLENGE_LIMIT.windowMs, VERIFY_LIMIT.windowMs);

  function prune(now) {
    const ts = Number.isFinite(now) ? now : Date.now();
    for (const [key, times] of windows.entries()) {
      const recent = (times || []).filter((t) => t > ts - maxWindowMs);
      if (!recent.length) {
        windows.delete(key);
      } else {
        windows.set(key, recent);
      }
    }
    if (windows.size > maxKeys) {
      const overflow = windows.size - maxKeys;
      const keys = windows.keys();
      for (let i = 0; i < overflow; i += 1) {
        const next = keys.next();
        if (next.done) {
          break;
        }
        windows.delete(next.value);
      }
    }
  }

  function isLimited(key, max, windowMs, now) {
    const ts = Number.isFinite(now) ? now : Date.now();
    if (windows.size > maxKeys / 2) {
      prune(ts);
    }
    const recent = (windows.get(key) || []).filter((t) => t > ts - windowMs);
    if (recent.length >= max) {
      windows.set(key, recent);
      return true;
    }
    recent.push(ts);
    windows.set(key, recent);
    if (windows.size > maxKeys) {
      prune(ts);
    }
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
    prune,
    size() {
      return windows.size;
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

  const fingerprint = tokenFingerprint(rawToken);
  const n = rawToken.length;
  console.log(`[wallet-link] created fingerprint=${fingerprint} length=${n}`);

  return { token: rawToken, url, expiresAt, tokenHash };
}

function lookupLinkToken(store, rawToken, now) {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    return { status: "invalid" };
  }
  if (rawToken.length > 128) {
    return { status: "invalid" };
  }

  const tokenHash = hashToken(rawToken);
  const record = store.linkTokens[tokenHash];
  if (!record || typeof record !== "object") {
    return { status: "invalid", tokenHash };
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
  invalidLink: "This verification link is invalid.",
  invalid: "Invalid request.",
  failed: "Verification failed.",
  temporary: "Verification is temporarily unavailable. Please try again.",
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
  const rawToken = typeof body.token === "string" ? body.token : "";
  const fingerprint = tokenFingerprint(rawToken);
  const n = rawToken.length;
  const charsetValid = isBase64UrlCharset(rawToken) ? "YES" : "NO";
  const tokenKey = rawToken ? hashToken(rawToken) : "missing";

  if (limiter.hitChallenge(tokenKey, now)) {
    console.log(
      `[wallet-challenge] received fingerprint=${fingerprint} length=${n} charset-valid=${charsetValid} lookup=rate`
    );
    return errorResult("rate", 429);
  }

  const wallet = normalizeSolanaPublicKey(body.wallet);
  if (!wallet) {
    console.log(
      `[wallet-challenge] received fingerprint=${fingerprint} length=${n} charset-valid=${charsetValid}`
    );
    return errorResult("invalid", 400);
  }

  return mutateWalletStore((store) => {
    const stored = Object.keys(store.linkTokens || {}).length;
    const lookup = lookupLinkToken(store, rawToken, now);
    const lookupLabel = lookupStatusLabel(lookup.status);
    console.log(
      `[wallet-challenge] received fingerprint=${fingerprint} length=${n} charset-valid=${charsetValid} stored=${stored} lookup=${lookupLabel}`
    );
    pruneExpired(store, now);
    if (lookup.status === "used") {
      return errorResult("used", 400);
    }
    if (lookup.status === "invalid") {
      return errorResult("invalidLink", 400);
    }
    if (lookup.status === "expired") {
      return errorResult("expired", 400);
    }
    if (lookup.status !== "ok") {
      return errorResult("invalidLink", 400);
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
  const rawToken = typeof body.token === "string" ? body.token : "";

  if (!wallet || !signature || !rawToken || !challengeId || challengeId.length > 128) {
    return errorResult("invalid", 400);
  }

  const publicKeyBytes = decodeBase58(wallet);
  if (!publicKeyBytes || publicKeyBytes.length !== 32) {
    return errorResult("invalid", 400);
  }

  const result = mutateWalletStore((store) => {
    const lookup = lookupLinkToken(store, rawToken, now);
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

    if (lookup.status === "used") {
      return errorResult("used", 400);
    }
    if (lookup.status === "invalid") {
      return errorResult("invalidLink", 400);
    }
    if (lookup.status === "expired") {
      return errorResult("expired", 400);
    }
    if (lookup.status !== "ok") {
      return errorResult("invalidLink", 400);
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

    return {
      ok: true,
      status: 200,
      persistedUserId: uid,
      persistedWallet: wallet,
    };
  }, options.walletFile);

  if (!result || result.ok !== true) {
    return result;
  }

  try {
    const confirmMapping =
      typeof options.confirmVerifiedMapping === "function"
        ? options.confirmVerifiedMapping
        : getVerifiedWalletForUser;
    const persisted = confirmMapping(result.persistedUserId, options.walletFile);
    if (!persisted || persisted.wallet !== result.persistedWallet) {
      console.error("[wallet-verify] persistence failed error=missing_mapping");
      return errorResult("failed", 500);
    }
    console.log("[wallet-verify] verified persistence success");
    try {
      require("./communityBuilder").onWalletLinked(result.persistedUserId, {
        walletFile: options.walletFile,
      });
    } catch (_err) {
      /* Referral wallet milestone must never break verification. */
    }
    return {
      ok: true,
      status: 200,
      notifyTelegramUserId: result.persistedUserId,
      notifyWallet: result.persistedWallet,
    };
  } catch (err) {
    const code = (err && err.code) || (err && err.name) || "Error";
    console.error(`[wallet-verify] persistence failed error=${code}`);
    return errorResult("failed", 500);
  }
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
  tokenFingerprint,
  isBase64UrlCharset,
  TOKEN_BYTES,
  TOKEN_FINGERPRINT_LENGTH,
  createMemoryRateLimiter,
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  buildChallengeMessage,
  getWalletConnectBaseUrl,
  resolveWalletFile,
};
