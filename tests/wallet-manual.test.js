/**
 * Telegram-only Solana public-key registration (registered, not verified).
 * Run: node tests/wallet-manual.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const { shortenWallet } = require("../utils/solanaWallet");
const {
  handleWallet,
  handleWalletCallback,
  handleWalletText,
  WALLET_CALLBACK,
  GROUP_WALLET_TEXT,
  UNVERIFIED_TEXT,
  ENTER_WALLET_PROMPT,
  INVALID_WALLET_TEXT,
  INPUT_CANCELLED,
  REMOVE_PROMPT,
} = require("../commands/wallet");
const { handleMemberCheck } = require("../commands/membercheck");
const { handlePoints } = require("../commands/points");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const {
  WALLET_INPUT_TTL_MS,
  REGISTRATION_MANUAL,
  REGISTRATION_SIGNATURE,
  getLinkedWalletForUser,
  getVerifiedWalletForUser,
  isWalletVerified,
  isWalletRegistered,
  registerManualWallet,
  beginWalletAddressInput,
  getPendingWalletInput,
  loadWalletStore,
  mutateWalletStore,
  setWalletFileForTests,
} = require("../services/walletLinks");
const {
  createReward,
  getReward,
  isRewardEligible,
} = require("../services/memberRewards");
const { getMemberActivityProfile } = require("../services/memberActivityProfile");
const { createPresaleSession } = require("../services/presaleSessions");
const { canUserContribute } = require("../services/presaleLedger");
const { MIN_CONTRIBUTION_LAMPORTS: MIN_LAMPORTS } = require("../services/presaleConstants");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-manual-"));
const pointsFile = path.join(tempDir, "points.json");
const prodWallets = path.resolve(__dirname, "..", "data", "wallet-links.json");
let fileIndex = 0;

function walletFile() {
  fileIndex += 1;
  return path.join(tempDir, `w-${fileIndex}.json`);
}

function rewardsFile() {
  fileIndex += 1;
  return path.join(tempDir, `r-${fileIndex}.json`);
}

function presaleFile() {
  fileIndex += 1;
  return path.join(tempDir, `p-${fileIndex}.json`);
}

function runTest(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result
      .then(() => console.log(`✓ ${name}`))
      .catch((err) => {
        console.error(`✗ ${name}`);
        throw err;
      });
  }
  console.log(`✓ ${name}`);
  return undefined;
}

function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    privateKey,
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

function createMockCtx({
  chatType = "private",
  userId = 111,
  firstName = "Ada",
  botUsername = "ManGoMemeFunCommunityBot",
  callbackData,
  text,
  replyUserId,
  replyName = "Pippi",
} = {}) {
  const replies = [];
  const edits = [];
  const answered = [];
  const chatId = chatType === "private" ? userId : -1001;
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName },
    botInfo: botUsername ? { username: botUsername } : {},
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    message: {
      text: text || "",
      reply_to_message: replyUserId
        ? { from: { id: replyUserId, first_name: replyName, is_bot: false } }
        : undefined,
    },
    replies,
    edits,
    answered,
    reply(body, extra) {
      replies.push({ text: body, extra });
      return Promise.resolve(replies[replies.length - 1]);
    },
    editMessageText(body, extra) {
      edits.push({ text: body, extra });
      return Promise.resolve(edits[edits.length - 1]);
    },
    answerCbQuery() {
      answered.push(true);
      return Promise.resolve();
    },
  };
}

function getButtons(payload) {
  const extra = payload && payload.extra;
  const rows =
    (extra && extra.reply_markup && extra.reply_markup.inline_keyboard) || [];
  return rows.flat();
}

function liveEnv(treasury) {
  return {
    PRESALE_ENABLED: "true",
    PRESALE_TREASURY_WALLET: treasury,
    PRESALE_RPC_URL: "https://rpc.test.invalid",
  };
}

fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");

const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

const pending = [];

pending.push(
  runTest("1. /wallet without wallet shows both choices", () => {
    const file = walletFile();
    const ctx = createMockCtx({ userId: 501 });
    handleWallet(ctx, { walletFile: file, now: 1000 });
    assert.strictEqual(ctx.replies[0].text, UNVERIFIED_TEXT);
    assert.ok(ctx.replies[0].text.includes("No wallet registered yet."));
    const labels = getButtons(ctx.replies[0]).map((b) => b.text);
    assert.ok(labels.includes("🌐 Connect & Verify"));
    assert.ok(labels.includes("⌨️ Enter Wallet Address"));
    assert.ok(labels.includes("⬅️ Back"));
  })
);

pending.push(
  runTest("2. manual entry accepts a valid address", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const enter = createMockCtx({
      userId: 502,
      callbackData: WALLET_CALLBACK.ENTER,
    });
    await handleWalletCallback(enter, { walletFile: file, now: 2000 });
    assert.strictEqual(enter.edits[0].text, ENTER_WALLET_PROMPT);
    assert.strictEqual(getButtons(enter.edits[0])[0].text, "Cancel");
    assert.ok(getPendingWalletInput(502, file, 2000));

    const typed = createMockCtx({
      userId: 502,
      text: `  ${wallet.address}  `,
    });
    const consumed = handleWalletText(typed, { walletFile: file, now: 2001 });
    assert.strictEqual(consumed, true);
    assert.ok(typed.replies[0].text.includes("✅ Wallet registered"));
    assert.ok(typed.replies[0].text.includes(shortenWallet(wallet.address)));
    assert.ok(typed.replies[0].text.includes("Status: 🟡 Registered"));
    assert.ok(!typed.replies[0].text.includes(wallet.address));
    const linked = getLinkedWalletForUser(502, file);
    assert.strictEqual(linked.wallet, wallet.address);
    assert.strictEqual(linked.verified, false);
    assert.strictEqual(linked.registrationMethod, REGISTRATION_MANUAL);
    assert.strictEqual(getVerifiedWalletForUser(502, file), null);
    assert.strictEqual(getPendingWalletInput(502, file, 2001), null);
  })
);

pending.push(
  runTest("3. invalid address is rejected", async () => {
    const file = walletFile();
    beginWalletAddressInput(503, 503, "register", file, 3000);
    const ctx = createMockCtx({ userId: 503, text: "not-a-solana-wallet" });
    const consumed = handleWalletText(ctx, { walletFile: file, now: 3001 });
    assert.strictEqual(consumed, true);
    assert.strictEqual(ctx.replies[0].text, INVALID_WALLET_TEXT);
    assert.strictEqual(getLinkedWalletForUser(503, file), null);
    assert.ok(getPendingWalletInput(503, file, 3001));
  })
);

pending.push(
  runTest("4. slash command is not stored as a wallet", () => {
    const file = walletFile();
    beginWalletAddressInput(504, 504, "register", file, 4000);
    const ctx = createMockCtx({ userId: 504, text: "/wallet" });
    const consumed = handleWalletText(ctx, { walletFile: file, now: 4001 });
    assert.strictEqual(consumed, false);
    assert.strictEqual(ctx.replies.length, 0);
    assert.strictEqual(getLinkedWalletForUser(504, file), null);
    assert.ok(getPendingWalletInput(504, file, 4001));
  })
);

pending.push(
  runTest("5. cancel clears input state", async () => {
    const file = walletFile();
    beginWalletAddressInput(505, 505, "register", file, 5000);
    const ctx = createMockCtx({
      userId: 505,
      callbackData: WALLET_CALLBACK.INPUT_CANCEL,
    });
    await handleWalletCallback(ctx, { walletFile: file, now: 5001 });
    assert.strictEqual(ctx.edits[0].text, INPUT_CANCELLED);
    assert.strictEqual(getPendingWalletInput(505, file, 5001), null);
    assert.strictEqual(getLinkedWalletForUser(505, file), null);
  })
);

pending.push(
  runTest("6. input-state expiry", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    beginWalletAddressInput(506, 506, "register", file, 6000);
    const expiredAt = 6000 + WALLET_INPUT_TTL_MS + 1;
    assert.strictEqual(getPendingWalletInput(506, file, expiredAt), null);
    const ctx = createMockCtx({ userId: 506, text: wallet.address });
    const consumed = handleWalletText(ctx, { walletFile: file, now: expiredAt });
    assert.strictEqual(consumed, false);
    assert.strictEqual(getLinkedWalletForUser(506, file), null);
  })
);

pending.push(
  runTest("7. manual wallet status is registered/unverified", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const result = registerManualWallet(507, wallet.address, file, 7000);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.verified, false);
    const linked = getLinkedWalletForUser(507, file);
    assert.strictEqual(linked.verified, false);
    assert.strictEqual(linked.registrationMethod, REGISTRATION_MANUAL);
    assert.strictEqual(linked.verifiedAt, 0);
    assert.strictEqual(isWalletVerified(507, file), false);
    assert.strictEqual(isWalletRegistered(507, file), true);
    const ctx = createMockCtx({ userId: 507 });
    handleWallet(ctx, { walletFile: file, now: 7001 });
    assert.ok(ctx.replies[0].text.includes("Status: 🟡 Registered"));
    const labels = getButtons(ctx.replies[0]).map((b) => b.text);
    assert.ok(labels.includes("🌐 Verify Wallet"));
    assert.ok(labels.includes("✏️ Change Wallet"));
    assert.ok(labels.includes("🗑 Remove Wallet"));
    const profile = getMemberActivityProfile(507, { walletFile: file, pointsFile });
    assert.strictEqual(profile.wallet.verified, false);
    assert.strictEqual(profile.wallet.registered, true);
    assert.strictEqual(profile.wallet.rewardEligible, true);
    const points = createMockCtx({ userId: 507 });
    handlePoints(points, { pointsFile, walletFile: file });
    assert.ok(points.replies[0].text.includes("Wallet: 🟡 Registered"));
  })
);

pending.push(
  runTest("8. signature wallet status is verified", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    connectUser(file, 508, wallet, 8000);
    const linked = getLinkedWalletForUser(508, file);
    assert.strictEqual(linked.verified, true);
    assert.strictEqual(linked.registrationMethod, REGISTRATION_SIGNATURE);
    assert.ok(linked.verifiedAt > 0);
    assert.strictEqual(getVerifiedWalletForUser(508, file).wallet, wallet.address);
    const ctx = createMockCtx({ userId: 508 });
    handleWallet(ctx, { walletFile: file, now: 8100 });
    assert.ok(ctx.replies[0].text.includes("Status: 🟢 Verified"));
  })
);

pending.push(
  runTest("9. existing verified wallet stays backward compatible", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    mutateWalletStore((store) => {
      store.users["509"] = {
        wallet: wallet.address,
        verifiedAt: 90,
        updatedAt: 90,
      };
      store.wallets[wallet.address] = "509";
    }, file);
    const linked = getLinkedWalletForUser(509, file);
    assert.strictEqual(linked.wallet, wallet.address);
    assert.strictEqual(linked.verified, true);
    assert.strictEqual(linked.registrationMethod, REGISTRATION_SIGNATURE);
    assert.strictEqual(getVerifiedWalletForUser(509, file).wallet, wallet.address);
    assert.strictEqual(isWalletVerified(509, file), true);
  })
);

pending.push(
  runTest("10. change wallet resets ownership verification", async () => {
    const file = walletFile();
    const first = generateSolanaWallet();
    const second = generateSolanaWallet();
    connectUser(file, 510, first, 10_000);
    assert.strictEqual(isWalletVerified(510, file), true);
    const change = createMockCtx({
      userId: 510,
      callbackData: WALLET_CALLBACK.CHANGE,
    });
    await handleWalletCallback(change, { walletFile: file, now: 10_100 });
    assert.strictEqual(change.edits[0].text, ENTER_WALLET_PROMPT);
    const typed = createMockCtx({ userId: 510, text: second.address });
    handleWalletText(typed, { walletFile: file, now: 10_101 });
    const linked = getLinkedWalletForUser(510, file);
    assert.strictEqual(linked.wallet, second.address);
    assert.strictEqual(linked.verified, false);
    assert.strictEqual(linked.registrationMethod, REGISTRATION_MANUAL);
    assert.strictEqual(getVerifiedWalletForUser(510, file), null);
    assert.ok(typed.replies[0].text.includes("Status: 🟡 Registered"));
  })
);

pending.push(
  runTest("11. remove wallet", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    registerManualWallet(511, wallet.address, file, 11_000);
    const remove = createMockCtx({
      userId: 511,
      callbackData: WALLET_CALLBACK.DISCONNECT,
    });
    await handleWalletCallback(remove, { walletFile: file, now: 11_001 });
    assert.strictEqual(remove.edits[0].text, REMOVE_PROMPT);
    const confirm = createMockCtx({
      userId: 511,
      callbackData: WALLET_CALLBACK.CONFIRM,
    });
    await handleWalletCallback(confirm, { walletFile: file, now: 11_002 });
    assert.strictEqual(getLinkedWalletForUser(511, file), null);
    assert.strictEqual(isWalletRegistered(511, file), false);
  })
);

pending.push(
  runTest("12. Mystery Gift uses the manual wallet as walletSnapshot", () => {
    const file = walletFile();
    const dest = rewardsFile();
    const wallet = generateSolanaWallet();
    registerManualWallet(512, wallet.address, file, 12_000);
    const created = createReward({
      telegramUserId: 512,
      type: "mystery-gift",
      walletFile: file,
      rewardsFile: dest,
      now: 12_001,
    });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.reward.walletSnapshot, wallet.address);
    assert.strictEqual(created.reward.type, "mystery-gift");
    assert.strictEqual(isRewardEligible(512, file), true);
  })
);

pending.push(
  runTest("13. existing reward keeps old walletSnapshot after wallet change", () => {
    const file = walletFile();
    const dest = rewardsFile();
    const first = generateSolanaWallet();
    const second = generateSolanaWallet();
    registerManualWallet(513, first.address, file, 13_000);
    const created = createReward({
      telegramUserId: 513,
      type: "mystery-gift",
      walletFile: file,
      rewardsFile: dest,
      now: 13_001,
    });
    registerManualWallet(513, second.address, file, 13_002);
    const stored = getReward(created.reward.rewardId, dest);
    assert.strictEqual(stored.walletSnapshot, first.address);
    assert.notStrictEqual(stored.walletSnapshot, second.address);
    assert.strictEqual(getLinkedWalletForUser(513, file).wallet, second.address);
  })
);

pending.push(
  runTest("14. presale verified-wallet gate is not bypassed", () => {
    const file = walletFile();
    const pFile = presaleFile();
    const wallet = generateSolanaWallet();
    const treasury = generateSolanaWallet();
    registerManualWallet(514, wallet.address, file, 14_000);
    const session = createPresaleSession(514, {
      walletFile: file,
      presaleFile: pFile,
      now: 14_001,
    });
    assert.strictEqual(session.ok, false);
    assert.strictEqual(session.reason, "unverified");
    const contrib = canUserContribute(514, MIN_LAMPORTS.toString(), {
      walletFile: file,
      presaleFile: pFile,
      env: liveEnv(treasury.address),
      now: 14_002,
    });
    assert.strictEqual(contrib.ok, false);
    assert.strictEqual(contrib.reason, "unverified");
    assert.strictEqual(getVerifiedWalletForUser(514, file), null);
  })
);

pending.push(
  runTest("15. no seed/private-key functionality", () => {
    const file = walletFile();
    beginWalletAddressInput(515, 515, "register", file, 15_000);
    const seed = createMockCtx({
      userId: 515,
      text: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    });
    assert.strictEqual(handleWalletText(seed, { walletFile: file, now: 15_001 }), true);
    assert.strictEqual(seed.replies[0].text, INVALID_WALLET_TEXT);
    const hex = createMockCtx({
      userId: 515,
      text: "a".repeat(64),
    });
    assert.strictEqual(handleWalletText(hex, { walletFile: file, now: 15_002 }), true);
    assert.strictEqual(getLinkedWalletForUser(515, file), null);
    const sources = [
      "commands/wallet.js",
      "services/walletLinks.js",
      "utils/solanaWallet.js",
    ].map((rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8").toLowerCase());
    for (const src of sources) {
      assert.ok(!src.includes("fromsecretkey"));
      assert.ok(!src.includes("bip39"));
      assert.ok(!src.includes("mnemonic"));
      assert.ok(!src.includes("privatekey"));
    }
    const prompt = fs.readFileSync(path.join(__dirname, "..", "commands", "wallet.js"), "utf8");
    assert.ok(prompt.includes("Never send your seed phrase or private key."));
  })
);

pending.push(
  runTest("16. restart/persistence is disk-backed", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    beginWalletAddressInput(516, 516, "register", file, 16_000);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(onDisk.pendingWalletInputs["516"]);
    assert.strictEqual(onDisk.pendingWalletInputs["516"].purpose, "register");
    setWalletFileForTests(file);
    try {
      const reloaded = loadWalletStore(file);
      assert.ok(reloaded.pendingWalletInputs["516"]);
      assert.ok(getPendingWalletInput(516, file, 16_000));
      const typed = createMockCtx({ userId: 516, text: wallet.address });
      handleWalletText(typed, { walletFile: file, now: 16_001 });
      assert.strictEqual(getLinkedWalletForUser(516, file).wallet, wallet.address);
      const after = loadWalletStore(file);
      assert.strictEqual(after.pendingWalletInputs["516"], undefined);
    } finally {
      setWalletFileForTests(null);
    }
  })
);

pending.push(
  runTest("17. store locking still serializes wallet writes", () => {
    const file = walletFile();
    const a = generateSolanaWallet();
    const b = generateSolanaWallet();
    mutateWalletStore((store) => {
      store.users["517a"] = {
        wallet: a.address,
        verifiedAt: 0,
        updatedAt: 1,
        registeredAt: 1,
        registrationMethod: REGISTRATION_MANUAL,
      };
      store.wallets[a.address] = "517a";
    }, file);
    mutateWalletStore((store) => {
      store.users["517b"] = {
        wallet: b.address,
        verifiedAt: 0,
        updatedAt: 2,
        registeredAt: 2,
        registrationMethod: REGISTRATION_MANUAL,
      };
      store.wallets[b.address] = "517b";
    }, file);
    const store = loadWalletStore(file);
    assert.strictEqual(store.users["517a"].wallet, a.address);
    assert.strictEqual(store.users["517b"].wallet, b.address);
  })
);

pending.push(
  runTest("membercheck distinguishes Registered vs Verified", () => {
    const file = walletFile();
    const manual = generateSolanaWallet();
    const signed = generateSolanaWallet();
    registerManualWallet(44, manual.address, file, 18_000);
    connectUser(file, 45, signed, 18_100);
    const registered = createMockCtx({
      userId: 9001,
      replyUserId: 44,
      text: "/membercheck",
    });
    handleMemberCheck(registered, { walletFile: file, pointsFile });
    assert.ok(registered.replies[0].text.includes("Wallet: 🟡 Registered"));
    assert.ok(!registered.replies[0].text.includes("🟢 Verified"));
    const verified = createMockCtx({
      userId: 9001,
      replyUserId: 45,
      text: "/membercheck",
    });
    handleMemberCheck(verified, { walletFile: file, pointsFile });
    assert.ok(verified.replies[0].text.includes("Wallet: 🟢 Verified"));
  })
);

pending.push(
  runTest("group Enter Wallet Address stays private", async () => {
    const file = walletFile();
    const ctx = createMockCtx({
      chatType: "supergroup",
      userId: 518,
      callbackData: WALLET_CALLBACK.ENTER,
    });
    await handleWalletCallback(ctx, { walletFile: file, now: 19_000 });
    assert.strictEqual(ctx.replies[0].text, GROUP_WALLET_TEXT);
    assert.strictEqual(getPendingWalletInput(518, file, 19_000), null);
  })
);

pending.push(
  runTest("tests do not touch production wallet-links.json", () => {
    const file = walletFile();
    assert.notStrictEqual(path.resolve(file), prodWallets);
    assert.ok(path.resolve(file).startsWith(tempDir));
    registerManualWallet(519, generateSolanaWallet().address, file, 20_000);
    assert.ok(!fs.readFileSync(file, "utf8").includes("mango-wallet-manual"));
    if (fs.existsSync(prodWallets)) {
      const prod = fs.readFileSync(prodWallets, "utf8");
      assert.ok(!prod.includes(path.basename(file)));
    }
  })
);

pending.push(
  runTest("signature after manual registration becomes verified", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    registerManualWallet(520, wallet.address, file, 21_000);
    assert.strictEqual(isWalletVerified(520, file), false);
    connectUser(file, 520, wallet, 21_100);
    assert.strictEqual(isWalletVerified(520, file), true);
    assert.strictEqual(getLinkedWalletForUser(520, file).registrationMethod, REGISTRATION_SIGNATURE);
  })
);

Promise.all(pending.filter(Boolean)).then(() => {
  if (originalAdmin === undefined) {
    delete process.env.ADMIN_USER_ID;
  } else {
    process.env.ADMIN_USER_ID = originalAdmin;
  }
  console.log("wallet-manual tests passed");
});
