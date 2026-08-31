/**
 * Per-file async FIFO queue.
 * Run: node tests/async-file-queue.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  enqueueFileMutation,
  hasFileMutationQueue,
  countFileMutationQueues,
  resolveFileMutationQueueKey,
} = require("../utils/asyncFileQueue");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-async-queue-"));

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

(async () => {
  await runTest("FIFO op hetzelfde pad", async () => {
    const file = path.join(tempDir, "same.json");
    const order = [];
    let releaseA;
    const holdA = new Promise((resolve) => {
      releaseA = resolve;
    });

    const pA = enqueueFileMutation(file, async () => {
      order.push("a-start");
      await holdA;
      order.push("a-end");
      return "A";
    });
    const pB = enqueueFileMutation(file, async () => {
      order.push("b");
      return "B";
    });
    const pC = enqueueFileMutation(file, async () => {
      order.push("c");
      return "C";
    });

    await delay(20);
    assert.deepStrictEqual(order, ["a-start"]);
    releaseA();
    assert.deepStrictEqual(await Promise.all([pA, pB, pC]), ["A", "B", "C"]);
    assert.deepStrictEqual(order, ["a-start", "a-end", "b", "c"]);
  });

  await runTest("A reject breekt de queue niet; B/C draaien", async () => {
    const file = path.join(tempDir, "throw.json");
    const pA = enqueueFileMutation(file, async () => {
      throw new Error("boom-a");
    });
    const pB = enqueueFileMutation(file, async () => "B");
    const pC = enqueueFileMutation(file, async () => "C");

    await assert.rejects(pA, /boom-a/);
    assert.strictEqual(await pB, "B");
    assert.strictEqual(await pC, "C");
  });

  await runTest("verschillende files serialiseren elkaar niet", async () => {
    const fileA = path.join(tempDir, "a.json");
    const fileB = path.join(tempDir, "b.json");
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

    const pA = enqueueFileMutation(fileA, async () => {
      aStarted = true;
      await holdA;
      return "A";
    });
    const pB = enqueueFileMutation(fileB, async () => {
      bStarted = true;
      await holdB;
      return "B";
    });

    await delay(20);
    assert.strictEqual(aStarted, true);
    assert.strictEqual(bStarted, true);
    assert.notStrictEqual(
      resolveFileMutationQueueKey(fileA),
      resolveFileMutationQueueKey(fileB)
    );
    releaseA();
    releaseB();
    assert.strictEqual(await pA, "A");
    assert.strictEqual(await pB, "B");
  });

  await runTest("wachtend op disk blokkeert de event loop niet", async () => {
    const file = path.join(tempDir, "loop.json");
    let immediateRan = false;
    const p = enqueueFileMutation(file, async () => {
      await delay(40);
      return 1;
    });
    setImmediate(() => {
      immediateRan = true;
    });
    await delay(10);
    assert.strictEqual(immediateRan, true);
    assert.strictEqual(await p, 1);
  });

  await runTest("drained queue entry verdwijnt", async () => {
    const file = path.join(tempDir, "drain.json");
    await enqueueFileMutation(file, async () => 1);
    await flushMicrotasks();
    assert.strictEqual(hasFileMutationQueue(file), false);
  });

  await runTest("cleanup van A verwijdert queued B niet", async () => {
    const file = path.join(tempDir, "race.json");
    let releaseA;
    let releaseB;
    const holdA = new Promise((resolve) => {
      releaseA = resolve;
    });
    const holdB = new Promise((resolve) => {
      releaseB = resolve;
    });

    const pA = enqueueFileMutation(file, async () => {
      await holdA;
      return "A";
    });
    await delay(5);
    const pB = enqueueFileMutation(file, async () => {
      await holdB;
      return "B";
    });
    assert.strictEqual(hasFileMutationQueue(file), true);

    releaseA();
    await pA;
    await flushMicrotasks();
    assert.strictEqual(hasFileMutationQueue(file), true);

    releaseB();
    assert.strictEqual(await pB, "B");
    await flushMicrotasks();
    assert.strictEqual(hasFileMutationQueue(file), false);
    assert.ok(countFileMutationQueues() >= 0);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll async-file-queue tests passed.");
})().catch((err) => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.error(err);
  process.exit(1);
});
