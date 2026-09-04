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
  renderWalletList,
} = require("../commands/walletlist");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-walletlist-"));
let n = 0;
const LIST_CHAT_ID = "-1003916996602";
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

function currentLookup(overrides = {}) {
  return async (chatId, userId) => {
    const uid = String(userId);
    const override = overrides[uid];
    if (override === "throw") {
      throw new Error("user not found");
    }
    if (override) {
      return override;
    }
    return { status: "member", user: { id: Number(uid), is_bot: false } };
  };
}

function listOpts(files, extra = {}) {
  const { membershipOverrides, ...rest } = extra;
  return {
    chatId: LIST_CHAT_ID,
    getChatMember: currentLookup(membershipOverrides || {}),
    ...files,
    ...rest,
  };
}

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
  const answers = [];
  return {
    chat: { type: chatType, id: chatType === "private" ? userId : -1001 },
    from: { id: userId, first_name: "Admin" },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    replies,
    edits,
    answers,
    answerCbQuery(text, extra) {
      answers.push({ text: text || "", extra });
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
  runTest("1. admin private /walletlist works", async () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 11: "Kevin" });
    const ctx = createMockCtx();
    await handleWalletList(ctx, listOpts({ pointsFile, walletFile }));
    assert.ok(ctx.replies[0].text.includes("ManGo Wallet Overview"));
    assert.ok(ctx.replies[0].text.includes("Kevin"));
    assert.strictEqual(ctx.replies[0].extra.parse_mode, "HTML");
  })
);

pending.push(
  runTest("2. non-admin rejected", async () => {
    const { pointsFile, walletFile } = files();
    const ctx = createMockCtx({ userId: 77 });
    await handleWalletList(ctx, listOpts({ pointsFile, walletFile }));
    assert.strictEqual(ctx.replies[0].text, ADMIN_ONLY);
    assert.ok(!ctx.replies[0].text.includes("Wallet Overview"));
  })
);

pending.push(
  runTest("3. group does not leak list", async () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 11: "Kevin" });
    const admin = createMockCtx({ chatType: "supergroup" });
    await handleWalletList(admin, listOpts({ pointsFile, walletFile }));
    assert.strictEqual(admin.replies[0].text, GROUP_WALLET_LIST_TEXT);
    assert.ok(!admin.replies[0].text.includes("Kevin"));
    const member = createMockCtx({ chatType: "supergroup", userId: 77 });
    const result = await handleWalletList(member, listOpts({ pointsFile, walletFile }));
    assert.strictEqual(result, undefined);
    assert.strictEqual(member.replies.length, 0);
  })
);

