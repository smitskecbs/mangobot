/**
 * Community wallet / profile / rewards / presale hub slice.
 * Run: node tests/community-wallet-hub.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  MENU_LABELS,
  GROUP_MENU_TEXT,
  GROUP_PROFILE_TEXT,
  PRIVATE_MENU_HINT,
  GROUP_MENU_CALLBACK,
  PRIVATE_HUB_CALLBACK,
  getPrivateMenuKeyboard,
  getGroupMenuExtra,
  getGroupProfileMenuExtra,
  getPrivateProfileMenuExtra,
} = require("../utils/botMenu");
const {
  handleMenu,
  handleGroupMenuCallback,
  handlePrivateProfile,
  handlePrivateHubCallback,
} = require("../commands/menu");
const {
  handleWallet,
  handleWalletCallback,
  WALLET_HUB_CALLBACK,
  GROUP_WALLET_TEXT,
  UNVERIFIED_TEXT,
} = require("../commands/wallet");
const {
  handleRewards,
  EMPTY_REWARDS_TEXT,
  GROUP_REWARDS_TEXT,
} = require("../commands/rewards");
const {
  handlePresale,
  PRESALE_COMING_SOON_TEXT,
  PRESALE_CALLBACK,
  GROUP_PRESALE_TEXT,
} = require("../commands/presale");
const { handleReward } = require("../commands/reward");
const { handleMemberCheck } = require("../commands/membercheck");
const { handleStart } = require("../commands/start");
const { handleHelp, HELP_MESSAGE } = require("../commands/help");
const {
  createReward,
  markRewardSent,
  getReward,
  deliverReward,
  isRewardEligible,
  userFacingRewardLine,
} = require("../services/memberRewards");
const { PRESALE_LIVE } = require("../services/presaleParticipation");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { loadPoints } = require("../services/points");
const { shortenWallet } = require("../utils/solanaWallet");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-hub-"));
const pointsFile = path.join(tempDir, "points.json");
const prodRewards = path.resolve(__dirname, "..", "data", "member-rewards.json");
const prodWallets = path.resolve(__dirname, "..", "data", "wallet-links.json");
let n = 0;
const pending = [];

function files() {
  n += 1;
  return {
    walletFile: path.join(tempDir, `w-${n}.json`),
    rewardsFile: path.join(tempDir, `r-${n}.json`),
  };
}

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
  userId = 111,
  firstName = "Ada",
  botUsername = "ManGoMemeFunCommunityBot",
  startPayload,
  callbackData,
  replyUserId,
  replyName = "Pippi",
  text = "/menu",
} = {}) {
  const replies = [];
  const edits = [];
  const answered = [];
  return {
    chat: { type: chatType, id: chatType === "private" ? userId : -1001 },
    from: { id: userId, first_name: firstName },
    botInfo: botUsername ? { username: botUsername } : {},
    startPayload,
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    message: {
      text,
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

function inlineRows(payload) {
  const extra = payload && payload.extra;
  return (
    (extra && extra.reply_markup && extra.reply_markup.inline_keyboard) || []
  );
}

function buttons(payload) {
  return inlineRows(payload).flat();
}

const TX_SIG = `${"1".repeat(32)}${"2".repeat(32)}${"3".repeat(24)}`;

fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

runTest("1. Wallet grote hoofdmenu-knop", () => {
  const ctx = createMockCtx({ chatType: "supergroup" });
  handleMenu(ctx);
  const labels = buttons(ctx.replies[0]).map((b) => b.text);
  assert.ok(labels.includes("👛 Wallet"));
  assert.strictEqual(ctx.replies[0].text, GROUP_MENU_TEXT);
});

runTest("2. Rewards grote hoofdmenu-knop", () => {
  const ctx = createMockCtx({ chatType: "supergroup" });
  handleMenu(ctx);
  const labels = buttons(ctx.replies[0]).map((b) => b.text);
  assert.ok(labels.includes("🎁 Rewards"));
});

runTest("3. My Profile naam", () => {
  const ctx = createMockCtx({ chatType: "supergroup" });
  handleMenu(ctx);
  const labels = buttons(ctx.replies[0]).map((b) => b.text);
  assert.ok(labels.includes("👤 My Profile"));
  assert.ok(!labels.includes("👤 My Progress"));
  const privateRows = getPrivateMenuKeyboard().reply_markup.keyboard;
  assert.ok(privateRows[0].includes(MENU_LABELS.MY_PROFILE));
});

runTest("4. max 2 buttons per row", () => {
  const group = createMockCtx({ chatType: "group" });
  handleMenu(group);
  assert.ok(inlineRows(group.replies[0]).every((row) => row.length <= 2));
  assert.ok(
    getGroupProfileMenuExtra(group).reply_markup.inline_keyboard.every(
      (row) => row.length <= 2
    )
  );
  assert.ok(
    getPrivateProfileMenuExtra().reply_markup.inline_keyboard.every(
      (row) => row.length <= 2
    )
  );
  assert.ok(
    getPrivateMenuKeyboard().reply_markup.keyboard.every((row) => row.length <= 2)
  );
});

runTest("5. Back behavior", async () => {
  const groupBack = createMockCtx({
    chatType: "group",
    callbackData: GROUP_MENU_CALLBACK.BACK,
  });
  await handleGroupMenuCallback(groupBack);
  assert.strictEqual(groupBack.edits[0].text, GROUP_MENU_TEXT);

  const profile = createMockCtx({ chatType: "private" });
  handlePrivateProfile(profile);
  assert.strictEqual(profile.replies[0].text, GROUP_PROFILE_TEXT);
  const privateBack = createMockCtx({
    chatType: "private",
    callbackData: PRIVATE_HUB_CALLBACK.PROFILE_BACK,
  });
  await handlePrivateHubCallback(privateBack);
  assert.strictEqual(privateBack.replies[0].text, PRIVATE_MENU_HINT);
});

runTest("6. verified wallet view", () => {
  const { walletFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 333, wallet, 2000);
  const ctx = createMockCtx({ userId: 333 });
  handleWallet(ctx, { walletFile, now: 3000 });
  assert.ok(ctx.replies[0].text.includes("Status: 🟢 Verified"));
  assert.ok(ctx.replies[0].text.includes(shortenWallet(wallet.address)));
  assert.ok(!ctx.replies[0].text.includes(wallet.address));
  assert.deepStrictEqual(buttons(ctx.replies[0]).map((b) => b.text), [
    "Manage Wallet",
    "Rewards",
    "Presale",
    "⬅️ Back",
  ]);
});

runTest("7. unverified wallet view", () => {
  const { walletFile } = files();
  const ctx = createMockCtx({ userId: 222 });
  handleWallet(ctx, { walletFile, now: 1000 });
  assert.strictEqual(ctx.replies[0].text, UNVERIFIED_TEXT);
  assert.ok(ctx.replies[0].text.includes("No wallet registered yet."));
  assert.strictEqual(buttons(ctx.replies[0])[0].text, "🌐 Connect & Verify");
  assert.strictEqual(buttons(ctx.replies[0])[1].text, "⌨️ Enter Wallet Address");
});

runTest("8. group wallet → private deep-link", () => {
  const ctx = createMockCtx({ chatType: "supergroup", userId: 999 });
  handleWallet(ctx, { walletFile: files().walletFile });
  assert.strictEqual(ctx.replies[0].text, GROUP_WALLET_TEXT);
  assert.strictEqual(buttons(ctx.replies[0])[0].text, "Open Wallet");
  assert.strictEqual(
    buttons(ctx.replies[0])[0].url,
    "https://t.me/ManGoMemeFunCommunityBot?start=wallet"
  );
});

runTest("9. no full wallet in group", () => {
  const { walletFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 1001, wallet, 10_000);
  const ctx = createMockCtx({ chatType: "supergroup", userId: 1001 });
  handleWallet(ctx, { walletFile });
  handleMenu(ctx);
  const blob = JSON.stringify(ctx.replies);
  assert.ok(!blob.includes(wallet.address));
});

runTest("10. no uid in callbacks", () => {
  const group = createMockCtx({ chatType: "group", userId: 4242, botUsername: "" });
  const extra = getGroupMenuExtra(group);
  const blob = JSON.stringify(extra);
  assert.ok(!blob.includes("4242"));
  assert.ok(!blob.includes("uid"));
  const walletBtn = extra.reply_markup.inline_keyboard.flat().find((b) => b.text === "👛 Wallet");
  assert.strictEqual(walletBtn.callback_data, GROUP_MENU_CALLBACK.WALLET);
  Object.values(WALLET_HUB_CALLBACK).forEach((value) => {
    assert.ok(!value.includes("uid"));
    assert.ok(!/\d{3,}/.test(value));
  });
});

runTest("11. /presale group → private", () => {
  const ctx = createMockCtx({ chatType: "supergroup", userId: 88 });
  handlePresale(ctx);
  assert.strictEqual(ctx.replies[0].text, GROUP_PRESALE_TEXT);
  assert.ok(ctx.replies[0].text.includes("Open the presale privately"));
  assert.strictEqual(
    buttons(ctx.replies[0])[0].url,
    "https://t.me/ManGoMemeFunCommunityBot?start=presale"
  );
  assert.ok(!JSON.stringify(ctx.replies[0]).includes("88"));
});

runTest("12. private PRESALE_LIVE=false → Coming soon", () => {
  assert.strictEqual(PRESALE_LIVE, false);
  const ctx = createMockCtx({ userId: 12 });
  handlePresale(ctx);
  assert.strictEqual(ctx.replies[0].text, PRESALE_COMING_SOON_TEXT);
  assert.ok(ctx.replies[0].text.includes("not live yet"));
  const startCtx = createMockCtx({ userId: 12, startPayload: "presale" });
  handleStart(startCtx);
  assert.strictEqual(startCtx.replies[0].text, PRESALE_COMING_SOON_TEXT);
});

runTest("13. geen payment button", () => {
  const ctx = createMockCtx({ userId: 13 });
  handlePresale(ctx);
  const labels = buttons(ctx.replies[0]).map((b) => b.text);
  assert.deepStrictEqual(labels, ["Presale Info", "⬅️ Back"]);
  assert.ok(!labels.some((label) => /buy|pay|contribute|sol/i.test(label)));
});

runTest("14. geen fake allocation", () => {
  const text = PRESALE_COMING_SOON_TEXT.toLowerCase();
  assert.ok(!text.includes("allocation"));
  assert.ok(!text.includes("price"));
  assert.ok(!/\b20\d{2}-\d{2}-\d{2}\b/.test(PRESALE_COMING_SOON_TEXT));
});

runTest("15. geen SOL address", () => {
  const ctx = createMockCtx({ userId: 15 });
  handlePresale(ctx);
  const blob = JSON.stringify(ctx.replies[0]);
  assert.ok(!/treasury/i.test(blob));
  assert.ok(!/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(ctx.replies[0].text.replace(/ManGo/g, "")));
});

runTest("16. no rewards", () => {
  const { rewardsFile } = files();
  const ctx = createMockCtx({ userId: 16, text: "/rewards" });
  handleRewards(ctx, { rewardsFile });
  assert.strictEqual(ctx.replies[0].text, EMPTY_REWARDS_TEXT);
  assert.ok(ctx.replies[0].text.includes("No rewards yet"));
});

runTest("17. pending mystery gift", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 17, wallet, 1000);
  createReward({
    telegramUserId: 17,
    type: "mystery-gift",
    label: "1000 USDC secret prize",
    walletFile,
    rewardsFile,
    now: 1_700_000_000_000,
  });
  const ctx = createMockCtx({ userId: 17, text: "/rewards" });
  handleRewards(ctx, { rewardsFile });
  assert.ok(ctx.replies[0].text.includes("Mystery Gift"));
  assert.ok(ctx.replies[0].text.includes("Pending:"));
  assert.ok(ctx.replies[0].text.includes("🎁 Mystery Gift"));
  assert.ok(ctx.replies[0].text.includes("Status: Pending"));
  assert.ok(ctx.replies[0].text.includes("Created:"));
  assert.ok(!ctx.replies[0].text.includes("1000 USDC"));
  assert.ok(!ctx.replies[0].text.includes(wallet.address));
});

runTest("18. sent reward", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 18, wallet, 1000);
  const created = createReward({
    telegramUserId: 18,
    type: "airdrop",
    walletFile,
    rewardsFile,
    now: 1_700_000_000_000,
  });
  markRewardSent(created.reward.rewardId, TX_SIG, { rewardsFile, now: 2 });
  const ctx = createMockCtx({ userId: 18 });
  handleRewards(ctx, { rewardsFile });
  assert.ok(ctx.replies[0].text.includes("Sent:"));
  assert.ok(ctx.replies[0].text.includes("Status: Sent"));
  assert.ok(ctx.replies[0].text.includes(`Tx: ${shortenWallet(TX_SIG)}`));
  assert.ok(!ctx.replies[0].text.includes(TX_SIG));
});

runTest("19. user alleen eigen rewards", () => {
  const { walletFile, rewardsFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  connectUser(walletFile, 191, a, 1000);
  connectUser(walletFile, 192, b, 2000);
  createReward({ telegramUserId: 191, walletFile, rewardsFile, now: 3 });
  const other = createMockCtx({ userId: 192 });
  handleRewards(other, { rewardsFile });
  assert.strictEqual(other.replies[0].text, EMPTY_REWARDS_TEXT);
  const own = createMockCtx({ userId: 191 });
  handleRewards(own, { rewardsFile });
  assert.ok(own.replies[0].text.includes("Mystery Gift"));
});

runTest("20. wallet replace houdt snapshot", () => {
  const { walletFile, rewardsFile } = files();
  const first = generateSolanaWallet();
  const second = generateSolanaWallet();
  connectUser(walletFile, 20, first, 1000);
  const created = createReward({
    telegramUserId: 20,
    walletFile,
    rewardsFile,
    now: 2000,
  });
  connectUser(walletFile, 20, second, 4000);
  const stored = getReward(created.reward.rewardId, rewardsFile);
  assert.strictEqual(stored.walletSnapshot, first.address);
  assert.notStrictEqual(stored.walletSnapshot, second.address);
  assert.strictEqual(isRewardEligible(20, walletFile), true);
});

runTest("21. membercheck metrics", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 44, wallet, 1000);
  const ctx = createMockCtx({
    userId: 9001,
    replyUserId: 44,
    text: "/membercheck",
  });
  handleMemberCheck(ctx, { walletFile, rewardsFile, pointsFile });
  const text = ctx.replies[0].text;
  assert.ok(text.includes("Wallet: 🟢 Verified"));
  assert.ok(text.includes("Weekly XP:"));
  assert.ok(text.includes("Lifetime XP:"));
  assert.ok(text.includes("Current streak:"));
  assert.ok(text.includes("Longest streak:"));
  assert.ok(text.includes("Last active:"));
  assert.ok(text.includes("Pending rewards:"));
  assert.ok(text.includes("Sent rewards:"));
  assert.ok(text.includes("Presale contribution: Coming soon"));
  assert.ok(text.includes("Presale allocation:"));
  assert.ok(text.includes("Presale distribution:"));
  assert.ok(!/score/i.test(text));
});

runTest("22. reward mystery pending", () => {
  const { walletFile, rewardsFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 44, wallet, 1000);
  const ctx = createMockCtx({
    userId: 9001,
    replyUserId: 44,
    replyName: "Pippi",
    text: "/reward mystery",
  });
  handleReward(ctx, { walletFile, rewardsFile, now: 50, pointsFile });
  assert.ok(ctx.replies[0].text.includes("🎁 Mystery Gift prepared"));
  assert.ok(ctx.replies[0].text.includes("Status: Pending"));
  assert.ok(ctx.replies[0].text.includes("Reward ID:"));
  const member = createMockCtx({ userId: 44 });
  handleRewards(member, { rewardsFile });
  assert.ok(member.replies[0].text.includes("Mystery Gift"));
  assert.ok(member.replies[0].text.includes("Status: Pending"));
});

runTest("23. non-admin rejected", () => {
  const { walletFile, rewardsFile } = files();
  const ctx = createMockCtx({
    userId: 77,
    replyUserId: 44,
    text: "/reward",
  });
  handleReward(ctx, { walletFile, rewardsFile });
  assert.ok(ctx.replies[0].text.includes("admin only"));
});

runTest("24. no automatic payout", () => {
  const result = deliverReward("ABC123");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "not-implemented");
  const weekly = fs.readFileSync(
    path.join(__dirname, "..", "services", "weeklyWinners.js"),
    "utf8"
  );
  assert.ok(!weekly.includes("createReward("));
  assert.ok(!weekly.includes("deliverReward("));
});

runTest("25. no private key/seed fields", () => {
  const sources = [
    "commands/wallet.js",
    "commands/rewards.js",
    "commands/presale.js",
    "commands/reward.js",
    "commands/membercheck.js",
    "commands/deliver.js",
    "services/memberRewards.js",
    "services/rewardDelivery.js",
    "services/deliveryConfig.js",
    "utils/botMenu.js",
  ].map((rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8").toLowerCase());
  for (const src of sources) {
    assert.ok(!src.includes("privatekey"));
    assert.ok(!src.includes("seedphrase"));
    assert.ok(!src.includes("fromsecretkey"));
    assert.ok(!src.includes("mnemonic"));
    if (src.includes("never send your seed phrase or private key")) {
      continue;
    }
    assert.ok(!src.includes("seed phrase"));
  }
});

runTest("26. no XP changes", () => {
  const { walletFile } = files();
  const before = JSON.stringify(loadPoints(pointsFile));
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 26, wallet, 7000);
  handleWallet(createMockCtx({ userId: 26 }), { walletFile, now: 8000 });
  assert.strictEqual(JSON.stringify(loadPoints(pointsFile)), before);
});

runTest("27. no automatic weekly reward", () => {
  const scheduler = fs.readFileSync(
    path.join(__dirname, "..", "services", "communityScheduler.js"),
    "utf8"
  );
  assert.ok(!scheduler.includes("createReward("));
  assert.ok(!scheduler.includes("prepareRewardsForUsers("));
});

runTest("28. tests use temp stores", () => {
  const { walletFile, rewardsFile } = files();
  assert.ok(walletFile.startsWith(tempDir));
  assert.ok(rewardsFile.startsWith(tempDir));
  assert.notStrictEqual(path.resolve(walletFile), prodWallets);
  assert.notStrictEqual(path.resolve(rewardsFile), prodRewards);
});

runTest("29. no production state touched", () => {
  const { walletFile, rewardsFile } = files();
  assert.notStrictEqual(path.resolve(walletFile), prodWallets);
  assert.notStrictEqual(path.resolve(rewardsFile), prodRewards);
  if (fs.existsSync(prodRewards)) {
    assert.ok(!fs.readFileSync(prodRewards, "utf8").includes("mango-wallet-hub-"));
  }
  if (fs.existsSync(prodWallets)) {
    assert.ok(!fs.readFileSync(prodWallets, "utf8").includes("mango-wallet-hub-"));
  }
});

runTest("group rewards/presale privacy + help commands", () => {
  const rewardsCtx = createMockCtx({ chatType: "group", userId: 55 });
  handleRewards(rewardsCtx);
  assert.strictEqual(rewardsCtx.replies[0].text, GROUP_REWARDS_TEXT);
  assert.ok(!JSON.stringify(rewardsCtx.replies[0]).includes("55"));
  handleHelp(createMockCtx());
  assert.ok(HELP_MESSAGE.includes("/wallet"));
  assert.ok(HELP_MESSAGE.includes("/rewards"));
  assert.ok(HELP_MESSAGE.includes("/presale"));
  assert.ok(
    !HELP_MESSAGE.split("\n").some((line) => line.trim() === "/reward")
  );
});

runTest("userFacingRewardLine hides mystery contents", () => {
  const line = userFacingRewardLine({
    type: "mystery-gift",
    status: "pending",
    label: "hidden jackpot",
    offchainGiftLabel: "Telegram Gift",
    createdAt: 1_700_000_000_000,
    walletSnapshot: "should-not-appear",
  });
  assert.ok(line.includes("🎁 Mystery Gift"));
  assert.ok(!line.includes("hidden jackpot"));
  assert.ok(!line.includes("Telegram Gift"));
  assert.ok(!line.includes("should-not-appear"));
});

runTest("presale info callback stays coming soon", async () => {
  const ctx = createMockCtx({
    userId: 40,
    callbackData: PRESALE_CALLBACK.INFO,
  });
  await handlePresale(ctx);
  const info = createMockCtx({
    userId: 40,
    callbackData: PRESALE_CALLBACK.INFO,
  });
  const { handlePresaleCallback } = require("../commands/presale");
  await handlePresaleCallback(info);
  assert.strictEqual(info.replies[0].text, PRESALE_COMING_SOON_TEXT);
});

runTest("wallet hub callbacks have no uid", async () => {
  const { walletFile } = files();
  const ctx = createMockCtx({
    userId: 41,
    callbackData: WALLET_HUB_CALLBACK.BACK,
  });
  await handleWalletCallback(ctx, { walletFile });
  assert.strictEqual(ctx.replies[0].text, PRIVATE_MENU_HINT);
  assert.ok(!JSON.stringify(WALLET_HUB_CALLBACK).includes("41"));
});

Promise.all(pending).then(() => {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("community-wallet-hub tests passed");
});
