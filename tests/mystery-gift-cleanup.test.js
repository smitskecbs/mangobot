/**
 * Mystery Gift pending cleanup and notification retry.
 * Temp files only. No live RPC. No production JSON mutation.
 * Run: node tests/mystery-gift-cleanup.test.js
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
  markRewardSent,
  markRewardSubmitted,
  cancelReward,
  getReward,
  loadRewardsStore,
  mutateRewardsStore,
} = require("../services/memberRewards");
const { mutateDeliveryStore, loadDeliveryStore } = require("../services/deliveryStore");
const {
  classifyMysteryGiftForCleanup,
  previewPendingMysteryGiftCleanup,
  clearPendingMysteryGifts,
  formatCleanupReport,
} = require("../services/mysteryGiftCleanup");
const {
  handleClearPendingGifts,
  handleClearPendingCallback,
  handleRetryMysteryAnnounce,
  ADMIN_ONLY,
  CPG_GO,
  CPG_X,
} = require("../commands/clearpendinggifts");
const { announceMysteryGiftDelivered } = require("../services/mysteryGiftAnnounce");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-mg-cleanup-"));
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

const prodFiles = [
  path.resolve(__dirname, "..", "data", "member-rewards.json"),
  path.resolve(__dirname, "..", "data", "reward-delivery.json"),
  path.resolve(__dirname, "..", "data", "mango-shop.json"),
  path.resolve(__dirname, "..", "points.json"),
];
const prodMtimes = {};
for (const file of prodFiles) {
  prodMtimes[file] = fs.existsSync(file) ? fs.statSync(file).mtimeMs : null;
}

const TX_SIG = `${"1".repeat(32)}${"2".repeat(32)}${"3".repeat(24)}`;
let n = 0;

function files() {
  n += 1;
  return {
    walletFile: path.join(tempDir, `w-${n}.json`),
    rewardsFile: path.join(tempDir, `r-${n}.json`),
    deliveryFile: path.join(tempDir, `d-${n}.json`),
  };
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

function seed(statusMap = {}) {
  const paths = files();
  const wallet = generateSolanaWallet();
  connectUser(paths.walletFile, 61, wallet, 1000);
  const created = {};
  let t = 1;
  for (const [key, status] of Object.entries(statusMap)) {
    const row = createReward({
      telegramUserId: 61,
      walletFile: paths.walletFile,
      rewardsFile: paths.rewardsFile,
      now: t,
    });
    assert.strictEqual(row.ok, true, row.error);
    created[key] = row.reward.rewardId;
    t += 1;
    if (status === "pending") {
      continue;
    }
    if (status === "sent") {
      markRewardSent(row.reward.rewardId, TX_SIG, { rewardsFile: paths.rewardsFile, now: t });
    } else if (status === "submitted") {
      markRewardSubmitted(row.reward.rewardId, TX_SIG, { rewardsFile: paths.rewardsFile, now: t });
    } else if (status === "cancelled") {
      cancelReward(row.reward.rewardId, { rewardsFile: paths.rewardsFile, now: t });
    } else if (status === "prepared" || status === "delivery-ready") {
      mutateRewardsStore((store) => {
        store.rewards[row.reward.rewardId].status = status;
        return { ok: true };
      }, paths.rewardsFile);
    }
    t += 1;
  }
  return { ...paths, wallet, created };
}

function mockCtx({ userId = 9001, chatType = "private", callbackData, text = "/clearpendinggifts" } = {}) {
  const replies = [];
  return {
    replies,
    from: { id: userId },
    chat: { type: chatType, id: userId },
    message: { text },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    async answerCbQuery() {
      return undefined;
    },
    reply(msg, extra) {
      replies.push({ text: msg, extra });
      return Promise.resolve();
    },
  };
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("pending removed", () => {
    const { rewardsFile, deliveryFile, created } = seed({ a: "pending", b: "pending" });
    const result = clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.UTC(2026, 7, 28, 12, 0, 0),
    });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.counts.pendingRemoved, 2);
    assert.strictEqual(getReward(created.a, rewardsFile), null);
    assert.strictEqual(getReward(created.b, rewardsFile), null);
  });

  await runTest("queued delivery-ready removed if semantically safe", () => {
    const { rewardsFile, deliveryFile, created } = seed({ q: "delivery-ready" });
    const result = clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.counts.pendingRemoved, 1);
    assert.strictEqual(getReward(created.q, rewardsFile), null);
  });

  await runTest("delivered preserved", () => {
    const { rewardsFile, deliveryFile, created } = seed({ d: "sent", p: "pending" });
    const result = clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.strictEqual(result.counts.deliveredPreserved, 1);
    assert.strictEqual(result.counts.pendingRemoved, 1);
    assert.strictEqual(getReward(created.d, rewardsFile).status, "sent");
    assert.strictEqual(getReward(created.d, rewardsFile).txSignature, TX_SIG);
  });

  await runTest("confirmed/submitted with tx signature skipped", () => {
    const { rewardsFile, deliveryFile, created } = seed({ s: "submitted", p: "pending" });
    const result = clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.strictEqual(result.counts.ambiguousSkipped, 1);
    assert.strictEqual(getReward(created.s, rewardsFile).status, "submitted");
    assert.strictEqual(getReward(created.s, rewardsFile).txSignature, TX_SIG);
    assert.strictEqual(getReward(created.p, rewardsFile), null);
  });

  await runTest("record with tx signature skipped even if status looks pending", () => {
    const { rewardsFile, deliveryFile, created } = seed({ x: "pending" });
    mutateRewardsStore((store) => {
      store.rewards[created.x].txSignature = TX_SIG;
      return { ok: true };
    }, rewardsFile);
    const preview = previewPendingMysteryGiftCleanup({ rewardsFile, deliveryFile });
    assert.strictEqual(preview.counts.ambiguousSkipped, 1);
    assert.strictEqual(preview.pendingCount, 0);
    const result = clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.strictEqual(result.counts.pendingRemoved, 0);
    assert.strictEqual(getReward(created.x, rewardsFile).txSignature, TX_SIG);
  });

  await runTest("failed/cancelled preserved", () => {
    const { rewardsFile, deliveryFile, created } = seed({ f: "cancelled", p: "pending" });
    const result = clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.strictEqual(result.counts.failedPreserved, 1);
    assert.strictEqual(getReward(created.f, rewardsFile).status, "cancelled");
  });

  await runTest("payment-ready session is ambiguous and skipped", () => {
    const { rewardsFile, deliveryFile, created } = seed({ p: "delivery-ready" });
    mutateDeliveryStore((store) => {
      store.sessions.hash1 = {
        rewardId: created.p,
        status: "payment-ready",
        deliveryId: "abc123",
      };
      return { ok: true };
    }, deliveryFile);
    const result = clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.strictEqual(result.counts.ambiguousSkipped, 1);
    assert.strictEqual(getReward(created.p, rewardsFile).status, "delivery-ready");
  });

  await runTest("unauthorized user rejected", async () => {
    const { rewardsFile, deliveryFile, created } = seed({ p: "pending" });
    const denied = clearPendingMysteryGifts({
      adminUserId: 8001,
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, "not-admin");
    assert.strictEqual(getReward(created.p, rewardsFile).status, "pending");

    const ctx = mockCtx({ userId: 8001 });
    await handleClearPendingGifts(ctx, { rewardsFile, deliveryFile });
    assert.strictEqual(ctx.replies[0].text, ADMIN_ONLY);
  });

  await runTest("cancel changes nothing", async () => {
    const { rewardsFile, deliveryFile, created } = seed({ p: "pending" });
    const ctx = mockCtx({ callbackData: CPG_X });
    await handleClearPendingCallback(ctx, { rewardsFile, deliveryFile });
    assert.ok(ctx.replies[0].text.includes("cancelled"));
    assert.strictEqual(getReward(created.p, rewardsFile).status, "pending");
  });

  await runTest("confirmation performs cleanup exactly once", async () => {
    const { rewardsFile, deliveryFile, created } = seed({ p: "pending", d: "sent" });
    const first = mockCtx({ callbackData: CPG_GO });
    await handleClearPendingCallback(first, {
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.ok(first.replies[0].text.includes("Pending removed: 1"));
    assert.ok(first.replies[0].text.includes("Delivered preserved: 1"));
    assert.strictEqual(getReward(created.p, rewardsFile), null);
    const second = mockCtx({ callbackData: CPG_GO });
    await handleClearPendingCallback(second, {
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    assert.ok(second.replies[0].text.includes("Pending removed: 0"));
    assert.strictEqual(getReward(created.d, rewardsFile).status, "sent");
  });

  await runTest("backup/write path exercised with temp test files only", () => {
    const { rewardsFile, deliveryFile } = seed({ p: "pending" });
    const result = clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.UTC(2026, 7, 28, 15, 0, 0),
    });
    assert.strictEqual(result.ok, true);
    const backup = (result.backups || []).find((row) => row && row.path);
    assert.ok(backup && fs.existsSync(backup.path));
    assert.ok(backup.path.includes("pre-clear-"));
    assert.ok(backup.path.startsWith(tempDir));
    const parsed = JSON.parse(fs.readFileSync(backup.path, "utf8"));
    assert.ok(parsed.rewards);
  });

  await runTest("open unsigned session is pruned with the pending gift", () => {
    const { rewardsFile, deliveryFile, created } = seed({ p: "delivery-ready" });
    mutateDeliveryStore((store) => {
      store.sessions.open1 = {
        rewardId: created.p,
        status: "open",
        deliveryId: "open-del",
      };
      return { ok: true };
    }, deliveryFile);
    clearPendingMysteryGifts({
      adminUserId: 9001,
      rewardsFile,
      deliveryFile,
      now: Date.now(),
    });
    const store = loadDeliveryStore(deliveryFile);
    assert.strictEqual(store.sessions.open1, undefined);
  });

  await runTest("formatCleanupReport matches admin copy", () => {
    const text = formatCleanupReport({
      pendingRemoved: 7,
      deliveredPreserved: 12,
      failedPreserved: 2,
      ambiguousSkipped: 1,
    });
    assert.ok(text.includes("Pending removed: 7"));
    assert.ok(text.includes("Delivered preserved: 12"));
    assert.ok(text.includes("Failed preserved: 2"));
    assert.ok(text.includes("Ambiguous/on-chain skipped: 1"));
  });

  await runTest("notification retry does not resend tokens", async () => {
    const { rewardsFile, deliveryFile, created, walletFile } = seed({ d: "sent" });
    const posts = [];
    const ctx = mockCtx({ text: "/retrymysteryannounce" });
    await handleRetryMysteryAnnounce(ctx, {
      rewardsFile,
      deliveryFile,
      walletFile,
      botToken: "TESTTOKEN",
      chatId: "-1003916996602",
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(init.body));
        return { ok: true };
      },
      announceMysteryGift: true,
      notifyMysteryGift: true,
    });
    assert.ok(ctx.replies[0].text.includes("On-chain rewards were not resent"));
    assert.ok(ctx.replies[0].text.includes("Group sent:"));
    assert.strictEqual(getReward(created.d, rewardsFile).status, "sent");
    assert.strictEqual(getReward(created.d, rewardsFile).txSignature, TX_SIG);
    assert.ok(posts.length >= 1);
    const group = posts.find((row) => String(row.chat_id) === "-1003916996602");
    assert.ok(group);
    assert.ok(!JSON.stringify(group).includes(TX_SIG));
    const again = await announceMysteryGiftDelivered(created.d, {
      announceMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      chatId: "-1003916996602",
      fetchImpl: async () => ({ ok: true }),
    });
    assert.strictEqual(again.sent, false);
    assert.strictEqual(again.announced, true);
  });

  await runTest("failed transaction path is not marked delivered by cleanup classifier", () => {
    const bucket = classifyMysteryGiftForCleanup(
      { type: "mystery-gift", status: "pending" },
      null,
      { usedSignatures: {} }
    );
    assert.strictEqual(bucket, "pending");
    const sent = classifyMysteryGiftForCleanup(
      { type: "mystery-gift", status: "sent", txSignature: TX_SIG },
      null,
      { usedSignatures: {} }
    );
    assert.strictEqual(sent, "delivered");
  });

  await runTest("ask shows pending count", async () => {
    const { rewardsFile, deliveryFile } = seed({ a: "pending", b: "pending", d: "sent" });
    const ctx = mockCtx();
    await handleClearPendingGifts(ctx, { rewardsFile, deliveryFile });
    assert.ok(ctx.replies[0].text.includes("Pending: 2"));
    assert.ok(ctx.replies[0].text.includes("Clear all pending Mystery Gifts"));
  });

  for (const [file, mtime] of Object.entries(prodMtimes)) {
    if (mtime == null) {
      assert.strictEqual(fs.existsSync(file), false, file);
    } else {
      assert.strictEqual(fs.statSync(file).mtimeMs, mtime, file);
    }
  }
  const leftover = loadRewardsStore(path.join(tempDir, "no-such.json"));
  assert.ok(leftover);
}

main()
  .then(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("All mystery-gift-cleanup tests passed.");
  })
  .catch((err) => {
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    console.error(err);
    process.exit(1);
  });