pending.push(
  runTest("4-8. statuses, shortened wallet, summary, sort", async () => {
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
    const page = await buildWalletListPage(listOpts({ pointsFile, walletFile }));
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
    assert.ok(page.text.includes("👥 Current members checked: 3"));
    assert.ok(page.text.includes("🔗 Current members with wallet: 2"));
    assert.ok(page.text.includes("⬜ Current members without wallet: 1"));
    assert.ok(!page.text.includes("Total known members"));
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
  runTest("10. pagination works", async () => {
    const { pointsFile, walletFile } = files();
    const users = {};
    for (let i = 1; i <= 26; i += 1) {
      users[String(100 + i)] = `User${String(i).padStart(2, "0")}`;
    }
    seedPoints(pointsFile, users);
    const opts = listOpts({ pointsFile, walletFile, pageSize: 25 });
    const first = await buildWalletListPage({ ...opts, page: 0 });
    const second = await buildWalletListPage({ ...opts, page: 1 });
    const stale = await buildWalletListPage({ ...opts, page: 99 });
    const stringPage = await buildWalletListPage({ ...opts, page: "1" });
    assert.strictEqual(first.page, 0);
    assert.strictEqual(first.rows.length, 25);
    assert.strictEqual(second.page, 1);
    assert.strictEqual(second.rows.length, 1);
    assert.strictEqual(stale.page, 1);
    assert.strictEqual(stringPage.page, 1);
    assert.ok(first.text.includes("Page 1/2"));
    assert.ok(!JSON.stringify(first).includes("telegramUserId"));
    const firstNav = await renderWalletList({ ...opts, page: 0 });
    const secondNav = await renderWalletList({ ...opts, page: 1 });
    const firstBtns = firstNav.extra.reply_markup.inline_keyboard[0].map((b) => b.text);
    const secondBtns = secondNav.extra.reply_markup.inline_keyboard[0].map((b) => b.text);
    assert.deepStrictEqual(firstBtns, ["Next ➡️"]);
    assert.deepStrictEqual(secondBtns, ["⬅️ Previous"]);
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
    await handleWalletListCallback(admin, listOpts({ pointsFile, walletFile, pageSize: 25 }));
    assert.ok(admin.edits[0].text.includes("Page 2/2"));
    assert.strictEqual(admin.answers.length, 1);
    const outsider = createMockCtx({ userId: 77, callbackData: "wlst:1" });
    await handleWalletListCallback(outsider, listOpts({ pointsFile, walletFile, pageSize: 25 }));
    assert.strictEqual(outsider.replies[0].text, ADMIN_ONLY);
    assert.ok(outsider.answers.length >= 1);
    const group = createMockCtx({ chatType: "group", callbackData: "wlst:1" });
    await handleWalletListCallback(group, listOpts({ pointsFile, walletFile, pageSize: 25 }));
    assert.strictEqual(group.replies[0].text, GROUP_WALLET_LIST_TEXT);
    assert.ok(!group.replies[0].text.includes("N01"));
    assert.ok(group.answers.length >= 1);
  })
);

pending.push(
  runTest("HTML escaping in names", async () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 9: "<script>Kevin</script>" });
    const page = await buildWalletListPage(listOpts({ pointsFile, walletFile }));
    assert.ok(page.text.includes("&lt;script&gt;Kevin&lt;/script&gt;"));
    assert.ok(!page.text.includes("<script>Kevin</script>"));
  })
);

function seedMixedSixty(pointsFile, walletFile) {
  const users = {};
  for (let i = 1; i <= 40; i += 1) {
    users[String(1000 + i)] = `None${String(i).padStart(2, "0")}`;
  }
  for (let i = 1; i <= 12; i += 1) {
    users[String(2000 + i)] = `Reg${String(i).padStart(2, "0")}`;
  }
  for (let i = 1; i <= 8; i += 1) {
    users[String(3000 + i)] = `Ver${String(i).padStart(2, "0")}`;
  }
  seedPoints(pointsFile, users);
  for (let i = 1; i <= 12; i += 1) {
    registerManualWallet(2000 + i, generateSolanaWallet().address, walletFile, 1000 + i);
  }
  for (let i = 1; i <= 8; i += 1) {
    verifyUser(walletFile, 3000 + i, generateSolanaWallet(), 5000 + i * 10);
  }
}

