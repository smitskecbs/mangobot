/**
 * Targeted dry-run tests for /cleanupinactive.
 * Run: node tests/cleanup-inactive.test.js
 */

const assert = require("assert");
const {
  scanInactiveCandidates,
  localKeepReason,
  decorateStores,
  formatCleanupMessages,
} = require("../services/inactiveCleanupScan");
const { handleCleanupInactive } = require("../commands/cleanupinactive");

const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";

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

function baseStores(overrides = {}) {
  return decorateStores({
    pointsUsers: {},
    walletUsers: {},
    shopUsers: {},
    presaleUsers: {},
    rewardByUser: {},
    builderBuilders: {},
    builderReferrals: {},
    builderWelcome: {},
    builderInviteLinks: {},
    builderEvents: {},
    highscoreUserIds: [],
    weeklyUserIds: [],
    ...overrides,
  });
}

function memberResult(userId, extra = {}) {
  return {
    status: extra.status || "member",
    user: {
      id: Number(userId),
      is_bot: Boolean(extra.is_bot),
      first_name: extra.first_name || "Idle",
      username: extra.username || "idleuser",
    },
  };
}

runTest("wallet -> keep", () => {
  const stores = baseStores({
    walletUsers: {
      11: { wallet: "So11111111111111111111111111111111111111112", verified: false },
    },
  });
  assert.strictEqual(localKeepReason("11", stores, { isAdminFn: () => false }), "wallet");
});

runTest("activity -> keep", () => {
  const stores = baseStores({
    pointsUsers: {
      12: { points: 0, activityDate: "2026-01-01", streak: { lastActiveDate: null } },
    },
  });
  assert.strictEqual(localKeepReason("12", stores, { isAdminFn: () => false }), "activity");
});

runTest("streak lastActiveDate -> keep", () => {
  const stores = baseStores({
    pointsUsers: {
      13: { points: 0, activityDate: null, streak: { lastActiveDate: "2026-02-02" } },
    },
  });
  assert.strictEqual(localKeepReason("13", stores, { isAdminFn: () => false }), "activity");
});

runTest("XP -> keep", () => {
  const stores = baseStores({
    pointsUsers: {
      14: { points: 3, activityDate: null, streak: {} },
    },
  });
  assert.strictEqual(localKeepReason("14", stores, { isAdminFn: () => false }), "xp");
});

runTest("other participation -> keep", () => {
  const shop = baseStores({ shopUsers: { 15: { loot: { balance: 0 } } } });
  const presale = baseStores({ presaleUsers: { 16: { recorded: true } } });
  const reward = baseStores({ rewardByUser: { 17: ["r1"] } });
  const builder = baseStores({ builderWelcome: { 18: { displayName: "Joiner" } } });
  const score = baseStores({ highscoreUserIds: ["19"] });
  assert.strictEqual(localKeepReason("15", shop, { isAdminFn: () => false }), "shop");
  assert.strictEqual(localKeepReason("16", presale, { isAdminFn: () => false }), "presale");
  assert.strictEqual(localKeepReason("17", reward, { isAdminFn: () => false }), "reward");
  assert.strictEqual(localKeepReason("18", builder, { isAdminFn: () => false }), "builder");
  assert.strictEqual(localKeepReason("19", score, { isAdminFn: () => false }), "highscore");
});

runTest("admin/owner/bot handled as keep", async () => {
  const stores = baseStores({
    pointsUsers: {
      20: { points: 0, activityDate: null },
      21: { points: 0, activityDate: null },
    },
  });
  assert.strictEqual(localKeepReason("20", stores, { isAdminFn: (id) => id === "20" }), "admin");

  const lookups = [];
  const result = await scanInactiveCandidates({
    stores,
    chatId: "-1001",
    isAdminFn: () => false,
    getChatMember: async (_chatId, userId) => {
      lookups.push(userId);
      if (String(userId) === "21") {
        return memberResult(userId, { is_bot: true });
      }
      return memberResult(userId, { status: "administrator" });
    },
  });
  assert.strictEqual(result.inactiveCandidates.length, 0);
  assert.strictEqual(result.removed, false);
});

runTest("uncertain Telegram lookup -> keep", async () => {
  const stores = baseStores({
    pointsUsers: { 22: { points: 0, activityDate: null } },
  });
  const result = await scanInactiveCandidates({
    stores,
    chatId: "-1001",
    isAdminFn: () => false,
    getChatMember: async () => {
      throw new Error("telegram timeout");
    },
  });
  assert.strictEqual(result.inactiveCandidates.length, 0);
  assert.strictEqual(result.removed, false);
  assert.strictEqual(result.telegramLookupsAttempted, 1);
  assert.strictEqual(result.confirmedCurrentMembers, 0);
  assert.strictEqual(result.keptByLocalData, 0);
});

