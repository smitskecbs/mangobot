/**
 * Fixed ManGo v1 presale tokenomics.
 *
 * Mint decimals were read from Solana mainnet SPL mint account data
 * (offset 44) for 29KN57rM6tV2aWdo1agZcF6ynPXB1dhHdKHNrrAmaNGo.
 * Do not guess; do not use IEEE floats for accounting.
 */

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Canonical ManGo mint (mainnet). */
const MANGO_MINT = "29KN57rM6tV2aWdo1agZcF6ynPXB1dhHdKHNrrAmaNGo";

/**
 * Verified 2026-08-16 via getAccountInfo (Tokenkeg mint, space 82).
 * supply raw = 1_000_000_000_000_000 = 1,000,000 * 10^9.
 */
const MANGO_MINT_DECIMALS = 9;

const TOTAL_MANGO_HUMAN = 1_000_000n;
const PRESALE_MANGO_HUMAN = 100_000n;
const MANGO_PER_SOL_HUMAN = 20_000n;
const HARD_CAP_SOL = 5n;
const MIN_SOL_HUMAN = "0.01";
const MAX_WALLET_SOL_HUMAN = "0.25";

const MIN_CONTRIBUTION_LAMPORTS = 10_000_000n; // 0.01 SOL
const MAX_WALLET_LAMPORTS = 250_000_000n; // 0.25 SOL
const HARD_CAP_LAMPORTS = HARD_CAP_SOL * LAMPORTS_PER_SOL; // 5 SOL

const ALLOWED_AMOUNTS_LAMPORTS = Object.freeze([
  10_000_000n, // 0.01
  50_000_000n, // 0.05
  100_000_000n, // 0.10
  250_000_000n, // 0.25
]);

const SESSION_TTL_MS = 15 * 60 * 1000;
const RESERVATION_TTL_MS = 10 * 60 * 1000;
const ORDER_TTL_MS = RESERVATION_TTL_MS;
const TOKEN_BYTES = 32;
const PURPOSE_PRESALE = "presale";
const MEMO_PREFIX = "mango-presale:";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const DEFAULT_PRESALE_URL = "https://mangomeme.fun/presale";
const RECONCILE_PAGE_SIZE = 100;
const RECONCILE_MAX_PAGES = 10;
const RECONCILE_MAX_SIGNATURES = RECONCILE_PAGE_SIZE * RECONCILE_MAX_PAGES;
const RECONCILE_TICK_MS = 60_000;

function mangoScale(decimals = MANGO_MINT_DECIMALS) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 18) {
    throw new Error("Invalid mint decimals.");
  }
  return 10n ** BigInt(d);
}

function totalMangoBaseUnits(decimals = MANGO_MINT_DECIMALS) {
  return TOTAL_MANGO_HUMAN * mangoScale(decimals);
}

function presaleMangoBaseUnits(decimals = MANGO_MINT_DECIMALS) {
  return PRESALE_MANGO_HUMAN * mangoScale(decimals);
}

/**
 * Integer allocation: lamports * 20_000 * 10^decimals / 1e9
 * @param {bigint|string} lamports
 * @param {number} [decimals]
 * @returns {{ ok: true, baseUnits: string, human: string } | { ok: false, reason: string }}
 */
function mangoBaseUnitsFromLamports(lamports, decimals = MANGO_MINT_DECIMALS) {
  let value;
  try {
    value = typeof lamports === "bigint" ? lamports : BigInt(String(lamports));
  } catch {
    return { ok: false, reason: "invalid-lamports" };
  }
  if (value < 0n) {
    return { ok: false, reason: "invalid-lamports" };
  }
  const scale = mangoScale(decimals);
  const numerator = value * MANGO_PER_SOL_HUMAN * scale;
  if (numerator % LAMPORTS_PER_SOL !== 0n) {
    return { ok: false, reason: "not-divisible" };
  }
  const baseUnits = numerator / LAMPORTS_PER_SOL;
  const human = (baseUnits / scale).toString();
  return { ok: true, baseUnits: baseUnits.toString(), human };
}

function isAllowedAmount(lamports) {
  let value;
  try {
    value = typeof lamports === "bigint" ? lamports : BigInt(String(lamports));
  } catch {
    return false;
  }
  return ALLOWED_AMOUNTS_LAMPORTS.some((allowed) => allowed === value);
}