pending.push(
  runTest("1-16. mixed 60 users full-list pagination", async () => {
    const { pointsFile, walletFile } = files();
    seedMixedSixty(pointsFile, walletFile);
    const all = collectWalletListRows({ pointsFile, walletFile });
    assert.strictEqual(all.length, 60);
    const knownSummary = summarizeWalletList(all);
    assert.strictEqual(knownSummary.none, 40);
    assert.strictEqual(knownSummary.registered, 12);
    assert.strictEqual(knownSummary.verified, 8);
    assert.deepStrictEqual(
      all.map((r) => r.status),
      [
        ...Array(40).fill("none"),
        ...Array(12).fill("registered"),
        ...Array(8).fill("verified"),
      ]
    );
    const opts = listOpts({ pointsFile, walletFile, pageSize: 25 });
    const p0 = await buildWalletListPage({ ...opts, page: 0 });
    const p1 = await buildWalletListPage({ ...opts, page: 1 });
    const p2 = await buildWalletListPage({ ...opts, page: 2 });
    assert.strictEqual(p0.rows.length, 25);
    assert.strictEqual(p1.rows.length, 25);
    assert.strictEqual(p2.rows.length, 10);
    assert.ok(p0.rows.every((r) => r.status === "none"));
    assert.ok(p1.rows.some((r) => r.status === "registered"));
    assert.ok(p2.rows.some((r) => r.status === "registered"));
    assert.ok(p2.rows.some((r) => r.status === "verified"));
    assert.ok(p0.text.includes("None01"));
    assert.ok(p1.text.includes("Reg"));
    assert.ok(p2.text.includes("Ver"));
    assert.ok(!p0.text.includes("Reg01"));
    assert.ok(!p0.text.includes("Ver01"));
    const combined = [...p0.rows, ...p1.rows, ...p2.rows];
    const ids = combined.map((r) => r.userId);
    assert.strictEqual(ids.length, 60);
    assert.strictEqual(new Set(ids).size, 60);
    for (const page of [p0, p1, p2]) {
      assert.strictEqual(page.summary.currentMembers, 60);
      assert.strictEqual(page.summary.withWallet, 20);
      assert.strictEqual(page.summary.withoutWallet, 40);
      assert.ok(page.text.includes("👥 Current members checked: 60"));
      assert.ok(page.text.includes("🔗 Current members with wallet: 20"));
      assert.ok(page.text.includes("⬜ Current members without wallet: 40"));
    }
    const firstNav = await renderWalletList({ ...opts, page: 0 });
    const midNav = await renderWalletList({ ...opts, page: 1 });
    const lastNav = await renderWalletList({ ...opts, page: 2 });
    assert.deepStrictEqual(
      firstNav.extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
      ["wlst:1"]
    );
    assert.deepStrictEqual(
      midNav.extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
      ["wlst:0", "wlst:2"]
    );
    assert.deepStrictEqual(
      lastNav.extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
      ["wlst:1"]
    );
    const next = createMockCtx({ callbackData: "wlst:1" });
    await handleWalletListCallback(next, opts);
    assert.ok(next.edits[0].text.includes("Page 2/3"));
    assert.ok(next.edits[0].text.includes("Reg"));
    assert.strictEqual(next.answers.length, 1);
    const next2 = createMockCtx({ callbackData: "wlst:2" });
    await handleWalletListCallback(next2, opts);
    assert.ok(next2.edits[0].text.includes("Page 3/3"));
    assert.ok(next2.edits[0].text.includes("Ver"));
    const prev = createMockCtx({ callbackData: "wlst:0" });
    await handleWalletListCallback(prev, opts);
    assert.ok(prev.edits[0].text.includes("Page 1/3"));
    const stuck = createMockCtx({ callbackData: "wlst:1" });
    stuck.editMessageText = () => {
      const err = new Error("Bad Request: message is not modified");
      err.description = "Bad Request: message is not modified";
      return Promise.reject(err);
    };
    await handleWalletListCallback(stuck, opts);
    assert.strictEqual(stuck.answers.length, 1);
    assert.strictEqual(stuck.edits.length, 0);
  })
);