runTest("left/kicked member -> keep", async () => {
  const stores = baseStores({
    pointsUsers: { 23: { points: 0, activityDate: null } },
  });
  const result = await scanInactiveCandidates({
    stores,
    chatId: "-1001",
    isAdminFn: () => false,
    getChatMember: async () => memberResult("23", { status: "left" }),
  });
  assert.strictEqual(result.inactiveCandidates.length, 0);
});

runTest("confirmed inactive normal member -> candidate", async () => {
  const stores = baseStores({
    pointsUsers: { 24: { points: 0, weeklyPoints: 0, activityDate: null, name: "Silent" } },
  });
  const result = await scanInactiveCandidates({
    stores,
    chatId: "-1001",
    isAdminFn: () => false,
    getChatMember: async () =>
      memberResult("24", { first_name: "Silent", username: "silentmango" }),
  });
  assert.strictEqual(result.knownUsersChecked, 1);
  assert.strictEqual(result.keptByLocalData, 0);
  assert.strictEqual(result.telegramLookupsAttempted, 1);
  assert.strictEqual(result.confirmedCurrentMembers, 1);
  assert.strictEqual(result.telegramGroupConfigured, true);
  assert.strictEqual(result.inactiveCandidates.length, 1);
  assert.strictEqual(result.inactiveCandidates[0].userId, "24");
  const messages = formatCleanupMessages(result);
  assert.ok(messages[0].includes("Known bot users: 1"));
  assert.ok(messages[0].includes("Kept by local activity/data: 0"));
  assert.ok(messages[0].includes("Telegram lookups attempted: 1"));
  assert.ok(messages[0].includes("Confirmed current members: 1"));
  assert.ok(messages[0].includes("Inactive candidates: 1"));
  assert.ok(messages[0].includes("Telegram group configured: yes"));
  assert.ok(!messages[0].includes("Current members checked"));
  assert.ok(!messages[0].includes("[debug]"));
  assert.ok(messages[0].includes("No members removed."));
  assert.ok(messages[0].includes("24 — Silent (@silentmango)"));
});

runTest("command performs NO removal", async () => {
  const replies = [];
  const telegram = {
    getChatMember: async () => memberResult("24"),
    banChatMember: async () => {
      throw new Error("must not ban");
    },
    kickChatMember: async () => {
      throw new Error("must not kick");
    },
    unbanChatMember: async () => {
      throw new Error("must not unban");
    },
  };
  const ctx = {
    chat: { type: "private", id: 9001 },
    from: { id: 9001, first_name: "Admin" },
    telegram,
    replies,
    reply(text) {
      replies.push(text);
      return Promise.resolve({ text });
    },
  };
  const stores = baseStores({
    pointsUsers: { 24: { points: 0, activityDate: null, name: "Idle" } },
  });
  await handleCleanupInactive(ctx, {
    stores,
    chatId: "-1001",
    isAdminFn: () => false,
    getChatMember: telegram.getChatMember,
  });
  assert.ok(replies[0].includes("No members removed."));
  assert.ok(replies[0].includes("Inactive candidates: 1"));
  assert.ok(replies[0].includes("Known bot users: 1"));
  assert.ok(!replies[0].includes("Current members checked"));
  assert.ok(!replies[0].toLowerCase().includes("removed 1"));
});

runTest("local KEEP skips Telegram lookup", async () => {
  let lookups = 0;
  const stores = baseStores({
    pointsUsers: { 25: { points: 4, activityDate: null } },
    walletUsers: {
      26: { wallet: "So11111111111111111111111111111111111111112" },
    },
  });
  const result = await scanInactiveCandidates({
    stores,
    chatId: "-1001",
    isAdminFn: () => false,
    getChatMember: async () => {
      lookups += 1;
      return memberResult("25");
    },
  });
  assert.strictEqual(result.knownUsersChecked, 2);
  assert.strictEqual(result.keptByLocalData, 2);
  assert.strictEqual(result.telegramLookupsAttempted, 0);
  assert.strictEqual(result.confirmedCurrentMembers, 0);
  assert.strictEqual(result.inactiveCandidates.length, 0);
  assert.strictEqual(lookups, 0);
  const messages = formatCleanupMessages(result);
  assert.ok(messages[0].includes("Kept by local activity/data: 2"));
  assert.ok(messages[0].includes("Telegram lookups attempted: 0"));
});

runTest("non-admin is rejected and scan is not used", async () => {
  const replies = [];
  let scanned = false;
  const ctx = {
    chat: { type: "private", id: 77 },
    from: { id: 77, first_name: "Nope" },
    replies,
    reply(text) {
      replies.push(text);
      return Promise.resolve({ text });
    },
  };
  await handleCleanupInactive(ctx, {
    stores: baseStores({ pointsUsers: { 1: { points: 0 } } }),
    getChatMember: async () => {
      scanned = true;
      return memberResult("1");
    },
  });
  assert.ok(replies[0].includes("admin only"));
  assert.strictEqual(scanned, false);
});

Promise.all(pending)
  .then(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    console.log(`\nAll cleanup-inactive tests passed.`);
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
