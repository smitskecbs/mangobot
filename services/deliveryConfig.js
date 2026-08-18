/**
 * Reward / presale distribution switches. Default disabled. Public address only.
 */

const { parseBool } = require("./presaleConfig");
const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const { MANGO_MINT, MANGO_MINT_DECIMALS, DEFAULT_DELIVERY_URL } = require("./deliveryConstants");

function getDeliveryConfig(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  const rewardDeliveryEnabled = parseBool(source.REWARD_DELIVERY_ENABLED);
  const presaleDistributionEnabled = parseBool(source.PRESALE_DISTRIBUTION_ENABLED);
  const distributionWallet = normalizeSolanaPublicKey(source.MANGO_DISTRIBUTION_WALLET);
  const rpcUrl =
    typeof source.DELIVERY_RPC_URL === "string" && source.DELIVERY_RPC_URL.trim()
      ? source.DELIVERY_RPC_URL.trim()
      : typeof source.PRESALE_RPC_URL === "string" && source.PRESALE_RPC_URL.trim()
        ? source.PRESALE_RPC_URL.trim()
        : typeof source.SOLANA_RPC_URL === "string" && source.SOLANA_RPC_URL.trim()
          ? source.SOLANA_RPC_URL.trim()
          : "";
  const deliveryUrl =
    typeof source.MANGO_DELIVERY_URL === "string" && source.MANGO_DELIVERY_URL.trim()
      ? source.MANGO_DELIVERY_URL.trim().replace(/\/+$/, "")
      : DEFAULT_DELIVERY_URL;

  const reasons = [];
  if (!distributionWallet) {
    reasons.push("distribution-wallet-missing");
  }
  if (!rpcUrl) {
    reasons.push("rpc-missing");
  }

  return {
    rewardDeliveryEnabled,
    presaleDistributionEnabled,
    distributionWallet,
    rpcUrl,
    deliveryUrl,
    mint: MANGO_MINT,
    decimals: MANGO_MINT_DECIMALS,
    rewardLive: rewardDeliveryEnabled && Boolean(distributionWallet) && Boolean(rpcUrl),
    presaleLive: presaleDistributionEnabled && Boolean(distributionWallet) && Boolean(rpcUrl),
    blockedReasons: reasons,
  };
}

function isRewardDeliveryLive(env = process.env) {
  return getDeliveryConfig(env).rewardLive;
}

function isPresaleDistributionLive(env = process.env) {
  return getDeliveryConfig(env).presaleLive;
}

function safeRpcHost(rpcUrl) {
  if (typeof rpcUrl !== "string" || !rpcUrl.trim()) {
    return "";
  }
  try {
    const hostname = new URL(rpcUrl).hostname;
    if (typeof hostname !== "string" || !hostname) {
      return "invalid";
    }
    return hostname.slice(0, 80);
  } catch {
    return "invalid";
  }
}

function safeLogReason(reason) {
  if (typeof reason !== "string") {
    return "unknown";
  }
  const trimmed = reason.trim().slice(0, 64);
  if (!/^[a-z0-9_-]+$/i.test(trimmed)) {
    return "unknown";
  }
  return trimmed;
}

function safeErrorName(err) {
  const name = err && typeof err.name === "string" ? err.name : "Error";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name.slice(0, 64))) {
    return "Error";
  }
  return name.slice(0, 64);
}

function safeErrorCode(err) {
  const code = err && err.code;
  if (typeof code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(code)) {
    return code;
  }
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(Math.trunc(code)).slice(0, 16);
  }
  return "";
}

module.exports = {
  getDeliveryConfig,
  isRewardDeliveryLive,
  isPresaleDistributionLive,
  safeRpcHost,
  safeLogReason,
  safeErrorName,
  safeErrorCode,
};
