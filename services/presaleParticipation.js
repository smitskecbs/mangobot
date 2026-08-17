/**
 * Presale participation facade.
 *
 * Payment, sessions, and on-chain verify live in presaleLedger / presaleApi.
 * This module keeps integer helpers and read models used by Telegram UX.
 */

const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const { isPresaleLive } = require("./presaleConfig");
const {
  LAMPORTS_PER_SOL,
  solStringToLamports,
  parseLamportsInteger,
  formatLamportsAsSol,
} = require("./presaleConstants");
const {
  getPresaleParticipation,
  getPresalePublicStatus,
  getPresaleStatus,
  getRemainingPresaleLamports,
  getRemainingPresaleAllocation,
  canUserContribute,
} = require("./presaleLedger");
const { loadPresaleStore } = require("./presaleStore");

/** Default production flag. Runtime liveness uses PRESALE_ENABLED + treasury. */
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

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyParticipation();
  }
  if (Array.isArray(raw.contributions) && raw.contributions.length) {
    const last = raw.contributions[raw.contributions.length - 1];
    const lamports = parseLamportsInteger(raw.confirmedLamports || last.contributedLamports);
    const walletSnapshot = normalizeSolanaPublicKey(last.walletSnapshot);
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
      transactions: raw.contributions.map((item) => item.transactionSignature).filter(Boolean),
      updatedAt: Number(last.confirmedAt) || null,
    };
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
  if (!publicStatus.live && !(participation && participation.recorded)) {
    return ["Presale:", publicStatus.userLine];
  }
  if (!participation || !participation.recorded) {
    return ["Presale:", "No participation recorded"];
  }
  return [
    "Presale:",
    "✅ Participating",
    `Contributed: ${formatLamportsAsSol(participation.contributedLamports)} SOL`,
    participation.allocation
      ? `Allocation: ${participation.allocation} MANGO`
      : "Allocation: pending",
  ];
}

function toLegacyParticipation(summary) {
  if (!summary || !summary.recorded) {
    return emptyParticipation();
  }
  return {
    recorded: true,
    status: "recorded",
    walletSnapshot: summary.walletSnapshot,
    contributedLamports: summary.confirmedLamports,
    allocation: summary.allocation,
    transactions: (summary.contributions || [])
      .map((item) => item.transactionSignature)
      .filter(Boolean),
    updatedAt: summary.updatedAt,
  };
}

function getPresaleParticipationLegacy(userId, presaleFile) {
  return toLegacyParticipation(getPresaleParticipation(userId, presaleFile));
}

module.exports = {
  PRESALE_LIVE,
  LAMPORTS_PER_SOL,
  emptyParticipation,
  solStringToLamports,
  parseLamportsInteger,
  formatLamportsAsSol,
  getPresaleParticipation: getPresaleParticipationLegacy,
  getPresaleParticipationFull: getPresaleParticipation,
  getPresalePublicStatus,
  getPresaleStatus,
  getRemainingPresaleLamports,
  getRemainingPresaleAllocation,
  canUserContribute,
  describeWalletReplacementPolicy,
  formatPresaleWalletLines,
  loadPresaleStore,
  normalizeRecord,
  isPresaleLive,
};
