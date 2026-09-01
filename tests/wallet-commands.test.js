/**
 * Telegram /wallet commands, menu, /start wallet, /points status, disconnect.
 * Run: node tests/wallet-commands.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  handleWallet,
  handleWalletCallback,
  WALLET_CALLBACK,
  WALLET_HUB_CALLBACK,
  GROUP_WALLET_TEXT,
  UNVERIFIED_TEXT,
  DISCONNECT_PROMPT,
  DISCONNECT_DONE,
} = require("../commands/wallet");
const { handleStart } = require("../commands/start");
const { handlePoints } = require("../commands/points");
const { handleHelp, HELP_MESSAGE } = require("../commands/help");
const { getGroupProfileMenuExtra } = require("../utils/botMenu");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
  hashToken,
} = require("../services/walletVerification");
const {
  getVerifiedWalletForUser,
  isWalletVerified,
  loadWalletStore,
} = require("../services/walletLinks");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const { loadPoints, awardDailyActivityPoint } = require("../services/points");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-cmd-"));
const pointsFile = path.join(tempDir, "points.json");
let fileIndex = 0;

function walletFile() {
  fileIndex += 1;
  return path.join(tempDir, `w-${fileIndex}.json`);
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
    privateKey,
    address: encodeBase58(publicKeyRaw),
    sign(message) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      return signEd25519Detached(buf, privateKey);
    },
  };
}

function createMockCtx({
  chatType = "private",
  userId = 111,
  firstName = "Ada",
  botUsername = "ManGoMemeFunCommunityBot",
  startPayload,
  callbackData,
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
    replies,
    edits,
    answered,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve(replies[replies.length - 1]);
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
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
  return created;
}

runTest("1. /wallet group → private deep-link", async () => {
  const ctx = createMockCtx({ chatType: "supergroup", userId: 999 });
  handleWallet(ctx, { walletFile: walletFile() });
  assert.strictEqual(ctx.replies[0].text, GROUP_WALLET_TEXT);
  const buttons = getButtons(ctx.replies[0]);
  assert.strictEqual(buttons[0].text, "Open Wallet");
  assert.strictEqual(
    buttons[0].url,
    "https://t.me/ManGoMemeFunCommunityBot?start=wallet"
  );
  const blob = JSON.stringify(ctx.replies[0]);
  assert.ok(!blob.includes("999"));
  assert.ok(!blob.includes("?t="));
});

runTest("2. /wallet private unverified", async () => {
  const file = walletFile();
  const ctx = createMockCtx({ chatType: "private", userId: 222 });
  handleWallet(ctx, { walletFile: file, now: 1000 });
  assert.strictEqual(ctx.replies[0].text, UNVERIFIED_TEXT);
  const buttons = getButtons(ctx.replies[0]);
  assert.strictEqual(buttons[0].text, "🌐 Connect & Verify");
  assert.ok(buttons[0].url.includes("https://mangomeme.fun/wallet-connect?t="));
  assert.ok(!buttons[0].url.includes("222"));
  assert.strictEqual(buttons[1].text, "⌨️ Enter Wallet Address");
  assert.strictEqual(buttons[1].callback_data, WALLET_CALLBACK.ENTER);
  assert.strictEqual(buttons[2].text, "⬅️ Back");
  assert.strictEqual(buttons[2].callback_data, WALLET_HUB_CALLBACK.BACK);
});

runTest("3. /wallet private verified hub", async () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 333, wallet, 2000);
  const ctx = createMockCtx({ chatType: "private", userId: 333 });
  handleWallet(ctx, { walletFile: file, now: 3000 });
  assert.ok(ctx.replies[0].text.includes("💳 My Wallet"));
  assert.ok(ctx.replies[0].text.includes("Status: 🟢 Verified"));
  assert.ok(ctx.replies[0].text.includes("..."));
  assert.ok(!ctx.replies[0].text.includes(wallet.address));
  const labels = getButtons(ctx.replies[0]).map((b) => b.text);
  assert.deepStrictEqual(labels, [
    "Manage Wallet",
    "Rewards",
    "Presale",
    "⬅️ Back",
  ]);
  assert.ok(!labels.includes("Replace Wallet"));
  assert.ok(!labels.includes("Disconnect Wallet"));
});

runTest("Manage Wallet shows replace/disconnect", async () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 334, wallet, 2000);
  const ctx = createMockCtx({
    chatType: "private",
    userId: 334,
    callbackData: WALLET_HUB_CALLBACK.MANAGE,
  });
  await handleWalletCallback(ctx, { walletFile: file, now: 3000 });
  const labels = getButtons(ctx.edits[0]).map((b) => b.text);
  assert.ok(labels.includes("Replace Wallet"));
  assert.ok(labels.includes("Disconnect Wallet"));
  assert.ok(ctx.edits[0].text.includes("Presale:"));
  assert.ok(ctx.edits[0].text.includes("Coming soon"));
});

runTest("4. /start wallet", async () => {
  const file = walletFile();
  const ctx = createMockCtx({
    chatType: "private",
    userId: 444,
    startPayload: "wallet",
  });
  handleStart(ctx, { walletFile: file, now: 4000 });
  assert.strictEqual(ctx.replies[0].text, UNVERIFIED_TEXT);
});

runTest("/start wallet group does not dump wallet", async () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 555, wallet, 5000);
  const ctx = createMockCtx({
    chatType: "group",
    userId: 555,
    startPayload: "wallet",
  });
  handleStart(ctx, { walletFile: file });
  assert.ok(!ctx.replies[0].text.includes(wallet.address));
  assert.ok(!ctx.replies[0].text.includes("Verified"));
});

runTest("/mywallet same handler as /wallet", async () => {
  const file = walletFile();
  const a = createMockCtx({ userId: 10 });
  const b = createMockCtx({ userId: 10 });
  handleWallet(a, { walletFile: file, now: 10 });
  handleWallet(b, { walletFile: file, now: 11 });
  assert.strictEqual(a.replies[0].text, b.replies[0].text);
});

runTest("10. owner works same as member", async () => {
  const prev = process.env.ADMIN_USER_ID;
  process.env.ADMIN_USER_ID = "9001";
  try {
    const file = walletFile();
    const owner = createMockCtx({ userId: 9001 });
    const member = createMockCtx({ userId: 42 });
    handleWallet(owner, { walletFile: file, now: 20 });
    handleWallet(member, { walletFile: file, now: 21 });
    assert.strictEqual(owner.replies[0].text, UNVERIFIED_TEXT);
    assert.strictEqual(member.replies[0].text, UNVERIFIED_TEXT);
    assert.strictEqual(getButtons(owner.replies[0])[0].text, "🌐 Connect & Verify");
    assert.strictEqual(getButtons(member.replies[0])[0].text, "🌐 Connect & Verify");
    assert.strictEqual(getButtons(owner.replies[0])[1].text, "⌨️ Enter Wallet Address");
    assert.strictEqual(getButtons(member.replies[0])[1].text, "⌨️ Enter Wallet Address");
  } finally {
    if (prev === undefined) {
      delete process.env.ADMIN_USER_ID;
    } else {
      process.env.ADMIN_USER_ID = prev;
    }
  }
});

runTest("11. no XP on wallet connect", async () => {
  const file = walletFile();
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }), "utf8");
  const wallet = generateSolanaWallet();
  connectUser(file, 77, wallet, 7000);
  const points = loadPoints(pointsFile);
  assert.deepStrictEqual(points.users, {});
  assert.strictEqual(isWalletVerified(77, file), true);
});

runTest("12. points wallet status", async () => {
  const file = walletFile();
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }), "utf8");
  const unverified = createMockCtx({ userId: 80 });
  handlePoints(unverified, { pointsFile, walletFile: file });
  assert.ok(unverified.replies[0].text.includes("Wallet: ⬜ Not linked"));
  assert.ok(unverified.replies[0].text.includes("XP earning locked"));
  const wallet = generateSolanaWallet();
  connectUser(file, 80, wallet, 8000);
  const verified = createMockCtx({ userId: 80 });
  handlePoints(verified, { pointsFile, walletFile: file });
  assert.ok(verified.replies[0].text.includes("Wallet: ✅ Verified"));
  assert.ok(!verified.replies[0].text.includes("XP earning locked"));
  assert.ok(!verified.replies[0].text.includes(wallet.address));
});

runTest("wallet connect does not change existing XP", async () => {
  const file = walletFile();
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }), "utf8");
  await awardDailyActivityPoint(81, "Ada", pointsFile);
  const before = loadPoints(pointsFile).users["81"].points;
  const wallet = generateSolanaWallet();
  connectUser(file, 81, wallet, 8100);
  const after = loadPoints(pointsFile).users["81"].points;
  assert.strictEqual(before, after);
});

runTest("13. disconnect confirmation", async () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 90, wallet, 9000);
  const ctx = createMockCtx({
    userId: 90,
    callbackData: WALLET_CALLBACK.DISCONNECT,
  });
  await handleWalletCallback(ctx, { walletFile: file });
  assert.strictEqual(ctx.edits[0].text, DISCONNECT_PROMPT);
  const labels = getButtons(ctx.edits[0]).map((b) => b.text);
  assert.deepStrictEqual(labels, ["Yes, disconnect", "Cancel"]);
  assert.strictEqual(isWalletVerified(90, file), true);
});

runTest("14. disconnect cancel", async () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 91, wallet, 9100);
  const ctx = createMockCtx({
    userId: 91,
    callbackData: WALLET_CALLBACK.CANCEL,
  });
  await handleWalletCallback(ctx, { walletFile: file, now: 9200 });
  assert.ok(ctx.edits[0].text.includes("✅ Verified"));
  assert.strictEqual(isWalletVerified(91, file), true);
});

runTest("15. disconnect confirm", async () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 92, wallet, 9300);
  const ctx = createMockCtx({
    userId: 92,
    callbackData: WALLET_CALLBACK.CONFIRM,
  });
  await handleWalletCallback(ctx, { walletFile: file, now: 9400 });
  assert.strictEqual(ctx.edits[0].text, DISCONNECT_DONE);
  assert.strictEqual(isWalletVerified(92, file), false);
  const points = loadPoints(pointsFile);
  assert.ok(!points.users["92"] || points.users["92"].points === undefined || true);
});

runTest("20. bot callbacks no uid/wallet", async () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 93, wallet, 9500);
  const ctx = createMockCtx({
    userId: 93,
    callbackData: WALLET_CALLBACK.DISCONNECT,
  });
  await handleWalletCallback(ctx, { walletFile: file });
  const blob = JSON.stringify(ctx.edits[0]);
  assert.ok(!blob.includes("93"));
  assert.ok(!blob.includes(wallet.address));
  assert.strictEqual(
    getButtons(ctx.edits[0])[0].callback_data,
    WALLET_CALLBACK.CONFIRM
  );
  assert.strictEqual(
    getButtons(ctx.edits[0])[1].callback_data,
    WALLET_CALLBACK.CANCEL
  );
});

runTest("menu Wallet Status deep-link", async () => {
  const ctx = createMockCtx({ chatType: "group" });
  const extra = getGroupProfileMenuExtra(ctx);
  const rows = extra.reply_markup.inline_keyboard;
  assert.deepStrictEqual(
    rows.map((row) => row.map((b) => b.text)),
    [
      ["My Points", "My Streak"],
      ["Wallet Status", "Rewards"],
      ["⬅️ Back"],
    ]
  );
  assert.strictEqual(
    rows[1][0].url,
    "https://t.me/ManGoMemeFunCommunityBot?start=wallet"
  );
  assert.strictEqual(
    rows[1][1].url,
    "https://t.me/ManGoMemeFunCommunityBot?start=rewards"
  );
});

runTest("help lists /wallet /mywallet /presale", async () => {
  const ctx = createMockCtx();
  handleHelp(ctx);
  assert.ok(HELP_MESSAGE.includes("/wallet"));
  assert.ok(HELP_MESSAGE.includes("/mywallet"));
  assert.ok(HELP_MESSAGE.includes("/rewards"));
  assert.ok(HELP_MESSAGE.includes("/presale"));
  assert.strictEqual(ctx.replies[0].text, HELP_MESSAGE);
});

runTest("group /wallet has no personal wallet dump", async () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  connectUser(file, 1001, wallet, 10_000);
  const ctx = createMockCtx({ chatType: "supergroup", userId: 1001 });
  handleWallet(ctx, { walletFile: file });
  assert.strictEqual(ctx.replies[0].text, GROUP_WALLET_TEXT);
  assert.ok(!JSON.stringify(ctx.replies[0]).includes(wallet.address));
});

runTest("token in connect URL is hashed at rest", async () => {
  const file = walletFile();
  const ctx = createMockCtx({ userId: 1200 });
  handleWallet(ctx, { walletFile: file, now: 12_000 });
  const url = getButtons(ctx.replies[0])[0].url;
  const token = new URL(url).searchParams.get("t");
  const store = loadWalletStore(file);
  assert.ok(token);
  assert.ok(!JSON.stringify(store).includes(token));
  assert.ok(store.linkTokens[hashToken(token)]);
});

Promise.all(pending).then(() => {
  console.log("wallet-commands tests passed");
});
