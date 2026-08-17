/**
 * Production-stability helpers: crash guards, health, timeouts, cleanup.
 * Run: node tests/stability.test.js
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
const { getPresaleConfig } = require("../services/presaleConfig");
const { rpcCall } = require("../services/presaleRpc");
const { notifyWalletVerified } = require("../services/walletVerifiedNotify");
const {
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { pruneExpired, mutateWalletStore, readWalletSnapshot } = require("../services/walletLinks");
const { mutatePoints, loadPoints } = require("../services/points");
const { mutateRewardsStore } = require("../services/memberRewards");
const {
  buildApiHealthPayload,
  probeWalletStoreAccessible,
} = require("../services/apiHealth");
const { fetchWithTimeout } = require("../utils/safeFetch");
const { pruneTimestampMap } = require("../utils/boundedMap");
const { installProcessGuards, safeErrorMeta } = require("../utils/processGuards");
const {
  noteRuntimeEvent,
  classifyRuntimeHealth,
  resetRuntimeHealthForTests,
} = require("../utils/runtimeHealth");
const { pruneExpiredSessions } = require("../services/presaleSessions");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-stability-"));
let n = 0;
function tmp(name) {
  n += 1;
  return path.join(tempDir, `${name}-${n}`);
}

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch((err) => {
      console.error(`✗ ${name}`);
      throw err;
    });
}

function engineCfg() {
  return parseActivityEngineConfig(
    {},
    { enabled: true, twentyFourSeven: true, autoFightEnabled: false }
  );
}

function disabledFight() {
  return {
    enabled: false,
    intervalMinutes: 120,
    chancePercent: 0,
    slots: [],
    types: [],
    startHour: 9,
    endHour: 22,
    minActivityGapMs: 0,
  };
}

async function main() {
  await runTest("uncaught async scheduler action → scheduler lives", async () => {
    let ticks = 0;
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: "1",
      timeZone: "UTC",
      stateFile: tmp("state.json"),
      weeklyWinnersFile: tmp("ww.json"),
      pointsFile: tmp("points.json"),
      tickMs: 20,
      activityEngineConfig: engineCfg(),
      autoChatFightConfig: disabledFight(),
      sendMessage: async () => {
        ticks += 1;
        if (ticks === 1) {
          throw new Error("async boom");
        }
        return true;
      },
      processActivitySlot: async () => {
        throw new Error("engine boom");
      },
    });
    sched.start();
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(sched.isTimerRunning(), true);
    assert.ok(sched.getTickCount() >= 2);
    sched.stop();
    assert.strictEqual(sched.isTimerRunning(), false);
  });

  await runTest("send failure → next tick works", async () => {
    let calls = 0;
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "UTC",
      stateFile: tmp("state.json"),
      weeklyWinnersFile: tmp("ww.json"),
      pointsFile: tmp("points.json"),
      tickMs: 15,
      now: () => new Date(Date.UTC(2026, 7, 12, 9, 0, 1)),
      activityEngineConfig: parseActivityEngineConfig({}, { enabled: false }),
      autoChatFightConfig: disabledFight(),
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("send down");
        }
        return true;
      },
    });
    sched.setLastChecked(new Date(Date.UTC(2026, 7, 12, 8, 59, 0)));
    sched.start();
    await new Promise((r) => setTimeout(r, 70));
    assert.ok(sched.getTickCount() >= 2);
    sched.stop();
  });

  await runTest("duplicate scheduler start → one timer", () => {
    let created = 0;
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: "1",
      stateFile: tmp("state.json"),
      weeklyWinnersFile: tmp("ww.json"),
      pointsFile: tmp("points.json"),
      tickMs: 60_000,
      activityEngineConfig: engineCfg(),
      autoChatFightConfig: disabledFight(),
      sendMessage: async () => true,
      setIntervalFn: () => {
        created += 1;
        return { unref() {}, hasRef: () => true };
      },
      clearIntervalFn: () => {},
    });
    sched.start();
    sched.start();
    assert.strictEqual(created, 1);
    sched.stop();
  });

  await runTest("stop clears timer", () => {
    let cleared = 0;
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: "1",
      stateFile: tmp("state.json"),
      weeklyWinnersFile: tmp("ww.json"),
      pointsFile: tmp("points.json"),
      tickMs: 60_000,
      activityEngineConfig: engineCfg(),
      autoChatFightConfig: disabledFight(),
      sendMessage: async () => true,
      setIntervalFn: () => ({ id: 1, hasRef: () => true }),
      clearIntervalFn: () => {
        cleared += 1;
      },
    });
    sched.start();
    sched.stop("test");
    assert.strictEqual(cleared, 1);
    assert.strictEqual(sched.isTimerRunning(), false);
  });

  await runTest("SIGTERM shutdown path", () => {
    const stops = [];
    const fake = {
      telegram: {},
      launch(cb) {
        if (typeof cb === "function") cb();
        return new Promise(() => {});
      },
      stop(signal) {
        stops.push(signal);
      },
    };
    const runtime = startBotRuntime({
      bot: fake,
      startScheduler: () => ({
        stop(reason) {
          stops.push(reason);
        },
      }),
      logFn: () => {},
    });
    runtime.shutdown("SIGTERM");
    assert.ok(stops.includes("shutdown"));
    assert.ok(stops.includes("SIGTERM"));
  });

  await runTest("optional presale config missing → startup ok", () => {
    const cfg = getPresaleConfig({});
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.live, false);
    assert.ok(cfg.blockedReasons.includes("disabled"));
  });

  await runTest("wallet store temporarily inaccessible → controlled failure", () => {
    const file = tmp("wallet.json");
    fs.writeFileSync(file, "{not-json", "utf8");
    assert.strictEqual(probeWalletStoreAccessible(file), false);
    assert.throws(() => {
      mutateWalletStore(() => undefined, file);
    }, /Failed to read wallet-links.json/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{not-json");
  });

  await runTest("corrupt store → no silent overwrite", () => {
    const points = tmp("points.json");
    fs.writeFileSync(points, "{not-json", "utf8");
    assert.throws(() => mutatePoints(() => undefined, points), /points.json/);
    assert.strictEqual(fs.readFileSync(points, "utf8"), "{not-json");
    assert.deepStrictEqual(loadPoints(points), { users: {} });

    const rewards = tmp("rewards.json");
    fs.writeFileSync(rewards, "{not-json", "utf8");
    assert.throws(() => mutateRewardsStore(() => undefined, rewards), /member-rewards/);
    assert.strictEqual(fs.readFileSync(rewards, "utf8"), "{not-json");
  });

  await runTest("health endpoint payload is safe", () => {
    resetRuntimeHealthForTests();
    process.env.BOT_TOKEN = process.env.BOT_TOKEN || "secret-token-value";
    const payload = buildApiHealthPayload({
      env: { PRESALE_ENABLED: "false" },
      walletStoreAccessible: true,
    });
    assert.strictEqual(payload.presaleEnabled, false);
    assert.strictEqual(typeof payload.uptimeSeconds, "number");
    assert.strictEqual(payload.walletStoreAccessible, true);
    const raw = JSON.stringify(payload);
    assert.ok(!raw.includes("secret-token-value"));
    assert.ok(!raw.includes("BOT_TOKEN"));
    assert.ok(!raw.includes("PRESALE_TREASURY"));
    assert.ok(!/telegramUserId/.test(raw));
  });

  await runTest("health contains no secrets", () => {
    const payload = buildApiHealthPayload({
      env: {
        PRESALE_ENABLED: "false",
        PRESALE_TREASURY_WALLET: "9".repeat(32) + "11111111",
        BOT_TOKEN: "123:secret",
      },
      walletStoreAccessible: true,
    });
    const raw = JSON.stringify(payload);
    assert.ok(!raw.includes("123:secret"));
    assert.ok(!raw.includes("PRESALE_TREASURY_WALLET"));
    assert.strictEqual(payload.presaleEnabled, false);
  });

  await runTest("rate limiter cleanup", () => {
    const limiter = createMemoryRateLimiter({ maxKeys: 20 });
    const now = 1_000_000;
    for (let i = 0; i < 50; i += 1) {
      limiter.hitChallenge(`k${i}`, now);
    }
    assert.ok(limiter.size() <= 20);
    limiter.prune(now + 11 * 60 * 1000);
    assert.strictEqual(limiter.size(), 0);
  });

  await runTest("session cleanup", () => {
    const store = {
      sessions: {
        a: { expiresAt: 1 },
        b: { expiresAt: Date.now() + 60_000 },
      },
      orders: {},
    };
    pruneExpiredSessions(store, Date.now() + 1000);
    assert.ok(!store.sessions.a);
    assert.ok(store.sessions.b);

    const walletStore = {
      linkTokens: { x: { expiresAt: 1 } },
      challenges: { y: { expiresAt: Date.now() + 60_000 } },
    };
    pruneExpired(walletStore, Date.now());
    assert.ok(!walletStore.linkTokens.x);
    assert.ok(walletStore.challenges.y);
  });

  await runTest("API timeout behavior", async () => {
    await assert.rejects(
      () =>
        fetchWithTimeout("https://example.invalid", {
          timeoutMs: 20,
          fetchImpl: () => new Promise(() => {}),
        }),
      /request-timeout/
    );
    const rpc = await rpcCall("getHealth", [], {
      rpcUrl: "https://example.invalid",
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}),
    });
    assert.strictEqual(rpc.ok, false);
    assert.strictEqual(rpc.reason, "rpc-timeout");
  });

  await runTest("Telegram notify timeout behavior", async () => {
    const result = await notifyWalletVerified(
      { telegramUserId: "1", wallet: "So11111111111111111111111111111111111111112" },
      {
        botToken: "123:test",
        fetchImpl: () => new Promise(() => {}),
        timeoutMs: 25,
      }
    );
    assert.strictEqual(result.sent, false);
  });

  await runTest("timestamp map prune bounds keys", () => {
    const map = new Map();
    const now = 50_000;
    for (let i = 0; i < 10; i += 1) {
      map.set(`ip${i}`, now - 40_000);
    }
    map.set("fresh", now);
    pruneTimestampMap(map, now, 10_000, 3);
    assert.ok(map.size <= 3);
    assert.ok(map.has("fresh"));
  });

  await runTest("fatal guards log then exit without swallowing", () => {
    const exits = [];
    const logs = [];
    const originalEx = process.listeners("uncaughtException").slice();
    const originalRej = process.listeners("unhandledRejection").slice();
    const guards = installProcessGuards({
      name: "test",
      logError: (...args) => logs.push(args.join(" ")),
      shutdown: () => logs.push("shutdown"),
      exit: (code) => exits.push(code),
    });
    guards.crash("uncaughtException", { name: "TypeError", code: "ERR" });
    assert.deepStrictEqual(exits, [1]);
    assert.ok(logs.some((line) => line.includes("[crash]")));
    assert.ok(logs.includes("shutdown"));
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    for (const listener of originalEx) {
      process.on("uncaughtException", listener);
    }
    for (const listener of originalRej) {
      process.on("unhandledRejection", listener);
    }
  });

  await runTest("runtime health criteria", () => {
    resetRuntimeHealthForTests(0);
    noteRuntimeEvent("schedulerWanted", { wanted: true });
    assert.strictEqual(classifyRuntimeHealth(30_000), "degraded");
    noteRuntimeEvent("schedulerTickOk", { at: 60_000 });
    assert.strictEqual(classifyRuntimeHealth(70_000), "healthy");
    assert.strictEqual(classifyRuntimeHealth(60_000 + 4 * 60 * 1000), "degraded");
    assert.strictEqual(classifyRuntimeHealth(60_000 + 11 * 60 * 1000), "unhealthy");
  });

  await runTest("no test touches production JSON", () => {
    const roots = [
      path.join(__dirname, "..", "points.json"),
      path.join(__dirname, "..", "data", "wallet-links.json"),
      path.join(__dirname, "..", "data", "weekly-winners.json"),
      path.join(__dirname, "..", "data", "community-scheduler.json"),
      path.join(__dirname, "..", "data", "member-rewards.json"),
      path.join(__dirname, "..", "data", "presale-participation.json"),
    ];
    for (const file of roots) {
      if (!fs.existsSync(file)) {
        continue;
      }
      const before = fs.statSync(file).mtimeMs;
      loadPoints(tmp("points-ro.json"));
      readWalletSnapshot(tmp("missing-wallet.json"), { strict: false });
      assert.strictEqual(fs.statSync(file).mtimeMs, before);
    }
  });

  await runTest("safeErrorMeta never includes token-like values", () => {
    const meta = safeErrorMeta({
      name: "Error",
      code: "ETIMEDOUT",
      message: "bot123:ABCDEF failed",
    });
    assert.deepStrictEqual(meta, { name: "Error", code: "ETIMEDOUT" });
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll stability tests passed.");
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
