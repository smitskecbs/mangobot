/**
 * Read-only member activity / wallet profile.
 * Run: node tests/member-activity-profile.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const { getMemberActivityProfile } = require("../services/memberActivityProfile");
const { getMemberWalletProfile } = require("../services/memberWalletProfile");
const { isRewardEligible } = require("../services/memberRewards");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { loadWalletStore } = require("../services/walletLinks");
const { mutatePoints, loadPoints, getWeekId } = require("../services/points");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-member-profile-"));
const pointsFile = path.join(tempDir, "points.json");
let fileIndex = 0;

function walletFile() {
  fileIndex += 1;
  return path.join(tempDir, `w-${fileIndex}.json`);
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

function connectUser(file, userId, wallet, now) {
  const created = createLinkToken(userId, { walletFile: file, now });
  const limiter = createMemoryRateLimiter();
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile: file, now: now + 1, rateLimiter: limiter }
  );
  const verified = verifyWalletSignature(
    {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    },
    { walletFile: file, now: now + 2, rateLimiter: limiter }
  );
  assert.strictEqual(verified.ok, true, verified.error);
}

fs.writeFileSync(
  pointsFile,
  JSON.stringify({ users: {} }, null, 2),
  "utf8"
);

runTest("1. verified member profile", () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 101, wallet, 1000);
  mutatePoints((data) => {
    data.users["101"] = {
      name: "Pippi",
      points: 76,
      weeklyPoints: 18,
      weekId: getWeekId(),
      streak: { current: 4, longest: 7, lastActiveDate: new Date().toISOString().slice(0, 10) },
    };
  }, pointsFile);

  const profile = getMemberActivityProfile(101, { walletFile: file, pointsFile });
  assert.strictEqual(profile.wallet.verified, true);
  assert.strictEqual(profile.wallet.address, wallet.address);
  assert.strictEqual(profile.wallet.rewardEligible, true);
  assert.strictEqual(profile.xp.lifetime, 76);
  assert.strictEqual(profile.xp.weekly, 18);
  assert.strictEqual(profile.streak.current, 4);
  assert.strictEqual(profile.streak.longest, 7);
  assert.strictEqual(profile.displayName, "Pippi");
  assert.ok(profile.rank.title);
  assert.strictEqual(isRewardEligible(101, file), true);
});

runTest("2. unverified profile", () => {
  const file = walletFile();
  const profile = getMemberActivityProfile(202, { walletFile: file, pointsFile });
  assert.strictEqual(profile.wallet.verified, false);
  assert.strictEqual(profile.wallet.address, null);
  assert.strictEqual(profile.wallet.rewardEligible, false);
  assert.strictEqual(isRewardEligible(202, file), false);
});

runTest("3. owner profile still readable; competition flag unset", () => {
  const prev = process.env.ADMIN_USER_ID;
  process.env.ADMIN_USER_ID = "303";
  try {
    const file = walletFile();
    const profile = getMemberActivityProfile(303, { walletFile: file, pointsFile });
    assert.strictEqual(profile.competitionExcluded, false);
    assert.strictEqual(profile.wallet.verified, false);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = prev;
  }
});

runTest("4. missing legacy streak/pvp/trivia safe", () => {
  const file = walletFile();
  mutatePoints((data) => {
    data.users["404"] = { name: "Legacy", points: 3 };
  }, pointsFile);
  const profile = getMemberActivityProfile(404, { walletFile: file, pointsFile });
  assert.strictEqual(profile.streak.current, 0);
  assert.strictEqual(profile.streak.longest, 0);
  assert.strictEqual(profile.pvp.rewardedWinsToday, 0);
  assert.strictEqual(profile.trivia.rewardedRoundsToday, 0);
  assert.strictEqual(profile.games.snakeClaimedToday, false);
  assert.strictEqual(profile.games.bounchClaimedToday, false);
});

runTest("5. no mutation during profile read", () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 505, wallet, 5000);
  const beforeWallet = JSON.stringify(loadWalletStore(file));
  const beforePoints = JSON.stringify(loadPoints(pointsFile));
  getMemberWalletProfile(505, { walletFile: file });
  getMemberActivityProfile(505, { walletFile: file, pointsFile });
  assert.strictEqual(JSON.stringify(loadWalletStore(file)), beforeWallet);
  assert.strictEqual(JSON.stringify(loadPoints(pointsFile)), beforePoints);
});

console.log("member-activity-profile tests passed");
