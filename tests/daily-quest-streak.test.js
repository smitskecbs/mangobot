/**
 * Daily Quest streak and milestone loot.
 * Run: node tests/daily-quest-streak.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { spawn } = require("child_process");

const { encodeBase58 } = require("../utils/base58");
const { setMangoShopFileForTests, loadShopStore } = require("../services/mangoShopStore");
const { getLootBalance } = require("../services/mangoLoot");
const {
  noteDailyQuestCommunity,
  noteDailyQuestGame,
  noteDailyQuestXp,
  getDailyQuestSnapshot,
  utcDate,
  FULL_COMPLETION_LOOT,
  ACTIVITY_LOOT,
  BASE_DAILY_MAX,
  completeSelectedQuests,
  fillDailyQuest,
  selectQuestsForDate,
} = require("../services/dailyQuest");
const { setWalletFileForTests, registerManualWallet } = require("../services/walletLinks");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-dq-streak-"));
let n = 0;
const USER = "8001";
const DAY0 = Date.UTC(2026, 7, 1, 12, 0, 0);

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function walletAddress(seed) {
  return encodeBase58(crypto.createHash("sha256").update(String(seed)).digest());
}

function files() {
  n += 1;
  const shopFile = path.join(tempDir, `shop-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  fs.writeFileSync(walletFile, JSON.stringify({ users: {}, wallets: {} }, null, 2), "utf8");
  setMangoShopFileForTests(shopFile);
  setWalletFileForTests(walletFile);
  registerManualWallet(USER, walletAddress(`s-${n}`), walletFile, DAY0);
  return { shopFile, walletFile };
}

function at(dayOffset) {
  return DAY0 + dayOffset * 24 * 60 * 60 * 1000;
}

function completeDay(f, dayOffset) {
  const now = at(dayOffset);
  const options = { shopFile: f.shopFile, walletFile: f.walletFile, now, date: utcDate(now) };
  return completeSelectedQuests(USER, options);
}

function spawnFill(f, now, questId) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, "helpers", "daily-quest-worker.js"),
        "fill",
        f.shopFile,
        f.walletFile,
        USER,
        String(now),
        questId,
      ],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("35-36. full day streak 1 then consecutive 2", () => {
    const f = files();
    completeDay(f, 0);
    let snap = getDailyQuestSnapshot(USER, { shopFile: f.shopFile, walletFile: f.walletFile, now: at(0) });
    assert.strictEqual(snap.streak, 1);
    completeDay(f, 1);
    snap = getDailyQuestSnapshot(USER, { shopFile: f.shopFile, walletFile: f.walletFile, now: at(1) });
    assert.strictEqual(snap.streak, 2);
  });

  await runTest("37. missed day resets next completion to 1", () => {
    const f = files();
    completeDay(f, 0);
    completeDay(f, 1);
    completeDay(f, 3);
    const snap = getDailyQuestSnapshot(USER, { shopFile: f.shopFile, walletFile: f.walletFile, now: at(3) });
    assert.strictEqual(snap.streak, 1);
    assert.strictEqual(snap.longestStreak, 2);
  });

  await runTest("38-41. streak milestone bonuses", () => {
    const f = files();
    let lootBefore = 0;
    for (let d = 0; d < 30; d += 1) {
      completeDay(f, d);
    }
    const snap = getDailyQuestSnapshot(USER, { shopFile: f.shopFile, walletFile: f.walletFile, now: at(29) });
    assert.strictEqual(snap.streak, 30);
    const expectedBase = 30 * BASE_DAILY_MAX;
    const expectedMilestones = 10 + 25 + 50 + 100;
    assert.strictEqual(getLootBalance(USER, f.shopFile), expectedBase + expectedMilestones);
    lootBefore = getLootBalance(USER, f.shopFile);
    completeDay(f, 29);
    assert.strictEqual(getLootBalance(USER, f.shopFile), lootBefore);
  });

  await runTest("42. milestone idempotent", () => {
    const f = files();
    for (let d = 0; d < 3; d += 1) {
      completeDay(f, d);
    }
    const after = getLootBalance(USER, f.shopFile);
    const now = at(2);
    noteDailyQuestXp(USER, 3, { shopFile: f.shopFile, walletFile: f.walletFile, now, date: utcDate(now) });
    assert.strictEqual(getLootBalance(USER, f.shopFile), after);
    const store = loadShopStore(f.shopFile);
    const marks = Object.values(store.transactions).filter((row) => row.reason === "daily-streak");
    assert.strictEqual(marks.length, 1);
    assert.strictEqual(marks[0].amount, 10);
  });

  await runTest("43. new streak cycle can earn milestone again", () => {
    const f = files();
    for (let d = 0; d < 3; d += 1) {
      completeDay(f, d);
    }
    const afterFirst = getLootBalance(USER, f.shopFile);
    completeDay(f, 5);
    completeDay(f, 6);
    completeDay(f, 7);
    const afterSecond = getLootBalance(USER, f.shopFile);
    const extra = afterSecond - afterFirst;
    assert.strictEqual(extra, 3 * BASE_DAILY_MAX + 10);
    const store = loadShopStore(f.shopFile);
    const marks = Object.values(store.transactions).filter((row) => row.reason === "daily-streak");
    assert.strictEqual(marks.length, 2);
  });

  await runTest("44-45. longest persists; restart preserves streak", () => {
    const f = files();
    completeDay(f, 0);
    completeDay(f, 1);
    completeDay(f, 3);
    setMangoShopFileForTests(f.shopFile);
    const snap = getDailyQuestSnapshot(USER, { shopFile: f.shopFile, walletFile: f.walletFile, now: at(3) });
    assert.strictEqual(snap.streak, 1);
    assert.strictEqual(snap.longestStreak, 2);
  });

  await runTest("57. streak milestone race awards once", async () => {
    const f = files();
    completeDay(f, 0);
    completeDay(f, 1);
    const now = at(2);
    const selected = selectQuestsForDate(utcDate(now));
    const options = { shopFile: f.shopFile, walletFile: f.walletFile, now, date: utcDate(now) };
    fillDailyQuest(USER, selected[0], options);
    fillDailyQuest(USER, selected[1], options);
    const [a, b] = await Promise.all([
      spawnFill(f, now, selected[2]),
      spawnFill(f, now, selected[2]),
    ]);
    assert.strictEqual(a.status, 0, a.stderr);
    assert.strictEqual(b.status, 0, b.stderr);
    const store = loadShopStore(f.shopFile);
    const marks = Object.values(store.transactions).filter((row) => row.reason === "daily-streak");
    assert.strictEqual(marks.length, 1);
    assert.strictEqual(marks[0].amount, 10);
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
    setMangoShopFileForTests(null);
    setWalletFileForTests(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll daily-quest-streak tests passed.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