function parseLamportsInteger(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
      return { ok: false };
    }
    return { ok: true, lamports: String(value) };
  }
  if (typeof value === "bigint") {
    if (value < 0n) {
      return { ok: false };
    }
    return { ok: true, lamports: value.toString() };
  }
  if (typeof value !== "string") {
    return { ok: false };
  }
  const raw = value.trim();
  if (!/^\d+$/.test(raw) || raw.length > 20) {
    return { ok: false };
  }
  return { ok: true, lamports: BigInt(raw).toString() };
}

function solStringToLamports(value) {
  if (typeof value !== "string") {
    return { ok: false };
  }
  const raw = String(value).trim();
  if (!raw || raw.length > 24) {
    return { ok: false };
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return { ok: false };
  }
  const [wholePart, fractionPart = ""] = raw.split(".");
  if (fractionPart.length > 9) {
    return { ok: false };
  }
  const whole = BigInt(wholePart);
  const fracPadded = (fractionPart + "000000000").slice(0, 9);
  const lamports = whole * LAMPORTS_PER_SOL + BigInt(fracPadded);
  return { ok: true, lamports: lamports.toString() };
}

function formatLamportsAsSol(lamports) {
  const parsed = parseLamportsInteger(lamports);
  if (!parsed.ok) {
    return "0";
  }
  const value = BigInt(parsed.lamports);
  const whole = value / LAMPORTS_PER_SOL;
  const frac = value % LAMPORTS_PER_SOL;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

function formatMangoHuman(baseUnits, decimals = MANGO_MINT_DECIMALS) {
  const parsed = parseLamportsInteger(baseUnits);
  if (!parsed.ok) {
    return "0";
  }
  const scale = mangoScale(decimals);
  return (BigInt(parsed.lamports) / scale).toString();
}

function assertV1Tokenomics(decimals = MANGO_MINT_DECIMALS) {
  const fiveSol = mangoBaseUnitsFromLamports(HARD_CAP_LAMPORTS, decimals);
  const min = mangoBaseUnitsFromLamports(MIN_CONTRIBUTION_LAMPORTS, decimals);
  const mid05 = mangoBaseUnitsFromLamports(50_000_000n, decimals);
  const mid10 = mangoBaseUnitsFromLamports(100_000_000n, decimals);
  const max = mangoBaseUnitsFromLamports(MAX_WALLET_LAMPORTS, decimals);
  return {
    totalHuman: TOTAL_MANGO_HUMAN.toString(),
    presaleHuman: PRESALE_MANGO_HUMAN.toString(),
    percent: ((PRESALE_MANGO_HUMAN * 100n) / TOTAL_MANGO_HUMAN).toString(),
    fiveSolHuman: fiveSol.human,
    minHuman: min.human,
    mid05Human: mid05.human,
    mid10Human: mid10.human,
    maxHuman: max.human,
    decimals,
  };
}

module.exports = {
  LAMPORTS_PER_SOL,
  MANGO_MINT,
  MANGO_MINT_DECIMALS,
  TOTAL_MANGO_HUMAN,
  PRESALE_MANGO_HUMAN,
  MANGO_PER_SOL_HUMAN,
  HARD_CAP_SOL,
  MIN_SOL_HUMAN,
  MAX_WALLET_SOL_HUMAN,
  MIN_CONTRIBUTION_LAMPORTS,
  MAX_WALLET_LAMPORTS,
  HARD_CAP_LAMPORTS,
  ALLOWED_AMOUNTS_LAMPORTS,
  SESSION_TTL_MS,
  RESERVATION_TTL_MS,
  ORDER_TTL_MS,
  TOKEN_BYTES,
  PURPOSE_PRESALE,
  MEMO_PREFIX,
  SYSTEM_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  DEFAULT_PRESALE_URL,
  RECONCILE_PAGE_SIZE,
  RECONCILE_MAX_PAGES,
  RECONCILE_MAX_SIGNATURES,
  RECONCILE_TICK_MS,
  mangoScale,
  totalMangoBaseUnits,
  presaleMangoBaseUnits,
  mangoBaseUnitsFromLamports,
  isAllowedAmount,
  parseLamportsInteger,
  solStringToLamports,
  formatLamportsAsSol,
  formatMangoHuman,
  assertV1Tokenomics,
};
