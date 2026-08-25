/**
 * Community title catalog, purchase, ownership, and active title.
 * Run: node tests/mango-titles.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawn } = require("child_process");

const { setMangoShopFileForTests, loadShopStore } = require("../services/mangoShopStore");
const { awardLoot, getLootAccount } = require("../services/mangoLoot");
const {
  TITLE_CATALOG,
  getTitleCatalog,
  getTitleById,
  formatTitleLabel,
  assertCatalogSafe,
  findReservedTitleMatch,
  isTitlePurchasable,
  isTitleWindowOpen,
} = require("../services/mangoTitles");
const {
  titleProgress,
  purchaseTitle,
  setActiveTitle,
  clearActiveTitle,
  getActiveTitle,
  getOwnedTitleIds,
  missingNeeds,
  setTitleLookupForTests,
} = require("../services/mangoShop");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-titles-"));
let n = 0;
const USER = "222";
const OTHER = "333";

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function nextFiles() {
  n += 1;
  return {
    shopFile: path.join(tempDir, `shop-${n}.json`),
    pointsFile: path.join(tempDir, `points-${n}.json`),
    builderFile: path.join(tempDir, `builder-${n}.json`),
  };
}

function seedXp(pointsFile, userId, points) {
  fs.writeFileSync(
    pointsFile,
    JSON.stringify(
      {
        users: {
          [String(userId)]: {
            name: "Ada",
            points,
            weeklyPoints: 0,
            weekId: "2026-W34",
            streak: { current: 0, longest: 0, lastActiveDate: null },
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );
}

function seedBp(builderFile, userId, points) {
  fs.writeFileSync(
    builderFile,
    JSON.stringify(
      {
        version: 1,
        builders: {
          [String(userId)]: {
            points,
            referralIds: [],
            displayName: "Ada",
            createdAt: 1,
            activeInviteId: null,
          },
        },
        referrals: {},
        inviteLinks: {},
        builderEvents: {},
        welcomeOpportunities: {},
      },
      null,
      2
    ),
    "utf8"
  );
}

function filesFor(userId, { xp, bp, loot }) {
  const files = nextFiles();
  seedXp(files.pointsFile, userId, xp);
  seedBp(files.builderFile, userId, bp);
  setMangoShopFileForTests(files.shopFile);
  if (loot > 0) {
    awardLoot(userId, loot, "admin-award", `seed-${n}`, { shopFile: files.shopFile });
  }
  return files;
}

function opts(files) {
  return {
    shopFile: files.shopFile,
    pointsFile: files.pointsFile,
    builderFile: files.builderFile,
  };
}

function spawnBuy(files, userId, titleId) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, "helpers", "mango-shop-buy-worker.js"),
        files.shopFile,
        files.pointsFile,
        files.builderFile,
        String(userId),
        titleId,
      ],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runTest(name, fn) {
  setTitleLookupForTests(null);
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    setTitleLookupForTests(null);
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("14. catalog loads", () => {
    const catalog = getTitleCatalog();
    assert.strictEqual(catalog.length, 5);
    assert.deepStrictEqual(
      catalog.map((row) => row.id),
      ["supporter", "contributor", "ambassador", "guard", "elite"]
    );
    assert.deepStrictEqual(
      catalog.map((row) => [row.requiredXp, row.requiredBp, row.lootPrice]),
      [
        [100, 5, 25],
        [200, 15, 50],
        [500, 30, 100],
        [800, 60, 200],
        [1500, 120, 400],
      ]
    );
    assert.strictEqual(getTitleById("supporter").description, "An active member who supports the ManGo community.");
    assert.strictEqual(
      getTitleById("guard").description,
      "A highly active and established member of the ManGo community."
    );
    assert.strictEqual(
      getTitleById("elite").description,
      "One of ManGo's most dedicated and accomplished community members."
    );
    assert.strictEqual(getTitleById("advocate").name, "ManGo Advocate");
    assert.strictEqual(getTitleById("advocate").active, false);
    assert.strictEqual(getTitleById("advocate").purchasable, false);
    assert.ok(!getTitleCatalog().some((row) => row.id === "advocate"));
    const { getRank } = require("../services/points");
    assert.strictEqual(getRank(300).title, "Guardian");
    assert.ok(!TITLE_CATALOG.some((row) => /mod|admin|owner|dev/i.test(row.name) && row.active));
    assertCatalogSafe();
  });

  await runTest("15. reserved staff title validation", () => {
    assert.strictEqual(
      findReservedTitleMatch({ id: "supporter", name: "ManGo Supporter" }),
      null
    );
    assert.strictEqual(
      findReservedTitleMatch({ id: "support", name: "ManGo Support" }),
      "support"
    );
    assert.ok(findReservedTitleMatch({ id: "mod", name: "ManGo Mod" }));
    assert.ok(findReservedTitleMatch({ id: "admin", name: "ManGo Admin" }));
    assert.ok(findReservedTitleMatch({ id: "developer", name: "ManGo Developer" }));
    assert.throws(() =>
      assertCatalogSafe([
        {
          id: "mod",
          name: "ManGo Mod",
          emoji: "🛡",
          requiredXp: 1,
          requiredBp: 1,
          lootPrice: 1,
        },
      ])
    );
  });

  await runTest("16. supporter locked below XP", () => {
    const files = filesFor(USER, { xp: 99, bp: 20, loot: 100 });
    const progress = titleProgress(USER, getTitleById("supporter"), opts(files));
    assert.strictEqual(progress.status, "locked");
    assert.strictEqual(progress.xpOk, false);
    assert.ok(missingNeeds(progress).some((row) => row.includes("XP")));
  });

  await runTest("17. locked below BP", () => {
    const files = filesFor(USER, { xp: 120, bp: 4, loot: 100 });
    const progress = titleProgress(USER, getTitleById("supporter"), opts(files));
    assert.strictEqual(progress.bpOk, false);
    assert.strictEqual(progress.status, "locked");
  });

  await runTest("18. locked below Loot", () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 10 });
    const progress = titleProgress(USER, getTitleById("supporter"), opts(files));
    assert.strictEqual(progress.lootOk, false);
    assert.strictEqual(progress.status, "locked");
  });

  await runTest("19. all requirements met -> available", () => {
    const files = filesFor(USER, { xp: 100, bp: 5, loot: 25 });
    const progress = titleProgress(USER, getTitleById("supporter"), opts(files));
    assert.strictEqual(progress.available, true);
    assert.strictEqual(progress.status, "available");
  });

  await runTest("20-23. purchase deducts only Loot; ownership stored", () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const xpBefore = JSON.parse(fs.readFileSync(files.pointsFile, "utf8")).users[USER].points;
    const bpBefore = JSON.parse(fs.readFileSync(files.builderFile, "utf8")).builders[USER].points;
    const result = purchaseTitle(USER, "supporter", opts(files));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.lootSpent, 25);
    const loot = getLootAccount(USER, files.shopFile);
    assert.strictEqual(loot.balance, 15);
    assert.strictEqual(loot.lifetimeSpent, 25);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(files.pointsFile, "utf8")).users[USER].points,
      xpBefore
    );
    assert.strictEqual(
      JSON.parse(fs.readFileSync(files.builderFile, "utf8")).builders[USER].points,
      bpBefore
    );
    assert.deepStrictEqual(getOwnedTitleIds(USER, files.shopFile), ["supporter"]);
  });

  await runTest("24-25. duplicate purchase and replay reject extra spend", () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 80 });
    const first = purchaseTitle(USER, "supporter", opts(files));
    const second = purchaseTitle(USER, "supporter", opts(files));
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual(getLootAccount(USER, files.shopFile).balance, 55);
    const store = loadShopStore(files.shopFile);
    assert.strictEqual(Object.keys(store.purchases).length, 1);
  });

  await runTest("26. concurrent buy exactly once", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 25 });
    const [a, b] = await Promise.all([
      spawnBuy(files, USER, "supporter"),
      spawnBuy(files, USER, "supporter"),
    ]);
    assert.strictEqual(a.status, 0, a.stderr);
    assert.strictEqual(b.status, 0, b.stderr);
    const first = JSON.parse(a.stdout);
    const second = JSON.parse(b.stdout);
    const successes = [first, second].filter((row) => row.ok && !row.duplicate);
    const blocked = [first, second].filter((row) => row.duplicate || row.reason === "owned");
    assert.strictEqual(successes.length, 1);
    assert.strictEqual(blocked.length, 1);
    assert.strictEqual(getLootAccount(USER, files.shopFile).balance, 0);
    assert.deepStrictEqual(getOwnedTitleIds(USER, files.shopFile), ["supporter"]);
    const store = loadShopStore(files.shopFile);
    assert.strictEqual(Object.keys(store.purchases).length, 1);
  });

  await runTest("27-29. active title set, switch, remove", () => {
    const files = filesFor(USER, { xp: 600, bp: 80, loot: 400 });
    assert.strictEqual(purchaseTitle(USER, "supporter", opts(files)).ok, true);
    assert.strictEqual(purchaseTitle(USER, "contributor", opts(files)).ok, true);
    const used = setActiveTitle(USER, "supporter", opts(files));
    assert.strictEqual(used.ok, true);
    assert.strictEqual(getActiveTitle(USER, files.shopFile).id, "supporter");
    const switched = setActiveTitle(USER, "contributor", opts(files));
    assert.strictEqual(switched.ok, true);
    assert.strictEqual(getActiveTitle(USER, files.shopFile).id, "contributor");
    const lootAfterSwitch = getLootAccount(USER, files.shopFile).balance;
    const cleared = clearActiveTitle(USER, opts(files));
    assert.strictEqual(cleared.ok, true);
    assert.strictEqual(getActiveTitle(USER, files.shopFile), null);
    assert.strictEqual(getLootAccount(USER, files.shopFile).balance, lootAfterSwitch);
  });

  await runTest("30. restart preserves ownership", () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 25 });
    purchaseTitle(USER, "supporter", opts(files));
    setActiveTitle(USER, "supporter", opts(files));
    setMangoShopFileForTests(files.shopFile);
    assert.deepStrictEqual(getOwnedTitleIds(USER, files.shopFile), ["supporter"]);
    assert.strictEqual(getActiveTitle(USER, files.shopFile).id, "supporter");
  });

  await runTest("31. title detail correct progress", () => {
    const files = filesFor(USER, { xp: 82, bp: 11, loot: 44 });
    const progress = titleProgress(USER, getTitleById("contributor"), opts(files));
    assert.strictEqual(progress.xp, 82);
    assert.strictEqual(progress.requiredXp, 200);
    assert.strictEqual(progress.bp, 11);
    assert.strictEqual(progress.requiredBp, 15);
    assert.strictEqual(progress.loot, 44);
    assert.strictEqual(progress.price, 50);
    assert.strictEqual(formatTitleLabel(progress.title), "🤝 ManGo Contributor");
  });

  await runTest("32. user cannot activate unowned title", () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 25 });
    const result = setActiveTitle(USER, "ambassador", opts(files));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "unowned");
    assert.strictEqual(getActiveTitle(USER, files.shopFile), null);
  });

  await runTest("other user cannot spend this purchase", () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 25 });
    seedXp(files.pointsFile, OTHER, 80);
    const builder = JSON.parse(fs.readFileSync(files.builderFile, "utf8"));
    builder.builders[OTHER] = {
      points: 20,
      referralIds: [],
      displayName: "Bo",
      createdAt: 1,
      activeInviteId: null,
    };
    fs.writeFileSync(files.builderFile, JSON.stringify(builder, null, 2), "utf8");
    awardLoot(OTHER, 25, "admin-award", "other-seed", { shopFile: files.shopFile });
    purchaseTitle(USER, "supporter", opts(files));
    assert.deepStrictEqual(getOwnedTitleIds(OTHER, files.shopFile), []);
    assert.strictEqual(getLootAccount(OTHER, files.shopFile).balance, 25);
  });

  await runTest("8. legacy advocate ownership remains readable and not purchasable", () => {
    const files = filesFor(USER, { xp: 600, bp: 80, loot: 400 });
    const { mutateShopStore } = require("../services/mangoShopStore");
    mutateShopStore((store) => {
      const user = require("../services/mangoShopStore").ensureUser(store, USER);
      user.ownedTitles.advocate = { purchasedAt: 1, purchaseId: "legacy" };
      user.activeTitle = "advocate";
    }, files.shopFile);
    const blocked = purchaseTitle(USER, "advocate", opts(files));
    assert.strictEqual(blocked.ok, false);
    assert.ok(blocked.reason === "unavailable" || blocked.reason === "disabled" || blocked.reason === "owned");
    const active = getActiveTitle(USER, files.shopFile);
    assert.strictEqual(active.id, "advocate");
    const used = setActiveTitle(USER, "advocate", opts(files));
    assert.strictEqual(used.ok, true);
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
    setTitleLookupForTests(null);
    setMangoShopFileForTests(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll mango-titles tests passed.");
  })
  .catch((err) => {
    setTitleLookupForTests(null);
    console.error(err);
    process.exit(1);
  });
