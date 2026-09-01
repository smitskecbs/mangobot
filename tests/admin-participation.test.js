/**
 * Telegram group administrator status is not ADMIN_USER_ID.
 * Owner and group admins both earn community XP and appear on boards.
 * Admin permissions (isAdmin) stay owner-only.
 * Run: node tests/admin-participation.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const { isAdmin } = require("../services/points");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const { MANAGE_STATUSES, canManageGroup } = require("../utils/admin");
const { getLifetimeTop, getWeeklyTop } = require("../services/leaderboard");
const {
  awardDailyActivityPoint,
  awardPvpWinXp,
  getEffectiveWeeklyPoints,
  loadPoints,
  PVP_WIN_XP,
} = require("../services/points");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-admin-part-"));
const pointsFile = path.join(tempDir, "points.json");
fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");

const OWNER_ID = "9001";
const GROUP_ADMIN_ID = "555001";
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = OWNER_ID;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

(async () => {
try {
  await runTest("Telegram administrator is not ADMIN_USER_ID", async () => {
    assert.ok(MANAGE_STATUSES.has("administrator"));
    assert.ok(MANAGE_STATUSES.has("creator"));
    assert.strictEqual(isAdmin(OWNER_ID), true);
    assert.strictEqual(isAdmin(GROUP_ADMIN_ID), false);
    assert.strictEqual(isCommunityCompetitionExcluded(OWNER_ID), false);
    assert.strictEqual(isCommunityCompetitionExcluded(GROUP_ADMIN_ID), false);
  });

  await runTest("owner admin permissions remain isAdmin-only", async () => {
    assert.strictEqual(isAdmin(OWNER_ID), true);
    assert.strictEqual(isAdmin(GROUP_ADMIN_ID), false);
    assert.strictEqual(isAdmin("0"), false);
  });

  await runTest("group admin can earn XP and appear on the leaderboard", async () => {
    const awarded = await awardDailyActivityPoint(GROUP_ADMIN_ID, "Mod", pointsFile);
    assert.strictEqual(awarded.awarded, true);
    assert.strictEqual(awarded.pointsToAdd, 1);

    const users = loadPoints(pointsFile).users;
    const top = getLifetimeTop(users, 10);
    assert.ok(top.some((row) => row.name === "Mod"));
  });

  await runTest("ADMIN_USER_ID can earn XP and appear on lifetime and weekly boards", async () => {
    const owner = await awardDailyActivityPoint(OWNER_ID, "Kevin", pointsFile);
    assert.strictEqual(owner.awarded, true);
    assert.strictEqual(owner.pointsToAdd, 1);
    assert.notStrictEqual(owner.reason, "excluded");

    const game = await awardPvpWinXp(OWNER_ID, "Kevin", pointsFile);
    assert.strictEqual(game.awarded, true);
    assert.strictEqual(game.pointsToAdd, PVP_WIN_XP);

    const users = loadPoints(pointsFile).users;
    assert.ok(Object.prototype.hasOwnProperty.call(users, OWNER_ID));
    assert.ok(users[OWNER_ID].points >= 1 + PVP_WIN_XP);

    const lifetime = getLifetimeTop(users, 10);
    assert.ok(lifetime.some((row) => row.name === "Kevin"));

    const weekly = getWeeklyTop(users, getEffectiveWeeklyPoints, 10);
    assert.ok(weekly.some((row) => row.name === "Kevin"));
  });

  await runTest("group Telegram admins stay participants while owner keeps canManageGroup", async () => {
    const groupCtx = {
      from: { id: Number(GROUP_ADMIN_ID) },
      chat: { id: -1001, type: "supergroup" },
    };
    const asGroupAdmin = await canManageGroup(groupCtx, {
      isAdminFn: isAdmin,
      getChatMember: async () => ({ status: "administrator" }),
    });
    assert.strictEqual(asGroupAdmin, true);

    const ownerCtx = {
      from: { id: Number(OWNER_ID) },
      chat: { id: -1001, type: "supergroup" },
    };
    const asOwner = await canManageGroup(ownerCtx, {
      isAdminFn: isAdmin,
      getChatMember: async () => ({ status: "member" }),
    });
    assert.strictEqual(asOwner, true);
    assert.strictEqual(isAdmin(OWNER_ID), true);
    assert.strictEqual(isAdmin(GROUP_ADMIN_ID), false);
  });

  console.log("\nAll admin participation tests passed.");
} finally {
  if (originalAdmin === undefined) {
    delete process.env.ADMIN_USER_ID;
  } else {
    process.env.ADMIN_USER_ID = originalAdmin;
  }
}
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
