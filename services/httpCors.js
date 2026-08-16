/**
 * Shared CORS allowlist for the public highscore/wallet HTTP API.
 * Canonical site origin is https://mangomeme.fun; www is also allowed
 * because mobile browsers/deeplinks sometimes land on the www host.
 */

const CANONICAL_ORIGIN = "https://mangomeme.fun";

const ALLOWED_ORIGINS = new Set([
  "https://mangomeme.fun",
  "https://www.mangomeme.fun",
  "http://mangomeme.fun",
  "http://www.mangomeme.fun",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

function resolveAllowedOrigin(originHeader) {
  if (typeof originHeader !== "string") {
    return null;
  }
  const normalized = originHeader.trim();
  if (!normalized || !ALLOWED_ORIGINS.has(normalized)) {
    return null;
  }
  return normalized;
}

function applyCorsHeaders(res, origin) {
  if (!origin || !res || typeof res.setHeader !== "function") {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handleCorsPreflight(res, origin) {
  applyCorsHeaders(res, origin);
  if (!res) {
    return;
  }
  res.statusCode = 204;
  if (typeof res.end === "function") {
    res.end();
  }
}

module.exports = {
  CANONICAL_ORIGIN,
  ALLOWED_ORIGINS,
  resolveAllowedOrigin,
  applyCorsHeaders,
  handleCorsPreflight,
};
