/**
 * Multi-asset Mystery Gift delivery. Temp files only. No live RPC.
 * Run: node tests/delivery-multi-asset.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { Readable } = require("stream");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  createReward,
  getReward,
  userFacingRewardLine,
  mutateRewardsStore,
} = require("../services/memberRewards");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { setDeliveryFileForTests, mutateDeliveryStore } = require("../services/deliveryStore");
const {
  MANGO_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  deliveryMemo,
  mangoHumanToBaseUnits,
  humanAmountToBaseUnits,
  ASSET_SPL,
  ASSET_NFT,
  ASSET_OFFCHAIN,
} = require("../services/deliveryConstants");
const {
  UNSUPPORTED_TOKEN_2022: INSPECT_UNSUPPORTED_TOKEN,
  UNSUPPORTED_NFT: INSPECT_UNSUPPORTED_NFT,
} = require("../services/deliveryMintInspect");
const { verifyDeliveryTransaction } = require("../services/deliveryVerify");
const {
  prepareRewardDelivery,
  issueDeliveryPayment,
  confirmDelivery,
  reconcileDeliveryPayment,
  ignoreClientOverrides,
  expectedFromRecord,
  markOffchainDelivered,
} = require("../services/rewardDelivery");
const { tryHandleDeliveryRequest } = require("../services/deliveryApi");
const {
  handleDeliver,
  handleDeliverCallback,
  handleDeliverText,
  PICKER_PRIVATE_ONLY,
} = require("../commands/deliver");
const { buildMysteryGiftDeliveredMessage } = require("../services/mysteryGiftAnnounce");
const { buildMysteryGiftRecipientMessage } = require("../services/mysteryGiftNotify");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-multi-asset-"));
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

const DELIVERY_RPC = "https://delivery-rpc.test.invalid/rpc";
const INJECTED_RPC = "https://injected-rpc.test.invalid/rpc";

function enabledEnv(distributionWallet) {
  return {
    REWARD_DELIVERY_ENABLED: "true",
    PRESALE_DISTRIBUTION_ENABLED: "true",
    MANGO_DISTRIBUTION_WALLET: distributionWallet,
    SOLANA_RPC_URL: "https://example.invalid/rpc",
    ADMIN_USER_ID: "9001",
  };
}

function deliveryRpcEnv(distributionWallet) {
  return {
    REWARD_DELIVERY_ENABLED: "true",
    MANGO_DISTRIBUTION_WALLET: distributionWallet,
    DELIVERY_RPC_URL: DELIVERY_RPC,
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
  programId = TOKEN_PROGRAM_ID,
  program = "spl-token",
  decimals = 9,
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
            program,
            programId,
            parsed: {
              type: "transferChecked",
              info: {
                authority: authority || signer,
                source: sourceAta,
                destination: destAta,
                mint,
                tokenAmount: { amount: String(amount), decimals },
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

function fakeInspect(info) {
  return async (mint) => {
    if (info && info.ok === false) {
      return info;
    }
    return {
      ok: true,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      decimals: 6,
      supply: "1000000000",
      sourceAmount: "1000000000000",
      ...info,
    };
  };
}

function assertNoSecretFields(value) {
  const json = JSON.stringify(value);
  assert.equal(/helius/i.test(json), false);
  assert.equal(/api[-_]?key/i.test(json), false);
}

function jsonReq(body, method = "POST") {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.method = method;
  req.headers = { origin: "https://mangomeme.fun" };
  return req;
}

function mockRes() {
  return {
    statusCode: 0,
    body: "",
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload;
    },
  };
}

function createMockCtx({
  userId = 9001,
  text = "/deliver",
  chatType = "private",
  callbackData,
} = {}) {
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

async function main() {
  const dist = generateSolanaWallet();
  const userWallet = generateSolanaWallet();
  const splMint = generateSolanaWallet().address;
  const nftMint = generateSolanaWallet().address;
  const mangoAmount = mangoHumanToBaseUnits("10");

  function seedPending() {
    const { walletFile, rewardsFile, deliveryFile } = files();
    connectUser(walletFile, 61, userWallet, 1000);
    const created = createReward({ telegramUserId: 61, walletFile, rewardsFile, now: 1 });
    return { walletFile, rewardsFile, deliveryFile, created, env: enabledEnv(dist.address) };
  }

  await runTest("1. existing /deliver id 10 still prepares MANGO", () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const ctx = createMockCtx({ text: `/deliver ${created.reward.rewardId} 10`, chatType: "supergroup" });
    handleDeliver(ctx, { walletFile, rewardsFile, deliveryFile, env, now: 50 });
    assert.ok(ctx.replies[0].text.includes("Mystery Gift Delivery"));
    assert.ok(ctx.replies[0].text.includes("MANGO"));
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
    assert.strictEqual(prepared.ok, false);
    assert.strictEqual(prepared.reason, "session-active");
    const reward = getReward(created.reward.rewardId, rewardsFile);
    assert.strictEqual(reward.mint, MANGO_MINT);
    assert.strictEqual(reward.amountBaseUnits, mangoAmount.baseUnits);
  });

  await runTest("2. exact MANGO verification unchanged when mint omitted", () => {
    const good = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      amount: mangoAmount.baseUnits,
      memo: "mango-delivery:abc123",
    });
    const verified = verifyDeliveryTransaction(good, {
      expectedSigner: dist.address,
      destinationOwner: userWallet.address,
      amountBaseUnits: mangoAmount.baseUnits,
      memo: "mango-delivery:abc123",
      createdAt: Date.now() - 1000,
    });
    assert.strictEqual(verified.ok, true, verified.reason);
    assert.strictEqual(verified.mint, MANGO_MINT);
  });

  await runTest("3-4. group announce and private DM stay generic", () => {
    const group = buildMysteryGiftDeliveredMessage({ kind: "username", username: "MangoFan" });
    assert.ok(group.includes("Mystery Gift delivered"));
    assert.ok(!group.includes(splMint));
    assert.ok(!group.includes("10"));
    assert.ok(!/MANGO mint/i.test(group));
    const dm = buildMysteryGiftRecipientMessage();
    assert.ok(dm.includes("Mystery Gift delivered"));
    assert.ok(!dm.toLowerCase().includes("spl"));
    assert.ok(!dm.includes(MANGO_MINT));
  });

  await runTest("5-6. valid Tokenkeg SPL freeze uses inspect decimals", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const inspect = fakeInspect({ decimals: 6, sourceAmount: "100000000" });
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "10",
      inspectMint: inspect,
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    assert.strictEqual(prepared.ok, true, prepared.error);
    assert.strictEqual(prepared.review.mint, splMint);
    assert.strictEqual(prepared.review.decimals, 6);
    assert.strictEqual(prepared.review.tokenProgram, TOKEN_PROGRAM_ID);
    assert.strictEqual(prepared.review.amountBaseUnits, humanAmountToBaseUnits("10", 6).baseUnits);
    assert.notStrictEqual(prepared.review.mint, MANGO_MINT);
    assertNoSecretFields(prepared.review);
  });

  await runTest("Telegram SPL inspect uses configured delivery RPC without input.rpcUrl", async () => {
    const { walletFile, rewardsFile, deliveryFile, created } = seedPending();
    const seen = [];
    const inspect = async (mint, options = {}) => {
      seen.push(options.rpcUrl);
      return fakeInspect({ decimals: 6, sourceAmount: "100000000" })(mint, options);
    };
    const input = {
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "10",
      inspectMint: inspect,
      walletFile,
      rewardsFile,
      deliveryFile,
      env: deliveryRpcEnv(dist.address),
      now: 50,
    };
    assert.strictEqual(input.rpcUrl, undefined);
    const prepared = await prepareRewardDelivery(input);
    assert.strictEqual(prepared.ok, true, prepared.error);
    assert.deepStrictEqual(seen, [DELIVERY_RPC]);
    assert.ok(!seen.includes("https://example.invalid/rpc"));
  });

  await runTest("Telegram NFT inspect uses configured delivery RPC without input.rpcUrl", async () => {
    const { walletFile, rewardsFile, deliveryFile, created } = seedPending();
    const seen = [];
    const inspect = async (mint, options = {}) => {
      seen.push(options.rpcUrl);
      return fakeInspect({ decimals: 0, supply: "1", sourceAmount: "1" })(mint, options);
    };
    const input = {
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_NFT,
      mint: nftMint,
      inspectMint: inspect,
      walletFile,
      rewardsFile,
      deliveryFile,
      env: deliveryRpcEnv(dist.address),
      now: 50,
    };
    assert.strictEqual(input.rpcUrl, undefined);
    const prepared = await prepareRewardDelivery(input);
    assert.strictEqual(prepared.ok, true, prepared.error);
    assert.deepStrictEqual(seen, [DELIVERY_RPC]);
    assert.ok(!seen.includes("https://example.invalid/rpc"));
  });

  await runTest("explicit inspect rpcUrl override still wins over delivery config", async () => {
    const { walletFile, rewardsFile, deliveryFile, created } = seedPending();
    const seen = [];
    const inspect = async (mint, options = {}) => {
      seen.push(options.rpcUrl);
      return fakeInspect({ decimals: 6, sourceAmount: "100000000" })(mint, options);
    };
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "10",
      inspectMint: inspect,
      rpcUrl: INJECTED_RPC,
      walletFile,
      rewardsFile,
      deliveryFile,
      env: deliveryRpcEnv(dist.address),
      now: 50,
    });
    assert.strictEqual(prepared.ok, true, prepared.error);
    assert.deepStrictEqual(seen, [INJECTED_RPC]);
  });

  await runTest("7-10. SPL verify rejects wrong mint/amount/destination/signer", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "10",
      inspectMint: fakeInspect({ decimals: 6 }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    const expected = expectedFromRecord({
      expectedSigner: dist.address,
      destination: userWallet.address,
      mint: splMint,
      amountBaseUnits: prepared.review.amountBaseUnits,
      deliveryId: prepared.review.deliveryId,
      tokenProgram: TOKEN_PROGRAM_ID,
      createdAt: 50,
    });
    const memo = deliveryMemo(prepared.review.deliveryId);
    assert.strictEqual(
      verifyDeliveryTransaction(
        tokenTx({
          signer: dist.address,
          destination: userWallet.address,
          mint: generateSolanaWallet().address,
          amount: prepared.review.amountBaseUnits,
          memo,
          decimals: 6,
        }),
        expected
      ).reason,
      "wrong-mint"
    );
    assert.strictEqual(
      verifyDeliveryTransaction(
        tokenTx({
          signer: dist.address,
          destination: userWallet.address,
          mint: splMint,
          amount: "1",
          memo,
          decimals: 6,
        }),
        expected
      ).reason,
      "wrong-amount"
    );
    assert.strictEqual(
      verifyDeliveryTransaction(
        tokenTx({
          signer: dist.address,
          destination: generateSolanaWallet().address,
          mint: splMint,
          amount: prepared.review.amountBaseUnits,
          memo,
          decimals: 6,
        }),
        expected
      ).reason,
      "wrong-destination"
    );
    assert.strictEqual(
      verifyDeliveryTransaction(
        tokenTx({
          signer: userWallet.address,
          destination: userWallet.address,
          mint: splMint,
          amount: prepared.review.amountBaseUnits,
          memo,
          decimals: 6,
        }),
        expected
      ).reason,
      "wrong-signer"
    );
  });

  await runTest("11. insufficient source balance fails before signing", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "10",
      inspectMint: fakeInspect({ decimals: 6, sourceAmount: "1" }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    assert.strictEqual(prepared.ok, false);
    assert.strictEqual(prepared.reason, "insufficient-balance");
  });

  await runTest("12. client mint override rejected against session mint", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "10",
      inspectMint: fakeInspect({ decimals: 6 }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    const ignored = ignoreClientOverrides(
      { mint: MANGO_MINT, assetType: "mango" },
      {
        destination: userWallet.address,
        mint: splMint,
        amountBaseUnits: prepared.review.amountBaseUnits,
        assetType: ASSET_SPL,
        decimals: 6,
        tokenProgram: TOKEN_PROGRAM_ID,
      }
    );
    assert.strictEqual(ignored.ok, false);
    const confirmed = await confirmDelivery(prepared.token, makeSig("override"), {
      deliveryFile,
      rewardsFile,
      body: { mint: MANGO_MINT, destination: generateSolanaWallet().address },
    });
    assert.strictEqual(confirmed.ok, false);
  });

  await runTest("13-14. NFT decimals 0 supply 1 amount frozen 1", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_NFT,
      mint: nftMint,
      amountHuman: "99",
      inspectMint: fakeInspect({ decimals: 0, supply: "1", sourceAmount: "1" }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    assert.strictEqual(prepared.ok, true, prepared.error);
    assert.strictEqual(prepared.review.decimals, 0);
    assert.strictEqual(prepared.review.amountBaseUnits, "1");
    assert.strictEqual(prepared.review.mint, nftMint);
  });

  await runTest("15-16. NFT wrong mint rejected; amount cannot exceed 1", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_NFT,
      mint: nftMint,
      inspectMint: fakeInspect({ decimals: 0, supply: "1", sourceAmount: "1" }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    const expected = expectedFromRecord({
      expectedSigner: dist.address,
      destination: userWallet.address,
      mint: nftMint,
      amountBaseUnits: "1",
      deliveryId: prepared.review.deliveryId,
      createdAt: 50,
    });
    assert.strictEqual(
      verifyDeliveryTransaction(
        tokenTx({
          signer: dist.address,
          destination: userWallet.address,
          mint: splMint,
          amount: "1",
          memo: deliveryMemo(prepared.review.deliveryId),
          decimals: 0,
        }),
        expected
      ).reason,
      "wrong-mint"
    );
    assert.strictEqual(prepared.review.amountBaseUnits, "1");
  });

  await runTest("17. unsupported NFT standard rejected", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const token2022 = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_NFT,
      mint: nftMint,
      inspectMint: fakeInspect({
        ok: false,
        reason: "unsupported-token-2022",
        error: INSPECT_UNSUPPORTED_NFT,
      }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    assert.strictEqual(token2022.ok, false);
    assert.strictEqual(token2022.error, INSPECT_UNSUPPORTED_NFT);

    const { created: created2, walletFile: w2, rewardsFile: r2, deliveryFile: d2, env: env2 } = seedPending();
    const badDecimals = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created2.reward.rewardId,
      assetType: ASSET_NFT,
      mint: nftMint,
      inspectMint: fakeInspect({ decimals: 6, supply: "1", sourceAmount: "1" }),
      walletFile: w2,
      rewardsFile: r2,
      deliveryFile: d2,
      env: env2,
      now: 50,
    });
    assert.strictEqual(badDecimals.ok, false);
    assert.strictEqual(badDecimals.error, INSPECT_UNSUPPORTED_NFT);

    const { created: created3, walletFile: w3, rewardsFile: r3, deliveryFile: d3, env: env3 } = seedPending();
    const badSupply = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created3.reward.rewardId,
      assetType: ASSET_NFT,
      mint: nftMint,
      inspectMint: fakeInspect({ decimals: 0, supply: "10", sourceAmount: "1" }),
      walletFile: w3,
      rewardsFile: r3,
      deliveryFile: d3,
      env: env3,
      now: 50,
    });
    assert.strictEqual(badSupply.ok, false);
    assert.strictEqual(badSupply.error, INSPECT_UNSUPPORTED_NFT);
  });

  await runTest("18. NFT source ownership required", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_NFT,
      mint: nftMint,
      inspectMint: fakeInspect({ decimals: 0, supply: "1", sourceAmount: "0" }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    assert.strictEqual(prepared.ok, false);
    assert.strictEqual(prepared.reason, "insufficient-balance");
  });

  await runTest("19-21. off-chain has no tx, mark delivered, no fake signature", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_OFFCHAIN,
      walletFile,
      rewardsFile,
      deliveryFile,
      env: { ADMIN_USER_ID: "9001", REWARD_DELIVERY_ENABLED: "true", MANGO_DISTRIBUTION_WALLET: dist.address },
      now: 50,
    });
    assert.strictEqual(prepared.ok, true, prepared.error);
    assert.strictEqual(prepared.url, null);
    assert.strictEqual(prepared.token, null);
    assert.strictEqual(prepared.review.assetType, ASSET_OFFCHAIN);
    const paid = await issueDeliveryPayment("not-a-token", { deliveryFile, env, now: 60 });
    assert.strictEqual(paid.ok, false);
    const marked = await markOffchainDelivered({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      deliveryNote: "handed to member",
      rewardsFile,
      deliveryFile,
      now: 70,
    });
    assert.strictEqual(marked.ok, true, marked.error);
    const reward = getReward(created.reward.rewardId, rewardsFile);
    assert.strictEqual(reward.status, "sent");
    assert.ok(reward.offchainDeliveredAt);
    assert.ok(!reward.txSignature);
    assert.strictEqual(reward.deliveryNote, "handed to member");
    const recon = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: makeSig("fakesig"),
      rewardsFile,
      deliveryFile,
      env,
      now: 80,
    });
    assert.strictEqual(recon.ok, false);
    assert.strictEqual(recon.reason, "offchain");
  });

  await runTest("22-23. destination frozen; frontend cannot override asset", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "2",
      inspectMint: fakeInspect({ decimals: 6 }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    assert.strictEqual(prepared.review.destination, userWallet.address);
    const ignored = ignoreClientOverrides(
      { destination: dist.address, assetType: "nft", mint: nftMint },
      {
        destination: userWallet.address,
        mint: splMint,
        amountBaseUnits: prepared.review.amountBaseUnits,
        assetType: ASSET_SPL,
        decimals: 6,
        tokenProgram: TOKEN_PROGRAM_ID,
      }
    );
    assert.strictEqual(ignored.ok, false);
  });

  await runTest("24. no Helius key leak in inspect or API payloads", async () => {
    assert.strictEqual(INSPECT_UNSUPPORTED_TOKEN, "Unsupported token type for automatic delivery.");
    assert.strictEqual(INSPECT_UNSUPPORTED_NFT, "Unsupported NFT type for automatic delivery.");
    const inspect = fakeInspect({ decimals: 6 });
    const info = await inspect(splMint, { sourceOwner: dist.address });
    assertNoSecretFields(info);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(info, "apiKey"), false);
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "1",
      inspectMint: inspect,
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    const res = mockRes();
    await tryHandleDeliveryRequest(
      jsonReq({ token: prepared.token }),
      res,
      "https://mangomeme.fun",
      "/delivery/status",
      "POST",
      { env, deliveryFile, rewardsFile, now: 60 }
    );
    const body = JSON.parse(res.body);
    assertNoSecretFields(body);
    const srcs = [
      "services/deliveryMintInspect.js",
      "services/rewardDelivery.js",
      "services/deliveryApi.js",
      "commands/deliver.js",
    ].map((rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));
    for (const src of srcs) {
      assert.equal(/HELIUS_API_KEY/.test(src), false);
      assert.equal(/apiKey\s*:/.test(src), false);
    }
  });

  await runTest("25. client still only sends token + signature", () => {
    const api = fs.readFileSync("C:\\Users\\kevin\\cbs-projects\\mango\\src\\adminDeliveryApi.ts", "utf8");
    assert.ok(api.includes("{ token }"));
    assert.ok(api.includes("{ token, signature }") || api.includes("token, signature"));
    assert.ok(!api.includes("mint:"));
    assert.ok(!api.includes("amountBaseUnits:"));
  });

  await runTest("26. SPL reconcile uses frozen mint not MANGO", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "10",
      inspectMint: fakeInspect({ decimals: 6 }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    const sig = makeSig("splrecon");
    const tx = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      mint: splMint,
      amount: prepared.review.amountBaseUnits,
      memo: deliveryMemo(prepared.review.deliveryId),
      decimals: 6,
    });
    tx.transaction.signatures[0] = sig;
    const mangoTx = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      mint: MANGO_MINT,
      amount: prepared.review.amountBaseUnits,
      memo: deliveryMemo(prepared.review.deliveryId),
      decimals: 9,
    });
    mangoTx.transaction.signatures[0] = sig;
    const wrong = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      signature: sig,
      rewardsFile,
      deliveryFile,
      env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: mangoTx }),
    });
    assert.ok(wrong.ok === false && wrong.reason === "wrong-mint");

    const goodSeed = seedPending();
    const preparedOk = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: goodSeed.created.reward.rewardId,
      assetType: ASSET_SPL,
      mint: splMint,
      amountHuman: "10",
      inspectMint: fakeInspect({ decimals: 6 }),
      walletFile: goodSeed.walletFile,
      rewardsFile: goodSeed.rewardsFile,
      deliveryFile: goodSeed.deliveryFile,
      env: goodSeed.env,
      now: 50,
    });
    const goodSig = makeSig("splreconok");
    const goodTx = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      mint: splMint,
      amount: preparedOk.review.amountBaseUnits,
      memo: deliveryMemo(preparedOk.review.deliveryId),
      decimals: 6,
    });
    goodTx.transaction.signatures[0] = goodSig;
    const right = await reconcileDeliveryPayment({
      adminUserId: 9001,
      rewardId: goodSeed.created.reward.rewardId,
      signature: goodSig,
      rewardsFile: goodSeed.rewardsFile,
      deliveryFile: goodSeed.deliveryFile,
      env: goodSeed.env,
      now: 80,
      getTransactionImpl: async () => ({ ok: true, result: goodTx }),
    });
    assert.strictEqual(right.ok, true, right.reason);
    assert.strictEqual(getReward(goodSeed.created.reward.rewardId, goodSeed.rewardsFile).status, "sent");
  });

  await runTest("27. NFT reconcile", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const prepared = await prepareRewardDelivery({
      adminUserId: 9001,
      rewardId: created.reward.rewardId,
      assetType: ASSET_NFT,
      mint: nftMint,
      inspectMint: fakeInspect({ decimals: 0, supply: "1", sourceAmount: "1" }),
      walletFile,
      rewardsFile,
      deliveryFile,
      env,
      now: 50,
    });
    const sig = makeSig("nftrecon");
    const tx = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      mint: nftMint,
      amount: "1",
      memo: deliveryMemo(prepared.review.deliveryId),
      decimals: 0,
    });
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
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).mint, nftMint);
  });

  await runTest("28. MANGO reconcile regression for old record without assetType", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
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
    mutateRewardsStore((store) => {
      const rec = store.rewards[created.reward.rewardId];
      delete rec.assetType;
      delete rec.mint;
      delete rec.tokenProgram;
      delete rec.decimals;
    }, rewardsFile);
    mutateDeliveryStore((store) => {
      const rec = Object.values(store.sessions)[0];
      delete rec.assetType;
      delete rec.mint;
      delete rec.tokenProgram;
      delete rec.decimals;
    }, deliveryFile);
    const expected = expectedFromRecord(getReward(created.reward.rewardId, rewardsFile), {
      expectedSigner: dist.address,
    });
    assert.strictEqual(expected.mint, MANGO_MINT);
    const sig = makeSig("oldmango");
    const tx = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      amount: mangoAmount.baseUnits,
      memo: deliveryMemo(prepared.review.deliveryId),
    });
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
  });

  await runTest("29-30. user pending view and group post hide asset/amount", () => {
    const line = userFacingRewardLine({
      type: "mystery-gift",
      status: "delivery-ready",
      mint: splMint,
      amountBaseUnits: "10000000",
      assetType: ASSET_SPL,
      createdAt: Date.now(),
    });
    assert.ok(line.includes("Mystery Gift"));
    assert.ok(line.includes("Pending"));
    assert.ok(!line.includes(splMint));
    assert.ok(!line.includes("10000000"));
    const group = buildMysteryGiftDeliveredMessage({ kind: "anonymous" });
    assert.ok(!group.includes(splMint));
    assert.ok(!group.includes("Amount"));
  });

  await runTest("Token-2022 transfer is unsupported-token-program", () => {
    const tx = tokenTx({
      signer: dist.address,
      destination: userWallet.address,
      mint: splMint,
      amount: "1000000",
      memo: "mango-delivery:tok2022",
      programId: TOKEN_2022_PROGRAM_ID,
      program: "spl-token-2022",
      decimals: 6,
    });
    const verified = verifyDeliveryTransaction(tx, {
      expectedSigner: dist.address,
      destinationOwner: userWallet.address,
      mint: splMint,
      amountBaseUnits: "1000000",
      memo: "mango-delivery:tok2022",
    });
    assert.strictEqual(verified.ok, false);
    assert.strictEqual(verified.reason, "unsupported-token-program");
  });

  await runTest("picker is private-only; amount path works in group", () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const groupPicker = createMockCtx({
      text: `/deliver ${created.reward.rewardId}`,
      chatType: "supergroup",
    });
    handleDeliver(groupPicker, { walletFile, rewardsFile, deliveryFile, env, now: 50 });
    assert.ok(groupPicker.replies[0].text.includes(PICKER_PRIVATE_ONLY) || groupPicker.replies[0].text.includes("private"));
    const privatePicker = createMockCtx({ text: `/deliver ${created.reward.rewardId}` });
    handleDeliver(privatePicker, { walletFile, rewardsFile, deliveryFile, env, now: 50 });
    assert.ok(privatePicker.replies[0].text.includes("Choose Mystery Gift type"));
  });

  await runTest("text handler calls next when no pending delivery input", async () => {
    const bot = {
      command() {},
      action() {},
      on(event, fn) {
        if (event === "text") {
          this.textFn = fn;
        }
      },
    };
    require("../commands/deliver")(bot);
    let nextCalled = false;
    await bot.textFn(
      { from: { id: 9001 }, chat: { type: "private", id: 9001 }, message: { text: "/wallet" } },
      () => {
        nextCalled = true;
      }
    );
    assert.strictEqual(nextCalled, true);
  });

  await runTest("NFT picker skipped: mint input only, no Helius in deliver command", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "commands", "deliver.js"), "utf8");
    assert.ok(src.includes("Send the NFT mint address"));
    assert.ok(!/helius/i.test(src));
    assert.ok(!src.includes("picker list"));
  });

  await runTest("offchain callback marks delivered without signature", async () => {
    const { walletFile, rewardsFile, deliveryFile, created, env } = seedPending();
    const ctx = createMockCtx({
      callbackData: `dlv:o:${created.reward.rewardId}`,
    });
    await handleDeliverCallback(ctx, {
      walletFile,
      rewardsFile,
      deliveryFile,
      env: { ...env, SOLANA_RPC_URL: undefined },
      now: 50,
    });
    assert.ok(ctx.replies.some((row) => String(row.text).includes("Off-chain") || String(row.text).includes("Mark delivered") || String(row.text).includes("Mystery Gift")));
    const mark = createMockCtx({ callbackData: `dlv:d:${created.reward.rewardId}` });
    await handleDeliverCallback(mark, { walletFile, rewardsFile, deliveryFile, env, now: 60 });
    const reward = getReward(created.reward.rewardId, rewardsFile);
    assert.strictEqual(reward.status, "sent");
    assert.ok(!reward.txSignature);
  });

  process.env.ADMIN_USER_ID = originalAdmin;
  console.log("delivery-multi-asset tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