pending.push(
  runTest("current membership uses Telegram user IDs only", async () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 11: "Kevin", 22: "Alice", 33: "Botty", 44: "Gone" });
    registerManualWallet(11, generateSolanaWallet().address, walletFile, 1);
    registerManualWallet(33, generateSolanaWallet().address, walletFile, 2);
    registerManualWallet(44, generateSolanaWallet().address, walletFile, 3);
    const beforeWallet = fs.readFileSync(walletFile, "utf8");
    const calls = [];
    const getChatMember = async (chatId, userId) => {
      calls.push({ chatId, userId: String(userId) });
      const uid = String(userId);
      if (uid === "11") {
        return { status: "administrator", user: { id: 11, is_bot: false } };
      }
      if (uid === "22") {
        return { status: "member", user: { id: 22, is_bot: false } };
      }
      if (uid === "33") {
        return { status: "member", user: { id: 33, is_bot: true } };
      }
      if (uid === "44") {
        return { status: "left", user: { id: 44, is_bot: false } };
      }
      throw new Error("unexpected user");
    };
    const page = await buildWalletListPage({
      pointsFile,
      walletFile,
      chatId: LIST_CHAT_ID,
      getChatMember,
    });
    assert.deepStrictEqual(
      calls.map((c) => c.userId).sort(),
      ["11", "22", "33", "44"]
    );
    assert.ok(calls.every((c) => c.chatId === LIST_CHAT_ID));
    assert.ok(calls.every((c) => /^\d+$/.test(c.userId)));
    assert.ok(!calls.some((c) => /Kevin|Alice|Botty|Gone/.test(String(c.userId))));
    assert.strictEqual(page.summary.currentMembers, 2);
    assert.strictEqual(page.summary.withWallet, 1);
    assert.strictEqual(page.summary.withoutWallet, 1);
    assert.strictEqual(page.historicalWallets, 1);
    assert.ok(page.text.includes("👥 Current members checked: 2"));
    assert.ok(page.text.includes("🔗 Current members with wallet: 1"));
    assert.ok(page.text.includes("⬜ Current members without wallet: 1"));
    assert.ok(page.text.includes("📦 Historical wallets (not in group): 1"));
    assert.ok(page.text.includes("Kevin"));
    assert.ok(page.text.includes("Alice"));
    assert.ok(!page.text.includes("Botty"));
    assert.ok(!page.text.includes("Gone"));
    assert.strictEqual(fs.readFileSync(walletFile, "utf8"), beforeWallet);
  })
);

pending.push(
  runTest("left/kicked/unknown are not current members", async () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 1: "Stay", 2: "Lefty", 3: "Kicked", 4: "Missing" });
    registerManualWallet(2, generateSolanaWallet().address, walletFile, 1);
    const page = await buildWalletListPage(
      listOpts(
        { pointsFile, walletFile },
        {
          membershipOverrides: {
            1: { status: "creator", user: { id: 1, is_bot: false } },
            2: { status: "left", user: { id: 2, is_bot: false } },
            3: { status: "kicked", user: { id: 3, is_bot: false } },
            4: "throw",
          },
        }
      )
    );
    assert.strictEqual(page.summary.currentMembers, 1);
    assert.strictEqual(page.summary.withWallet, 0);
    assert.strictEqual(page.summary.withoutWallet, 1);
    assert.ok(page.text.includes("Stay"));
    assert.ok(!page.text.includes("Lefty"));
    assert.ok(!page.text.includes("Kicked"));
    assert.ok(!page.text.includes("Missing"));
    assert.ok(page.text.includes("📦 Historical wallets (not in group): 1"));
  })
);

pending.push(
  runTest("restricted current members count; bots never do", async () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 8: "Muted", 9: "Bot" });
    const page = await buildWalletListPage(
      listOpts(
        { pointsFile, walletFile },
        {
          membershipOverrides: {
            8: { status: "restricted", user: { id: 8, is_bot: false } },
            9: { status: "administrator", user: { id: 9, is_bot: true } },
          },
        }
      )
    );
    assert.strictEqual(page.summary.currentMembers, 1);
    assert.ok(page.text.includes("Muted"));
    assert.ok(!page.text.includes("Bot"));
    assert.ok(!page.text.includes("Historical wallets"));
  })
);

pending.push(
  runTest("missing Telegram lookup does not treat store size as current", async () => {
    const { pointsFile, walletFile } = files();
    seedPoints(pointsFile, { 1: "Kevin", 2: "Alice" });
    registerManualWallet(1, generateSolanaWallet().address, walletFile, 1);
    const page = await buildWalletListPage({ pointsFile, walletFile, chatId: "" });
    assert.strictEqual(page.summary.currentMembers, 0);
    assert.strictEqual(page.historicalWallets, 1);
    assert.ok(page.text.includes("Telegram group is not configured"));
    assert.ok(page.text.includes("👥 Current members checked: 0"));
    assert.ok(!page.text.includes("Kevin"));
  })
);

Promise.all(pending.filter(Boolean)).then(() => {
  setWalletFileForTests(null);
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  console.log("walletlist tests passed");
});
