/**
 * Solana public-key validation and safe display helpers.
 * No private keys. No seed phrases.
 */

const { decodeBase58, encodeBase58 } = require("./base58");

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBKEY_BYTES = 32;

/**
 * Validate and canonicalize a Solana public key.
 * @param {unknown} value
 * @returns {string|null} canonical base58 or null
 */
function normalizeSolanaPublicKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!BASE58_REGEX.test(trimmed)) {
    return null;
  }

  const bytes = decodeBase58(trimmed);
  if (!bytes || bytes.length !== PUBKEY_BYTES) {
    return null;
  }

  return encodeBase58(bytes);
}

function isValidSolanaPublicKey(value) {
  return normalizeSolanaPublicKey(value) !== null;
}

/**
 * Shorten a wallet address for display, e.g. 7Abc...9XYZ
 * @param {unknown} address
 * @returns {string}
 */
function shortenWallet(address) {
  if (typeof address !== "string") {
    return "";
  }
  const trimmed = address.trim();
  if (trimmed.length <= 8) {
    return trimmed;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Escape text for Telegram HTML parse_mode.
 * @param {unknown} value
 * @returns {string}
 */
function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * @param {number} timestampMs
 * @returns {string} YYYY-MM-DD (UTC)
 */
function formatVerifiedDate(timestampMs) {
  const ms = Number(timestampMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return "";
  }
  return new Date(ms).toISOString().slice(0, 10);
}

module.exports = {
  BASE58_REGEX,
  PUBKEY_BYTES,
  normalizeSolanaPublicKey,
  isValidSolanaPublicKey,
  shortenWallet,
  escapeTelegramHtml,
  formatVerifiedDate,
};
