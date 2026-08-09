/**
 * Focused tests for community points trigger detection, ranks, and silent feedback.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

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

function runTest(name, fn) {
  try {
    resetFile();
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("exact GM / gm", () => {
  assert.strictEqual(detectTrigger("GM"), "gm");
  assert.strictEqual(detectTrigger("gm"), "gm");
});

runTest("GM with emoji around", () => {
  assert.strictEqual(detectTrigger("GM 🥭"), "gm");
  assert.strictEqual(detectTrigger("🥭 GM"), "gm");
  assert.strictEqual(detectTrigger("☀️ GM"), "gm");
  assert.strictEqual(detectTrigger("GM ☀️"), "gm");
  assert.strictEqual(detectTrigger("gm ☕"), "gm");
  assert.strictEqual(detectTrigger("☕ gm"), "gm");
});

runTest("GMango with emoji around", () => {
  assert.strictEqual(detectTrigger("GMango"), "gmango");
  assert.strictEqual(detectTrigger("gmango"), "gmango");
  assert.strictEqual(detectTrigger("GMango 🥭"), "gmango");
  assert.strictEqual(detectTrigger("🥭 GMango"), "gmango");
  assert.strictEqual(detectTrigger("🥭🥭 GMango"), "gmango");
  assert.strictEqual(detectTrigger("GMango ☀️"), "gmango");
  assert.strictEqual(detectTrigger("☀️🥭 GMango"), "gmango");
});

runTest("GN / GNango with emoji around", () => {
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

runTest("no match inside other words", () => {
  assert.strictEqual(detectTrigger("programmer"), null);
  assert.strictEqual(detectTrigger("gmangos"), null);
  assert.strictEqual(detectTrigger("longmango"), null);
});

runTest("gmango preferred over gm substring", () => {
  assert.strictEqual(detectTrigger("gmango"), "gmango");
  assert.strictEqual(detectTrigger("GMango 🥭"), "gmango");
});

runTest("one message yields at most one trigger", () => {
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

runTest("point values unchanged", () => {
  assert.strictEqual(TRIGGERS.gm, 1);
  assert.strictEqual(TRIGGERS.gn, 1);
  assert.strictEqual(TRIGGERS.gmango, 2);
  assert.strictEqual(TRIGGERS.gnango, 2);
});

runTest("rank thresholds", () => {
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

runTest("successful claim saves points", () => {
  const result = awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.pointsToAdd, 1);
  assert.strictEqual(result.points, 1);

  const saved = loadPoints(testFile);
  assert.strictEqual(saved.users["42"].points, 1);
  assert.deepStrictEqual(saved.users["42"].triggersUsed, ["gm"]);
});

runTest("successful claim has no standard reply", () => {
  const result = awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.rankUp, false);
  assert.strictEqual(getAutomaticTriggerReply(result, "Kevin"), null);
});

runTest("duplicate claim awards no points", () => {
  awardTriggerPoints(42, "Kevin", "gm", testFile);
  const second = awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(second.awarded, false);
  assert.strictEqual(second.points, 1);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 1);
});

runTest("duplicate claim has no reply", () => {
  awardTriggerPoints(42, "Kevin", "gm", testFile);
  const second = awardTriggerPoints(42, "Kevin", "gm", testFile);

  assert.strictEqual(second.awarded, false);
  assert.strictEqual(getAutomaticTriggerReply(second, "Kevin"), null);
});

runTest("rank-up is detected and may reply", () => {
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

  const result = awardTriggerPoints(42, "Kevin", "gm", testFile);

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

runTest("only rank-up yields automatic visible message", () => {
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

runTest("first normal message awards +1 activity", () => {
  const result = awardDailyActivityPoint(42, "Kevin", testFile);

  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.pointsToAdd, 1);
  assert.strictEqual(result.points, 1);

  const saved = loadPoints(testFile).users["42"];
  assert.strictEqual(saved.points, 1);
  assert.ok(typeof saved.activityDate === "string" && saved.activityDate.length === 10);
});

runTest("second normal message same UTC day awards +0 activity", () => {
  awardDailyActivityPoint(42, "Kevin", testFile);
  const second = awardDailyActivityPoint(42, "Kevin", testFile);

  assert.strictEqual(second.awarded, false);
  assert.strictEqual(second.points, 1);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 1);
});

runTest("next UTC day awards activity again", () => {
  awardDailyActivityPoint(42, "Kevin", testFile);
  const data = loadPoints(testFile);
  data.users["42"].activityDate = "2000-01-01";
  savePoints(data, testFile);

  const nextDay = awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(nextDay.awarded, true);
  assert.strictEqual(nextDay.points, 2);
});

runTest("existing user without activityDate still works", () => {
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

  const result = awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 11);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 11);
  assert.ok(loadPoints(testFile).users["42"].activityDate);
});

runTest("activity increases lifetime points", () => {
  awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 1);
});

runTest("activity increases weeklyPoints", () => {
  awardDailyActivityPoint(42, "Kevin", testFile);
  const user = loadPoints(testFile).users["42"];
  assert.strictEqual(user.weeklyPoints, 1);
  assert.strictEqual(getEffectiveWeeklyPoints(user), 1);
});

runTest("activity and gmango both award on same message flow", () => {
  const activity = awardDailyActivityPoint(42, "Kevin", testFile);
  const trigger = awardTriggerPoints(42, "Kevin", "gmango", testFile);

  assert.strictEqual(activity.awarded, true);
  assert.strictEqual(trigger.awarded, true);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 3);
  assert.strictEqual(loadPoints(testFile).users["42"].weeklyPoints, 3);
  assert.deepStrictEqual(loadPoints(testFile).users["42"].triggersUsed, ["gmango"]);
});

runTest("activity of one user does not affect another", () => {
  awardDailyActivityPoint(42, "Kevin", testFile);
  awardDailyActivityPoint(99, "Ada", testFile);

  const data = loadPoints(testFile);
  assert.strictEqual(data.users["42"].points, 1);
  assert.strictEqual(data.users["99"].points, 1);

  const secondKevin = awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(secondKevin.awarded, false);
  assert.strictEqual(loadPoints(testFile).users["99"].points, 1);
});

runTest("existing gm/gmango/gn/gnango behavior still works with activity present", () => {
  awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(awardTriggerPoints(42, "Kevin", "gm", testFile).points, 2);
  assert.strictEqual(awardTriggerPoints(42, "Kevin", "gmango", testFile).points, 4);
  assert.strictEqual(awardTriggerPoints(42, "Kevin", "gn", testFile).points, 5);
  assert.strictEqual(awardTriggerPoints(42, "Kevin", "gnango", testFile).points, 7);

  assert.strictEqual(awardTriggerPoints(42, "Kevin", "gm", testFile).awarded, false);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 7);
});

runTest("isCommandText filters slash commands for activity", () => {
  assert.strictEqual(isCommandText("/help"), true);
  assert.strictEqual(isCommandText("/points"), true);
  assert.strictEqual(isCommandText("  /weekly"), true);
  assert.strictEqual(isCommandText("hello"), false);
  assert.strictEqual(isCommandText("gmango"), false);
  assert.strictEqual(isCommandText("/"), true);
});

runTest("combined rank-up reply is at most one message", () => {
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

runTest("activity then gmango crossing Sprout yields single combined reply", () => {
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

  const activity = awardDailyActivityPoint(42, "Kevin", testFile);
  const trigger = awardTriggerPoints(42, "Kevin", "gmango", testFile);

  assert.strictEqual(activity.awarded, true);
  assert.strictEqual(activity.rankUp, true);
  assert.strictEqual(trigger.awarded, true);
  assert.strictEqual(trigger.rankUp, false);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 27);

  const reply = getCombinedRankUpReply(activity, trigger, "Kevin");
  assert.strictEqual(reply, "🥭 Kevin reached 🌿 Sprout!");
});

runTest("activityDate today means daily activity claimed", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(hasClaimedDailyActivity({ activityDate: today }), true);
  assert.strictEqual(
    formatClaimedTodayLines({ activityDate: today, triggerDate: null, triggersUsed: [] }),
    "✅ Daily activity\n⬜ Snake\n⬜ Bounch"
  );
});

runTest("activityDate other day means daily activity not claimed", () => {
  assert.strictEqual(hasClaimedDailyActivity({ activityDate: "2000-01-01" }), false);
  assert.strictEqual(
    formatClaimedTodayLines({
      activityDate: "2000-01-01",
      triggerDate: null,
      triggersUsed: [],
    }),
    "⬜ Daily activity\n⬜ Snake\n⬜ Bounch"
  );
});

runTest("missing activityDate means daily activity not claimed", () => {
  assert.strictEqual(hasClaimedDailyActivity({}), false);
  assert.strictEqual(hasClaimedDailyActivity({ activityDate: null }), false);
  assert.strictEqual(hasClaimedDailyActivity(undefined), false);
});

runTest("trigger claimed-today status still works with activity lines", () => {
  const today = new Date().toISOString().slice(0, 10);
  const user = {
    activityDate: today,
    triggerDate: today,
    triggersUsed: ["gm", "gmango"],
  };

  assert.deepStrictEqual(getTriggersClaimedToday(user), ["gm", "gmango"]);
  assert.strictEqual(
    formatClaimedTodayLines(user),
    "✅ Daily activity\n✅ gm\n✅ gmango\n⬜ Snake\n⬜ Bounch"
  );

  const triggersOnly = {
    triggerDate: today,
    triggersUsed: ["gm", "gmango"],
  };
  assert.strictEqual(
    formatClaimedTodayLines(triggersOnly),
    "⬜ Daily activity\n✅ gm\n✅ gmango\n⬜ Snake\n⬜ Bounch"
  );
});

runTest("legacy user without game → Snake/Bounch unchecked and unlocks 0/7", () => {
  const legacy = { activityDate: null, triggerDate: null, triggersUsed: [] };
  assert.strictEqual(hasClaimedSnakeToday(legacy), false);
  assert.strictEqual(hasClaimedBounchToday(legacy), false);
  assert.strictEqual(getBounchUnlockedMaxForDisplay(legacy), 0);
  assert.strictEqual(formatBounchUnlocksLine(legacy), "🎮 Bounch unlocks: 0 / 7");
  assert.strictEqual(
    formatClaimedTodayLines(legacy),
    "⬜ Daily activity\n⬜ Snake\n⬜ Bounch"
  );
  assert.strictEqual(hasClaimedSnakeToday(undefined), false);
  assert.strictEqual(hasClaimedBounchToday(null), false);
  assert.strictEqual(getBounchUnlockedMaxForDisplay({}), 0);
});

runTest("snakePlayDate today → claimed; yesterday → not claimed", () => {
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

runTest("bounchPlayDate today → claimed; yesterday → not claimed", () => {
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

runTest("bounchUnlockedMax display clamps and is read-only", () => {
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
