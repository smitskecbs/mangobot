/**
 * Signed ManGo game-link tokens (HMAC-SHA256).
 * Pure crypto helpers — no I/O beyond reading process.env.GAME_LINK_SECRET.
 */

const crypto = require("node:crypto");

const ALLOWED_GAMES = Object.freeze(["snake", "bounch"]);
const DEFAULT_TTL_SECONDS = 86400;

function isAllowedGame(game) {
  return typeof game === "string" && ALLOWED_GAMES.includes(game);
}

function resolveSecret(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "secret")) {
    return options.secret;
  }

  return process.env.GAME_LINK_SECRET;
}

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("GAME_LINK_SECRET is required");
  }
}

function normalizeUid(userId) {
  const uid = String(userId);
  if (!uid) {
    throw new Error("userId must be a non-empty value");
  }
  return uid;
}

function assertPositiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function unixNowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecodeToBuffer(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");

  try {
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

function signPayloadPart(payloadPart, secret) {
  return crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest();
}

function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {string|number} userId
 * @param {string} game
 * @param {{ secret?: string, ttlSeconds?: number, now?: number }} [options]
 * @returns {string}
 */
function createGameToken(userId, game, options = {}) {
  const secret = resolveSecret(options);
  assertSecret(secret);

  const uid = normalizeUid(userId);

  if (!isAllowedGame(game)) {
    throw new Error('game must be "snake" or "bounch"');
  }

  const ttlSeconds =
    options.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : options.ttlSeconds;
  assertPositiveInteger(ttlSeconds, "ttlSeconds");

  const now = options.now === undefined ? unixNowSeconds() : options.now;

  if (typeof now !== "number" || !Number.isInteger(now) || !Number.isFinite(now)) {
    throw new Error("now must be a finite integer Unix timestamp");
  }

  const payload = {
    uid,
    game,
    exp: now + ttlSeconds,
  };

  const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = base64UrlEncode(signPayloadPart(payloadPart, secret));

  return `${payloadPart}.${signature}`;
}

/**
 * @param {unknown} token
 * @param {string} expectedGame
 * @param {{ secret?: string, now?: number }} [options]
 * @returns {{ ok: true, uid: string, game: string, exp: number } | { ok: false, reason: string }}
 */
function verifyGameToken(token, expectedGame, options = {}) {
  if (token === undefined || token === null || token === "") {
    return { ok: false, reason: "missing-token" };
  }

  if (typeof token !== "string") {
    return { ok: false, reason: "malformed-token" };
  }

  const secret = resolveSecret(options);

  if (typeof secret !== "string" || secret.length === 0) {
    return { ok: false, reason: "missing-secret" };
  }

  if (!isAllowedGame(expectedGame)) {
    return { ok: false, reason: "invalid-game" };
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return { ok: false, reason: "malformed-token" };
  }

  const [payloadPart, signaturePart] = parts;

  if (!payloadPart || !signaturePart) {
    return { ok: false, reason: "malformed-token" };
  }

  const expectedSig = signPayloadPart(payloadPart, secret);
  const actualSig = base64UrlDecodeToBuffer(signaturePart);

  if (!actualSig || !safeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: "invalid-signature" };
  }

  const payloadBuffer = base64UrlDecodeToBuffer(payloadPart);

  if (!payloadBuffer) {
    return { ok: false, reason: "malformed-token" };
  }

  let payload;

  try {
    payload = JSON.parse(payloadBuffer.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid-payload" };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid-payload" };
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "uid")) {
    return { ok: false, reason: "invalid-user" };
  }

  if (typeof payload.uid !== "string" || payload.uid.length === 0) {
    return { ok: false, reason: "invalid-user" };
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "game")) {
    return { ok: false, reason: "invalid-game" };
  }

  if (!isAllowedGame(payload.game)) {
    return { ok: false, reason: "invalid-game" };
  }

  if (payload.game !== expectedGame) {
    return { ok: false, reason: "wrong-game" };
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "exp")) {
    return { ok: false, reason: "invalid-expiry" };
  }

  if (
    typeof payload.exp !== "number" ||
    !Number.isInteger(payload.exp) ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, reason: "invalid-expiry" };
  }

  const now = options.now === undefined ? unixNowSeconds() : options.now;

  if (typeof now !== "number" || !Number.isInteger(now) || !Number.isFinite(now)) {
    return { ok: false, reason: "invalid-expiry" };
  }

  if (payload.exp < now) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    uid: payload.uid,
    game: payload.game,
    exp: payload.exp,
  };
}

module.exports = {
  createGameToken,
  verifyGameToken,
  ALLOWED_GAMES,
  DEFAULT_TTL_SECONDS,
};
