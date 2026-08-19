/**
 * Bounded retry of submitted MANGO deliveries with a known signature.
 * No chain-wide scan. Never builds or sends a new transaction.
 */

const { error: logError } = require("../utils/logger");
const { listSubmittedRewards, bumpRewardReconcileAttempts } = require("./memberRewards");
const { reconcileDeliveryPayment } = require("./rewardDelivery");

const RECONCILE_TICK_MS = 30_000;
const MAX_PER_TICK = 5;
const MAX_ATTEMPTS = 20;

function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_DELIVERY === "1") {
    return true;
  }
  for (const arg of process.argv) {
    if (typeof arg !== "string") {
      continue;
    }
    const norm = arg.replace(/\\/g, "/");
    if (norm.includes("/tests/") || /\.test\.js$/i.test(norm)) {
      return true;
    }
  }
  return false;
}

async function reconcileSubmittedDeliveries(options = {}) {
  const maxPerTick = Number(options.maxPerTick) > 0 ? Number(options.maxPerTick) : MAX_PER_TICK;
  const maxAttempts = Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : MAX_ATTEMPTS;
  const submitted = listSubmittedRewards(options.rewardsFile);
  const results = [];
  let processed = 0;
  for (const reward of submitted) {
    if (processed >= maxPerTick) {
      break;
    }
    const attempts = Number(reward.reconcileAttempts) || 0;
    if (attempts >= maxAttempts) {
      continue;
    }
    processed += 1;
    bumpRewardReconcileAttempts(reward.rewardId, { rewardsFile: options.rewardsFile });
    try {
      const result = await reconcileDeliveryPayment({
        ...options,
        allowInternal: true,
        rewardId: reward.rewardId,
        signature: reward.txSignature,
      });
      results.push({ rewardId: reward.rewardId, ok: Boolean(result && result.ok), pending: Boolean(result && result.pending) });
    } catch (err) {
      const code = (err && err.code) || (err && err.name) || "Error";
      logError(`[delivery] reconcile tick failed error=${code}`);
      results.push({ rewardId: reward.rewardId, ok: false });
    }
  }
  return { processed, results };
}

let deliveryReconcileTimer = null;

function startDeliveryReconciliationTimer(options = {}) {
  if (isLikelyTestProcess() && options.force !== true) {
    return null;
  }
  if (deliveryReconcileTimer) {
    return deliveryReconcileTimer;
  }
  const ms = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : RECONCILE_TICK_MS;
  deliveryReconcileTimer = setInterval(() => {
    reconcileSubmittedDeliveries(options).catch((err) => {
      const code = (err && err.code) || (err && err.name) || "Error";
      logError(`[delivery] reconcile tick failed error=${code}`);
    });
  }, ms);
  if (typeof deliveryReconcileTimer.unref === "function") {
    deliveryReconcileTimer.unref();
  }
  return deliveryReconcileTimer;
}

function stopDeliveryReconciliationTimer() {
  if (deliveryReconcileTimer) {
    clearInterval(deliveryReconcileTimer);
    deliveryReconcileTimer = null;
  }
}

module.exports = {
  RECONCILE_TICK_MS,
  MAX_PER_TICK,
  MAX_ATTEMPTS,
  reconcileSubmittedDeliveries,
  startDeliveryReconciliationTimer,
  stopDeliveryReconciliationTimer,
};
