/**
 * Server-side presale switches. Default disabled. No invented dates.
 * Treasury must be a valid Solana pubkey from env — never VITE_*.
 */

const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const { MANGO_MINT, MANGO_MINT_DECIMALS } = require("./presaleConstants");

function parseBool(value) {
  if (typeof value !== "string") {
    return false;
  }
  const raw = value.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) {
      return null;
    }
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function getPresaleConfig(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  const enabled = parseBool(source.PRESALE_ENABLED);
  const treasury = normalizeSolanaPublicKey(source.PRESALE_TREASURY_WALLET);
  const startAt = parseTimestamp(source.PRESALE_START_AT);
  const endAt = parseTimestamp(source.PRESALE_END_AT);
  const rpcUrl =
    typeof source.PRESALE_RPC_URL === "string" && source.PRESALE_RPC_URL.trim()
      ? source.PRESALE_RPC_URL.trim()
      : typeof source.SOLANA_RPC_URL === "string" && source.SOLANA_RPC_URL.trim()
        ? source.SOLANA_RPC_URL.trim()
        : "";

  const reasons = [];
  if (!enabled) {
    reasons.push("disabled");
  }
  if (!treasury) {
    reasons.push("treasury-missing");
  }
  if (!rpcUrl) {
    reasons.push("rpc-missing");
  }
  return {
    enabled,
    treasury,
    startAt,
    endAt,
    rpcUrl,
    mint: MANGO_MINT,
    decimals: MANGO_MINT_DECIMALS,
    live: enabled && Boolean(treasury) && Boolean(rpcUrl),
    blockedReasons: reasons,
  };
}

function isPresaleLive(now = Date.now(), env = process.env) {
  const config = getPresaleConfig(env);
  if (!config.live) {
    return false;
  }
  const ts = Number(now);
  if (config.startAt && ts < config.startAt) {
    return false;
  }
  if (config.endAt && ts > config.endAt) {
    return false;
  }
  return true;
}

function presaleWindowReason(now = Date.now(), env = process.env) {
  const config = getPresaleConfig(env);
  if (!config.enabled) {
    return "disabled";
  }
  if (!config.treasury) {
    return "treasury-missing";
  }
  if (!config.rpcUrl) {
    return "rpc-missing";
  }
  const ts = Number(now);
  if (config.startAt && ts < config.startAt) {
    return "not-started";
  }
  if (config.endAt && ts > config.endAt) {
    return "ended";
  }
  return null;
}

module.exports = {
  parseBool,
  parseTimestamp,
  getPresaleConfig,
  isPresaleLive,
  presaleWindowReason,
};
