/**
 * Bot lifecycle — Telegraf launch onLaunch vs Promise semantics.
 * Run: node tests/bot-lifecycle.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { startBotRuntime } = require("../utils/botLifecycle");
const {
  createCommunityScheduler,
} = require("../services/communityScheduler");
const {
  parseActivityEngineConfig,
} = require("../services/communityActivityEngine");


const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-bot-lifecycle-"));
let testCounter = 0;

function stateFile() {
  testCounter += 1;
  return path.join(tempDir, `state-${testCounter}.json`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function createFakeBot({
  onLaunchHook,
  launchPromise,
  rejectLaunch,
} = {}) {
  let launchCalls = 0;
  let stopCalls = [];
  let capturedOnLaunch = null;
  const telegram = { token: "fake" };

  const bot = {
    telegram,
    launch(configOrCb, maybeCb) {
      launchCalls += 1;
      const onLaunch =
        typeof configOrCb === "function" ? configOrCb : maybeCb;
      capturedOnLaunch = onLaunch;
      if (typeof onLaunchHook === "function") {
        onLaunchHook(onLaunch);
      } else if (typeof onLaunch === "function" && !rejectLaunch) {
        // Default Telegraf semantics: call onLaunch, then stay pending.
        onLaunch();
      }
      if (rejectLaunch) {
        return Promise.reject(
          rejectLaunch instanceof Error
            ? rejectLaunch
            : new Error(String(rejectLaunch))
        );
      }
      if (launchPromise) {
        return launchPromise;
      }
      return new Promise(() => {});
    },
    stop(signal) {
      stopCalls.push(signal);
    },
  };

  return {
    bot,
    telegram,
    getLaunchCalls: () => launchCalls,
    getStopCalls: () => stopCalls.slice(),
    getCapturedOnLaunch: () => capturedOnLaunch,
  };
}

async function main() {
  await runTest("A/B/D/E. onLaunch starts scheduler while launch Promise pending", async () => {
    const logs = [];
    let startCount = 0;
    let resolveLaunch = null;
    const pending = new Promise((resolve) => {
      resolveLaunch = resolve;
    });
    let settled = false;
    pending.then(() => {
      settled = true;
    });

    const fake = createFakeBot({
      launchPromise: pending,
      onLaunchHook: (onLaunch) => {
        // Mimic Telegraf: invoke onLaunch immediately after "getMe",
        // while returned Promise remains pending.
        onLaunch();
      },
    });

    const fakeScheduler = {
      stop() {},
    };

    const runtime = startBotRuntime({
      bot: fake.bot,
      startScheduler: (telegram) => {
        startCount += 1;
        assert.strictEqual(telegram, fake.telegram);
        return fakeScheduler;
      },
      logFn: (...args) => logs.push(args.join(" ")),
    });

    await sleep(10);

    assert.strictEqual(fake.getLaunchCalls(), 1);
    assert.strictEqual(typeof fake.getCapturedOnLaunch(), "function");
    assert.strictEqual(settled, false, "launch Promise must stay pending");
    assert.strictEqual(startCount, 1);
    assert.strictEqual(runtime.isSchedulerStarted(), true);
    assert.strictEqual(runtime.getCommunityScheduler(), fakeScheduler);
    assert.ok(
      logs.some((line) => line.includes("🥭 ManGo Bot running...")),
      "running log expected"
    );

    // Cleanup: resolve to avoid dangling rejection handlers in other tests.
    resolveLaunch();
  });

  await runTest("F. scheduler starts exactly once even if onLaunch re-fired", async () => {
    let startCount = 0;
    const fake = createFakeBot({
      onLaunchHook: (onLaunch) => {
        onLaunch();
        onLaunch();
      },
    });

    const runtime = startBotRuntime({
      bot: fake.bot,
      startScheduler: () => {
        startCount += 1;
        return { stop() {} };
      },
      logFn: () => {},
    });

    assert.strictEqual(startCount, 1);
    assert.strictEqual(runtime.isSchedulerStarted(), true);
  });

  await runTest("C. .then() resolution is NOT required for scheduler start", async () => {
    let startCount = 0;
    const never = new Promise(() => {});
    const fake = createFakeBot({
      launchPromise: never,
      onLaunchHook: (onLaunch) => onLaunch(),
    });

    startBotRuntime({
      bot: fake.bot,
      startScheduler: () => {
        startCount += 1;
        return { stop() {} };
      },
      logFn: () => {},
    });

    await sleep(20);
    assert.strictEqual(startCount, 1);
    // never resolves — proving start does not depend on Promise settlement
  });

  await runTest("shutdown: stop(shutdown) then bot.stop; no second scheduler start", async () => {
    const stopReasons = [];
    let startCount = 0;
    let resolveLaunch = null;
    const pending = new Promise((resolve) => {
      resolveLaunch = resolve;
    });

    const fake = createFakeBot({
      launchPromise: pending,
      onLaunchHook: (onLaunch) => onLaunch(),
    });

    const runtime = startBotRuntime({
      bot: fake.bot,
      startScheduler: () => {
        startCount += 1;
        return {
          stop(reason) {
            stopReasons.push(reason);
          },
        };
      },
      logFn: () => {},
    });

    assert.strictEqual(startCount, 1);
    runtime.shutdown("SIGTERM");
    assert.deepStrictEqual(stopReasons, ["shutdown"]);
    assert.deepStrictEqual(fake.getStopCalls(), ["SIGTERM"]);

    // Simulate Telegraf resolving launch after polling stops.
    resolveLaunch();
    await sleep(20);
    assert.strictEqual(startCount, 1, "no scheduler start after bot.stop");
  });

  await runTest("launch reject before onLaunch: no scheduler, error path", async () => {
    let startCount = 0;
    const failures = [];
    const fake = createFakeBot({
      rejectLaunch: new Error("getMe failed"),
      onLaunchHook: () => {
        // intentionally do not call onLaunch — getMe failed first
      },
    });

    const runtime = startBotRuntime({
      bot: fake.bot,
      startScheduler: () => {
        startCount += 1;
        return { stop() {} };
      },
      logFn: () => {},
      onLaunchFailed: (err) => failures.push(err.message),
    });

    await sleep(20);
    assert.strictEqual(startCount, 0);
    assert.strictEqual(runtime.isSchedulerStarted(), false);
    assert.deepStrictEqual(failures, ["getMe failed"]);
  });

  await runTest("scheduler start throw: logged, no crash, no orphan if null returned", async () => {
    const logs = [];
    const fake = createFakeBot({
      onLaunchHook: (onLaunch) => onLaunch(),
    });

    const runtime = startBotRuntime({
      bot: fake.bot,
      startScheduler: () => {
        throw new Error("scheduler boom");
      },
      logFn: (...args) => logs.push(args.join(" ")),
    });

    assert.strictEqual(runtime.isSchedulerStarted(), true);
    assert.strictEqual(runtime.getCommunityScheduler(), null);
    assert.ok(
      logs.some((line) =>
        line.includes("[community-scheduler] Failed to start: scheduler boom")
      )
    );
    assert.doesNotThrow(() => runtime.shutdown("SIGINT"));
    assert.deepStrictEqual(fake.getStopCalls(), ["SIGINT"]);
  });

  await runTest("systemd stop regressie: real scheduler timer cleared, no restart after stop", async () => {
    const cfg = parseActivityEngineConfig(
      {},
      { enabled: true, twentyFourSeven: true, autoFightEnabled: false }
    );

    let resolveLaunch = null;
    const pending = new Promise((resolve) => {
      resolveLaunch = resolve;
    });
    const fake = createFakeBot({
      launchPromise: pending,
      onLaunchHook: (onLaunch) => onLaunch(),
    });

    let startCount = 0;
    const runtime = startBotRuntime({
      bot: fake.bot,
      startScheduler: () => {
        startCount += 1;
        const sched = createCommunityScheduler({
          enabled: false,
          chatId: "1",
          stateFile: stateFile(),
          tickMs: 40,
          probeDelayMs: 0,
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
        });
        // Mirror startCommunityScheduler(): create then start.
        sched.start();
        return sched;
      },
      logFn: () => {},
    });

    const sched = runtime.getCommunityScheduler();
    assert.ok(sched);
    assert.strictEqual(startCount, 1);
    assert.strictEqual(sched.isTimerRunning(), true);
    await sleep(90);
    assert.ok(sched.getTickCount() >= 1);

    runtime.shutdown("SIGTERM");
    assert.strictEqual(sched.isTimerRunning(), false);
    assert.strictEqual(sched.getDiagnostics().lastStopReason, "shutdown");
    assert.deepStrictEqual(fake.getStopCalls(), ["SIGTERM"]);

    const ticksAfterStop = sched.getTickCount();
    await sleep(80);
    assert.strictEqual(
      sched.getTickCount(),
      ticksAfterStop,
      "no pulses after timer cleared"
    );

    resolveLaunch();
    await sleep(20);
    assert.strictEqual(startCount, 1, "no second scheduler after launch resolves");
    assert.strictEqual(sched.isTimerRunning(), false);
  });

  await runTest("uses bot.launch(onLaunch) signature — first arg is function", async () => {
    let firstArgType = null;
    const bot = {
      telegram: {},
      launch(first) {
        firstArgType = typeof first;
        if (typeof first === "function") {
          first();
        }
        return new Promise(() => {});
      },
      stop() {},
    };

    startBotRuntime({
      bot,
      startScheduler: () => ({ stop() {} }),
      logFn: () => {},
    });

    assert.strictEqual(firstArgType, "function");
  });

  await runTest("index.js does not use launch().then for scheduler", () => {
    const indexSrc = fs.readFileSync(
      path.join(__dirname, "..", "index.js"),
      "utf8"
    );
    assert.ok(indexSrc.includes("startBotRuntime"));
    assert.ok(!/\.launch\s*\([^)]*\)\s*\.then\s*\(/.test(indexSrc));
    assert.ok(!/bot\s*\n\s*\.launch\s*\(\s*\)\s*\n\s*\.then/.test(indexSrc));
  });

  await runTest("telegraf 4.16.3 launch calls onLaunch before awaiting polling", () => {
    const telegrafSrc = fs.readFileSync(
      path.join(__dirname, "..", "node_modules", "telegraf", "lib", "telegraf.js"),
      "utf8"
    );
    const launchIdx = telegrafSrc.indexOf("async launch(");
    assert.ok(launchIdx > 0);
    const snippet = telegrafSrc.slice(launchIdx, launchIdx + 900);
    assert.ok(snippet.includes("onMe"));
    assert.ok(/onMe[\s\S]*startPolling/.test(snippet));
    const onMePos = snippet.indexOf("onMe");
    // Find the call site onMe?.() style after assignment of botInfo
    const callMatch = snippet.match(/onMe[\s\S]{0,40}\(\)/);
    assert.ok(callMatch, "onLaunch/onMe is invoked");
    const pollPos = snippet.indexOf("startPolling");
    assert.ok(pollPos > onMePos, "onLaunch runs before startPolling await");
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll bot-lifecycle tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
