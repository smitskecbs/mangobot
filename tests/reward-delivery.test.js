/**
 * Admin-signed MANGO delivery. Temp files only. No production data.
 * Run: node tests/reward-delivery.test.js
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
  markRewardSent,
} = require("../services/memberRewards");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { setDeliveryFileForTests } = require("../services/deliveryStore");
const { setPresaleFileForTests, mutatePresaleStore } = require("../services/presaleStore");
const { MANGO_MINT, MANGO_MINT_DECIMALS } = require("../services/presaleConstants");
const { TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, deliveryMemo, mangoHumanToBaseUnits } = require("../services/deliveryConstants");
const { getDeliveryConfig } = require("../services/deliveryConfig");
const { verifyDeliveryTransaction } = require("../services/deliveryVerify");
const {
  prepareRewardDelivery,
  preparePresaleDistribution,
  lookupDeliverySession,
  issueDeliveryPayment,
  confirmDelivery,
  ignoreClientOverrides,
} = require("../services/rewardDelivery");
const { handleDeliver } = require("../commands/deliver");
const { handleTrivia } = require("../commands/trivia");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-delivery-"));
let n = 0;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

function files() {
  n += 1;
  const walletFile = path.join(tempDir, `w-${n}.json`);
  const rewardsFile = path.join(tempDir, `r-${n}.json`);
  const deliveryFile = path.join(tempDir, `d-${n}.json`);
  const presaleFile = path.join(tempDir, `p-${n}.json`);
  setDeliveryFileForTests(deliveryFile);
  setPresaleFileForTests(presaleFile);
  return { walletFile, rewardsFile, deliveryFile, presaleFile };
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
  extraTransfer = false,
  authority,
  destOwner,
}) {
  const sourceAta = generateSolanaWallet().address;
  const destAta = generateSolanaWallet().address;
  const transfer = {
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
  };
  const instructions = [
    transfer,
    extraTransfer ? { ...transfer, parsed: { ...transfer.parsed, info: { ...transfer.parsed.info, amount: "1" } } } : null,
    {
      programId: MEMO_PROGRAM_ID,
      program: "spl-memo",
      parsed: memo,
    },
  ].filter(Boolean);
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
        instructions,
      },
    },
  };
}

function createMockCtx({ userId = 9001, text = "/deliver", replyUserId, chatType = "private" } = {}) {
  const replies = [];
  return {
    replies,
    from: { id: userId },
    chat: { type: chatType, id: userId },
    message: {
      text,
      reply_to_message: replyUserId
        ? { from: { id: replyUserId, first_name: "Pippi", is_bot: false } }
        : undefined,
    },
    reply(msg) {
      replies.push({ text: msg });
      return Promise.resolve();
    },
  };
}

async function main() {
  const dist = generateSolanaWallet();
  const userWallet = generateSolanaWallet();

  await runTest("delivery disabled by default", () => {
    const cfg = getDeliveryConfig({});
    assert.strictEqual(cfg.rewardDeliveryEnabled, false);
    assert.strictEqual(cfg.presaleDistributionEnabled, false);
    assert.strictEqual(cfg.rewardLive, false);
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 11, userWallet, 1000);
    const created = createReward({ telegramUserId: 11, walletFile, rewardsFile, now: 1 });
    const result = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      amountHuman: "1000",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: { ADMIN_USER_ID: "9001" },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "disabled");
  });

  await runTest("presale remains disabled", () => {
    const { isPresaleLive } = require("../services/presaleConfig");
    assert.strictEqual(isPresaleLive(Date.now(), {}), false);
  });

  await runTest("1. pending verified reward can be prepared", () => {
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 11, userWallet, 1000);
    const created = createReward({ telegramUserId: 11, walletFile, rewardsFile, now: 1 });
    const result = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      amountHuman: "1000",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: enabledEnv(dist.address),
      now: 50,
    });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.review.destination, userWallet.address);
    assert.strictEqual(result.review.mint, MANGO_MINT);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "delivery-ready");
  });

  await runTest("2. unverified rejected at creation", () => {
    const { walletFile, rewardsFile } = files();
    const result = createReward({ telegramUserId: 99, walletFile, rewardsFile });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "unverified");
  });

  await runTest("3-5. walletSnapshot frozen; frontend wallet ignored", () => {
    const { walletFile, rewardsFile, deliveryFile } = files();
    const first = generateSolanaWallet();
    const second = generateSolanaWallet();
    connectUser(walletFile, 12, first, 1000);
    const created = createReward({ telegramUserId: 12, walletFile, rewardsFile, now: 1 });
    connectUser(walletFile, 12, second, 4000);
    const result = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      amountHuman: "10",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: enabledEnv(dist.address),
      now: 50,
    });
    assert.strictEqual(result.review.destination, first.address);
    assert.notStrictEqual(result.review.destination, second.address);
    const ignored = ignoreClientOverrides(
      { destination: second.address, mint: second.address, amountBaseUnits: "1" },
      { destination: first.address, amountBaseUnits: mangoHumanToBaseUnits("10").baseUnits }
    );
    assert.strictEqual(ignored.ok, false);
  });

  await runTest("6-8. one active session; expiry; wrong-purpose", () => {
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 13, userWallet, 1000);
    const created = createReward({ telegramUserId: 13, walletFile, rewardsFile, now: 1 });
    const first = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      amountHuman: "5",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: enabledEnv(dist.address),
      now: 100,
    });
    assert.strictEqual(first.ok, true);
    const second = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      amountHuman: "5",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: enabledEnv(dist.address),
      now: 101,
    });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, "session-active");
    const expired = lookupDeliverySession(first.token, {
      deliveryFile,
      now: 100 + 16 * 60 * 1000,
    });
    assert.strictEqual(expired.status, "expired");
    const { mutateDeliveryStore, loadDeliveryStore } = require("../services/deliveryStore");
    const { PURPOSE_PRESALE } = require("../services/presaleConstants");
    mutateDeliveryStore((store) => {
      const hash = Object.keys(store.sessions)[0];
      store.sessions[hash].purpose = PURPOSE_PRESALE;
    }, deliveryFile);
    const wrong = lookupDeliverySession(first.token, { deliveryFile, now: 100 });
    assert.strictEqual(wrong.status, "wrong-purpose");
    void loadDeliveryStore;
  });

  await runTest("9. non-admin cannot prepare", () => {
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 14, userWallet, 1000);
    const created = createReward({ telegramUserId: 14, walletFile, rewardsFile, now: 1 });
    const result = prepareRewardDelivery({
      adminUserId: 77,
      rewardId: created.reward.rewardId,
      amountHuman: "5",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: enabledEnv(dist.address),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "not-admin");
  });

  await runTest("10. sent reward cannot send again", () => {
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 15, userWallet, 1000);
    const created = createReward({ telegramUserId: 15, walletFile, rewardsFile, now: 1 });
    markRewardSent(created.reward.rewardId, makeSig("sentonce"), { rewardsFile, now: 2 });
    const result = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      amountHuman: "5",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: enabledEnv(dist.address),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "already-sent");
  });

  const amount = mangoHumanToBaseUnits("1000");

  await runTest("11-21. transaction verification gates", async () => {
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 16, userWallet, 1000);
    const created = createReward({ telegramUserId: 16, walletFile, rewardsFile, now: 1 });
    const prepared = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      amountHuman: "1000",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: enabledEnv(dist.address),
      now: 10,
    });
    const memo = deliveryMemo(prepared.review.deliveryId);
    const good = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      amount: amount.baseUnits,
      memo,
    });
    good.transaction.signatures[0] = makeSig("goodtx");
    assert.strictEqual(
      verifyDeliveryTransaction(good, {
        expectedSigner: dist.address,
        destinationOwner: userWallet.address,
        mint: MANGO_MINT,
        amountBaseUnits: amount.baseUnits,
        memo,
        createdAt: 10,
      }).ok,
      true
    );

    const wrongSigner = tokenTx({
      signer: userWallet.address,
      destination: userWallet.address,
      amount: amount.baseUnits,
      memo,
    });
    assert.strictEqual(
      verifyDeliveryTransaction(wrongSigner, {
        expectedSigner: dist.address,
        destinationOwner: userWallet.address,
        mint: MANGO_MINT,
        amountBaseUnits: amount.baseUnits,
        memo,
      }).reason,
      "wrong-signer"
    );

    const wrongMint = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      mint: generateSolanaWallet().address,
      amount: amount.baseUnits,
      memo,
    });
    assert.strictEqual(
      verifyDeliveryTransaction(wrongMint, {
        expectedSigner: dist.address,
        destinationOwner: userWallet.address,
        mint: MANGO_MINT,
        amountBaseUnits: amount.baseUnits,
        memo,
      }).reason,
      "wrong-mint"
    );

    const wrongDest = tokenTx({
      signer: dist.address,
      destination: generateSolanaWallet().address,
      amount: amount.baseUnits,
      memo,
    });
    assert.strictEqual(
      verifyDeliveryTransaction(wrongDest, {
        expectedSigner: dist.address,
        destinationOwner: userWallet.address,
        mint: MANGO_MINT,
        amountBaseUnits: amount.baseUnits,
        memo,
      }).reason,
      "wrong-destination"
    );

    const wrongAmt = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      amount: mangoHumanToBaseUnits("1").baseUnits,
      memo,
    });
    assert.strictEqual(
      verifyDeliveryTransaction(wrongAmt, {
        expectedSigner: dist.address,
        destinationOwner: userWallet.address,
        mint: MANGO_MINT,
        amountBaseUnits: amount.baseUnits,
        memo,
      }).reason,
      "wrong-amount"
    );

    const failed = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      amount: amount.baseUnits,
      memo,
      err: { InstructionError: [0, "Custom"] },
    });
    assert.strictEqual(
      verifyDeliveryTransaction(failed, {
        expectedSigner: dist.address,
        destinationOwner: userWallet.address,
        mint: MANGO_MINT,
        amountBaseUnits: amount.baseUnits,
        memo,
      }).reason,
      "failed-tx"
    );

    const sig = makeSig("confirm1");
    good.transaction.signatures[0] = sig;
    const confirmed = await confirmDelivery(prepared.token, sig, {
      deliveryFile,
      rewardsFile,
      now: 20,
      getTransactionImpl: async () => ({ ok: true, result: good }),
    });
    assert.strictEqual(confirmed.ok, true, confirmed.reason);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).txSignature, sig);

    const again = await confirmDelivery(prepared.token, sig, {
      deliveryFile,
      rewardsFile,
      now: 21,
      getTransactionImpl: async () => ({ ok: true, result: good }),
    });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.idempotent, true);

    const created2 = createReward({ telegramUserId: 16, walletFile, rewardsFile, now: 40 });
    const prepared2 = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created2.reward.rewardId,
      amountHuman: "1000",
      walletFile,
      rewardsFile,
      deliveryFile,
      env: enabledEnv(dist.address),
      now: 41,
    });
    const dup = await confirmDelivery(prepared2.token, sig, {
      deliveryFile,
      rewardsFile,
      now: 42,
      getTransactionImpl: async () => ({ ok: true, result: good }),
    });
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.reason, "duplicate-signature");
  });

  await runTest("22-26. presale allocation exact; no automatic distribution", () => {
    const { walletFile, rewardsFile, deliveryFile, presaleFile } = files();
    connectUser(walletFile, 18, userWallet, 1000);
    const alloc = mangoHumanToBaseUnits("200");
    mutatePresaleStore((store) => {
      store.users["18"] = {
        telegramUserId: "18",
        confirmedLamports: "10000000",
        allocatedMangoBaseUnits: alloc.baseUnits,
        contributions: [
          {
            id: "c-18",
            walletSnapshot: userWallet.address,
            contributedLamports: "10000000",
            mangoAllocationBaseUnits: alloc.baseUnits,
            transactionSignature: makeSig("pay18"),
            confirmedAt: 1,
            distributionStatus: "pending",
            distributionTxSignature: null,
          },
        ],
      };
    }, presaleFile);
    const prepared = preparePresaleDistribution({
      adminUserId: 9001,
      telegramUserId: 18,
      walletFile,
      rewardsFile,
      deliveryFile,
      presaleFile,
      env: enabledEnv(dist.address),
      now: 40,
    });
    assert.strictEqual(prepared.ok, true, prepared.error);
    assert.strictEqual(prepared.review.destination, userWallet.address);
    assert.strictEqual(prepared.review.mint, MANGO_MINT);
    assert.strictEqual(prepared.review.amountBaseUnits, alloc.baseUnits);
    assert.strictEqual(prepared.review.typeLabel, "Presale Allocation");
    const src = fs.readFileSync(path.join(__dirname, "..", "services", "presaleLedger.js"), "utf8");
    assert.ok(!src.includes("preparePresaleDistribution("));
    assert.ok(src.includes('distributionStatus: "pending"'));
  });

  await runTest("27-33. no private keys, no server signing, no auto XP/rewards", () => {
    const sources = [
      "services/rewardDelivery.js",
      "services/deliveryVerify.js",
      "services/deliveryApi.js",
      "commands/deliver.js",
    ].map((rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8").toLowerCase());
    for (const src of sources) {
      assert.ok(!src.includes("privatekey"));
      assert.ok(!src.includes("secretkey"));
      assert.ok(!src.includes("seed phrase"));
      assert.ok(!src.includes("signtransaction"));
      assert.ok(!src.includes("keypair"));
    }
    const weekly = fs.readFileSync(path.join(__dirname, "..", "services", "weeklyWinners.js"), "utf8");
    assert.ok(!weekly.includes("prepareRewardDelivery("));
    assert.ok(!weekly.includes("createReward("));
    const trivia = fs.readFileSync(path.join(__dirname, "..", "services", "points.js"), "utf8");
    assert.ok(trivia.includes("TRIVIA_ROUND_WIN_XP"));
  });

  await runTest("34. tests use temp files", () => {
    const { rewardsFile, deliveryFile } = files();
    assert.ok(rewardsFile.startsWith(os.tmpdir()) || rewardsFile.includes("mango-delivery-"));
    assert.ok(deliveryFile.includes("mango-delivery-") || deliveryFile.startsWith(tempDir));
    const prodRewards = path.resolve(__dirname, "..", "data", "member-rewards.json");
    const prodDelivery = path.resolve(__dirname, "..", "data", "reward-delivery.json");
    assert.notStrictEqual(path.resolve(rewardsFile), prodRewards);
    assert.notStrictEqual(path.resolve(deliveryFile), prodDelivery);
  });

  await runTest("admin /deliver disabled message; missing distribution wallet", () => {
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 19, userWallet, 1000);
    const created = createReward({ telegramUserId: 19, walletFile, rewardsFile, now: 1 });
    const ctx = createMockCtx({ text: `/deliver ${created.reward.rewardId} 10` });
    handleDeliver(ctx, {
      walletFile,
      rewardsFile,
      deliveryFile,
      env: { ADMIN_USER_ID: "9001", REWARD_DELIVERY_ENABLED: "true" },
    });
    assert.ok(ctx.replies[0].text.includes("Distribution wallet"));
  });

  await runTest("canonical mint is not taken from frontend", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "services", "rewardDelivery.js"), "utf8");
    assert.ok(src.includes("MANGO_MINT"));
    assert.ok(src.includes("ignoreClientOverrides"));
    assert.strictEqual(MANGO_MINT, "29KN57rM6tV2aWdo1agZcF6ynPXB1dhHdKHNrrAmaNGo");
    assert.strictEqual(MANGO_MINT_DECIMALS, 9);
  });

  await runTest("no XP change from delivery command import", () => {
    assert.strictEqual(typeof handleTrivia, "function");
  });

  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  setDeliveryFileForTests(null);
  setPresaleFileForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("reward-delivery tests passed");
}

main().catch((err) => {
  console.error(err);
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  setDeliveryFileForTests(null);
  setPresaleFileForTests(null);
  process.exitCode = 1;
});
