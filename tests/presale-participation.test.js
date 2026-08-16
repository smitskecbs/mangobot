/**
 * Presale participation model: no fake payments, integer lamports, replacement policy.
 * Run: node tests/presale-participation.test.js
 */

const assert = require("assert");
const crypto = require("node:crypto");
const { encodeBase58 } = require("../utils/base58");
const {
  PRESALE_LIVE,
  solStringToLamports,
  parseLamportsInteger,
  formatLamportsAsSol,
  getPresaleParticipation,
  getPresalePublicStatus,
  describeWalletReplacementPolicy,
  normalizeRecord,
  emptyParticipation,
} = require("../services/presaleParticipation");

function runTest(name, fn) {
  fn();
  console.log(`✓ ${name}`);
}

function generateAddress() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  return encodeBase58(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
}

runTest("22. no fake contribution without verified source", () => {
  assert.strictEqual(PRESALE_LIVE, false);
  const participation = getPresaleParticipation(1);
  assert.strictEqual(participation.recorded, false);
  assert.strictEqual(participation.status, "not-started");
  assert.strictEqual(participation.contributedLamports, "0");
  assert.strictEqual(getPresalePublicStatus().live, false);
  assert.strictEqual(getPresalePublicStatus().userLine, "Coming soon");
});

runTest("23. wallet replacement history safe", () => {
  const paidWith = generateAddress();
  const laterWallet = generateAddress();
  const record = normalizeRecord({
    walletSnapshot: paidWith,
    contributedLamports: "1000000000",
    allocation: null,
    transactions: ["onchain-later"],
    updatedAt: 1,
  });
  assert.strictEqual(record.recorded, true);
  const policy = describeWalletReplacementPolicy(laterWallet, record);
  assert.strictEqual(policy.conflict, true);
  assert.strictEqual(policy.migratesAutomatically, false);
  assert.strictEqual(policy.snapshotWallet, paidWith);
  const same = describeWalletReplacementPolicy(paidWith, record);
  assert.strictEqual(same.conflict, false);
  const none = describeWalletReplacementPolicy(laterWallet, emptyParticipation());
  assert.strictEqual(none.conflict, false);
});

runTest("24. amount uses integer lamports", () => {
  assert.deepStrictEqual(solStringToLamports("1"), { ok: true, lamports: "1000000000" });
  assert.deepStrictEqual(solStringToLamports("0.01"), { ok: true, lamports: "10000000" });
  assert.deepStrictEqual(parseLamportsInteger("1000000000"), {
    ok: true,
    lamports: "1000000000",
  });
  assert.strictEqual(formatLamportsAsSol("10000000"), "0.01");
});

runTest("25. no float accounting", () => {
  assert.strictEqual(solStringToLamports(0.1).ok, false);
  assert.strictEqual(solStringToLamports("1.0000000001").ok, false);
  assert.strictEqual(solStringToLamports("-1").ok, false);
  assert.strictEqual(parseLamportsInteger(1.5).ok, false);
  assert.strictEqual(parseLamportsInteger("1.0").ok, false);
  assert.strictEqual(typeof solStringToLamports("1.23").lamports, "string");
});

console.log("presale-participation tests passed");
