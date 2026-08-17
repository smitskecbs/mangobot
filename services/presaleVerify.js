/**
 * On-chain presale payment verification. Server never signs.
 * Accepts jsonParsed getTransaction fixtures in tests.
 */

const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const {
  SYSTEM_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  parseLamportsInteger,
} = require("./presaleConstants");

const CLOCK_SKEW_MS = 30_000;

function accountPubkey(key) {
  if (typeof key === "string") {
    return normalizeSolanaPublicKey(key);
  }
  if (key && typeof key === "object" && typeof key.pubkey === "string") {
    return normalizeSolanaPublicKey(key.pubkey);
  }
  return null;
}

function collectInstructions(tx) {
  const message = tx && tx.transaction && tx.transaction.message;
  const top = message && Array.isArray(message.instructions) ? message.instructions : [];
  const inner =
    tx &&
    tx.meta &&
    Array.isArray(tx.meta.innerInstructions)
      ? tx.meta.innerInstructions.flatMap((group) =>
          Array.isArray(group.instructions) ? group.instructions : []
        )
      : [];
  return top.concat(inner);
}

function instructionProgramId(ix) {
  if (!ix || typeof ix !== "object") {
    return "";
  }
  if (typeof ix.programId === "string") {
    return ix.programId;
  }
  return "";
}

function parseSystemTransfer(ix) {
  if (!ix || typeof ix !== "object") {
    return null;
  }
  const programId = instructionProgramId(ix);
  const parsed = ix.parsed;
  if (
    (programId === SYSTEM_PROGRAM_ID || ix.program === "system") &&
    parsed &&
    typeof parsed === "object" &&
    parsed.type === "transfer" &&
    parsed.info &&
    typeof parsed.info === "object"
  ) {
    const source = normalizeSolanaPublicKey(parsed.info.source);
    const destination = normalizeSolanaPublicKey(parsed.info.destination);
    const lamports = parseLamportsInteger(parsed.info.lamports);
    if (source && destination && lamports.ok) {
      return { source, destination, lamports: lamports.lamports };
    }
  }
  return null;
}

function parseMemo(ix) {
  if (!ix || typeof ix !== "object") {
    return "";
  }
  const programId = instructionProgramId(ix);
  if (programId !== MEMO_PROGRAM_ID && ix.program !== "spl-memo") {
    return "";
  }
  if (typeof ix.parsed === "string") {
    return ix.parsed;
  }
  if (ix.parsed && typeof ix.parsed === "object" && typeof ix.parsed.info === "string") {
    return ix.parsed.info;
  }
  return "";
}

function transactionSucceeded(tx) {
  if (!tx || typeof tx !== "object") {
    return false;
  }
  const meta = tx.meta;
  if (!meta || typeof meta !== "object") {
    return false;
  }
  if (meta.err !== null && meta.err !== undefined) {
    return false;
  }
  return true;
}

/**
 * @param {object} tx getTransaction result
 * @param {{ expectedWallet: string, treasury: string, expectedLamports: string, memo: string, createdAt: number }} expected
 */
function verifyPresaleTransaction(tx, expected, options = {}) {
  if (!tx) {
    return { ok: false, reason: "missing-tx", error: "This transaction could not be verified." };
  }
  if (!transactionSucceeded(tx)) {
    return { ok: false, reason: "failed-tx", error: "This transaction could not be verified." };
  }

  const expectedWallet = normalizeSolanaPublicKey(expected.expectedWallet);
  const treasury = normalizeSolanaPublicKey(expected.treasury);
  const expectedLamports = parseLamportsInteger(expected.expectedLamports);
  if (!expectedWallet || !treasury || !expectedLamports.ok) {
    return { ok: false, reason: "invalid-expected", error: "This transaction could not be verified." };
  }

  const signatures =
    tx.transaction && Array.isArray(tx.transaction.signatures)
      ? tx.transaction.signatures
      : [];
  if (!signatures.length || typeof signatures[0] !== "string") {
    return { ok: false, reason: "no-signature", error: "This transaction could not be verified." };
  }

  const message = tx.transaction.message || {};
  const accountKeys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const feePayer = accountPubkey(accountKeys[0]);
  if (feePayer !== expectedWallet) {
    return { ok: false, reason: "wrong-sender", error: "This transaction could not be verified." };
  }

  const instructions = collectInstructions(tx);
  const transfers = instructions.map(parseSystemTransfer).filter(Boolean);
  if (transfers.length !== 1) {
    return { ok: false, reason: "multiple-transfers", error: "This transaction could not be verified." };
  }
  const matching = transfers[0];
  if (matching.source !== expectedWallet) {
    return { ok: false, reason: "wrong-sender", error: "This transaction could not be verified." };
  }
  if (matching.destination !== treasury) {
    return { ok: false, reason: "wrong-treasury", error: "This transaction could not be verified." };
  }
  if (BigInt(matching.lamports) !== BigInt(expectedLamports.lamports)) {
    return { ok: false, reason: "wrong-amount", error: "This transaction could not be verified." };
  }

  const memos = instructions.map(parseMemo).filter(Boolean);
  if (!expected.memo || !memos.includes(expected.memo)) {
    return { ok: false, reason: "memo-mismatch", error: "This transaction could not be verified." };
  }

  const createdAt = Number(expected.createdAt) || 0;
  const blockTime = Number(tx.blockTime);
  if (createdAt > 0) {
    if (!Number.isFinite(blockTime) || blockTime <= 0) {
      return { ok: false, reason: "old-tx", error: "This transaction could not be verified." };
    }
    const skew = options.clockSkewMs === undefined ? CLOCK_SKEW_MS : options.clockSkewMs;
    if (blockTime * 1000 < createdAt - skew) {
      return { ok: false, reason: "old-tx", error: "This transaction could not be verified." };
    }
  }

  if (expected.recentBlockhash) {
    const txHash =
      (message && typeof message.recentBlockhash === "string" && message.recentBlockhash) ||
      (tx.transaction && typeof tx.transaction.recentBlockhash === "string"
        ? tx.transaction.recentBlockhash
        : "");
    if (txHash !== expected.recentBlockhash) {
      return { ok: false, reason: "blockhash-mismatch", error: "This transaction could not be verified." };
    }
  }

  return {
    ok: true,
    signature: signatures[0],
    transferredLamports: matching.lamports,
    sender: matching.source,
    destination: matching.destination,
  };
}

module.exports = {
  CLOCK_SKEW_MS,
  verifyPresaleTransaction,
  parseSystemTransfer,
  parseMemo,
  transactionSucceeded,
};
