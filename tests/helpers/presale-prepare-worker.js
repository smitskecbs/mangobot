/**
 * Cross-process presale prepare worker.
 * Usage: node tests/helpers/presale-prepare-worker.js '<json>'
 */
const { preparePresalePayment } = require("../../services/presaleLedger");

let payload;
try {
  payload = JSON.parse(process.argv[2] || "{}");
} catch {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "invalid-json" })}\n`);
  process.exit(1);
}

(async () => {
  const result = await preparePresalePayment(payload.token, payload.lamports, {
    walletFile: payload.walletFile,
    presaleFile: payload.presaleFile,
    env: payload.env,
    now: payload.now,
    currentBlockHeight: payload.currentBlockHeight,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: Boolean(result.ok),
      reason: result.reason || null,
      orderId: result.orderId || null,
    })}\n`
  );
})().catch((err) => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: String(err && err.message) })}\n`);
});
