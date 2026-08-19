/**
 * Admin-signed MANGO delivery constants.
 * Canonical mint is server-side only. No private keys.
 */

const {
  MANGO_MINT,
  MANGO_MINT_DECIMALS,
  TOKEN_BYTES,
  MEMO_PROGRAM_ID,
  parseLamportsInteger,
  formatMangoHuman,
  mangoScale,
} = require("./presaleConstants");

const PURPOSE_REWARD_DELIVERY = "reward-delivery";
const PURPOSE_PRESALE_DISTRIBUTION = "presale-distribution";
const DELIVERY_TTL_MS = 15 * 60 * 1000;
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PREFIX = "mango-delivery:";
const DEFAULT_DELIVERY_URL = "https://mangomeme.fun/admin-delivery";
const ASSET_MANGO = "mango";
const ASSET_SPL = "spl";
const ASSET_NFT = "nft";
const ASSET_OFFCHAIN = "offchain";
const DELIVERY_TYPE_MANGO_TOKEN = "mango-token";
const DELIVERY_TYPE_SPL_TOKEN = "spl-token";
const DELIVERY_TYPE_NFT = "nft";
const DELIVERY_TYPE_OFFCHAIN = "offchain";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function deliveryMemo(deliveryId) {
  return `${MEMO_PREFIX}${deliveryId}`;
}

function formatMangoGrouped(human) {
  const raw = String(human || "0");
  if (!/^\d+$/.test(raw)) {
    return raw;
  }
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Whole MANGO amount → base units. Commas allowed. No floats.
 * @param {unknown} value
 */
function mangoHumanToBaseUnits(value, decimals = MANGO_MINT_DECIMALS) {
  if (value === undefined || value === null) {
    return { ok: false, reason: "invalid-amount" };
  }
  const raw = String(value).trim().replace(/,/g, "");
  if (!/^\d+$/.test(raw) || raw.length > 12) {
    return { ok: false, reason: "invalid-amount" };
  }
  const human = BigInt(raw);
  if (human <= 0n) {
    return { ok: false, reason: "invalid-amount" };
  }
  const baseUnits = human * mangoScale(decimals);
  return {
    ok: true,
    baseUnits: baseUnits.toString(),
    human: human.toString(),
  };
}

function parseBaseUnits(value) {
  return parseLamportsInteger(value);
}

/**
 * Human token amount → base units. Integers always; optional fraction up to `decimals`.
 * @param {unknown} value
 * @param {number} decimals
 */
function humanAmountToBaseUnits(value, decimals) {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) {
    return { ok: false, reason: "invalid-decimals" };
  }
  if (value === undefined || value === null) {
    return { ok: false, reason: "invalid-amount" };
  }
  const raw = String(value).trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(raw) || raw.length > 24) {
    return { ok: false, reason: "invalid-amount" };
  }
  const [wholeRaw, fracRaw = ""] = raw.split(".");
  if (fracRaw.length > dec) {
    return { ok: false, reason: "invalid-amount" };
  }
  const whole = BigInt(wholeRaw);
  const frac = BigInt(fracRaw.padEnd(dec, "0") || "0");
  const scale = 10n ** BigInt(dec);
  const baseUnits = whole * scale + frac;
  if (baseUnits <= 0n) {
    return { ok: false, reason: "invalid-amount" };
  }
  return {
    ok: true,
    baseUnits: baseUnits.toString(),
    human: raw.replace(/^0+(\d)/, "$1"),
  };
}

function assetTypeLabel(assetType) {
  if (assetType === ASSET_SPL) {
    return "SPL Token";
  }
  if (assetType === ASSET_NFT) {
    return "NFT";
  }
  if (assetType === ASSET_OFFCHAIN) {
    return "Off-chain";
  }
  return "MANGO";
}

function deliveryTypeForAsset(assetType) {
  if (assetType === ASSET_SPL) {
    return DELIVERY_TYPE_SPL_TOKEN;
  }
  if (assetType === ASSET_NFT) {
    return DELIVERY_TYPE_NFT;
  }
  if (assetType === ASSET_OFFCHAIN) {
    return DELIVERY_TYPE_OFFCHAIN;
  }
  return DELIVERY_TYPE_MANGO_TOKEN;
}

module.exports = {
  MANGO_MINT,
  MANGO_MINT_DECIMALS,
  TOKEN_BYTES,
  PURPOSE_REWARD_DELIVERY,
  PURPOSE_PRESALE_DISTRIBUTION,
  DELIVERY_TTL_MS,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  MEMO_PREFIX,
  DEFAULT_DELIVERY_URL,
  ASSET_MANGO,
  ASSET_SPL,
  ASSET_NFT,
  ASSET_OFFCHAIN,
  DELIVERY_TYPE_MANGO_TOKEN,
  DELIVERY_TYPE_SPL_TOKEN,
  DELIVERY_TYPE_NFT,
  DELIVERY_TYPE_OFFCHAIN,
  TOKEN_2022_PROGRAM_ID,
  deliveryMemo,
  formatMangoGrouped,
  formatMangoHuman,
  mangoHumanToBaseUnits,
  humanAmountToBaseUnits,
  parseBaseUnits,
  assetTypeLabel,
  deliveryTypeForAsset,
};
