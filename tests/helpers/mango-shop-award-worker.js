/**
 * Worker: award Loot against a shared shop file.
 * node tests/helpers/mango-shop-award-worker.js <shopFile> <userId> <amount> <reason> <referenceId>
 */

const { awardLoot } = require("../../services/mangoLoot");

const shopFile = process.argv[2];
const userId = process.argv[3];
const amount = Number(process.argv[4]);
const reason = process.argv[5];
const referenceId = process.argv[6];

if (!shopFile || !userId || !Number.isInteger(amount) || !reason || !referenceId) {
  process.exit(2);
}

try {
  const result = awardLoot(userId, amount, reason, referenceId, { shopFile });
  process.stdout.write(
    JSON.stringify({
      ok: result.ok,
      duplicate: Boolean(result.duplicate),
      balance: result.balance,
      reason: result.reason || null,
    })
  );
} catch (err) {
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exit(1);
}
