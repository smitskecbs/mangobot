/**
 * Admin /walletlist privacy, pagination, and status display.
 * Run: node tests/walletlist.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const { mutatePoints } = require("../services/points");
const {
  registerManualWallet,
  setWalletFileForTests,
} = require("../services/walletLinks");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { shortenWallet } = require("../utils/solanaWallet");
const {
  buildWalletListPage,
  collectWalletListRows,
  summarizeWalletList,
  parseWalletListCallback,
  walletListCallbackData,
  WALLET_LIST_CALLBACK_PREFIX,
} = require("../services/walletList");
const {
  handleWalletList,
  handleWalletListCallback,
  GROUP_WALLET_LIST_TEXT,
  ADMIN_ONLY,
} = require("../commands/walletlist");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-walletlist-"));
let n = 0;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

function files() {
  n += 1;
  return {
    pointsFile: path.join(tempDir, `p-${n}.json`),
    walletFile: path.join(tempDir, `w-${n}.json`),
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

function seedPoints(pointsFile, users) {
  mutatePoints((data) => {
    for (const [id, name] of Object.entries(users)) {
      data.users[id] = {
        points: 1,
        weeklyPoints: 0,
        weekId: "2026-08-17",
        name,
        triggerDate: null,
        triggersUsed: [],
        activityDate: null,
      };
    }
  }, pointsFile);
}

function verifyUser(walletFile, userId, wallet, now) {
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
  callbackData,
} = {}) {
  const replies = [];
  const edits = [];
  return {
    chat: { type: chatType, id: chatType === "private" ? userId : -1001 },
    from: { id: userId, first_name: "Admin" },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    replies,
    edits,
    answerCbQuery() {
      return Promise.resolve();
    },
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve(replies[replies.length - 1]);
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve(edits[edits.length - 1]);
    },
  };
}

function runTest(name, fn) {
  try {
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
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

const pending = [];

pending.push(
  runTest("1. admin private /walletlist works", () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 11: "Kevin" });
    const ctx = createMockCtx();
    handleWalletList(ctx, { pointsFile, walletFile });
    assert.ok(ctx.replies[0].text.includes("ManGo Wallet Overview"));
    assert.ok(ctx.replies[0].text.includes("Kevin"));
    assert.strictEqual(ctx.replies[0].extra.parse_mode, "HTML");
  })
);

pending.push(
  runTest("2. non-admin rejected", () => {
    const { pointsFile, walletFile } = files();
    const ctx = createMockCtx({ userId: 77 });
    handleWalletList(ctx, { pointsFile, walletFile });
    assert.strictEqual(ctx.replies[0].text, ADMIN_ONLY);
    assert.ok(!ctx.replies[0].text.includes("Wallet Overview"));
  })
);

pending.push(
  runTest("3. group does not leak list", () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 11: "Kevin" });
    const admin = createMockCtx({ chatType: "supergroup" });
    handleWalletList(admin, { pointsFile, walletFile });
    assert.strictEqual(admin.replies[0].text, GROUP_WALLET_LIST_TEXT);
    assert.ok(!admin.replies[0].text.includes("Kevin"));
    const member = createMockCtx({ chatType: "supergroup", userId: 77 });
    const result = handleWalletList(member, { pointsFile, walletFile });
    assert.strictEqual(result, undefined);
    assert.strictEqual(member.replies.length, 0);
  })
);

pending.push(
  runTest("4-8. statuses, shortened wallet, summary, sort", () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, {
      1: "Kevin",
      2: "Alice",
      3: "Bob",
    });
    const verifiedWallet = generateSolanaWallet();
    const registeredWallet = generateSolanaWallet();
    verifyUser(walletFile, 1, verifiedWallet, 1000);
    registerManualWallet(2, registeredWallet.address, walletFile, 2000);
    const rows = collectWalletListRows({ pointsFile, walletFile });
    assert.strictEqual(rows[0].name, "Bob");
    assert.strictEqual(rows[0].status, "none");
    assert.strictEqual(rows[1].name, "Alice");
    assert.strictEqual(rows[1].status, "registered");
    assert.strictEqual(rows[2].name, "Kevin");
    assert.strictEqual(rows[2].status, "verified");
    const page = buildWalletListPage({ pointsFile, walletFile });
    assert.ok(page.text.includes("⬜ Bob — Not linked"));
    assert.ok(page.text.includes(`🟡 Alice — ${shortenWallet(registeredWallet.address)}`));
    assert.ok(page.text.includes(`🟢 Kevin — ${shortenWallet(verifiedWallet.address)}`));
    assert.ok(!page.text.includes(verifiedWallet.address));
    assert.ok(!page.text.includes(registeredWallet.address));
    const summary = summarizeWalletList(rows);
    assert.strictEqual(summary.verified, 1);
    assert.strictEqual(summary.registered, 1);
    assert.strictEqual(summary.none, 1);
    assert.strictEqual(summary.total, 3);
    assert.ok(page.text.includes("🟢 Verified: 1"));
    assert.ok(page.text.includes("🟡 Registered: 1"));
    assert.ok(page.text.includes("⬜ Not linked: 1"));
    assert.ok(page.text.includes("Total known members: 3"));
  })
);

pending.push(
  runTest("9. sorting not-linked first then alpha", () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 1: "Zed", 2: "Amy", 3: "Bea" });
    registerManualWallet(1, generateSolanaWallet().address, walletFile, 1);
    verifyUser(walletFile, 3, generateSolanaWallet(), 2);
    const rows = collectWalletListRows({ pointsFile, walletFile });
    assert.deepStrictEqual(
      rows.map((r) => `${r.status}:${r.name}`),
      ["none:Amy", "registered:Zed", "verified:Bea"]
    );
  })
);

pending.push(
  runTest("10. pagination works", () => {
    const { pointsFile, walletFile } = files();
    const users = {};
    for (let i = 1; i <= 26; i += 1) {
      users[String(100 + i)] = `User${String(i).padStart(2, "0")}`;
    }
    seedPoints(pointsFile, users);
    const first = buildWalletListPage({ pointsFile, walletFile, pageSize: 25, page: 0 });
    const second = buildWalletListPage({ pointsFile, walletFile, pageSize: 25, page: 1 });
    const stale = buildWalletListPage({ pointsFile, walletFile, pageSize: 25, page: 99 });
    assert.strictEqual(first.page, 0);
    assert.strictEqual(first.rows.length, 25);
    assert.strictEqual(second.page, 1);
    assert.strictEqual(second.rows.length, 1);
    assert.strictEqual(stale.page, 1);
    assert.ok(first.text.includes("Page 1/2"));
    assert.ok(!JSON.stringify(first).includes("telegramUserId"));
  })
);

pending.push(
  runTest("11. callbacks admin-only and opaque", async () => {
    const { pointsFile, walletFile } = files();
    const users = {};
    for (let i = 1; i <= 26; i += 1) {
      users[String(i)] = `N${String(i).padStart(2, "0")}`;
    }
    seedPoints(pointsFile, users);
    assert.ok(walletListCallbackData(1).startsWith(WALLET_LIST_CALLBACK_PREFIX));
    assert.deepStrictEqual(parseWalletListCallback("wlst:1"), { page: 1 });
    assert.strictEqual(parseWalletListCallback("wlst:1:9001"), null);
    const admin = createMockCtx({ callbackData: "wlst:1" });
    await handleWalletListCallback(admin, { pointsFile, walletFile, pageSize: 25 });
    assert.ok(admin.edits[0].text.includes("Page 2/2"));
    const outsider = createMockCtx({ userId: 77, callbackData: "wlst:1" });
    await handleWalletListCallback(outsider, { pointsFile, walletFile, pageSize: 25 });
    assert.strictEqual(outsider.replies[0].text, ADMIN_ONLY);
    const group = createMockCtx({ chatType: "group", callbackData: "wlst:1" });
    await handleWalletListCallback(group, { pointsFile, walletFile, pageSize: 25 });
    assert.strictEqual(group.replies[0].text, GROUP_WALLET_LIST_TEXT);
    assert.ok(!group.replies[0].text.includes("N01"));
  })
);

pending.push(
  runTest("HTML escaping in names", () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 9: "<script>Kevin</script>" });
    const page = buildWalletListPage({ pointsFile, walletFile });
    assert.ok(page.text.includes("&lt;script&gt;Kevin&lt;/script&gt;"));
    assert.ok(!page.text.includes("<script>Kevin</script>"));
  })
);

Promise.all(pending.filter(Boolean)).then(() => {
  setWalletFileForTests(null);
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  console.log("walletlist tests passed");
});
