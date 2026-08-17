/**
 * Persistence / locking tests for points.json (atomic write + cross-process lock).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");
const lockfile = require("proper-lockfile");

const {
  loadPoints,
  savePoints,
  mutatePoints,
  awardDailyActivityPoint,
  awardTriggerPoints,
  resetWeeklyForAll,
  getEffectiveWeeklyPoints,
  POINTS_LOCK_OPTIONS,
} = require("../services/points");
const { writeJsonFileAtomic } = require("../utils/json");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-points-lock-test-"));
const testFile = path.join(tempDir, "points.json");
const workerPath = path.join(__dirname, "helpers", "points-lock-worker.js");

function resetFile(contents = { users: {} }) {
  fs.writeFileSync(testFile, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
}

function listTempArtifacts() {
  return fs
    .readdirSync(tempDir)
    .filter((name) => name.includes(".tmp-") || name.endsWith(".lock"));
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

runTest("awardDailyActivityPoint blijft werken", () => {
  const first = awardDailyActivityPoint(42, "Kevin", testFile);
  assert.strictEqual(first.awarded, true);
  assert.strictEqual(first.points, 1);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 1);
});

runTest("awardTriggerPoints blijft werken", () => {
  const result = awardTriggerPoints(42, "Kevin", "gmango", testFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 2);
  assert.strictEqual(loadPoints(testFile).users["42"].points, 2);
});

runTest("duplicate cooldown gedrag blijft", () => {
  assert.strictEqual(awardDailyActivityPoint(7, "Ada", testFile).awarded, true);
  assert.strictEqual(awardDailyActivityPoint(7, "Ada", testFile).awarded, false);
  assert.strictEqual(awardTriggerPoints(7, "Ada", "gm", testFile).awarded, true);
  assert.strictEqual(awardTriggerPoints(7, "Ada", "gm", testFile).awarded, false);
  assert.strictEqual(loadPoints(testFile).users["7"].points, 2);
});

runTest("weekly reset blijft", () => {
  awardTriggerPoints(42, "Kevin", "gmango", testFile);
  assert.strictEqual(loadPoints(testFile).users["42"].weeklyPoints, 2);

  resetWeeklyForAll(testFile);
  const user = loadPoints(testFile).users["42"];
  assert.strictEqual(user.weeklyPoints, 0);
  assert.strictEqual(getEffectiveWeeklyPoints(user), 0);
});

runTest("legacy records blijven werken", () => {
  resetFile({
    users: {
      "99": {
        points: 10,
        name: "Legacy",
      },
    },
  });

  const activity = awardDailyActivityPoint(99, "Legacy", testFile);
  assert.strictEqual(activity.awarded, true);
  const user = loadPoints(testFile).users["99"];
  assert.strictEqual(user.points, 11);
  assert.ok(user.weekId);
  assert.ok(user.activityDate);
  assert.strictEqual(typeof user.weeklyPoints, "number");
});

runTest("atomic write resulteert in valide JSON", () => {
  writeJsonFileAtomic(testFile, { users: { a: { points: 1 } } });
  const raw = fs.readFileSync(testFile, "utf8");
  const parsed = JSON.parse(raw);
  assert.deepStrictEqual(parsed, { users: { a: { points: 1 } } });
});

runTest("geen temp files achter na succesvolle write", () => {
  mutatePoints((data) => {
    data.users["1"] = {
      points: 3,
      weeklyPoints: 0,
      weekId: "2026-08-04",
      name: "T",
      triggerDate: null,
      triggersUsed: [],
      activityDate: null,
    };
  }, testFile);

  const leftovers = listTempArtifacts().filter((name) => name.includes(".tmp-"));
  assert.deepStrictEqual(leftovers, []);
  assert.ok(fs.existsSync(testFile));
});

runTest("lock wordt vrijgegeven na succesvolle mutation", () => {
  mutatePoints((data) => {
    data.users["1"] = { points: 1, weeklyPoints: 0, name: "T" };
  }, testFile);

  assert.strictEqual(
    lockfile.checkSync(testFile, { realpath: false, stale: POINTS_LOCK_OPTIONS.stale }),
    false
  );
});

runTest("lock wordt vrijgegeven na thrown mutation", () => {
  assert.throws(() => {
    mutatePoints(() => {
      throw new Error("boom-mutation");
    }, testFile);
  }, /boom-mutation/);

  assert.strictEqual(
    lockfile.checkSync(testFile, { realpath: false, stale: POINTS_LOCK_OPTIONS.stale }),
    false
  );
  assert.deepStrictEqual(
    listTempArtifacts().filter((name) => name.includes(".tmp-")),
    []
  );
});

runTest("twee gelijktijdige mutation workers verliezen geen updates", () => {
  resetFile({ users: {} });
  const iterations = 50;
  const coordinator = `
    const { spawn } = require('child_process');
    const path = require('path');
    const worker = ${JSON.stringify(workerPath)};
    const file = ${JSON.stringify(testFile)};
    const n = ${iterations};
    function run(id) {
      return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [worker, file, String(n), id], { stdio: 'inherit' });
        c.on('exit', (code) => code === 0 ? resolve() : reject(new Error('exit '+code+' id='+id)));
        c.on('error', reject);
      });
    }
    Promise.all([run('1'), run('1')]).then(() => process.exit(0)).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  `;

  const result = spawnSync(process.execPath, ["-e", coordinator], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const data = loadPoints(testFile);
  assert.strictEqual(data.users["1"].points, iterations * 2);
});

runTest("bestaand points bestand blijft leesbaar terwijl writers serialiseren", () => {
  resetFile({
    users: {
      "42": {
        points: 5,
        weeklyPoints: 1,
        weekId: new Date().toISOString().slice(0, 10),
        name: "Kevin",
        triggerDate: null,
        triggersUsed: [],
        activityDate: null,
      },
    },
  });

  const iterations = 20;
  // Reader samples only when the points lock is free so Windows cannot hold the
  // target open across a concurrent renameSync (EPERM). Snapshots are still
  // complete JSON produced by atomic writes under lock.
  const coordinator = `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const lockfile = require('proper-lockfile');
    const worker = ${JSON.stringify(workerPath)};
    const file = ${JSON.stringify(testFile)};
    const n = ${iterations};
    const stale = ${POINTS_LOCK_OPTIONS.stale};
    let readsOk = 0;
    let parseFailures = 0;

    function readCompleteSnapshot() {
      try {
        if (lockfile.checkSync(file, { realpath: false, stale })) {
          return;
        }
      } catch {
        return;
      }

      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        // Transient Windows timing only — never hide writer failures.
        if (err && (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'EACCES')) {
          return;
        }
        throw err;
      }

      try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || !data.users || typeof data.users !== 'object') {
          throw new Error('bad shape');
        }
        readsOk += 1;
      } catch (err) {
        parseFailures += 1;
        throw err;
      }
    }

    const reader = setInterval(readCompleteSnapshot, 15);

    function run(id) {
      return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [worker, file, String(n), id], { stdio: 'inherit' });
        c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('exit ' + code))));
        c.on('error', reject);
      });
    }

    Promise.all([run('7'), run('8')])
      .then(() => {
        clearInterval(reader);
        readCompleteSnapshot();
        if (readsOk < 3) {
          throw new Error('expected multiple successful reads, got ' + readsOk);
        }
        if (parseFailures !== 0) {
          throw new Error('unexpected parse failures: ' + parseFailures);
        }
        process.exit(0);
      })
      .catch((e) => {
        clearInterval(reader);
        console.error(e);
        process.exit(1);
      });
  `;

  const result = spawnSync(process.execPath, ["-e", coordinator], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const data = loadPoints(testFile);
  assert.strictEqual(data.users["42"].points, 5);
  assert.strictEqual(data.users["7"].points, iterations);
  assert.strictEqual(data.users["8"].points, iterations);

  assert.deepStrictEqual(
    listTempArtifacts().filter((name) => name.includes(".tmp-")),
    []
  );
  assert.strictEqual(
    lockfile.checkSync(testFile, {
      realpath: false,
      stale: POINTS_LOCK_OPTIONS.stale,
    }),
    false
  );
});

runTest("corrupt JSON is not overwritten; empty file can initialize", () => {
  fs.writeFileSync(testFile, "{not-json", "utf8");
  assert.deepStrictEqual(loadPoints(testFile), { users: {} });
  assert.throws(() => {
    mutatePoints((data) => {
      data.users["1"] = {
        points: 1,
        weeklyPoints: 1,
        weekId: "2026-08-04",
        name: "Repair",
        triggerDate: null,
        triggersUsed: [],
        activityDate: null,
      };
    }, testFile);
  }, /Failed to read points.json/);
  assert.strictEqual(fs.readFileSync(testFile, "utf8"), "{not-json");

  fs.writeFileSync(testFile, "   \n", "utf8");
  assert.deepStrictEqual(loadPoints(testFile), { users: {} });
  savePoints({ users: { "2": { points: 9, name: "Empty" } } }, testFile);
  assert.strictEqual(loadPoints(testFile).users["2"].points, 9);
});

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\nAll points-locking tests passed.");
