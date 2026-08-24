/**
 * ManGo Loot store + admin award.
 * Run: node tests/mango-loot.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { setMangoShopFileForTests, loadShopStore } = require("../services/mangoShopStore");
const {
  getLootBalance,
  getLootAccount,
  awardLoot,
  spendLoot,
  getLootHistory,
  awardDailyActivityLoot,
} = require("../services/mangoLoot");
const { handleLootAward, parseLootAwardArg } = require("../commands/lootaward");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-loot-"));
let n = 0;
const USER = "111";
const ADMIN_ID = "9001";
const originalAdmin = process.env.ADMIN_USER_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function shopFile() {
  n += 1;
  return path.join(tempDir, `shop-${n}.json`);
}

function mockCtx({ userId, chatType = "supergroup", replyTo, text }) {
  const replies = [];
  return {
    replies,
    chat: { id: -1001234567890, type: chatType },
    from: { id: Number(userId), is_bot: false, first_name: "Admin" },
    message: {
      text,
      message_id: 77,
      reply_to_message: replyTo
        ? { from: { id: Number(replyTo), is_bot: false, first_name: "Ada" } }
        : undefined,
    },
    reply(msg) {
      replies.push(msg);
      return Promise.resolve();
    },
  };
}

async function runTest(name, fn) {
  process.env.ADMIN_USER_ID = ADMIN_ID;
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("1-4. new user 0; award increases balance and lifetimeEarned", () => {
    const file = shopFile();
    setMangoShopFileForTests(file);
    assert.strictEqual(getLootBalance(USER, file), 0);
    const awarded = awardLoot(USER, 10, "daily-activity", "ref-a", { shopFile: file });
    assert.strictEqual(awarded.ok, true);
    assert.strictEqual(awarded.balance, 10);
    const acc = getLootAccount(USER, file);
    assert.strictEqual(acc.balance, 10);
    assert.strictEqual(acc.lifetimeEarned, 10);
  });

  await runTest("5. duplicate reference no duplicate award", () => {
    const file = shopFile();
    setMangoShopFileForTests(file);
    awardLoot(USER, 5, "daily-activity", "same", { shopFile: file });
    const again = awardLoot(USER, 5, "daily-activity", "same", { shopFile: file });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.duplicate, true);
    assert.strictEqual(getLootBalance(USER, file), 5);
  });

  await runTest("6-7. spend increases lifetimeSpent", () => {
    const file = shopFile();
    setMangoShopFileForTests(file);
    awardLoot(USER, 20, "special-event", "e1", { shopFile: file });
    const spent = spendLoot(USER, 8, "title-purchase", "s1", { shopFile: file });
    assert.strictEqual(spent.ok, true);
    const acc = getLootAccount(USER, file);
    assert.strictEqual(acc.balance, 12);
    assert.strictEqual(acc.lifetimeSpent, 8);
  });

  await runTest("8-9. insufficient reject; never negative", () => {
    const file = shopFile();
    setMangoShopFileForTests(file);
    awardLoot(USER, 3, "daily-streak", "d1", { shopFile: file });
    const spent = spendLoot(USER, 4, "title-purchase", "s2", { shopFile: file });
    assert.strictEqual(spent.ok, false);
    assert.strictEqual(spent.reason, "insufficient");
    assert.strictEqual(getLootBalance(USER, file), 3);
  });

  await runTest("10. persistence restart", () => {
    const file = shopFile();
    setMangoShopFileForTests(file);
    awardLoot(USER, 11, "admin-award", "a1", { shopFile: file });
    setMangoShopFileForTests(file);
    assert.strictEqual(getLootBalance(USER, file), 11);
    const store = loadShopStore(file);
    assert.strictEqual(store.users[USER].loot.lifetimeEarned, 11);
  });

  await runTest("11. corrupt store fail closed", () => {
    const file = shopFile();
    fs.writeFileSync(file, "{not-json", "utf8");
    setMangoShopFileForTests(file);
    assert.throws(() => awardLoot(USER, 1, "daily-activity", "x", { shopFile: file }));
  });

  await runTest("12. admin lootaward works", () => {
    const file = shopFile();
    setMangoShopFileForTests(file);
    const ctx = mockCtx({
      userId: ADMIN_ID,
      replyTo: USER,
      text: "/lootaward 40 shop test reason",
    });
    handleLootAward(ctx, { shopFile: file });
    assert.ok(String(ctx.replies[0]).includes("+40"));
    assert.strictEqual(getLootBalance(USER, file), 40);
    const hist = getLootHistory(USER, { shopFile: file });
    assert.strictEqual(hist[0].reason, "admin-award");
    assert.strictEqual(hist[0].type, "adjust");
  });

  await runTest("13. non-admin lootaward rejected", () => {
    const file = shopFile();
    setMangoShopFileForTests(file);
    const ctx = mockCtx({
      userId: USER,
      chatType: "private",
      replyTo: "222",
      text: "/lootaward 40 shop test reason",
    });
    handleLootAward(ctx, { shopFile: file });
    assert.ok(String(ctx.replies[0]).includes("admin only"));
    assert.strictEqual(getLootBalance("222", file), 0);
    const parsed = parseLootAwardArg("0 nope");
    assert.strictEqual(parsed.ok, false);
    const group = mockCtx({
      userId: USER,
      chatType: "supergroup",
      replyTo: "222",
      text: "/lootaward 40 shop test reason",
    });
    assert.strictEqual(handleLootAward(group, { shopFile: file }), undefined);
    assert.strictEqual(group.replies.length, 0);
  });

  await runTest("daily activity insertion point is idempotent", () => {
    const file = shopFile();
    setMangoShopFileForTests(file);
    const first = awardDailyActivityLoot(
      { userId: USER, activityId: "chat", date: "2026-08-24", amount: 2 },
      { shopFile: file }
    );
    const second = awardDailyActivityLoot(
      { userId: USER, activityId: "chat", date: "2026-08-24", amount: 2 },
      { shopFile: file }
    );
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual(getLootBalance(USER, file), 2);
  });

  await runTest("no production files touched", () => {
    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
    }
  });
}

main()
  .then(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    setMangoShopFileForTests(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll mango-loot tests passed.");
  })
  .catch((err) => {
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    console.error(err);
    process.exit(1);
  });
