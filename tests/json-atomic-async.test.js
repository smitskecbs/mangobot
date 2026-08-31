/**
 * Async atomic JSON write helper.
 * Run: node tests/json-atomic-async.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  writeJsonFileAtomic,
  writeJsonFileAtomicAsync,
} = require("../utils/json");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-json-async-"));

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function listTemps(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

(async () => {
  await runTest("async write matches sync formatting", async () => {
    const syncFile = path.join(tempDir, "sync.json");
    const asyncFile = path.join(tempDir, "async.json");
    const data = { users: { a: { points: 1 } } };
    writeJsonFileAtomic(syncFile, data);
    await writeJsonFileAtomicAsync(asyncFile, data);
    assert.strictEqual(
      fs.readFileSync(asyncFile, "utf8"),
      fs.readFileSync(syncFile, "utf8")
    );
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(asyncFile, "utf8")), data);
  });

  await runTest("geen temp files achter na succesvolle async write", async () => {
    const file = path.join(tempDir, "clean.json");
    await writeJsonFileAtomicAsync(file, { users: {} });
    assert.deepStrictEqual(listTemps(tempDir), []);
    assert.ok(fs.existsSync(file));
  });

  await runTest("rename failure laat bestaande JSON intact en ruimt temp op", async () => {
    const file = path.join(tempDir, "keep.json");
    const original = { users: { x: { points: 7 } } };
    writeJsonFileAtomic(file, original);

    const io = {
      writeFile: (...args) => fs.promises.writeFile(...args),
      open: (...args) => fs.promises.open(...args),
      rename: async () => {
        throw new Error("injected-rename-failure");
      },
      unlink: (...args) => fs.promises.unlink(...args),
    };

    await assert.rejects(
      () => writeJsonFileAtomicAsync(file, { users: { x: { points: 99 } } }, io),
      /injected-rename-failure/
    );
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
    assert.deepStrictEqual(listTemps(tempDir), []);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll json-atomic-async tests passed.");
})().catch((err) => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.error(err);
  process.exit(1);
});
