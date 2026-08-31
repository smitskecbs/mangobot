/**
 * Telegram group administrator status is not ADMIN_USER_ID.
 * Group admins earn community XP; owner stays excluded.
 * Run: node tests/admin-participation.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const { isAdmin } = require("../services/points");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const { MANAGE_STATUSES } = require("../utils/admin");
const { getLifetimeTop } = require("../services/leaderboard");
const {
  awardDailyActivityPoint,
  loadPoints,
} = require("../services/points");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-admin-part-"));
const pointsFile = path.join(tempDir, "points.json");
fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");

const OWNER_ID = "9001";
const GROUP_ADMIN_ID = "555001";
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = OWNER_ID;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

try {
  runTest("Telegram administrator is not ADMIN_USER_ID", () => {
    assert.ok(MANAGE_STATUSES.has("administrator"));
    assert.ok(MANAGE_STATUSES.has("creator"));
    assert.strictEqual(isAdmin(OWNER_ID), true);
    assert.strictEqual(isAdmin(GROUP_ADMIN_ID), false);
    assert.strictEqual(isCommunityCompetitionExcluded(OWNER_ID), true);
    assert.strictEqual(isCommunityCompetitionExcluded(GROUP_ADMIN_ID), false);
  });

  runTest("group admin can earn XP and appear on the leaderboard", () => {
    const awarded = awardDailyActivityPoint(GROUP_ADMIN_ID, "Mod", pointsFile);
    assert.strictEqual(awarded.awarded, true);
    assert.strictEqual(awarded.pointsToAdd, 1);

    const owner = awardDailyActivityPoint(OWNER_ID, "Kevin", pointsFile);
    assert.strictEqual(owner.awarded, false);
    assert.strictEqual(owner.reason, "excluded");

    const users = loadPoints(pointsFile).users;
    const top = getLifetimeTop(users, 10);
    assert.ok(top.some((row) => row.name === "Mod"));
    assert.ok(!top.some((row) => row.name === "Kevin"));
    assert.ok(!Object.prototype.hasOwnProperty.call(users, OWNER_ID));
  });

  console.log("\nAll admin participation tests passed.");
} finally {
  if (originalAdmin === undefined) {
    delete process.env.ADMIN_USER_ID;
  } else {
    process.env.ADMIN_USER_ID = originalAdmin;
  }
}
