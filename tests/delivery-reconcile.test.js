/**
 * Signature-first delivery reconcile, crash recovery, expired sessions.
 * Temp files only. No production data. Never sends a transaction.
 * Run: node tests/delivery-reconcile.test.js
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
  getReward,
  userFacingRewardLine,
} = require("../services/memberRewards");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { setDeliveryFileForTests, mutateDeliveryStore, loadDeliveryStore } = require("../services/deliveryStore");
const { MANGO_MINT } = require("../services/presaleConstants");
const {
  TOKEN_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  deliveryMemo,
  mangoHumanToBaseUnits,
} = require("../services/deliveryConstants");
const {
  prepareRewardDelivery,
  confirmDelivery,
  reconcileDeliveryPayment,
  issueDeliveryPayment,
  lookupDeliverySession,
} = require("../services/rewardDelivery");
const { reconcileSubmittedDeliveries } = require("../services/deliveryReconcile");
const { handleReconcileDelivery } = require("../commands/reconciledelivery");
const { handleRewards, formatOwnRewards } = require("../commands/rewards");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-reconcile-"));
let n = 0;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

function files() {
  n += 1;
  const walletFile = path.join(tempDir, `w-${n}.json`);
  const rewardsFile = path.join(tempDir, `r-${n}.json`);
  const deliveryFile = path.join(tempDir, `d-${n}.json`);
  setDeliveryFileForTests(deliveryFile);
  return { walletFile, rewardsFile, deliveryFile };
}

function runTest(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.then(() => console.log(`✓ ${name}`));
  }
  console.log(`✓ ${name}`);
  return result;
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

function makeSig(seed) {
  const raw = `${seed}${"1".repeat(80)}`.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "2");
  return raw.slice(0, 88);
}

function enabledEnv(distributionWallet) {
  return {
    REWARD_DELIVERY_ENABLED: "true",
    PRESALE_DISTRIBUTION_ENABLED: "true",
    MANGO_DISTRIBUTION_WALLET: distributionWallet,
    SOLANA_RPC_URL: "https://example.invalid/rpc",
    ADMIN_USER_ID: "9001",
  };
}

function tokenTx({
  signer,
  destination,
  mint = MANGO_MINT,
  amount,
  memo,
  err = null,
  authority,
  destOwner,
}) {
  const sourceAta = generateSolanaWallet().address;
  const destAta = generateSolanaWallet().address;
  return {
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err,
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint,
          owner: destOwner || destination,
          uiTokenAmount: { amount: String(amount) },
        },
      ],
    },
    transaction: {
      signatures: [makeSig("sig" + String(amount).slice(-4))],
      message: {
        accountKeys: [{ pubkey: signer }],
        instructions: [
          {
            program: "spl-token",
            programId: TOKEN_PROGRAM_ID,
            parsed: {
              type: "transferChecked",
              info: {
                authority: authority || signer,
                source: sourceAta,
                destination: destAta,
                mint,
                tokenAmount: { amount: String(amount), decimals: 9 },
              },
            },
          },
          {
            programId: MEMO_PROGRAM_ID,
            program: "spl-memo",
            parsed: memo,
          },
        ],
      },
    },
  };
}

function createMockCtx({ userId = 9001, text = "/reconciledelivery", chatType = "private" } = {}) {
  const replies = [];
  return {
    replies,
    from: { id: userId },
    chat: { type: chatType, id: userId },
    message: { text },
    reply(msg) {
      replies.push({ text: msg });
      return Promise.resolve();
    },
  };
}

async function main() {
  const dist = generateSolanaWallet();
  const userWallet = generateSolanaWallet();
  const amount = mangoHumanToBaseUnits("10");

  function prepareTen(env) {
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 41, userWallet, 1000);
    const created = createReward({ telegramUserId: 41, walletFile, rewardsFile, now: 1 });
    const prepared = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      amountHuman: "10",
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    assert.strictEqual(prepared.ok, true, prepared.error);
    return { walletFile, rewardsFile, deliveryFile, created, prepared };
  }

  function goodTx(prepared, overrides = {}) {
    const tx = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      amount: amount.baseUnits,
      memo: deliveryMemo(prepared.review.deliveryId),
      ...overrides,
    });
    return tx;
  }

  await runTest("1. delivery-ready reward + valid signature → Sent", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created, prepared } = prepareTen(env);
    const sig = makeSig("recon1");
    const tx = goodTx(prepared);
    tx.transaction.signatures[0] = sig;
    const result = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: sig,
      rewardsFile,
      deliveryFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.status, "sent");
    const reward = getReward(created.reward.rewardId, rewardsFile);
    assert.strictEqual(reward.status, "sent");
    assert.strictEqual(reward.txSignature, sig);
    assert.ok(reward.sentAt);
  });

  await runTest("2. reconcile does not build a new transaction or deliveryId", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created, prepared } = prepareTen(env);
    const before = getReward(created.reward.rewardId, rewardsFile);
    const sig = makeSig("recon2");
    const tx = goodTx(prepared);
    tx.transaction.signatures[0] = sig;
    let built = false;
    await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: sig,
      rewardsFile,
      deliveryFile,
      env,
      now: 80,
      getLatestBlockhashImpl: async () => {
        built = true;
        return { ok: false };
      },
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.strictEqual(built, false);
    assert.strictEqual(
      getReward(created.reward.rewardId, rewardsFile).deliveryId,
      before.deliveryId
    );
    const src = fs.readFileSync(path.join(__dirname, "..", "commands", "reconciledelivery.js"), "utf8");
    assert.ok(!src.includes("prepareRewardDelivery("));
    assert.ok(!src.includes("markRewardSent("));
  });

  await runTest("3-9. exact memo/amount/destination/signer/mint/success required", async () => {
    const env = enabledEnv(dist.address);
    const cases = [
      { name: "wrong memo", reason: "memo-mismatch", tx: (p) => goodTx(p, { memo: "mango-delivery:deadbeef" }) },
      {
        name: "wrong amount",
        reason: "wrong-amount",
        tx: (p) => goodTx(p, { amount: mangoHumanToBaseUnits("1").baseUnits }),
      },
      {
        name: "wrong destination",
        reason: "wrong-destination",
        tx: (p) => goodTx(p, { destination: generateSolanaWallet().address }),
      },
      {
        name: "wrong signer",
        reason: "wrong-signer",
        tx: (p) => goodTx(p, { signer: userWallet.address }),
      },
      {
        name: "wrong mint",
        reason: "wrong-mint",
        tx: (p) => goodTx(p, { mint: generateSolanaWallet().address }),
      },
      {
        name: "failed tx",
        reason: "failed-tx",
        tx: (p) => goodTx(p, { err: { InstructionError: [0, "Custom"] } }),
      },
    ];
    for (const item of cases) {
      const { rewardsFile, deliveryFile, created, prepared } = prepareTen(env);
      const sig = makeSig(item.reason.slice(0, 8));
      const tx = item.tx(prepared);
      tx.transaction.signatures[0] = sig;
      const result = await reconcileDeliveryPayment({
        adminUserId: 9001,
        rewardId: created.reward.rewardId,
        signature: sig,
        rewardsFile,
        deliveryFile,
        env,
        now: 80,
        getTransactionImpl: async () => ({ ok: true, result: tx }),
      });
      assert.strictEqual(result.ok, false, item.name);
      assert.strictEqual(result.reason, item.reason, item.name);
      assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "submitted");
      assert.notStrictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
    }
  });

  await runTest("10. signature used by another delivery is rejected", async () => {
    const env = enabledEnv(dist.address);
    const first = prepareTen(env);
    const sig = makeSig("sharedsig");
    const tx = goodTx(first.prepared);
    tx.transaction.signatures[0] = sig;
    const sent = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: first.created.reward.rewardId,
      signature: sig,
      rewardsFile: first.rewardsFile,
      deliveryFile: first.deliveryFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.strictEqual(sent.ok, true, sent.reason);

    connectUser(first.walletFile, 42, generateSolanaWallet(), 2000);
    const second = createReward({
      telegramUserId: 42,
      walletFile: first.walletFile,
      rewardsFile: first.rewardsFile,
      now: 90,
    });
    const prepared2 = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: second.reward.rewardId,
      amountHuman: "10",
      walletFile: first.walletFile,
      rewardsFile: first.rewardsFile,
      deliveryFile: first.deliveryFile,
      env,
      now: 91,
    });
    assert.strictEqual(prepared2.ok, true, prepared2.error);
    const dup = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: second.reward.rewardId,
      signature: sig,
      rewardsFile: first.rewardsFile,
      deliveryFile: first.deliveryFile,
      env,
      now: 92,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.reason, "duplicate-signature");
    assert.notStrictEqual(getReward(second.reward.rewardId, first.rewardsFile).status, "sent");
  });

  await runTest("11-12. getTransaction null → submitted/pending; later reconcile → Sent", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created, prepared } = prepareTen(env);
    const sig = makeSig("pending1");
    const tx = goodTx(prepared);
    tx.transaction.signatures[0] = sig;
    const pending = await confirmDelivery(prepared.token, sig, {
      deliveryFile,
      rewardsFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: null }),
    });
    assert.strictEqual(pending.ok, true);
    assert.strictEqual(pending.pending, true);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "submitted");
    assert.ok(userFacingRewardLine(getReward(created.reward.rewardId, rewardsFile)).includes("Pending"));

    const later = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: sig,
      rewardsFile,
      deliveryFile,
      env,
      now: 90,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.strictEqual(later.ok, true, later.reason);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
  });

  await runTest("13. same signature retry is idempotent", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created, prepared } = prepareTen(env);
    const sig = makeSig("idem1");
    const tx = goodTx(prepared);
    tx.transaction.signatures[0] = sig;
    const first = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: sig,
      rewardsFile,
      deliveryFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    const second = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: sig,
      rewardsFile,
      deliveryFile,
      env,
      now: 81,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.idempotent, true);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
  });

  await runTest("14. usedSignature stored + reward pending repairs to Sent", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created, prepared } = prepareTen(env);
    const sig = makeSig("repair1");
    const tx = goodTx(prepared);
    tx.transaction.signatures[0] = sig;
    mutateDeliveryStore((store) => {
      store.usedSignatures[sig] = prepared.review.deliveryId;
    }, deliveryFile);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "delivery-ready");
    const repaired = await confirmDelivery(prepared.token, sig, {
      deliveryFile,
      rewardsFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.strictEqual(repaired.ok, true, repaired.reason);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
  });

  await runTest("15. expired original session + known signature still reconciles", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created, prepared } = prepareTen(env);
    const sig = makeSig("expired1");
    const tx = goodTx(prepared);
    tx.transaction.signatures[0] = sig;
    const later = 50 + 16 * 60 * 1000;
    const lookup = lookupDeliverySession(prepared.token, { deliveryFile, now: later });
    assert.strictEqual(lookup.status, "expired");
    const result = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: sig,
      rewardsFile,
      deliveryFile,
      env,
      now: later,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
  });

  await runTest("16. expired session cannot start new signing", async () => {
    const env = enabledEnv(dist.address);
    const { deliveryFile, prepared } = prepareTen(env);
    const later = 50 + 16 * 60 * 1000;
    const payment = await issueDeliveryPayment(prepared.token, {
      deliveryFile,
      env,
      now: later,
      getLatestBlockhashImpl: async () => ({ ok: true, blockhash: "1".repeat(32), lastValidBlockHeight: 1 }),
    });
    assert.strictEqual(payment.ok, false);
    assert.strictEqual(payment.reason, "expired");
  });

  await runTest("25-26. /rewards shows Pending then Sent", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created, prepared, walletFile } = prepareTen(env);
    const pendingText = formatOwnRewards([getReward(created.reward.rewardId, rewardsFile)]);
    assert.ok(pendingText.includes("Pending"));
    assert.ok(!pendingText.includes("Status: Sent"));
    const sig = makeSig("uxsent");
    const tx = goodTx(prepared);
    tx.transaction.signatures[0] = sig;
    await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: sig,
      rewardsFile,
      deliveryFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    const ctx = createMockCtx({ userId: 41, text: "/rewards" });
    handleRewards(ctx, { rewardsFile });
    assert.ok(ctx.replies[0].text.includes("Status: Sent"));
    void walletFile;
  });

  await runTest("33. reconcile command never bypasses chain verify", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created } = prepareTen(env);
    const ctx = createMockCtx({
      text: `/reconciledelivery ${created.reward.rewardId} ${makeSig("cmdfail")}`,
    });
    await handleReconcileDelivery(ctx, {
      rewardsFile,
      deliveryFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: null }),
    });
    assert.ok(ctx.replies[0].text.includes("Waiting for network confirmation"));
    assert.notStrictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
  });

  await runTest("worker retries submitted deliveries only", async () => {
    const env = enabledEnv(dist.address);
    const { rewardsFile, deliveryFile, created, prepared } = prepareTen(env);
    const sig = makeSig("worker1");
    const tx = goodTx(prepared);
    tx.transaction.signatures[0] = sig;
    await confirmDelivery(prepared.token, sig, {
      deliveryFile,
      rewardsFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: null }),
    });
    const tick = await reconcileSubmittedDeliveries({
      rewardsFile,
      deliveryFile,
      env,
      now: 90,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    });
    assert.ok(tick.processed >= 1);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
  });

  await runTest("35-36. no XP/presale/secret changes in reconcile sources", () => {
    const filesToScan = [
      "services/rewardDelivery.js",
      "services/deliveryReconcile.js",
      "commands/reconciledelivery.js",
      "services/mysteryGiftNotify.js",
    ];
    for (const rel of filesToScan) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8").toLowerCase();
      assert.ok(!src.includes("privatekey"), rel);
      assert.ok(!src.includes("helius"), rel);
      assert.ok(!src.includes("api-key"), rel);
    }
    const points = fs.readFileSync(path.join(__dirname, "..", "services", "points.js"), "utf8");
    assert.ok(points.includes("TRIVIA_ROUND_WIN_XP"));
    const presale = fs.readFileSync(path.join(__dirname, "..", "services", "presaleLedger.js"), "utf8");
    assert.ok(presale.includes("reconcilePresaleOrder"));
    const cmd = fs.readFileSync(path.join(__dirname, "..", "commands", "reconciledelivery.js"), "utf8");
    assert.ok(!cmd.includes("markRewardSent"));
    assert.ok(!cmd.includes("addPoints"));
  });

  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  setDeliveryFileForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("delivery-reconcile tests passed");
}

main().catch((err) => {
  console.error(err);
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  setDeliveryFileForTests(null);
  process.exitCode = 1;
});
