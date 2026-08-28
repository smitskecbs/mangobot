/**
 * Daily Quest UTC rotation: same 3 quests for everyone, restart-stable.
 * Run: node tests/daily-quest-rotation.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");

const {
  selectQuestsForDate,
  CATEGORY,
  QUEST_DEFS,
  SOCIAL_POOL,
  GAME_POOL,
  PROGRESSION_POOL,
} = require("../services/dailyQuestPool");
const {
  getDailyQuestSnapshot,
  utcDate,
  completeSelectedQuests,
} = require("../services/dailyQuest");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const { setWalletFileForTests, registerManualWallet } = require("../services/walletLinks");
const { encodeBase58 } = require("../utils/base58");
const crypto = require("node:crypto");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-dq-rot-"));
const USER = "9001";
const DAY = Date.UTC(2026, 7, 28, 12, 0, 0);

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

function files(tag) {
  const shopFile = path.join(tempDir, `shop-${tag}.json`);
  const walletFile = path.join(tempDir, `wallet-${tag}.json`);
  setMangoShopFileForTests(shopFile);
  setWalletFileForTests(walletFile);
  registerManualWallet(USER, walletAddress(tag), walletFile, DAY);
  return { shopFile, walletFile };
}

function assertBalanced(selected) {
  assert.strictEqual(selected.length, 3);
  assert.strictEqual(new Set(selected).size, 3);
  const cats = selected.map((id) => QUEST_DEFS[id].category);
  assert.deepStrictEqual(cats, [CATEGORY.SOCIAL, CATEGORY.GAME, CATEGORY.PROGRESSION]);
  assert.ok(SOCIAL_POOL.includes(selected[0]));
  assert.ok(GAME_POOL.includes(selected[1]));
  assert.ok(PROGRESSION_POOL.includes(selected[2]));
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("same UTC date => same exact selection", () => {
  const a = selectQuestsForDate("2026-08-28");
  const b = selectQuestsForDate("2026-08-28");
  assert.deepStrictEqual(a, b);
  assertBalanced(a);
});

runTest("restart => same selection", () => {
  const script = path.join(tempDir, "pick.js");
  fs.writeFileSync(
    script,
    `const { selectQuestsForDate } = require(${JSON.stringify(
      path.join(__dirname, "..", "services", "dailyQuestPool.js")
    )});
process.stdout.write(JSON.stringify(selectQuestsForDate("2026-08-28")));
`,
    "utf8"
  );
  const first = spawnSync(process.execPath, [script], { encoding: "utf8" });
  const second = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(first.stdout, second.stdout);
  assert.deepStrictEqual(JSON.parse(first.stdout), selectQuestsForDate("2026-08-28"));
});

runTest("next date deterministic selection", () => {
  const today = selectQuestsForDate("2026-08-28");
  let nextDate = "2026-08-29";
  let next = selectQuestsForDate(nextDate);
  for (let i = 1; i < 60 && JSON.stringify(next) === JSON.stringify(today); i += 1) {
    nextDate = utcDate(Date.UTC(2026, 7, 28 + i, 12, 0, 0));
    next = selectQuestsForDate(nextDate);
  }
  assertBalanced(next);
  assert.deepStrictEqual(selectQuestsForDate(nextDate), next);
});

runTest("exactly one SOCIAL + one GAME + one PROGRESSION", () => {
  for (let i = 0; i < 40; i += 1) {
    const date = utcDate(DAY + i * 24 * 60 * 60 * 1000);
    assertBalanced(selectQuestsForDate(date));
  }
});

runTest("exactly 3 unique quests", () => {
  const selected = selectQuestsForDate("2026-08-28");
  assert.strictEqual(selected.length, 3);
  assert.strictEqual(new Set(selected).size, 3);
  const f = files("snap");
  const snap = getDailyQuestSnapshot(USER, { ...f, now: DAY });
  assert.deepStrictEqual(snap.selected, selected);
  assert.strictEqual(snap.questList.length, 3);
  completeSelectedQuests(USER, { ...f, now: DAY });
  const done = getDailyQuestSnapshot(USER, { ...f, now: DAY });
  assert.strictEqual(done.completedToday, 3);
});

for (const [file, mtime] of Object.entries(prodMtimes)) {
  if (fs.existsSync(file)) {
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime, file);
  }
}

setMangoShopFileForTests(null);
setWalletFileForTests(null);
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("All daily-quest-rotation tests passed.");
