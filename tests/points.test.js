/**
 * Focused tests for community points trigger detection and ranks.
 */

const assert = require("assert");
const { detectTrigger, getRank, TRIGGERS } = require("../services/points");

function runTest(name, fn) {
  try {
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

console.log("\nAll points tests passed.");
