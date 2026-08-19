/**
 * Admin /membercheck /reward /memberrewards and user /rewards.
 * Run: node tests/member-rewards-commands.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const { handleMemberCheck } = require("../commands/membercheck");
const { handleReward, handleMemberRewards } = require("../commands/reward");
const { handleRewards, GROUP_REWARDS_TEXT } = require("../commands/rewards");
const { handleStart } = require("../commands/start");
const { handleHelp, HELP_MESSAGE } = require("../commands/help");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { createReward } = require("../services/memberRewards");
const { shortenWallet } = require("../utils/solanaWallet");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-reward-cmd-"));
const pointsFile = path.join(tempDir, "points.json");
let n = 0;

function files() {
  n += 1;
  return {
    walletFile: path.join(tempDir, `w-${n}.json`),
    rewardsFile: path.join(tempDir, `r-${n}.json`),
  };
}

const pending = [];

function runTest(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(
        result
          .then(() => console.log(`✓ ${name}`))
          .catch((err) => {
            console.error(`✗ ${name}`);
            throw err;
          })
      );
      return;
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
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

function createMockCtx({
  chatType = "private",
  userId = 9001,
  firstName = "Admin",
  replyUserId,
  replyName = "Pippi",
  text = "/reward",
  startPayload,
} = {}) {
  const replies = [];
  return {
    chat: { type: chatType, id: chatType === "private" ? userId : -1001 },
    from: { id: userId, first_name: firstName },
    botInfo: { username: "ManGoMemeFunCommunityBot" },
    startPayload,
    message: {
      text,
      reply_to_message: replyUserId
        ? { from: { id: replyUserId, first_name: replyName, is_bot: false } }
        : undefined,
    },
    replies,
    reply(body, extra) {
      replies.push({ text: body, extra });
      return Promise.resolve(replies[replies.length - 1]);
    },
  };
}

fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");

const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

runTest("11. admin-only creation", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 44, wallet, 1000);
  const ctx = createMockCtx({
    replyUserId: 44,
    text: "/reward mystery",
  });
  handleReward(ctx, { walletFile, rewardsFile, now: 50, pointsFile });
  assert.ok(ctx.replies[0].text.includes("Mystery Gift prepared"));
  assert.ok(ctx.replies[0].text.includes("Status: Pending"));
  assert.ok(ctx.replies[0].text.includes("Reward ID:"));
  assert.ok(ctx.replies[0].text.includes(shortenWallet(wallet.address)));
  assert.ok(!ctx.replies[0].text.includes(wallet.address));
});

runTest("12. non-admin rejected", () => {
  const { walletFile, rewardsFile } = files();
  const ctx = createMockCtx({
    userId: 77,
    replyUserId: 44,
    text: "/reward",
  });
  handleReward(ctx, { walletFile, rewardsFile });
  assert.ok(ctx.replies[0].text.includes("admin only"));
});

runTest("unverified reward target", () => {
  const { walletFile, rewardsFile } = files();
  const ctx = createMockCtx({
    replyUserId: 55,
    text: "/reward",
  });
  handleReward(ctx, { walletFile, rewardsFile, now: 1 });
  assert.ok(ctx.replies[0].text.includes("verify a wallet first"));
});

runTest("17. user can see own rewards", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 66, wallet, 1000);
  createReward({
    telegramUserId: 66,
    type: "mystery-gift",
    walletFile,
    rewardsFile,
    now: 2,
  });
  const ctx = createMockCtx({ userId: 66, text: "/rewards" });
  handleRewards(ctx, { rewardsFile });
  assert.ok(ctx.replies[0].text.includes("Mystery Gift"));
  assert.ok(ctx.replies[0].text.includes("Pending"));
  assert.ok(!ctx.replies[0].text.includes(wallet.address));
});

runTest("18. user cannot inspect someone else", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 88, wallet, 1000);
  createReward({ telegramUserId: 88, walletFile, rewardsFile, now: 3 });
  const ctx = createMockCtx({
    userId: 77,
    replyUserId: 88,
    text: "/rewards",
  });
  handleRewards(ctx, { rewardsFile });
  assert.ok(!ctx.replies[0].text.includes("Reward ID"));
  assert.ok(ctx.replies[0].text.includes("No rewards yet"));
  assert.ok(ctx.replies[0].text.includes("ManGo Rewards"));
});

runTest("group /rewards has no personal dump", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 99, wallet, 1000);
  createReward({ telegramUserId: 99, walletFile, rewardsFile, now: 4 });
  const ctx = createMockCtx({
    chatType: "supergroup",
    userId: 99,
    text: "/rewards",
  });
  handleRewards(ctx, { rewardsFile });
  assert.strictEqual(ctx.replies[0].text, GROUP_REWARDS_TEXT);
  assert.ok(!JSON.stringify(ctx.replies[0]).includes(wallet.address));
});

runTest("membercheck admin reply", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 44, wallet, 1000);
  const ctx = createMockCtx({
    replyUserId: 44,
    replyName: "Pippi",
    text: "/membercheck",
  });
  handleMemberCheck(ctx, { walletFile, rewardsFile, pointsFile });
  assert.ok(ctx.replies[0].text.includes("ManGo Member Profile"));
  assert.ok(ctx.replies[0].text.includes("Pippi"));
  assert.ok(ctx.replies[0].text.includes("🟢 Verified"));
  assert.ok(ctx.replies[0].text.includes(shortenWallet(wallet.address)));
  assert.ok(!ctx.replies[0].text.includes(wallet.address));
  assert.ok(ctx.replies[0].text.includes("Presale contribution:"));
  assert.ok(ctx.replies[0].text.includes("Weekly XP:"));
  assert.ok(ctx.replies[0].text.includes("Lifetime XP:"));
  assert.ok(ctx.replies[0].text.includes("Current streak:"));
  assert.ok(ctx.replies[0].text.includes("Longest streak:"));
  assert.ok(ctx.replies[0].text.includes("Last active:"));
  assert.ok(ctx.replies[0].text.includes("Pending rewards:"));
  assert.ok(ctx.replies[0].text.includes("Sent rewards:"));
});

runTest("membercheck non-admin private rejected", () => {
  const ctx = createMockCtx({ userId: 77, replyUserId: 44, text: "/membercheck" });
  handleMemberCheck(ctx, { pointsFile });
  assert.ok(ctx.replies[0].text.includes("admin only"));
});

runTest("memberrewards admin history", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 44, wallet, 1000);
  createReward({ telegramUserId: 44, walletFile, rewardsFile, now: 9 });
  const ctx = createMockCtx({
    replyUserId: 44,
    replyName: "Pippi",
    text: "/memberrewards",
  });
  handleMemberRewards(ctx, { walletFile, rewardsFile });
  assert.ok(ctx.replies[0].text.includes("Rewards for Pippi"));
  assert.ok(ctx.replies[0].text.includes("pending"));
});

runTest("/start rewards private", () => {
  const { rewardsFile } = files();
  const ctx = createMockCtx({
    userId: 66,
    startPayload: "rewards",
  });
  handleStart(ctx, { rewardsFile, pointsFile });
  assert.ok(ctx.replies[0].text.includes("ManGo Rewards"));
  assert.ok(ctx.replies[0].text.includes("No rewards yet"));
});

runTest("help lists /rewards /presale not admin reward internals", () => {
  handleHelp(createMockCtx());
  assert.ok(HELP_MESSAGE.includes("/rewards"));
  assert.ok(HELP_MESSAGE.includes("/presale"));
  assert.ok(!HELP_MESSAGE.includes("/membercheck"));
  assert.ok(!HELP_MESSAGE.includes("/memberrewards"));
  assert.ok(!HELP_MESSAGE.includes("/reconciledelivery"));
  assert.ok(!HELP_MESSAGE.includes("/walletlist"));
  assert.ok(
    !HELP_MESSAGE.split("\n").some((line) => line.trim() === "/reward")
  );
});

Promise.all(pending).then(() => {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  console.log("member-rewards-commands tests passed");
});
