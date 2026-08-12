/**
 * Env loading precedence — .env app-config overrides pre-set process.env.
 * Run: node tests/load-env.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { loadAppEnv, APP_CONFIG_KEYS } = require("../utils/loadEnv");
const {
  parseAutoChatFightConfig,
} = require("../services/autoChatFight");
const {
  parseActivityEngineConfig,
  buildActivitySlots,
} = require("../services/communityActivityEngine");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-loadenv-"));

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("1. interval env 30 parses 30", () => {
  assert.strictEqual(
    parseAutoChatFightConfig({ AUTO_CHATFIGHT_INTERVAL_MINUTES: "30" })
      .intervalMinutes,
    30
  );
});

runTest("2. 120 parses 120", () => {
  assert.strictEqual(
    parseAutoChatFightConfig({ AUTO_CHATFIGHT_INTERVAL_MINUTES: "120" })
      .intervalMinutes,
    120
  );
});

runTest("3. invalid fallback 120", () => {
  assert.strictEqual(
    parseAutoChatFightConfig({ AUTO_CHATFIGHT_INTERVAL_MINUTES: "nope" })
      .intervalMinutes,
    120
  );
});

runTest("4. loadAppEnv overrides systemd-like pre-set 120 with .env 30", () => {
  const envPath = path.join(tempDir, ".env");
  fs.writeFileSync(
    envPath,
    "AUTO_CHATFIGHT_INTERVAL_MINUTES=30\nAUTO_CHATFIGHT_ENABLED=true\n",
    "utf8"
  );
  const processEnv = {
    AUTO_CHATFIGHT_INTERVAL_MINUTES: "120",
    AUTO_CHATFIGHT_ENABLED: "true",
    BOT_TOKEN: "x",
  };
  const result = loadAppEnv({ envPath, processEnv });
  assert.ok(APP_CONFIG_KEYS.includes("AUTO_CHATFIGHT_INTERVAL_MINUTES"));
  assert.strictEqual(processEnv.AUTO_CHATFIGHT_INTERVAL_MINUTES, "30");
  assert.ok(result.overridden.includes("AUTO_CHATFIGHT_INTERVAL_MINUTES"));
  assert.strictEqual(
    parseAutoChatFightConfig(processEnv).intervalMinutes,
    30
  );
});

runTest("5. config not cached before env init — fresh parse each call", () => {
  const a = parseAutoChatFightConfig({ AUTO_CHATFIGHT_INTERVAL_MINUTES: "30" });
  const b = parseAutoChatFightConfig({ AUTO_CHATFIGHT_INTERVAL_MINUTES: "60" });
  assert.strictEqual(a.intervalMinutes, 30);
  assert.strictEqual(b.intervalMinutes, 60);
});

runTest("6-7. 24/7 false default; true → 48 slots at 30m", () => {
  const off = parseActivityEngineConfig({});
  assert.strictEqual(off.twentyFourSeven, false);
  const slots = buildActivitySlots(30, { twentyFourSeven: true });
  assert.strictEqual(slots.length, 48);
  assert.strictEqual(slots[0].label, "00:00");
  assert.strictEqual(slots[slots.length - 1].label, "23:30");
});

runTest("MIN_GAP alias: new name wins", () => {
  const cfg = parseAutoChatFightConfig({
    AUTO_CHATFIGHT_MIN_GAP_MINUTES: "90",
    AUTO_CHATFIGHT_MIN_ACTIVITY_GAP_MINUTES: "15",
  });
  assert.strictEqual(cfg.minGapMinutes, 90);
});

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll load-env tests passed.");
