/**
 * Treasury history scan for presale order reconciliation.
 * Bounded getSignaturesForAddress + exact getTransaction matching.
 * Does not mutate the ledger.
 */

const { getSignaturesForAddress, getTransaction } = require("./presaleRpc");
const { verifyPresaleTransaction, CLOCK_SKEW_MS } = require("./presaleVerify");
const {
  RECONCILE_PAGE_SIZE,
  RECONCILE_MAX_PAGES,
} = require("./presaleConstants");

function expectedFromOrder(order, treasury) {
  return {
    expectedWallet: order.walletSnapshot,
    treasury,
    expectedLamports: order.requestedLamports || order.lamports,
    memo: order.memo,
    createdAt: order.createdAt,
    recentBlockhash: order.recentBlockhash,
  };
}

function cutoffUnixSeconds(order) {
  const createdAt = Number(order && order.createdAt) || 0;
  return Math.floor((createdAt - CLOCK_SKEW_MS) / 1000);
}

/**
 * Scan recent treasury signatures for exact matches to one order.
 * coverage:
 *   complete  — walked past order window or reached history end
 *   uncertain — page/RPC bound hit before the window was covered
 *   conflict  — more than one exact match
 */
async function scanTreasuryForOrder(order, treasury, options = {}) {
  if (!order || !treasury) {
    return { ok: false, reason: "invalid", matches: [], coverage: "uncertain" };
  }
  const expected = expectedFromOrder(order, treasury);
  const cutoff = cutoffUnixSeconds(order);
  const matches = [];
  let before;
  let sawOlderThanCutoff = false;
  let reachedEnd = false;
  let pages = 0;
  let scanned = 0;

  while (pages < RECONCILE_MAX_PAGES) {
    pages += 1;
    const page = await getSignaturesForAddress(
      treasury,
      { limit: RECONCILE_PAGE_SIZE, before },
      options
    );
    if (!page.ok) {
      return { ok: false, reason: page.reason || "rpc", matches, coverage: "uncertain" };
    }
    const list = Array.isArray(page.result) ? page.result : [];
    if (list.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const item of list) {
      if (!item || typeof item.signature !== "string") {
        return { ok: false, reason: "rpc-malformed", matches, coverage: "uncertain" };
      }
      scanned += 1;
      const blockTime = Number(item.blockTime);
      if (Number.isFinite(blockTime) && cutoff > 0 && blockTime < cutoff) {
        sawOlderThanCutoff = true;
        break;
      }
      if (item.err !== null && item.err !== undefined) {
        continue;
      }
      if (typeof item.memo === "string" && item.memo && item.memo !== order.memo) {
        continue;
      }
      const tx = await getTransaction(item.signature, options);
      if (!tx.ok) {
        return { ok: false, reason: tx.reason || "rpc", matches, coverage: "uncertain" };
      }
      if (!tx.result) {
        continue;
      }
      const verified = verifyPresaleTransaction(tx.result, expected);
      if (verified.ok) {
        matches.push({
          signature: verified.signature || item.signature,
          tx: tx.result,
        });
        if (matches.length > 1) {
          return { ok: true, matches, coverage: "conflict", pages, scanned };
        }
      }
    }
    if (sawOlderThanCutoff) {
      break;
    }
    if (list.length < RECONCILE_PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
    before = list[list.length - 1].signature;
  }

  const complete = sawOlderThanCutoff || reachedEnd;
  return {
    ok: true,
    matches,
    coverage: complete ? "complete" : "uncertain",
    pages,
    scanned,
  };
}

function needsReconciliation(order, blockHeight) {
  if (!order || typeof order !== "object") {
    return false;
  }
  const status = order.status;
  if (
    status !== "payment-ready" &&
    status !== "submitted" &&
    status !== "reconciliation-pending"
  ) {
    return false;
  }
  if (status === "reconciliation-pending") {
    return true;
  }
  const last = Number(order.lastValidBlockHeight);
  if (!Number.isFinite(last) || last <= 0) {
    return false;
  }
  if (!Number.isFinite(blockHeight)) {
    return false;
  }
  return Number(blockHeight) > last;
}

module.exports = {
  scanTreasuryForOrder,
  needsReconciliation,
  expectedFromOrder,
  cutoffUnixSeconds,
};
