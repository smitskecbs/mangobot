/**
 * Two-process wallet-links store: bot process vs API process, shared file.
 * Run: node tests/wallet-cross-process.test.js
 *
 * This is the production architecture:
 *   mangobot.service writes tokens
 *   mango-highscore.service challenges against the same wallet-links.json
 *   without restarting.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { spawn } = require("child_process");
const { encodeBase58 } = require("../utils/base58");

const WORKER = path.join(__dirname, "..", "scripts", "wallet-store-worker.js");
const ROUNDS = 10;
const RPC_TIMEOUT_MS = 20_000;

function generateSolanaAddress() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  return encodeBase58(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
}

function spawnWorker(file) {
  const env = { ...process.env, WALLET_LINKS_FILE: file };
  delete env.MANGO_FORCE_TEST_WALLET_LINKS;

  const child = spawn(process.execPath, [WORKER], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  const queue = [];
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === "ready") {
        readyResolve(msg);
        continue;
      }
      const waiter = queue.shift();
      if (waiter) {
        waiter.resolve(msg);
      }
    }
  });
  child.on("error", (err) => {
    readyReject(err);
    for (const waiter of queue.splice(0)) {
      waiter.reject(err);
    }
  });
  child.on("exit", (code, signal) => {
    const err = new Error(
      `wallet worker exited code=${code} signal=${signal} stderr=${stderrBuf}`
    );
    readyReject(err);
    for (const waiter of queue.splice(0)) {
      waiter.reject(err);
    }
  });

  function rpc(payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`rpc timeout op=${payload.op} stderr=${stderrBuf}`));
      }, RPC_TIMEOUT_MS);
      queue.push({
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async function stop() {
    try {
      child.stdin.write(`${JSON.stringify({ op: "quit" })}\n`);
    } catch {
      // ignore
    }
    child.kill();
  }

  return { child, ready, rpc, stop, stderr: () => stderrBuf };
}

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✓ ${name}`);
    })
    .catch((err) => {
      console.error(`✗ ${name}`);
      throw err;
    });
}

async function withWorkers(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-xproc-"));
  const file = path.join(dir, "wallet-links.json");
  fs.writeFileSync(file, JSON.stringify({
    users: {},
    wallets: {},
    linkTokens: {},
    challenges: {},
  }, null, 2));

  const api = spawnWorker(file);
  const bot = spawnWorker(file);
  try {
    const apiReady = await api.ready;
    const botReady = await bot.ready;
    assert.strictEqual(apiReady.file, file, `API resolved ${apiReady.file}`);
    assert.strictEqual(botReady.file, file, `bot resolved ${botReady.file}`);
    assert.notStrictEqual(apiReady.pid, botReady.pid);
    await fn({ api, bot, file });
  } finally {
    await Promise.allSettled([api.stop(), bot.stop()]);
  }
}

async function liveShapedRound(round) {
  await withWorkers(async ({ api, bot, file }) => {
    const warm = await api.rpc({ op: "warmup" });
    assert.strictEqual(warm.ok, true, warm.error);
    assert.strictEqual(warm.linkTokens, 0, `round ${round} API warmup saw tokens`);

    const created = await bot.rpc({ op: "createLink", uid: String(8000 + round) });
    assert.strictEqual(created.ok, true, created.error);
    assert.ok(created.token);

    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(disk.linkTokens[created.tokenHash], `round ${round} disk missing hash`);

    const wallet = generateSolanaAddress();
    const challenge = await api.rpc({
      op: "challenge",
      token: created.token,
      wallet,
    });
    assert.strictEqual(
      challenge.ok,
      true,
      `round ${round} API missed bot token: ${challenge.error}`
    );
    assert.ok(challenge.challengeId);
  });
}

async function reverseVisibilityRound(round) {
  await withWorkers(async ({ api, bot }) => {
    const created = await bot.rpc({ op: "createLink", uid: String(9000 + round) });
    assert.strictEqual(created.ok, true, created.error);
    const wallet = generateSolanaAddress();
    const challenge = await api.rpc({
      op: "challenge",
      token: created.token,
      wallet,
    });
    assert.strictEqual(challenge.ok, true, challenge.error);

    const botView = await bot.rpc({ op: "load" });
    assert.strictEqual(botView.ok, true, botView.error);
    assert.ok(
      botView.challengeIds.includes(challenge.challengeId),
      `round ${round} bot missed API challenge write`
    );
    assert.ok(botView.tokenHashes.includes(created.tokenHash));
  });
}

(async () => {
  await runTest(`live-shaped API-first then bot token x${ROUNDS}`, async () => {
    for (let i = 1; i <= ROUNDS; i += 1) {
      await liveShapedRound(i);
    }
  });

  await runTest(`API challenge write visible to bot x${ROUNDS}`, async () => {
    for (let i = 1; i <= ROUNDS; i += 1) {
      await reverseVisibilityRound(i);
    }
  });

  await runTest("lock init does not clobber a bot write", async () => {
    await withWorkers(async ({ api, bot, file }) => {
      await api.rpc({ op: "warmup" });
      const created = await bot.rpc({ op: "createLink", uid: "42" });
      const before = fs.readFileSync(file, "utf8");
      assert.ok(before.includes(created.tokenHash));
      const again = await api.rpc({ op: "warmup" });
      assert.strictEqual(again.ok, true);
      const after = fs.readFileSync(file, "utf8");
      assert.ok(after.includes(created.tokenHash));
      const loaded = await api.rpc({ op: "load" });
      assert.ok(loaded.tokenHashes.includes(created.tokenHash));
    });
  });

  console.log("wallet-cross-process tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
