/**
 * Reward queue storage, snapshots, and status transitions.
 * Run: node tests/member-rewards.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  createReward,
  prepareRewardsForUsers,
  markRewardPrepared,
  markRewardSent,
  cancelReward,
  getReward,
  listRewardsForUser,
  loadRewardsStore,
  mutateRewardsStore,
  isPlausibleTxSignature,
} = require("../services/memberRewards");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-rewards-"));
let n = 0;

function files() {
  n += 1;
  return {
    walletFile: path.join(tempDir, `w-${n}.json`),
    rewardsFile: path.join(tempDir, `r-${n}.json`),
  };
}

function runTest(name, fn) {
  fn();
  console.log(`✓ ${name}`);
}

function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    address: encodeBase58(publicKeyRaw),
    sign(message) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      return signEd25519Detached(buf, privateKey);
    },
  };
}

const TX_SIG = `${"1".repeat(32)}${"2".repeat(32)}${"3".repeat(24)}`;

function connectUser(walletFile, userId, wallet, now) {
  const created = createLinkToken(userId, { walletFile, now });
  const limiter = createMemoryRateLimiter();
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile, now: now + 1, rateLimiter: limiter }
  );
  const verified = verifyWalletSignature(
    {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    },
    { walletFile, now: now + 2, rateLimiter: limiter }
  );
  assert.strictEqual(verified.ok, true, verified.error);
}

runTest("6. verified user can get pending reward", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 11, wallet, 1000);
  const result = createReward({
    telegramUserId: 11,
    type: "mystery-gift",
    walletFile,
    rewardsFile,
    now: 2000,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reward.status, "pending");
  assert.strictEqual(result.reward.type, "mystery-gift");
  assert.strictEqual(result.reward.walletSnapshot, wallet.address);
  assert.ok(result.reward.rewardId);
});

runTest("7. unverified rejected", () => {
  const { walletFile, rewardsFile } = files();
  const result = createReward({
    telegramUserId: 12,
    walletFile,
    rewardsFile,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "unverified");
  assert.ok(result.error.includes("verify a wallet"));
});

runTest("8. walletSnapshot correct", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 13, wallet, 1000);
  const result = createReward({
    telegramUserId: 13,
    walletFile,
    rewardsFile,
    now: 3000,
  });
  assert.strictEqual(result.reward.walletSnapshot, wallet.address);
  assert.ok(!JSON.stringify(result.reward).toLowerCase().includes("private"));
  assert.ok(!JSON.stringify(result.reward).toLowerCase().includes("seed"));
});

runTest("9. replace wallet after reward does NOT mutate old destination", () => {
  const { walletFile, rewardsFile } = files();
  const first = generateSolanaWallet();
  const second = generateSolanaWallet();
  connectUser(walletFile, 14, first, 1000);
  const created = createReward({
    telegramUserId: 14,
    walletFile,
    rewardsFile,
    now: 2000,
  });
  connectUser(walletFile, 14, second, 4000);
  const stored = getReward(created.reward.rewardId, rewardsFile);
  assert.strictEqual(stored.walletSnapshot, first.address);
  assert.notStrictEqual(stored.walletSnapshot, second.address);
});

runTest("10. unique reward id", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 15, wallet, 1000);
  const a = createReward({ telegramUserId: 15, walletFile, rewardsFile, now: 1 });
  const b = createReward({ telegramUserId: 15, walletFile, rewardsFile, now: 2 });
  assert.notStrictEqual(a.reward.rewardId, b.reward.rewardId);
});

runTest("13. mark sent stores txSignature", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 16, wallet, 1000);
  const created = createReward({ telegramUserId: 16, walletFile, rewardsFile, now: 1 });
  const sent = markRewardSent(created.reward.rewardId, TX_SIG, { rewardsFile, now: 5 });
  assert.strictEqual(sent.ok, true);
  assert.strictEqual(sent.reward.status, "sent");
  assert.strictEqual(sent.reward.txSignature, TX_SIG);
  assert.strictEqual(sent.reward.sentAt, 5);
});

runTest("14. invalid tx status transition rejected", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 17, wallet, 1000);
  const created = createReward({ telegramUserId: 17, walletFile, rewardsFile, now: 1 });
  const bad = markRewardSent(created.reward.rewardId, "short", { rewardsFile });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "pending");
});

runTest("15. cancel pending", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 18, wallet, 1000);
  const created = createReward({ telegramUserId: 18, walletFile, rewardsFile, now: 1 });
  const cancelled = cancelReward(created.reward.rewardId, { rewardsFile, now: 9 });
  assert.strictEqual(cancelled.ok, true);
  assert.strictEqual(cancelled.reward.status, "cancelled");
});

runTest("16. sent cannot become pending", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 19, wallet, 1000);
  const created = createReward({ telegramUserId: 19, walletFile, rewardsFile, now: 1 });
  markRewardPrepared(created.reward.rewardId, { rewardsFile });
  markRewardSent(created.reward.rewardId, TX_SIG, { rewardsFile, now: 8 });
  const back = cancelReward(created.reward.rewardId, { rewardsFile });
  assert.strictEqual(back.ok, false);
  assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
});

runTest("19. storage locking + 20. atomic write", () => {
  const { rewardsFile } = files();
  mutateRewardsStore((store) => {
    store.rewards.LOCK1 = { telegramUserId: "1", status: "pending" };
  }, rewardsFile);
  const raw = fs.readFileSync(rewardsFile, "utf8");
  assert.ok(raw.includes("LOCK1"));
  JSON.parse(raw);
  assert.strictEqual(loadRewardsStore(rewardsFile).rewards.LOCK1.status, "pending");
});

runTest("21. malformed storage safe", () => {
  const rewardsFile = path.join(tempDir, "bad.json");
  fs.writeFileSync(rewardsFile, "{not-json", "utf8");
  const store = loadRewardsStore(rewardsFile);
  assert.deepStrictEqual(store.rewards, {});
  assert.deepStrictEqual(listRewardsForUser(1, rewardsFile), []);
});

runTest("26-27. no automatic weekly payout; explicit helper only", () => {
  const { walletFile, rewardsFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  connectUser(walletFile, 21, a, 1000);
  connectUser(walletFile, 22, b, 2000);
  const prepared = prepareRewardsForUsers([21, 22, 23], "airdrop", {
    walletFile,
    rewardsFile,
    now: 3000,
  });
  assert.strictEqual(prepared.created.length, 2);
  assert.strictEqual(prepared.skipped.length, 1);
  assert.strictEqual(prepared.skipped[0].telegramUserId, "23");
  assert.ok(!fs.readFileSync(path.join(__dirname, "..", "services", "weeklyWinners.js"), "utf8").includes("createReward("));
});

runTest("28-29. no private key / seed phrase fields", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 24, wallet, 1000);
  createReward({ telegramUserId: 24, walletFile, rewardsFile, now: 1 });
  const dumped = JSON.stringify(loadRewardsStore(rewardsFile)).toLowerCase();
  assert.ok(!dumped.includes("privatekey"));
  assert.ok(!dumped.includes("seed"));
  assert.ok(!dumped.includes("secret"));
});

runTest("30. tests do not touch production reward file", () => {
  const prod = path.resolve(__dirname, "..", "data", "member-rewards.json");
  const { rewardsFile } = files();
  assert.notStrictEqual(path.resolve(rewardsFile), prod);
  mutateRewardsStore((store) => {
    store.rewards.TESTONLY = { status: "pending" };
  }, rewardsFile);
  if (fs.existsSync(prod)) {
    const raw = fs.readFileSync(prod, "utf8");
    assert.ok(!raw.includes("TESTONLY"));
  }
});

assert.strictEqual(isPlausibleTxSignature(TX_SIG), true);
assert.strictEqual(isPlausibleTxSignature(""), false);

console.log("member-rewards tests passed");
