/**
 * mutatePointsAsync infrastructure (production still uses mutatePoints).
 * Run: node tests/points-async.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawn } = require("child_process");
const lockfile = require("proper-lockfile");

const {
  loadPoints,
  mutatePoints,
  mutatePointsAsync,
  POINTS_LOCK_OPTIONS,
  POINTS_LOCK_ASYNC_OPTIONS,
} = require("../services/points");
const { writeJsonFileAtomicAsync } = require("../utils/json");
const { hasFileMutationQueue } = require("../utils/asyncFileQueue");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-points-async-"));
const holderPath = path.join(__dirname, "helpers", "points-lock-holder.js");

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function emptyUsers() {
  return { users: {} };
}

function writeFile(file, contents = emptyUsers()) {
  fs.writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
}

function bumpUser(data, userId, amount = 1) {
  const id = String(userId);
  if (!data.users[id]) {
    data.users[id] = {
      points: 0,
      weeklyPoints: 0,
      weekId: "2026-08-04",
      name: "T",
      triggerDate: null,
      triggersUsed: [],
      activityDate: null,
    };
  }
  data.users[id].points += amount;
  data.users[id].weeklyPoints += amount;
  return data.users[id].points;
}

function waitUntil(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 10);
  });
}

(async () => {
  await runTest("normale mutation persist", async () => {
    const file = path.join(tempDir, "normal.json");
    writeFile(file);
    const result = await mutatePointsAsync((data) => bumpUser(data, "42"), file);
    assert.strictEqual(result, 1);
    assert.strictEqual(loadPoints(file).users["42"].points, 1);
  });

  await runTest("20 concurrent mutations blijven allemaal behouden", async () => {
    const file = path.join(tempDir, "concurrent.json");
    writeFile(file);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        mutatePointsAsync((data) => bumpUser(data, "1"), file)
      )
    );
    assert.strictEqual(loadPoints(file).users["1"].points, 20);
  });

  await runTest("twee users concurrent blijven beide behouden", async () => {
    const file = path.join(tempDir, "two-users.json");
    writeFile(file);
    await Promise.all([
      mutatePointsAsync((data) => bumpUser(data, "a", 3), file),
      mutatePointsAsync((data) => bumpUser(data, "b", 5), file),
    ]);
    const users = loadPoints(file).users;
    assert.strictEqual(users.a.points, 3);
    assert.strictEqual(users.b.points, 5);
  });

  await runTest("A throw: A rejects, B/C draaien daarna", async () => {
    const file = path.join(tempDir, "throw.json");
    writeFile(file);
    const pA = mutatePointsAsync(() => {
      throw new Error("boom-mutation");
    }, file);
    const pB = mutatePointsAsync((data) => bumpUser(data, "2"), file);
    const pC = mutatePointsAsync((data) => bumpUser(data, "3"), file);
    await assert.rejects(pA, /boom-mutation/);
    assert.strictEqual(await pB, 1);
    assert.strictEqual(await pC, 1);
    const users = loadPoints(file).users;
    assert.strictEqual(users["2"].points, 1);
    assert.strictEqual(users["3"].points, 1);
    assert.strictEqual(
      lockfile.checkSync(file, {
        realpath: false,
        stale: POINTS_LOCK_OPTIONS.stale,
      }),
      false
    );
  });

  await runTest("mutator throw vóór write laat origineel intact", async () => {
    const file = path.join(tempDir, "unchanged.json");
    const original = { users: { keep: { points: 11, name: "Keep" } } };
    writeFile(file, original);
    await assert.rejects(
      () =>
        mutatePointsAsync((data) => {
          data.users.keep.points = 0;
          throw new Error("no-write");
        }, file),
      /no-write/
    );
    assert.strictEqual(loadPoints(file).users.keep.points, 11);
  });

  await runTest("async atomic write failure laat valid JSON intact", async () => {
    const file = path.join(tempDir, "write-fail.json");
    writeFile(file, { users: { x: { points: 7, name: "X" } } });
    await assert.rejects(
      () =>
        mutatePointsAsync(
          (data) => {
            data.users.x.points = 99;
            return 99;
          },
          file,
          {
            writeJsonFileAtomicAsync: async () => {
              throw new Error("disk-full");
            },
          }
        ),
      /Failed to write points.json: disk-full/
    );
    assert.strictEqual(loadPoints(file).users.x.points, 7);
  });

  await runTest("thenable mutator wordt geweigerd; file unchanged", async () => {
    const file = path.join(tempDir, "thenable.json");
    writeFile(file, { users: { z: { points: 4, name: "Z" } } });
    await assert.rejects(
      () => mutatePointsAsync(async () => 1, file),
      /mutator must be synchronous/
    );
    assert.strictEqual(loadPoints(file).users.z.points, 4);
  });

  await runTest("queue entry verdwijnt na drain", async () => {
    const file = path.join(tempDir, "drain.json");
    writeFile(file);
    await mutatePointsAsync((data) => bumpUser(data, "9"), file);
    await flushMicrotasks();
    assert.strictEqual(hasFileMutationQueue(file), false);
  });

  await runTest("verschillende points files serialiseren elkaar niet", async () => {
    const fileA = path.join(tempDir, "file-a.json");
    const fileB = path.join(tempDir, "file-b.json");
    writeFile(fileA);
    writeFile(fileB);
    let aStarted = false;
    let bStarted = false;
    let releaseA;
    let releaseB;
    const holdA = new Promise((resolve) => {
      releaseA = resolve;
    });
    const holdB = new Promise((resolve) => {
      releaseB = resolve;
    });

    const pA = mutatePointsAsync(
      (data) => bumpUser(data, "a"),
      fileA,
      {
        writeJsonFileAtomicAsync: async (fp, data) => {
          aStarted = true;
          await holdA;
          return writeJsonFileAtomicAsync(fp, data);
        },
      }
    );
    const pB = mutatePointsAsync(
      (data) => bumpUser(data, "b"),
      fileB,
      {
        writeJsonFileAtomicAsync: async (fp, data) => {
          bStarted = true;
          await holdB;
          return writeJsonFileAtomicAsync(fp, data);
        },
      }
    );

    await delay(30);
    assert.strictEqual(aStarted, true);
    assert.strictEqual(bStarted, true);
    releaseA();
    releaseB();
    await Promise.all([pA, pB]);
    assert.strictEqual(loadPoints(fileA).users.a.points, 1);
    assert.strictEqual(loadPoints(fileB).users.b.points, 1);
  });

  await runTest("async write wait laat de event loop vrij", async () => {
    const file = path.join(tempDir, "event-loop.json");
    writeFile(file);
    let immediateRan = false;
    const p = mutatePointsAsync(
      (data) => bumpUser(data, "loop"),
      file,
      {
        writeJsonFileAtomicAsync: async (fp, data) => {
          await delay(50);
          return writeJsonFileAtomicAsync(fp, data);
        },
      }
    );
    setImmediate(() => {
      immediateRan = true;
    });
    await delay(15);
    assert.strictEqual(immediateRan, true);
    await p;
    assert.strictEqual(loadPoints(file).users.loop.points, 1);
  });

  await runTest("corrupt JSON fail-closed; file niet overschreven", async () => {
    const file = path.join(tempDir, "corrupt.json");
    fs.writeFileSync(file, "{not-json", "utf8");
    await assert.rejects(
      () => mutatePointsAsync((data) => bumpUser(data, "1"), file),
      /Failed to read points.json/
    );
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{not-json");
  });

  await runTest("async lock retries zijn geconfigureerd zonder Atomics.wait", async () => {
    assert.strictEqual(POINTS_LOCK_ASYNC_OPTIONS.stale, 10_000);
    assert.strictEqual(POINTS_LOCK_ASYNC_OPTIONS.realpath, false);
    assert.strictEqual(POINTS_LOCK_ASYNC_OPTIONS.retries.retries, 100);
    assert.strictEqual(POINTS_LOCK_ASYNC_OPTIONS.retries.minTimeout, 20);
    assert.strictEqual(POINTS_LOCK_ASYNC_OPTIONS.retries.maxTimeout, 500);
    assert.strictEqual(POINTS_LOCK_ASYNC_OPTIONS.retries.factor, 1.5);
    const src = fs.readFileSync(path.join(__dirname, "..", "services", "points.js"), "utf8");
    const asyncFn = src.slice(
      src.indexOf("async function acquirePointsLockAsync"),
      src.indexOf("function getTodayDate")
    );
    assert.ok(!asyncFn.includes("Atomics.wait"));
    assert.ok(!asyncFn.includes("lockSync"));
    assert.ok(asyncFn.includes("lockfile.lock("));
  });

  await runTest("cross-process lock: B wacht async, event loop vrij, geen lost update", async () => {
    const file = path.join(tempDir, "cross-process.json");
    writeFile(file);
    mutatePoints((data) => bumpUser(data, "1", 2), file);

    const child = spawn(process.execPath, [holderPath, file, "400"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    try {
      await waitUntil(() => stdout.includes("LOCKED"), 5000, "LOCKED");
      let immediateRan = false;
      const p = mutatePointsAsync((data) => bumpUser(data, "1", 3), file);
      setImmediate(() => {
        immediateRan = true;
      });
      await delay(20);
      assert.strictEqual(immediateRan, true);
      await p;
      await waitUntil(
        () => stdout.includes("RELEASED") || child.exitCode === 0,
        5000,
        "RELEASED"
      );
    } finally {
      if (child.exitCode == null && !child.killed) {
        child.kill();
      }
    }
    if (stderr) {
      throw new Error(stderr);
    }
    assert.strictEqual(loadPoints(file).users["1"].points, 5);
    assert.strictEqual(
      lockfile.checkSync(file, {
        realpath: false,
        stale: POINTS_LOCK_OPTIONS.stale,
      }),
      false
    );
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll points-async tests passed.");
})().catch((err) => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.error(err);
  process.exit(1);
});
