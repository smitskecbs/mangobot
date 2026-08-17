/**
 * Cross-process presale reconcile worker.
 * Usage: node tests/helpers/presale-reconcile-worker.js '<json>'
 */
const { reconcilePresaleOrder } = require("../../services/presaleLedger");

let payload;
try {
  payload = JSON.parse(process.argv[2] || "{}");
} catch {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "invalid-json" })}\n`);
  process.exit(1);
}

(async () => {
  const txs = payload.transactions || {};
  const signatures = Array.isArray(payload.signatures) ? payload.signatures : [];
  const result = await reconcilePresaleOrder(payload.orderId, {
    walletFile: payload.walletFile,
    presaleFile: payload.presaleFile,
    env: payload.env,
    now: payload.now,
    currentBlockHeight: payload.currentBlockHeight,
    getSignaturesForAddressImpl: async () => ({ ok: true, result: signatures }),
    getTransactionImpl: async (signature) => {
      if (Object.prototype.hasOwnProperty.call(txs, signature)) {
        return { ok: true, result: txs[signature] };
      }
      return { ok: true, result: null };
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: Boolean(result.ok),
      reason: result.reason || null,
      expired: Boolean(result.expired),
      pending: Boolean(result.pending),
      confirmed: Boolean(result.contribution),
    })}\n`
  );
})().catch((err) => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: String(err && err.message) })}\n`);
});
