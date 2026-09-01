/**
 * Focused tests for community points trigger detection, ranks, and silent feedback.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  detectTrigger,
  getRank,
  TRIGGERS,
  awardTriggerPoints,
  awardDailyActivityPoint,
  getAutomaticTriggerReply,
  getCombinedRankUpReply,
  buildRankUpMessage,
  isCommandText,
  loadPoints,
  savePoints,
  getEffectiveWeeklyPoints,
  hasClaimedDailyActivity,
  hasClaimedSnakeToday,
  hasClaimedBounchToday,
  getBounchUnlockedMaxForDisplay,
  formatBounchUnlocksLine,
  getTriggersClaimedToday,
  formatClaimedTodayLines,
} = require("../services/points");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-points-test-"));
const testFile = path.join(tempDir, "points.json");

function resetFile(contents = { users: {} }) {
  fs.writeFileSync(testFile, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
}

async function runTest(name, fn) {
  try {
    resetFile();
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

(async () => {
await runTest("exact GM / gm", async () => {
  assert.strictEqual(detectTrigger("GM"), "gm");
  assert.strictEqual(detectTrigger("gm"), "gm");
});

await runTest("GM with emoji around", async () => {
  assert.strictEqual(detectTrigger("GM 🥭"), "gm");
  assert.strictEqual(detectTrigger("🥭 GM"), "gm");
  assert.strictEqual(detectTrigger("☀️ GM"), "gm");
  assert.strictEqual(detectTrigger("GM ☀️"), "gm");
  assert.strictEqual(detectTrigger("gm ☕"), "gm");
  assert.strictEqual(detectTrigger("☕ gm"), "gm");
});

await runTest("GMango with emoji around", async () => {
  assert.strictEqual(detectTrigger("GMango"), "gmango");
  assert.strictEqual(detectTrigger("gmango"), "gmango");
  assert.strictEqual(detectTrigger("GMango 🥭"), "gmango");
  assert.strictEqual(detectTrigger("🥭 GMango"), "gmango");
  assert.strictEqual(detectTrigger("🥭🥭 GMango"), "gmango");
  assert.strictEqual(detectTrigger("GMango ☀️"), "gmango");
  assert.strictEqual(detectTrigger("☀️🥭 GMango"), "gmango");
});

await runTest("GN / GNango with emoji around", async () => {
  assert.strictEqual(detectTrigger("GN"), "gn");
  assert.strictEqual(detectTrigger("gn"), "gn");
  assert.strictEqual(detectTrigger("GN 🌙"), "gn");
  assert.strictEqual(detectTrigger("🌙 GN"), "gn");
  assert.strictEqual(detectTrigger("GN 😴"), "gn");
  assert.strictEqual(detectTrigger("GNango"), "gnango");
  assert.strictEqual(detectTrigger("GNango 🌙"), "gnango");
  assert.strictEqual(detectTrigger("🌙 GNango"), "gnango");
  assert.strictEqual(detectTrigger("🌙🥭 GNango"), "gnango");
  assert.strictEqual(detectTrigger("🥭 GNango 🌙"), "gnango");
});

await runTest("no match inside other words", async () => {
  assert.strictEqual(detectTrigger("programmer"), null);
  assert.strictEqual(detectTrigger("gmangos"), null);
  assert.strictEqual(detectTrigger("longmango"), null);
});

await runTest("gmango preferred over gm substring", async () => {
  assert.strictEqual(detectTrigger("gmango"), "gmango");
  assert.strictEqual(detectTrigger("GMango 🥭"), "gmango");
});

await runTest("one message yields at most one trigger", async () => {
  assert.strictEqual(detectTrigger("GM 🥭 GMango"), "gmango");
  assert.strictEqual(TRIGGERS[detectTrigger("GM 🥭 GMango")], 2);

  assert.strictEqual(detectTrigger("GN 🌙 GNango"), "gnango");
  assert.strictEqual(TRIGGERS[detectTrigger("GN 🌙 GNango")], 2);

  assert.strictEqual(detectTrigger("GM GN"), "gm");
  assert.strictEqual(TRIGGERS[detectTrigger("GM GN")], 1);

  assert.strictEqual(detectTrigger("GMango GNango"), "gmango");
  assert.strictEqual(TRIGGERS[detectTrigger("GMango GNango")], 2);

  assert.strictEqual(detectTrigger("🥭 GMango GM GN"), "gmango");
  assert.strictEqual(TRIGGERS[detectTrigger("🥭 GMango GM GN")], 2);
});

await runTest("point values unchanged", async () => {
  assert.strictEqual(TRIGGERS.gm, 1);
  assert.strictEqual(TRIGGERS.gn, 1);
  assert.strictEqual(TRIGGERS.gmango, 2);
  assert.strictEqual(TRIGGERS.gnango, 2);
});

await runTest("rank thresholds", async () => {
  assert.deepStrictEqual(getRank(0), { emoji: "🌱", title: "Seed" });
  assert.deepStrictEqual(getRank(24), { emoji: "🌱", title: "Seed" });
  assert.deepStrictEqual(getRank(25), { emoji: "🌿", title: "Sprout" });
  assert.deepStrictEqual(getRank(74), { emoji: "🌿", title: "Sprout" });
  assert.deepStrictEqual(getRank(75), { emoji: "🌳", title: "Tree" });
  assert.deepStrictEqual(getRank(149), { emoji: "🌳", title: "Tree" });
  assert.deepStrictEqual(getRank(150), { emoji: "🥭", title: "Mango Tree" });
  assert.deepStrictEqual(getRank(299), { emoji: "🥭", title: "Mango Tree" });
  assert.deepStrictEqual(getRank(300), { emoji: "🛡", title: "Guardian" });
  assert.deepStrictEqual(getRank(599), { emoji: "🛡", title: "Guardian" });
  assert.deepStrictEqual(getRank(600), { emoji: "👑", title: "Legend" });
});

await runTest("successful claim saves points", async () => {
  const result = await awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.pointsToAdd, 1);
  assert.strictEqual(result.points, 1);

  const saved = loadPoints(testFile);
  assert.strictEqual(saved.users["42"].points, 1);
  assert.deepStrictEqual(saved.users["42"].triggersUsed, ["gm"]);
});

await runTest("successful claim has no standard reply", async () => {
  const result = await awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.rankUp, false);
  assert.strictEqual(getAutomaticTriggerReply(result, "Kevin"), null);
});

await runTest("duplicate claim awards no points", async () => {
  await awardTriggerPoints(42, "Kevin", "gm", testFile);
  const second = await awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(second.awarded, false);
  assert.strictEqual(second.points, 1);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 1);
});

await runTest("duplicate claim has no reply", async () => {
  await awardTriggerPoints(42, "Kevin", "gm", testFile);
  const second = await awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(second.awarded, false);
  assert.strictEqual(getAutomaticTriggerReply(second, "Kevin"), null);
});

await runTest("rank-up is detected and may reply", async () => {
  resetFile({
    users: {
      "42": {
        points: 24,
        weeklyPoints: 0,
        weekId: "2099-01-01",
        name: "Kevin",
        triggerDate: "2099-01-01",
        triggersUsed: [],
      },
    },
  });

  const result = await awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 25);
  assert.strictEqual(result.rankUp, true);
  assert.deepStrictEqual(result.rank, { emoji: "🌿", title: "Sprout" });
  assert.strictEqual(
    getAutomaticTriggerReply(result, "Kevin"),
    "🥭 Kevin reached 🌿 Sprout!"
  );
  assert.strictEqual(
    buildRankUpMessage("Kevin", result.rank),
    "🥭 Kevin reached 🌿 Sprout!"
  );
});

await runTest("only rank-up yields automatic visible message", async () => {
  const silentSuccess = {
    awarded: true,
    rankUp: false,
    rank: { emoji: "🌱", title: "Seed" },
  };
  const silentDuplicate = {
    awarded: false,
    rankUp: false,
    rank: { emoji: "🌱", title: "Seed" },
  };
  const rankUp = {
    awarded: true,
    rankUp: true,
    rank: { emoji: "🌳", title: "Tree" },
  };

  assert.strictEqual(getAutomaticTriggerReply(silentSuccess, "Kevin"), null);
  assert.strictEqual(getAutomaticTriggerReply(silentDuplicate, "Kevin"), null);
  assert.strictEqual(
    getAutomaticTriggerReply(rankUp, "Kevin"),
    "🥭 Kevin reached 🌳 Tree!"
  );
});

await runTest("first normal message awards +1 activity", async () => {
  const result = await awardDailyActivityPoint(42, "Kevin", testFile);

  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.pointsToAdd, 1);
  assert.strictEqual(result.points, 1);

  const saved = loadPoints(testFile).users["42"];
  assert.strictEqual(saved.points, 1);
  assert.ok(typeof saved.activityDate === "string" && saved.activityDate.length === 10);
});

await runTest("second normal message same UTC day awards +0 activity", async () => {
  await awardDailyActivityPoint(42, "Kevin", testFile);
  const second = await awardDailyActivityPoint(42, "Kevin", testFile);

  assert.strictEqual(second.awarded, false);
  assert.strictEqual(second.points, 1);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 1);
});

await runTest("next UTC day awards activity again", async () => {
  await awardDailyActivityPoint(42, "Kevin", testFile);
  const data = loadPoints(testFile);
  data.users["42"].activityDate = "2000-01-01";
  savePoints(data, testFile);

  const nextDay = await awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(nextDay.awarded, true);
  assert.strictEqual(nextDay.points, 2);
});

await runTest("existing user without activityDate still works", async () => {
  resetFile({
    users: {
      "42": {
        points: 10,
        weeklyPoints: 3,
        weekId: new Date().toISOString().slice(0, 10),
        name: "Kevin",
        triggerDate: "2000-01-01",
        triggersUsed: [],
      },
    },
  });

  const result = await awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 11);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 11);
  assert.ok(loadPoints(testFile).users["42"].activityDate);
});

await runTest("activity increases lifetime points", async () => {
  await awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 1);
});

await runTest("activity increases weeklyPoints", async () => {
  await awardDailyActivityPoint(42, "Kevin", testFile);
  const user = loadPoints(testFile).users["42"];
  assert.strictEqual(user.weeklyPoints, 1);
  assert.strictEqual(getEffectiveWeeklyPoints(user), 1);
});

await runTest("activity and gmango both award on same message flow", async () => {
  const activity = await awardDailyActivityPoint(42, "Kevin", testFile);
  const trigger = await awardTriggerPoints(42, "Kevin", "gmango", testFile);

  assert.strictEqual(activity.awarded, true);
  assert.strictEqual(trigger.awarded, true);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 3);
  assert.strictEqual(loadPoints(testFile).users["42"].weeklyPoints, 3);
  assert.deepStrictEqual(loadPoints(testFile).users["42"].triggersUsed, ["gmango"]);
});

await runTest("activity of one user does not affect another", async () => {
  await awardDailyActivityPoint(42, "Kevin", testFile);
  await awardDailyActivityPoint(99, "Ada", testFile);

  const data = loadPoints(testFile);
  assert.strictEqual(data.users["42"].points, 1);
  assert.strictEqual(data.users["99"].points, 1);

  const secondKevin = await awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(secondKevin.awarded, false);
  assert.strictEqual(loadPoints(testFile).users["99"].points, 1);
});

await runTest("existing gm/gmango/gn/gnango behavior still works with activity present", async () => {
  await awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual((await awardTriggerPoints(42, "Kevin", "gm", testFile)).points, 2);
  assert.strictEqual((await awardTriggerPoints(42, "Kevin", "gmango", testFile)).points, 4);
  assert.strictEqual((await awardTriggerPoints(42, "Kevin", "gn", testFile)).points, 5);
  assert.strictEqual((await awardTriggerPoints(42, "Kevin", "gnango", testFile)).points, 7);

  assert.strictEqual((await awardTriggerPoints(42, "Kevin", "gm", testFile)).awarded, false);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 7);
});

await runTest("isCommandText filters slash commands for activity", async () => {
  assert.strictEqual(isCommandText("/help"), true);
  assert.strictEqual(isCommandText("/points"), true);
  assert.strictEqual(isCommandText("  /weekly"), true);
  assert.strictEqual(isCommandText("hello"), false);
  assert.strictEqual(isCommandText("gmango"), false);
  assert.strictEqual(isCommandText("/"), true);
});

await runTest("combined rank-up reply is at most one message", async () => {
  const activityRankUp = {
    awarded: true,
    rankUp: true,
    rank: { emoji: "🌿", title: "Sprout" },
  };
  const triggerNoRankUp = {
    awarded: true,
    rankUp: false,
    rank: { emoji: "🌿", title: "Sprout" },
  };
  const triggerRankUp = {
    awarded: true,
    rankUp: true,
    rank: { emoji: "🌳", title: "Tree" },
  };

  assert.strictEqual(
    getCombinedRankUpReply(activityRankUp, triggerNoRankUp, "Kevin"),
    "🥭 Kevin reached 🌿 Sprout!"
  );
  assert.strictEqual(
    getCombinedRankUpReply(activityRankUp, triggerRankUp, "Kevin"),
    "🥭 Kevin reached 🌳 Tree!"
  );
  assert.strictEqual(getCombinedRankUpReply(null, null, "Kevin"), null);
});

await runTest("activity then gmango crossing Sprout yields single combined reply", async () => {
  resetFile({
    users: {
      "42": {
        points: 24,
        weeklyPoints: 0,
        weekId: new Date().toISOString().slice(0, 10),
        name: "Kevin",
        triggerDate: "2000-01-01",
        triggersUsed: [],
      },
    },
  });

  const activity = await awardDailyActivityPoint(42, "Kevin", testFile);
  const trigger = await awardTriggerPoints(42, "Kevin", "gmango", testFile);

  assert.strictEqual(activity.awarded, true);
  assert.strictEqual(activity.rankUp, true);
  assert.strictEqual(trigger.awarded, true);
  assert.strictEqual(trigger.rankUp, false);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 27);

  const reply = getCombinedRankUpReply(activity, trigger, "Kevin");
  assert.strictEqual(reply, "🥭 Kevin reached 🌿 Sprout!");
});

await runTest("activityDate today means daily activity claimed", async () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(hasClaimedDailyActivity({ activityDate: today }), true);
  assert.strictEqual(
    formatClaimedTodayLines({ activityDate: today, triggerDate: null, triggersUsed: [] }),
    "✅ Daily activity\n⬜ GMango\n⬜ GNango\n⬜ GM\n⬜ GN\n⬜ Snake\n⬜ Bounch\n🎮 PvP wins today: 0 / 3\n⚔️ PvP games today: 0"
  );
});

await runTest("activityDate other day means daily activity not claimed", async () => {
  assert.strictEqual(hasClaimedDailyActivity({ activityDate: "2000-01-01" }), false);
  assert.strictEqual(
    formatClaimedTodayLines({
      activityDate: "2000-01-01",
      triggerDate: null,
      triggersUsed: [],
    }),
    "⬜ Daily activity\n⬜ GMango\n⬜ GNango\n⬜ GM\n⬜ GN\n⬜ Snake\n⬜ Bounch\n🎮 PvP wins today: 0 / 3\n⚔️ PvP games today: 0"
  );
});

await runTest("missing activityDate means daily activity not claimed", async () => {
  assert.strictEqual(hasClaimedDailyActivity({}), false);
  assert.strictEqual(hasClaimedDailyActivity({ activityDate: null }), false);
  assert.strictEqual(hasClaimedDailyActivity(undefined), false);
});

await runTest("trigger claimed-today status still works with activity lines", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const user = {
    activityDate: today,
    triggerDate: today,
    triggersUsed: ["gm", "gmango"],
  };

  assert.deepStrictEqual(getTriggersClaimedToday(user), ["gm", "gmango"]);
  assert.strictEqual(
    formatClaimedTodayLines(user),
    "✅ Daily activity\n✅ GMango\n⬜ GNango\n✅ GM\n⬜ GN\n⬜ Snake\n⬜ Bounch\n🎮 PvP wins today: 0 / 3\n⚔️ PvP games today: 0"
  );

  const triggersOnly = {
    triggerDate: today,
    triggersUsed: ["gm", "gmango"],
  };
  assert.strictEqual(
    formatClaimedTodayLines(triggersOnly),
    "⬜ Daily activity\n✅ GMango\n⬜ GNango\n✅ GM\n⬜ GN\n⬜ Snake\n⬜ Bounch\n🎮 PvP wins today: 0 / 3\n⚔️ PvP games today: 0"
  );
});

await runTest("legacy user without game → Snake/Bounch unchecked and unlocks 0/7", async () => {
  const legacy = { activityDate: null, triggerDate: null, triggersUsed: [] };
  assert.strictEqual(hasClaimedSnakeToday(legacy), false);
  assert.strictEqual(hasClaimedBounchToday(legacy), false);
  assert.strictEqual(getBounchUnlockedMaxForDisplay(legacy), 0);
  assert.strictEqual(formatBounchUnlocksLine(legacy), "🎮 Bounch unlocks: 0 / 7");
  assert.strictEqual(
    formatClaimedTodayLines(legacy),
    "⬜ Daily activity\n⬜ GMango\n⬜ GNango\n⬜ GM\n⬜ GN\n⬜ Snake\n⬜ Bounch\n🎮 PvP wins today: 0 / 3\n⚔️ PvP games today: 0"
  );
  assert.strictEqual(hasClaimedSnakeToday(undefined), false);
  assert.strictEqual(hasClaimedBounchToday(null), false);
  assert.strictEqual(getBounchUnlockedMaxForDisplay({}), 0);
});

await runTest("snakePlayDate today → claimed; yesterday → not claimed", async () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(
    hasClaimedSnakeToday({ game: { snakePlayDate: today } }),
    true
  );
  assert.ok(formatClaimedTodayLines({ game: { snakePlayDate: today } }).includes("✅ Snake"));
  assert.strictEqual(
    hasClaimedSnakeToday({ game: { snakePlayDate: "2000-01-01" } }),
    false
  );
  assert.ok(
    formatClaimedTodayLines({ game: { snakePlayDate: "2000-01-01" } }).includes(
      "⬜ Snake"
    )
  );
});

await runTest("bounchPlayDate today → claimed; yesterday → not claimed", async () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(
    hasClaimedBounchToday({ game: { bounchPlayDate: today } }),
    true
  );
  assert.ok(
    formatClaimedTodayLines({ game: { bounchPlayDate: today } }).includes("✅ Bounch")
  );
  assert.strictEqual(
    hasClaimedBounchToday({ game: { bounchPlayDate: "2000-01-01" } }),
    false
  );
  assert.ok(
    formatClaimedTodayLines({ game: { bounchPlayDate: "2000-01-01" } }).includes(
      "⬜ Bounch"
    )
  );
});

await runTest("bounchUnlockedMax display clamps and is read-only", async () => {
  assert.strictEqual(
    getBounchUnlockedMaxForDisplay({ game: { bounchUnlockedMax: 4 } }),
    4
  );
  assert.strictEqual(
    formatBounchUnlocksLine({ game: { bounchUnlockedMax: 4 } }),
    "🎮 Bounch unlocks: 4 / 7"
  );
  assert.strictEqual(
    getBounchUnlockedMaxForDisplay({ game: { bounchUnlockedMax: 7 } }),
    7
  );
  assert.strictEqual(
    formatBounchUnlocksLine({ game: { bounchUnlockedMax: 7 } }),
    "🎮 Bounch unlocks: 7 / 7"
  );
  assert.strictEqual(
    getBounchUnlockedMaxForDisplay({ game: { bounchUnlockedMax: 99 } }),
    7
  );
  assert.strictEqual(
    getBounchUnlockedMaxForDisplay({ game: { bounchUnlockedMax: -3 } }),
    0
  );
  assert.strictEqual(
    getBounchUnlockedMaxForDisplay({ game: { bounchUnlockedMax: 2.5 } }),
    0
  );
  assert.strictEqual(
    getBounchUnlockedMaxForDisplay({ game: { bounchUnlockedMax: "4" } }),
    0
  );
  assert.strictEqual(
    getBounchUnlockedMaxForDisplay({ game: { bounchUnlockedMax: null } }),
    0
  );

  const user = { game: { bounchUnlockedMax: 99 } };
  getBounchUnlockedMaxForDisplay(user);
  formatBounchUnlocksLine(user);
  formatClaimedTodayLines(user);
  assert.strictEqual(user.game.bounchUnlockedMax, 99);
});


  fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll points tests passed.");

})().catch((err) => {
  console.error(err);
  process.exit(1);
});
