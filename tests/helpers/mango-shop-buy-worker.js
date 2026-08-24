/**
 * Worker: one title purchase against a shared shop file.
 * node tests/helpers/mango-shop-buy-worker.js <shopFile> <pointsFile> <builderFile> <userId> <titleId>
 */

const { purchaseTitle } = require("../../services/mangoShop");

const shopFile = process.argv[2];
const pointsFile = process.argv[3];
const builderFile = process.argv[4];
const userId = process.argv[5];
const titleId = process.argv[6];

if (!shopFile || !pointsFile || !builderFile || !userId || !titleId) {
  process.exit(2);
}

try {
  const result = purchaseTitle(userId, titleId, {
    shopFile,
    pointsFile,
    builderFile,
  });
  process.stdout.write(JSON.stringify({ ok: result.ok, reason: result.reason || null, duplicate: Boolean(result.duplicate) }));
} catch (err) {
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exit(1);
}
