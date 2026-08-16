/**
 * Presale participation helpers.
 *
 * Audit (website + bot): there is no functional SOL payment, treasury wallet,
 * contribution ledger, allocation engine, or claim/airdrop sender.
 * Website copy mentions a future community airdrop / whitelist; /launch says
 * "No presale."
 *
 * Until contributions can be verified on-chain or by a trusted server observer,
 * this module is READ-ONLY. It never accepts "I paid X SOL" from clients.
 *
 * Wallet replacement policy (not auto-migrated):
 * If a participation record exists, historical contribution stays on
 * walletSnapshot from payment time. A later verified-wallet replace does NOT
 * become owner of that allocation without an explicit reviewed migration.
 */

const fs = require("fs");
const path = require("path");
const { normalizeUserId } = require("./walletLinks");
const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const { error: logError } = require("../utils/logger");

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_PRESALE_FILE = path.resolve(__dirname, "..", "data", "presale-participation.json");

/** Presale payment is not live. Do not invent contribution data. */
const PRESALE_LIVE = false;

function emptyParticipation() {
  return {
    recorded: false,
    status: "not-started",
    walletSnapshot: null,
    contributedLamports: "0",
    allocation: null,
    transactions: [],
    updatedAt: null,
  };
}

/**
 * Parse a decimal SOL amount into integer lamports without IEEE floats.
 * Accepts "1", "0.01", "10.000000001". Rejects negatives, NaN, extra dots.
 * @param {unknown} value
 * @returns {{ ok: true, lamports: string } | { ok: false }}
 */
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

/**
 * @param {unknown} value
 * @returns {{ ok: true, lamports: string } | { ok: false }}
 */
function parseLamportsInteger(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
      return { ok: false };
    }
    return { ok: true, lamports: String(value) };
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

function emptyStore() {
  return { users: {} };
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return store;
  }
  if (raw.users && typeof raw.users === "object" && !Array.isArray(raw.users)) {
    store.users = raw.users;
  }
  return store;
}

function resolvePresaleFile(explicit) {
  if (explicit) {
    return explicit;
  }
  const fromEnv =
    typeof process.env.PRESALE_PARTICIPATION_FILE === "string"
      ? process.env.PRESALE_PARTICIPATION_FILE.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_PRESALE_FILE;
}

function loadPresaleStore(presaleFile) {
  const filePath = resolvePresaleFile(presaleFile);
  try {
    if (!fs.existsSync(filePath)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    logError("Error reading presale-participation.json:", err);
    return emptyStore();
  }
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyParticipation();
  }
  const lamports = parseLamportsInteger(raw.contributedLamports);
  const walletSnapshot = normalizeSolanaPublicKey(raw.walletSnapshot);
  const txs = Array.isArray(raw.transactions) ? raw.transactions : [];
  const recorded = Boolean(walletSnapshot && lamports.ok && BigInt(lamports.lamports) > 0n);
  return {
    recorded,
    status: recorded ? "recorded" : "not-started",
    walletSnapshot: walletSnapshot || null,
    contributedLamports: lamports.ok ? lamports.lamports : "0",
    allocation:
      typeof raw.allocation === "string" && raw.allocation.trim()
        ? raw.allocation.trim()
        : null,
    transactions: txs,
    updatedAt: Number(raw.updatedAt) || null,
  };
}

/**
 * Read-only participation for a Telegram user.
 * Missing file / empty store → not-started (presale is not live).
 */
function getPresaleParticipation(userId, presaleFile) {
  if (!PRESALE_LIVE) {
    return emptyParticipation();
  }
  const uid = normalizeUserId(userId);
  if (!uid) {
    return emptyParticipation();
  }
  const store = loadPresaleStore(presaleFile);
  return normalizeRecord(store.users[uid]);
}

function getPresalePublicStatus() {
  if (!PRESALE_LIVE) {
    return {
      live: false,
      label: "Coming soon",
      userLine: "Coming soon",
    };
  }
  return {
    live: true,
    label: "Live",
    userLine: "Live",
  };
}

/**
 * Historical contribution stays on walletSnapshot. No automatic migration.
 * @param {string|null} currentVerifiedWallet
 * @param {ReturnType<typeof emptyParticipation>} participation
 */
function describeWalletReplacementPolicy(currentVerifiedWallet, participation) {
  const current = normalizeSolanaPublicKey(currentVerifiedWallet);
  if (!participation || !participation.recorded) {
    return {
      conflict: false,
      migratesAutomatically: false,
      message: "No recorded presale participation.",
    };
  }
  const snapshot = participation.walletSnapshot;
  const conflict = Boolean(current && snapshot && current !== snapshot);
  return {
    conflict,
    migratesAutomatically: false,
    snapshotWallet: snapshot,
    currentWallet: current,
    message: conflict
      ? "Historical contribution stays on the original walletSnapshot. No automatic migration."
      : "Current verified wallet matches the contribution snapshot.",
  };
}

function formatPresaleWalletLines(participation) {
  const publicStatus = getPresalePublicStatus();
  if (!publicStatus.live) {
    return ["Presale:", publicStatus.userLine];
  }
  if (!participation || !participation.recorded) {
    return ["Presale:", "No participation recorded"];
  }
  return [
    "Presale:",
    "✅ Participating",
    `Contributed: ${formatLamportsAsSol(participation.contributedLamports)} SOL`,
    participation.allocation ? `Allocation: ${participation.allocation}` : "Allocation: pending",
  ];
}

module.exports = {
  PRESALE_LIVE,
  LAMPORTS_PER_SOL,
  emptyParticipation,
  solStringToLamports,
  parseLamportsInteger,
  formatLamportsAsSol,
  getPresaleParticipation,
  getPresalePublicStatus,
  describeWalletReplacementPolicy,
  formatPresaleWalletLines,
  loadPresaleStore,
  normalizeRecord,
};
