/**
 * On-chain SPL MANGO delivery verification. Server never signs.
 * Accepts jsonParsed getTransaction fixtures in tests.
 */

const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const { parseMemo, transactionSucceeded } = require("./presaleVerify");
const {
  MANGO_MINT,
  TOKEN_PROGRAM_ID,
  parseBaseUnits,
} = require("./deliveryConstants");

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

function parseTokenTransfer(ix) {
  if (!ix || typeof ix !== "object") {
    return null;
  }
  const programId = instructionProgramId(ix);
  const parsed = ix.parsed;
  if (
    programId !== TOKEN_PROGRAM_ID &&
    ix.program !== "spl-token" &&
    ix.program !== "spl-token-2022"
  ) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if (parsed.type !== "transferChecked" && parsed.type !== "transfer") {
    return null;
  }
  const info = parsed.info && typeof parsed.info === "object" ? parsed.info : {};
  const authority = normalizeSolanaPublicKey(info.authority || info.multisigAuthority);
  const source = normalizeSolanaPublicKey(info.source);
  const destination = normalizeSolanaPublicKey(info.destination);
  const mint = normalizeSolanaPublicKey(info.mint) || null;
  let amount = null;
  if (info.tokenAmount && typeof info.tokenAmount === "object") {
    const parsedAmount = parseBaseUnits(info.tokenAmount.amount);
    if (parsedAmount.ok) {
      amount = parsedAmount.lamports;
    }
  } else {
    const parsedAmount = parseBaseUnits(info.amount);
    if (parsedAmount.ok) {
      amount = parsedAmount.lamports;
    }
  }
  if (!authority || !source || !destination || !amount) {
    return null;
  }
  return { authority, source, destinationAta: destination, mint, amount };
}

function tokenBalanceOwnerDelta(tx, mint, owner) {
  const expectedMint = normalizeSolanaPublicKey(mint);
  const expectedOwner = normalizeSolanaPublicKey(owner);
  if (!expectedMint || !expectedOwner) {
    return null;
  }
  const pre = Array.isArray(tx && tx.meta && tx.meta.preTokenBalances)
    ? tx.meta.preTokenBalances
    : [];
  const post = Array.isArray(tx && tx.meta && tx.meta.postTokenBalances)
    ? tx.meta.postTokenBalances
    : [];

  function amountFor(list) {
    let total = 0n;
    for (const row of list) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const rowMint = normalizeSolanaPublicKey(row.mint);
      const rowOwner = normalizeSolanaPublicKey(row.owner);
      if (rowMint !== expectedMint || rowOwner !== expectedOwner) {
        continue;
      }
      const parsed = parseBaseUnits(
        row.uiTokenAmount && row.uiTokenAmount.amount
      );
      if (parsed.ok) {
        total += BigInt(parsed.lamports);
      }
    }
    return total;
  }

  return amountFor(post) - amountFor(pre);
}

/**
 * @param {object} tx
 * @param {{ expectedSigner: string, destinationOwner: string, mint: string, amountBaseUnits: string, memo: string, createdAt?: number }} expected
 */
function verifyDeliveryTransaction(tx, expected, options = {}) {
  if (!tx) {
    return { ok: false, reason: "missing-tx", error: "This transaction could not be verified." };
  }
  if (!transactionSucceeded(tx)) {
    return { ok: false, reason: "failed-tx", error: "This transaction could not be verified." };
  }

  const expectedSigner = normalizeSolanaPublicKey(expected.expectedSigner);
  const destinationOwner = normalizeSolanaPublicKey(expected.destinationOwner);
  const mint = normalizeSolanaPublicKey(expected.mint) || MANGO_MINT;
  const expectedAmount = parseBaseUnits(expected.amountBaseUnits);
  if (!expectedSigner || !destinationOwner || !mint || !expectedAmount.ok) {
    return { ok: false, reason: "invalid-expected", error: "This transaction could not be verified." };
  }
  if (mint !== MANGO_MINT) {
    return { ok: false, reason: "wrong-mint", error: "This transaction could not be verified." };
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
  if (feePayer !== expectedSigner) {
    return { ok: false, reason: "wrong-signer", error: "This transaction could not be verified." };
  }

  const instructions = collectInstructions(tx);
  const transfers = instructions.map(parseTokenTransfer).filter(Boolean);
  if (transfers.length !== 1) {
    return {
      ok: false,
      reason: "multiple-transfers",
      error: "This transaction could not be verified.",
    };
  }
  const transfer = transfers[0];
  if (transfer.authority !== expectedSigner) {
    return { ok: false, reason: "wrong-signer", error: "This transaction could not be verified." };
  }
  if (transfer.mint && transfer.mint !== mint) {
    return { ok: false, reason: "wrong-mint", error: "This transaction could not be verified." };
  }
  if (BigInt(transfer.amount) !== BigInt(expectedAmount.lamports)) {
    return { ok: false, reason: "wrong-amount", error: "This transaction could not be verified." };
  }

  const destDelta = tokenBalanceOwnerDelta(tx, mint, destinationOwner);
  if (destDelta !== BigInt(expectedAmount.lamports)) {
    return {
      ok: false,
      reason: "wrong-destination",
      error: "This transaction could not be verified.",
    };
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

  return {
    ok: true,
    signature: signatures[0],
    amountBaseUnits: transfer.amount,
    signer: transfer.authority,
    destinationOwner,
    mint,
  };
}

module.exports = {
  CLOCK_SKEW_MS,
  verifyDeliveryTransaction,
  parseTokenTransfer,
  tokenBalanceOwnerDelta,
};
