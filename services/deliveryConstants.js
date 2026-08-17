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
const DELIVERY_TYPE_MANGO_TOKEN = "mango-token";

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
  DELIVERY_TYPE_MANGO_TOKEN,
  deliveryMemo,
  formatMangoGrouped,
  formatMangoHuman,
  mangoHumanToBaseUnits,
  parseBaseUnits,
};
