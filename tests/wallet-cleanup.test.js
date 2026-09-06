/**
 * Wallet cleanup preview + confirm (kick then unban). Temp files only.
 * Run: node tests/wallet-cleanup.test.js
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
const {
  setKnownMembersFileForTests,
  addProtectedUser,
  recordObservedJoin,
} = require("../services/knownMembers");
const {
  BUCKET,
  classifyWalletCleanupMember,
  scanWalletCleanup,
  confirmWalletCleanup,
  kickThenUnban,
  formatWalletCleanupPreview,
} = require("../services/walletCleanup");
const {
  handleWalletCleanup,
  handleWalletCleanupConfirm,
  ADMIN_ONLY,
} = require("../commands/walletcleanup");
const { collectWalletListRows, buildWalletListPage } = require("../services/walletList");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-cleanup-"));
let n = 0;
const CHAT = "-1003916996602";
const originalAdmin = process.env.ADMIN_USER_ID;
const originalChat = process.env.TELEGRAM_CHAT_ID;
process.env.ADMIN_USER_ID = "9001";
process.env.TELEGRAM_CHAT_ID = CHAT;

function files() {
  n += 1;
  const pack = {
    pointsFile: path.join(tempDir, `p-${n}.json`),
    walletFile: path.join(tempDir, `w-${n}.json`),
    membersFile: path.join(tempDir, `m-${n}.json`),
  };
  setWalletFileForTests(pack.walletFile);
  setKnownMembersFileForTests(pack.membersFile);
  return pack;
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
    for (const [id, extra] of Object.entries(users)) {
      const name = typeof extra === "string" ? extra : extra.name;
      data.users[id] = {
        points: typeof extra === "object" && extra.points != null ? extra.points : 0,
        weeklyPoints: 0,
        weekId: "2026-09-06",
        name,
        triggerDate: null,
        triggersUsed: [],
        activityDate: extra && extra.activityDate ? extra.activityDate : null,
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

function memberResult(userId, extra = {}) {
  return {
    status: extra.status || "member",
    user: {
      id: Number(userId),
      is_bot: Boolean(extra.isBot),
      first_name: extra.name || "User",
      username: extra.username || "",
    },
  };
}

function lookupMap(map) {
  return async (_chatId, userId) => {
    const uid = String(userId);
    const row = map[uid];
    if (row === "throw") {
      throw new Error("getChatMember failed");
    }
    if (!row) {
      throw new Error("unknown");
    }
    return row;
  };
}

function scanOpts(pack, membership, extra = {}) {
  return {
    ...pack,
    chatId: CHAT,
    getChatMember: typeof membership === "function" ? membership : lookupMap(membership),
    ...extra,
  };
}

function createMockCtx({ userId = 9001, chatType = "private" } = {}) {
  const replies = [];
  return {
    chat: { type: chatType, id: chatType === "private" ? userId : -1001 },
    from: { id: userId, first_name: "Admin" },
    replies,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve(replies[replies.length - 1]);
    },
    telegram: {},
  };
}

async function runTest(name, fn) {
  await fn();
  console.log(`✓ ${name}`);
}

async function main() {
  await runTest("1. known current member + verified wallet → KEEP", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 11: "Kevin" });
    verifyUser(pack.walletFile, 11, generateSolanaWallet(), 1000);
    const scan = await scanWalletCleanup(
      scanOpts(pack, { 11: memberResult("11", { name: "Kevin" }) })
    );
    assert.strictEqual(scan.buckets[BUCKET.WALLET_LINKED].length, 1);
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE].length, 0);
    assert.strictEqual(scan.removed, false);
  });

  await runTest("2. known current member + registered wallet → KEEP", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 12: "Alice" });
    registerManualWallet(12, generateSolanaWallet().address, pack.walletFile, 1);
    const scan = await scanWalletCleanup(
      scanOpts(pack, { 12: memberResult("12", { name: "Alice" }) })
    );
    assert.strictEqual(scan.buckets[BUCKET.WALLET_LINKED][0].reason, "registered");
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE].length, 0);
  });

  await runTest("3. known current member + no wallet → candidate", async () => {
    const pack = files();
    recordObservedJoin(
      { chatId: CHAT, userId: 13, displayName: "Spam" },
      { membersFile: pack.membersFile, now: 1 }
    );
    const scan = await scanWalletCleanup(
      scanOpts(pack, { 13: memberResult("13", { name: "Spam" }) })
    );
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE].length, 1);
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE][0].userId, "13");
  });

  await runTest("4. active/XP member + no wallet → candidate", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, {
      14: { name: "Active", points: 40, activityDate: "2026-09-06" },
    });
    const scan = await scanWalletCleanup(
      scanOpts(pack, { 14: memberResult("14", { name: "Active" }) })
    );
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE].length, 1);
    assert.ok(!scan.buckets[BUCKET.PROTECTED].some((r) => r.userId === "14"));
  });

  await runTest("5. Telegram admin + no wallet → protected", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 15: "Mod" });
    const scan = await scanWalletCleanup(
      scanOpts(pack, {
        15: memberResult("15", { name: "Mod", status: "administrator" }),
      })
    );
    assert.strictEqual(scan.buckets[BUCKET.PROTECTED][0].reason, "administrator");
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE].length, 0);
  });

  await runTest("6. creator + no wallet → protected", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 16: "Owner" });
    const scan = await scanWalletCleanup(
      scanOpts(pack, {
        16: memberResult("16", { name: "Owner", status: "creator" }),
      })
    );
    assert.strictEqual(scan.buckets[BUCKET.PROTECTED][0].reason, "creator");
  });

  await runTest("7. ADMIN_USER_ID → protected", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 9001: "EnvAdmin" });
    const scan = await scanWalletCleanup(
      scanOpts(pack, { 9001: memberResult("9001", { name: "EnvAdmin" }) })
    );
    assert.strictEqual(scan.buckets[BUCKET.PROTECTED][0].reason, "admin-user-id");
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE].length, 0);
  });

  await runTest("8. bot → protected", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 17: "Botty" });
    const scan = await scanWalletCleanup(
      scanOpts(pack, {
        17: memberResult("17", { name: "Botty", isBot: true }),
      })
    );
    assert.strictEqual(scan.buckets[BUCKET.PROTECTED][0].reason, "bot");
  });

  await runTest("9. unknown getChatMember → never remove", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 18: "Missing" });
    const scan = await scanWalletCleanup(scanOpts(pack, { 18: "throw" }));
    assert.strictEqual(scan.buckets[BUCKET.LOOKUP_FAILED].length, 1);
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE].length, 0);
    const confirm = await confirmWalletCleanup({
      ...scanOpts(pack, { 18: "throw" }),
      banChatMember: async () => {
        throw new Error("should not kick");
      },
      unbanChatMember: async () => {
        throw new Error("should not unban");
      },
    });
    assert.strictEqual(confirm.kicked.length, 0);
    assert.strictEqual(confirm.removed, false);
  });

  await runTest("10. left member → no removal", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 19: "Gone" });
    const scan = await scanWalletCleanup(
      scanOpts(pack, { 19: memberResult("19", { name: "Gone", status: "left" }) })
    );
    assert.strictEqual(scan.buckets[BUCKET.NOT_IN_GROUP][0].reason, "left");
    assert.strictEqual(scan.buckets[BUCKET.ELIGIBLE].length, 0);
  });

  await runTest("11. candidate obtains wallet between preview and confirm → SKIP", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 20: "Flip" });
    const membership = { 20: memberResult("20", { name: "Flip" }) };
    const preview = await scanWalletCleanup(scanOpts(pack, membership));
    assert.strictEqual(preview.buckets[BUCKET.ELIGIBLE].length, 1);
    registerManualWallet(20, generateSolanaWallet().address, pack.walletFile, 9);
    const bans = [];
    const confirm = await confirmWalletCleanup({
      ...scanOpts(pack, membership),
      banChatMember: async (chatId, userId) => {
        bans.push(String(userId));
      },
      unbanChatMember: async () => undefined,
    });
    assert.strictEqual(confirm.scannedEligible, 0);
    assert.strictEqual(confirm.kicked.length, 0);
    assert.deepStrictEqual(bans, []);
  });

  await runTest("12. candidate becomes admin between preview and confirm → SKIP", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 21: "Promo" });
    let calls = 0;
    const getChatMember = async () => {
      calls += 1;
      const status = calls <= 2 ? "member" : "administrator";
      return memberResult("21", { name: "Promo", status });
    };
    const preview = await scanWalletCleanup(scanOpts(pack, getChatMember));
    assert.strictEqual(preview.buckets[BUCKET.ELIGIBLE].length, 1);
    const bans = [];
    const confirm = await confirmWalletCleanup({
      ...scanOpts(pack, getChatMember),
      banChatMember: async (_c, userId) => {
        bans.push(String(userId));
      },
      unbanChatMember: async () => undefined,
    });
    assert.strictEqual(confirm.skipped[0].reason, "administrator");
    assert.deepStrictEqual(bans, []);
  });

  await runTest("13. kick followed by immediate unban", async () => {
    const order = [];
    const result = await kickThenUnban({
      chatId: CHAT,
      userId: "22",
      banChatMember: async (chatId, userId) => {
        order.push(`ban:${chatId}:${userId}`);
      },
      unbanChatMember: async (chatId, userId, extra) => {
        order.push(`unban:${chatId}:${userId}:${extra && extra.only_if_banned}`);
      },
    });
    assert.deepStrictEqual(order, [`ban:${CHAT}:22`, `unban:${CHAT}:22:true`]);
    assert.strictEqual(result.kicked, true);
    assert.strictEqual(result.unbanned, true);
  });

  await runTest("14. failed kick cannot falsely report success", async () => {
    const result = await kickThenUnban({
      chatId: CHAT,
      userId: "23",
      banChatMember: async () => {
        throw new Error("forbidden");
      },
      unbanChatMember: async () => {
        throw new Error("should not unban");
      },
    });
    assert.strictEqual(result.kicked, false);
    assert.strictEqual(result.unbanned, false);
    const pack = files();
    seedPoints(pack.pointsFile, { 23: "FailKick" });
    const confirm = await confirmWalletCleanup({
      ...scanOpts(pack, { 23: memberResult("23", { name: "FailKick" }) }),
      banChatMember: async () => {
        throw new Error("forbidden");
      },
      unbanChatMember: async () => undefined,
    });
    assert.strictEqual(confirm.kicked.length, 0);
    assert.strictEqual(confirm.kickFailed.length, 1);
    assert.strictEqual(confirm.removed, false);
  });

  await runTest("15. failed unban is prominently reported", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 24: "Stuck" });
    const confirm = await confirmWalletCleanup({
      ...scanOpts(pack, { 24: memberResult("24", { name: "Stuck" }) }),
      banChatMember: async () => undefined,
      unbanChatMember: async () => {
        throw new Error("unban exploded");
      },
    });
    assert.strictEqual(confirm.kicked.length, 0);
    assert.strictEqual(confirm.unbanFailed.length, 1);
    assert.strictEqual(confirm.unbanFailed[0].kicked, true);
    assert.strictEqual(confirm.unbanFailed[0].unbanned, false);
    const text = require("../services/walletCleanup").formatWalletCleanupConfirm(confirm);
    assert.ok(text.includes("UNBAN FAILED"));
    assert.ok(text.includes("24"));
  });

  await runTest("16. /walletcleanup itself performs ZERO removals", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 25: "PreviewOnly" });
    let banned = 0;
    const ctx = createMockCtx();
    ctx.telegram.banChatMember = async () => {
      banned += 1;
    };
    ctx.telegram.unbanChatMember = async () => {
      banned += 1;
    };
    ctx.telegram.getChatMember = lookupMap({
      25: memberResult("25", { name: "PreviewOnly" }),
    });
    await handleWalletCleanup(ctx, pack);
    assert.strictEqual(banned, 0);
    assert.ok(ctx.replies[0].text.includes("NOBODY was removed"));
    assert.ok(ctx.replies[0].text.includes("eligible: 1"));
    assert.ok(ctx.replies[0].text.includes("/walletcleanup_confirm"));
  });

  await runTest("17. confirmation command rescans rather than trusting cached preview", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 26: "Cached" });
    addProtectedUser("26", { membersFile: pack.membersFile, now: 1 });
    const ctx = createMockCtx();
    const bans = [];
    ctx.telegram.getChatMember = lookupMap({
      26: memberResult("26", { name: "Cached" }),
    });
    ctx.telegram.banChatMember = async (_c, userId) => {
      bans.push(String(userId));
    };
    ctx.telegram.unbanChatMember = async () => undefined;
    await handleWalletCleanupConfirm(ctx, pack);
    assert.deepStrictEqual(bans, []);
    assert.ok(ctx.replies[0].text.includes("Skipped") || ctx.replies[0].text.includes("Kicked + unbanned: 0"));
  });

  await runTest("explicit whitelist protects a normal member", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 27: "Friend" });
    addProtectedUser("27", { membersFile: pack.membersFile, now: 1 });
    const scan = await scanWalletCleanup(
      scanOpts(pack, { 27: memberResult("27", { name: "Friend" }) })
    );
    assert.strictEqual(scan.buckets[BUCKET.PROTECTED][0].reason, "whitelist");
  });

  await runTest("preview text paginates eligible names/ids and never claims a full roster", async () => {
    const pack = files();
    const users = {};
    const membership = {};
    for (let i = 1; i <= 21; i += 1) {
      users[String(300 + i)] = `Cand${i}`;
      membership[String(300 + i)] = memberResult(String(300 + i), { name: `Cand${i}` });
    }
    seedPoints(pack.pointsFile, users);
    const scan = await scanWalletCleanup(scanOpts(pack, membership));
    const page0 = formatWalletCleanupPreview(scan, { page: 0, pageSize: 20 });
    const page1 = formatWalletCleanupPreview(scan, { page: 1, pageSize: 20 });
    assert.ok(page0.text.includes("Known members only"));
    assert.ok(page0.text.includes("Page 1/2"));
    assert.ok(page1.text.includes("Page 2/2"));
    assert.strictEqual(scan.removed, false);
  });

  await runTest("20. existing /walletlist behavior for linked users remains correct", async () => {
    const pack = files();
    seedPoints(pack.pointsFile, { 31: "Linked" });
    const wallet = generateSolanaWallet();
    registerManualWallet(31, wallet.address, pack.walletFile, 1);
    const rows = collectWalletListRows(pack);
    assert.strictEqual(rows[0].status, "registered");
    assert.ok(rows[0].walletShort);
    assert.ok(!rows[0].walletShort.includes(wallet.address) || rows[0].walletShort.length < wallet.address.length);
    const page = await buildWalletListPage({
      ...pack,
      chatId: CHAT,
      getChatMember: lookupMap({ 31: memberResult("31", { name: "Linked" }) }),
    });
    assert.ok(page.text.includes("Registered"));
    assert.ok(page.text.includes("31"));
    assert.ok(!page.text.includes(wallet.address));
  });

  await runTest("classify fail-closed helpers", () => {
    assert.strictEqual(
      classifyWalletCleanupMember({ userId: "1", lookupOk: false }).bucket,
      BUCKET.LOOKUP_FAILED
    );
    assert.strictEqual(
      classifyWalletCleanupMember({
        userId: "1",
        lookupOk: true,
        member: { status: "member", user: { is_bot: false } },
        walletLinked: false,
      }).bucket,
      BUCKET.ELIGIBLE
    );
  });

  await runTest("non-admin cannot run cleanup", async () => {
    const pack = files();
    const ctx = createMockCtx({ userId: 77 });
    await handleWalletCleanup(ctx, pack);
    assert.strictEqual(ctx.replies[0].text, ADMIN_ONLY);
  });

  setWalletFileForTests(null);
  setKnownMembersFileForTests(null);
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
  console.log("wallet-cleanup tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
