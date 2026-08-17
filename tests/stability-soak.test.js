/**
 * Accelerated local soak: many scheduler ticks without waiting 24h.
 * No Telegram sends. Run: node tests/stability-soak.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const {
  createCommunityScheduler,
} = require("../services/communityScheduler");
const {
  parseActivityEngineConfig,
} = require("../services/communityActivityEngine");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-soak-"));
const TICKS = 120;

function utcDate(iso) {
  return new Date(iso);
}

async function main() {
  const file = path.join(tempDir, "state.json");
  let now = utcDate("2026-08-12T08:00:00.000Z");
  let created = 0;
  let cleared = 0;
  const errors = [];
  const cfg = parseActivityEngineConfig(
    {},
    {
      enabled: true,
      twentyFourSeven: true,
      intervalMinutes: 30,
      autoFightEnabled: false,
    }
  );

  const sched = createCommunityScheduler({
    enabled: false,
    chatId: "1",
    timeZone: "UTC",
    stateFile: file,
    weeklyWinnersFile: path.join(tempDir, "ww.json"),
    pointsFile: path.join(tempDir, "points.json"),
    tickMs: 5,
    now: () => now,
    activityEngineConfig: cfg,
    autoChatFightConfig: {
      enabled: false,
      intervalMinutes: 120,
      chancePercent: 0,
      slots: [],
      types: [],
      startHour: 9,
      endHour: 22,
      minActivityGapMs: 0,
    },
    sendMessage: async () => true,
    activityRandom: () => 0.99,
    setIntervalFn: (fn, ms) => {
      created += 1;
      const id = setInterval(fn, ms);
      return id;
    },
    clearIntervalFn: (id) => {
      cleared += 1;
      clearInterval(id);
    },
  });

  const beforeListeners = process.listenerCount("uncaughtException");
  const memStart = process.memoryUsage().heapUsed;
  sched.start();
  assert.strictEqual(created, 1);

  for (let i = 0; i < TICKS; i += 1) {
    now = new Date(now.getTime() + 30 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }

  const memEnd = process.memoryUsage().heapUsed;
  const growth = memEnd - memStart;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));

  assert.strictEqual(created, 1, "timer count must stay 1");
  assert.strictEqual(sched.isTimerRunning(), true);
  assert.ok(sched.getTickCount() >= TICKS / 3);
  assert.ok(state && typeof state === "object");
  assert.ok(Array.isArray(state.recentActivityTypes));
  assert.ok(state.recentActivityTypes.length <= 8);
  assert.strictEqual(process.listenerCount("uncaughtException"), beforeListeners);
  assert.ok(
    growth < 40 * 1024 * 1024,
    `heap grew ${growth} bytes; expected bounded soak growth`
  );

  sched.stop();
  assert.strictEqual(cleared, 1);
  assert.strictEqual(sched.isTimerRunning(), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(
    `Soak ok ticks=${sched.getTickCount()} heapDeltaBytes=${growth} errors=${errors.length}`
  );
  console.log("All soak tests passed.");
}

main().catch((err) => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_err) {
    /* ignore */
  }
  console.error(err);
  process.exit(1);
});
