/**
 * Presale reservation accounting, expiry, races, exact payment.
 * Run: node tests/presale-reservation.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { spawn } = require("child_process");
const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  HARD_CAP_LAMPORTS,
  MIN_CONTRIBUTION_LAMPORTS,
  MAX_WALLET_LAMPORTS,
  RESERVATION_TTL_MS,
  mangoBaseUnitsFromLamports,
  MEMO_PREFIX,
  SYSTEM_PROGRAM_ID,
  MEMO_PROGRAM_ID,
} = require("../services/presaleConstants");
const { setPresaleFileForTests, loadPresaleStore } = require("../services/presaleStore");
const { createPresaleSession } = require("../services/presaleSessions");
  const {
    preparePresalePayment,
    issuePresalePayment,
    confirmPresalePayment,
    reconcilePresalePayment,
    reconcilePresaleOrder,
    reconcileExpiredPresaleOrders,
    getPresaleStatus,
    reservationInvariant,
  } = require("../services/presaleLedger");
const { verifyPresaleTransaction } = require("../services/presaleVerify");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");

const TEST_BLOCKHASH = "TestPresaleBlockhash11111111111111111";
const LAST_VALID = 2000;
const HEIGHT_VALID = 1000;
const HEIGHT_EXPIRED = LAST_VALID + 1;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-presale-res-"));
const prodPresale = path.resolve(__dirname, "..", "data", "presale-participation.json");
const WORKER = path.join(__dirname, "helpers", "presale-prepare-worker.js");
const RECONCILE_WORKER = path.join(__dirname, "helpers", "presale-reconcile-worker.js");
let n = 0;
const pending = [];

function runTest(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    pending.push(
      result.then(
        () => console.log(`✓ ${name}`),
        (err) => {
          console.error(`✗ ${name}`);
          throw err;
        }
      )
    );
    return;
  }
  console.log(`✓ ${name}`);
}

function files() {
  n += 1;
  return {
    walletFile: path.join(tempDir, `w-${n}.json`),
    presaleFile: path.join(tempDir, `p-${n}.json`),
  };
}

function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    address: encodeBase58(publicKeyRaw),
    sign(message) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      return signEd25519Detached(buf, privateKey);
    },
  };
}

function liveEnv(treasury) {
  return {
    PRESALE_ENABLED: "true",
    PRESALE_TREASURY_WALLET: treasury,
    PRESALE_RPC_URL: "https://rpc.test.invalid",
  };
}

function connectUser(walletFile, userId, wallet, now) {
  const limiter = createMemoryRateLimiter();
  const created = createLinkToken(userId, { walletFile, now });
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile, now: now + 1, rateLimiter: limiter }
  );
  const verified = verifyWalletSignature(
    {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    },
    { walletFile, now: now + 2, rateLimiter: limiter }
  );
  assert.strictEqual(verified.ok, true, verified.error);
}

function fakeSig() {
  return encodeBase58(crypto.randomBytes(64)).slice(0, 88);
}

function withPaymentRpc(options, height = HEIGHT_VALID, lastValid = LAST_VALID, blockhash = TEST_BLOCKHASH) {
  return {
    ...options,
    currentBlockHeight: height,
    getLatestBlockhashImpl: async () => ({
      ok: true,
      blockhash,
      lastValidBlockHeight: lastValid,
    }),
  };
}

function emptyTreasury(options = {}) {
  return {
    ...options,
    getSignaturesForAddressImpl: async () => ({ ok: true, result: [] }),
  };
}

function treasuryHistory(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const bySig = new Map(list.map((item) => [item.signature, item]));
  return {
    ...options,
    getSignaturesForAddressImpl: async () => ({
      ok: true,
      result: list.map((item) => ({
        signature: item.signature,
        err: item.err === undefined ? null : item.err,
        blockTime: item.blockTime,
        memo: item.memo,
        slot: item.slot || 1,
      })),
    }),
    getTransactionImpl:
      typeof options.getTransactionImpl === "function"
        ? options.getTransactionImpl
        : async (signature) => {
            const found = bySig.get(signature);
            if (!found) {
              return { ok: true, result: null };
            }
            if (found.rpcFail) {
              return { ok: false, reason: found.rpcFail };
            }
            return { ok: true, result: found.tx || null };
          },
  };
}

function mockTx({
  from,
  to,
  lamports,
  memo,
  signature,
  blockTime,
  err = null,
  extraDest,
  extraTransfers = [],
  recentBlockhash = TEST_BLOCKHASH,
}) {
  const transfers = [
    {
      program: "system",
      programId: SYSTEM_PROGRAM_ID,
      parsed: {
        type: "transfer",
        info: {
          source: from,
          destination: extraDest || to,
          lamports: Number(lamports),
        },
      },
    },
  ];
  for (const extra of extraTransfers) {
    transfers.push({
      program: "system",
      programId: SYSTEM_PROGRAM_ID,
      parsed: {
        type: "transfer",
        info: {
          source: extra.from || from,
          destination: extra.to || to,
          lamports: Number(extra.lamports),
        },
      },
    });
  }
  return {
    blockTime,
    meta: { err },
    transaction: {
      signatures: [signature],
      message: {
        recentBlockhash,
        accountKeys: [{ pubkey: from, signer: true }, { pubkey: extraDest || to }],
        instructions: [
          ...transfers,
          {
            program: "spl-memo",
            programId: MEMO_PROGRAM_ID,
            parsed: memo,
          },
        ],
      },
    },
  };
}

function seedConfirmed(presaleFile, lamports, userId = null) {
  const target = BigInt(lamports);
  const users = {};
  let remaining = target;
  let i = 100;
  let allocated = 0n;
  if (userId) {
    const chunk = remaining > MAX_WALLET_LAMPORTS ? MAX_WALLET_LAMPORTS : remaining;
    users[String(userId)] = {
      confirmedLamports: chunk.toString(),
      allocatedMangoBaseUnits: mangoBaseUnitsFromLamports(chunk).baseUnits,
      contributions: [{ contributedLamports: chunk.toString() }],
    };
    remaining -= chunk;
    allocated += chunk;
    i = 200;
  }
  while (remaining > 0n) {
    const chunk = remaining > MAX_WALLET_LAMPORTS ? MAX_WALLET_LAMPORTS : remaining;
    users[String(i)] = {
      confirmedLamports: chunk.toString(),
      allocatedMangoBaseUnits: mangoBaseUnitsFromLamports(chunk).baseUnits,
      contributions: [{ contributedLamports: chunk.toString() }],
    };
    remaining -= chunk;
    allocated += chunk;
    i += 1;
  }
  const alloc = mangoBaseUnitsFromLamports(allocated);
  fs.writeFileSync(
    presaleFile,
    JSON.stringify({
      version: 1,
      totals: {
        confirmedLamports: allocated.toString(),
        reservedLamports: "0",
        allocatedMangoBaseUnits: alloc.ok ? alloc.baseUnits : "0",
        reservedMangoBaseUnits: "0",
      },
      users,
      usedTransactions: {},
      sessions: {},
      orders: {},
    }),
    "utf8"
  );
}

function spawnReconcile(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RECONCILE_WORKER, JSON.stringify(payload)], {
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch (parseErr) {
        reject(new Error(`${parseErr.message}: ${out} ${err}`));
      }
    });
  });
}

function spawnPrepare(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(payload)], {
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch (parseErr) {
        reject(new Error(`${parseErr.message}: ${out} ${err}`));
      }
    });
  });
}

async function issueReady(token, orderId, options, height = HEIGHT_VALID) {
  const issued = await issuePresalePayment(token, orderId, withPaymentRpc(options, height));
  assert.strictEqual(issued.ok, true, issued.error || issued.reason);
  return issued;
}

setPresaleFileForTests(path.join(tempDir, "isolated.json"));

runTest("reservation TTL is 10 minutes independent of 15m session", () => {
  assert.strictEqual(RESERVATION_TTL_MS, 10 * 60 * 1000);
});

runTest("no late-confirm wall-clock grace", () => {
  const constants = fs.readFileSync(
    path.join(__dirname, "..", "services", "presaleConstants.js"),
    "utf8"
  );
  const ledger = fs.readFileSync(path.join(__dirname, "..", "services", "presaleLedger.js"), "utf8");
  assert.ok(!constants.includes("LATE_CONFIRM_GRACE"));
  assert.ok(!ledger.includes("LATE_CONFIRM_GRACE"));
});

runTest("prepare reserves capacity under lock", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 1, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(1, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(prepared.ok, true);
  assert.strictEqual(prepared.status, "reserved");
  const status = getPresaleStatus({
    presaleFile,
    env,
    now: 2001,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(status.reservedLamports, "10000000");
  assert.strictEqual(status.confirmedLamports, "0");
  const inv = reservationInvariant(loadPresaleStore(presaleFile), 2001, HEIGHT_VALID);
  assert.strictEqual(inv.ok, true);
  assert.ok(inv.totals.confirmedLamports + inv.totals.reservedLamports <= HARD_CAP_LAMPORTS);
});

runTest("idempotent prepare same amount reuses one reservation", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 2, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(2, { walletFile, presaleFile, now: 2000 });
  const a = await preparePresalePayment(session.token, "50000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const b = await preparePresalePayment(session.token, "50000000", {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(a.orderId, b.orderId);
  const store = loadPresaleStore(presaleFile);
  const reserved = Object.values(store.orders).filter((item) => item.status === "reserved");
  assert.strictEqual(reserved.length, 1);
});

runTest("different amount supersedes unpaid reserved only", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 3, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(3, { walletFile, presaleFile, now: 2000 });
  const first = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const second = await preparePresalePayment(session.token, "50000000", {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.notStrictEqual(first.orderId, second.orderId);
  const store = loadPresaleStore(presaleFile);
  assert.strictEqual(store.orders[first.orderId].status, "superseded");
  assert.strictEqual(store.orders[second.orderId].status, "reserved");
  const status = getPresaleStatus({ presaleFile, env, now: 2002 });
  assert.strictEqual(status.reservedLamports, "50000000");
});

runTest("pre-payment TTL expiry releases capacity", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 4, a, 1000);
  connectUser(walletFile, 5, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - 50_000_000n);
  const sA = createPresaleSession(4, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(5, { walletFile, presaleFile, now: 2001 });
  const pA = await preparePresalePayment(sA.token, "50000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000,
  });
  assert.strictEqual(pA.ok, true);
  const pBblocked = await preparePresalePayment(sB.token, "50000000", {
    walletFile,
    presaleFile,
    env,
    now: 3001,
  });
  assert.strictEqual(pBblocked.ok, false);
  assert.strictEqual(pBblocked.reason, "sold-out");
  const pBopen = await preparePresalePayment(sB.token, "50000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000 + RESERVATION_TTL_MS + 1,
  });
  assert.strictEqual(pBopen.ok, true);
});

runTest("confirm requires payment-ready then moves to confirmed", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 6, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(6, { walletFile, presaleFile, now: 2000 });
  const options = { walletFile, presaleFile, env, now: 2000 };
  const prepared = await preparePresalePayment(session.token, "10000000", options);
  const issued = await issueReady(session.token, prepared.orderId, { ...options, now: 2001 });
  const before = getPresaleStatus({
    presaleFile,
    env,
    now: 2002,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(before.reservedLamports, "10000000");
  const sig = fakeSig();
  const tx = mockTx({
    from: user.address,
    to: treasury.address,
    lamports: 10_000_000,
    memo: issued.memo,
    signature: sig,
    blockTime: 3,
    recentBlockhash: issued.recentBlockhash,
  });
  const confirmed = await confirmPresalePayment(
    session.token,
    sig,
    withPaymentRpc(
      {
        walletFile,
        presaleFile,
        env,
        now: 3000,
        orderId: issued.orderId,
        getTransactionImpl: async () => ({ ok: true, result: tx }),
      },
      HEIGHT_VALID
    )
  );
  assert.strictEqual(confirmed.ok, true);
  const after = getPresaleStatus({
    presaleFile,
    env,
    now: 3001,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(after.reservedLamports, "0");
  assert.strictEqual(after.confirmedLamports, "10000000");
  assert.strictEqual(after.allocatedMango, "200");
});

runTest("payment-ready blockhash protection after wall-clock TTL", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 7, a, 1000);
  connectUser(walletFile, 8, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
  const sA = createPresaleSession(7, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(8, { walletFile, presaleFile, now: 2001 });
  const pA = await preparePresalePayment(sA.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000,
  });
  await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 3001 });
  const lateNow = 3000 + RESERVATION_TTL_MS + 1;
  const pB = await preparePresalePayment(sB.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: lateNow,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(pB.ok, false);
  assert.strictEqual(pB.reason, "sold-out");
});

runTest("last-slot protected while tx valid 20×", async () => {
  for (let round = 0; round < 20; round += 1) {
    const { walletFile, presaleFile } = files();
    const a = generateSolanaWallet();
    const b = generateSolanaWallet();
    const treasury = generateSolanaWallet();
    connectUser(walletFile, 10, a, 1000);
    connectUser(walletFile, 11, b, 1000);
    const env = liveEnv(treasury.address);
    seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
    const sA = createPresaleSession(10, { walletFile, presaleFile, now: 2000 });
    const sB = createPresaleSession(11, { walletFile, presaleFile, now: 2001 });
    const pA = await preparePresalePayment(sA.token, "10000000", {
      walletFile,
      presaleFile,
      env,
      now: 4000,
    });
    await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 4001 });
    const afterTtl = 4000 + RESERVATION_TTL_MS + 1;
    const pB = await preparePresalePayment(sB.token, "10000000", {
      walletFile,
      presaleFile,
      env,
      now: afterTtl,
      currentBlockHeight: HEIGHT_VALID,
    });
    assert.strictEqual(pB.ok, false, `round ${round}`);
    assert.strictEqual(pB.reason, "sold-out", `round ${round}`);
    const inv = reservationInvariant(loadPresaleStore(presaleFile), afterTtl, HEIGHT_VALID);
    assert.strictEqual(inv.ok, true);
    assert.ok(inv.totals.confirmedLamports + inv.totals.reservedLamports <= HARD_CAP_LAMPORTS);
  }
});

runTest("release after lastValidBlockHeight", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 16, a, 1000);
  connectUser(walletFile, 17, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
  const sA = createPresaleSession(16, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(17, { walletFile, presaleFile, now: 2001 });
  const pA = await preparePresalePayment(sA.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000,
  });
  await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 3001 });
  const pB = await preparePresalePayment(
    sB.token,
    "10000000",
    emptyTreasury({
      walletFile,
      presaleFile,
      env,
      now: 3000 + RESERVATION_TTL_MS + 1,
      currentBlockHeight: HEIGHT_EXPIRED,
    })
  );
  assert.strictEqual(pB.ok, true);
  const store = loadPresaleStore(presaleFile);
  assert.strictEqual(store.orders[pA.orderId].status, "expired");
});

runTest("late landing still receives allocation", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 18, a, 1000);
  connectUser(walletFile, 19, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
  const sA = createPresaleSession(18, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(19, { walletFile, presaleFile, now: 2001 });
  const pA = await preparePresalePayment(sA.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000,
  });
  const issued = await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 3001 });
  const lateNow = 3000 + RESERVATION_TTL_MS + 60_000;
  const pB = await preparePresalePayment(sB.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: lateNow,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(pB.ok, false);
  const sig = fakeSig();
  const confirmed = await confirmPresalePayment(
    sA.token,
    sig,
    withPaymentRpc(
      {
        walletFile,
        presaleFile,
        env,
        now: lateNow + 1,
        orderId: issued.orderId,
        getTransactionImpl: async () => ({
          ok: true,
          result: mockTx({
            from: a.address,
            to: treasury.address,
            lamports: 10_000_000,
            memo: issued.memo,
            signature: sig,
            blockTime: Math.floor((lateNow + 1) / 1000),
            recentBlockhash: issued.recentBlockhash,
          }),
        }),
      },
      HEIGHT_VALID
    )
  );
  assert.strictEqual(confirmed.ok, true);
  const after = getPresaleStatus({
    presaleFile,
    env,
    now: lateNow + 2,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(after.confirmedLamports, (HARD_CAP_LAMPORTS).toString());
  assert.strictEqual(loadPresaleStore(presaleFile).orders[pA.orderId].status, "confirmed");
});

runTest("late-landing race 20× never reallocates capacity", async () => {
  for (let round = 0; round < 20; round += 1) {
    const { walletFile, presaleFile } = files();
    const a = generateSolanaWallet();
    const b = generateSolanaWallet();
    const treasury = generateSolanaWallet();
    connectUser(walletFile, 20, a, 1000);
    connectUser(walletFile, 21, b, 1000);
    const env = liveEnv(treasury.address);
    seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
    const sA = createPresaleSession(20, { walletFile, presaleFile, now: 2000 });
    const sB = createPresaleSession(21, { walletFile, presaleFile, now: 2001 });
    const pA = await preparePresalePayment(sA.token, "10000000", {
      walletFile,
      presaleFile,
      env,
      now: 3000,
    });
    const issued = await issueReady(sA.token, pA.orderId, {
      walletFile,
      presaleFile,
      env,
      now: 3001,
    });
    const lateNow = 3000 + RESERVATION_TTL_MS + 1;
    const pB = await preparePresalePayment(sB.token, "10000000", {
      walletFile,
      presaleFile,
      env,
      now: lateNow,
      currentBlockHeight: HEIGHT_VALID,
    });
    const sig = fakeSig();
    const confirmed = await confirmPresalePayment(
      sA.token,
      sig,
      withPaymentRpc(
        {
          walletFile,
          presaleFile,
          env,
          now: lateNow + 1,
          orderId: issued.orderId,
          getTransactionImpl: async () => ({
            ok: true,
            result: mockTx({
              from: a.address,
              to: treasury.address,
              lamports: 10_000_000,
              memo: issued.memo,
              signature: sig,
              blockTime: Math.floor((lateNow + 1) / 1000),
              recentBlockhash: issued.recentBlockhash,
            }),
          }),
        },
        HEIGHT_VALID
      )
    );
    assert.strictEqual(pB.ok, false, `round ${round} B must not take capacity`);
    assert.strictEqual(confirmed.ok, true, `round ${round} A must land`);
    const inv = reservationInvariant(loadPresaleStore(presaleFile), lateNow + 2, HEIGHT_VALID);
    assert.strictEqual(inv.ok, true);
    assert.ok(inv.totals.confirmedLamports <= HARD_CAP_LAMPORTS);
  }
});

runTest("abandoned payment releases after invalidity", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 22, a, 1000);
  connectUser(walletFile, 23, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
  const sA = createPresaleSession(22, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(23, { walletFile, presaleFile, now: 2001 });
  const pA = await preparePresalePayment(sA.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000,
  });
  await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 3001 });
  const stillHeld = await preparePresalePayment(sB.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 4000,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(stillHeld.ok, false);
  const released = await preparePresalePayment(
    sB.token,
    "10000000",
    emptyTreasury({
      walletFile,
      presaleFile,
      env,
      now: 5000,
      currentBlockHeight: HEIGHT_EXPIRED,
    })
  );
  assert.strictEqual(released.ok, true);
});

runTest("submitted tx protected until confirmed", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 24, a, 1000);
  connectUser(walletFile, 25, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
  const sA = createPresaleSession(24, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(25, { walletFile, presaleFile, now: 2001 });
  const pA = await preparePresalePayment(sA.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000,
  });
  const issued = await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 3001 });
  const sig = fakeSig();
  const pendingConfirm = await confirmPresalePayment(
    sA.token,
    sig,
    withPaymentRpc(
      {
        walletFile,
        presaleFile,
        env,
        now: 3002,
        orderId: issued.orderId,
        getTransactionImpl: async () => ({ ok: false, reason: "rpc-missing" }),
      },
      HEIGHT_VALID
    )
  );
  assert.strictEqual(pendingConfirm.ok, false);
  assert.strictEqual(pendingConfirm.submitted, true);
  assert.strictEqual(loadPresaleStore(presaleFile).orders[issued.orderId].status, "submitted");
  const pB = await preparePresalePayment(sB.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000 + RESERVATION_TTL_MS + 1,
    currentBlockHeight: HEIGHT_EXPIRED,
  });
  assert.strictEqual(pB.ok, false);
  assert.strictEqual(pB.reason, "sold-out");
});

runTest("browser-close recovery via reconcile", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 26, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(26, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const issued = await issueReady(session.token, prepared.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  const sig = fakeSig();
  const recovered = await reconcilePresalePayment(
    issued.orderId,
    sig,
    withPaymentRpc(
      {
        walletFile,
        presaleFile,
        env,
        now: 9000,
        getTransactionImpl: async () => ({
          ok: true,
          result: mockTx({
            from: user.address,
            to: treasury.address,
            lamports: 10_000_000,
            memo: issued.memo,
            signature: sig,
            blockTime: 10,
            recentBlockhash: issued.recentBlockhash,
          }),
        }),
      },
      HEIGHT_VALID
    )
  );
  assert.strictEqual(recovered.ok, true);
  assert.strictEqual(recovered.notifyTelegramUserId, "26");
  const store = loadPresaleStore(presaleFile);
  assert.strictEqual(store.orders[issued.orderId].status, "confirmed");
});

runTest("wallet-cap race 20× — never 0.30 exposure", async () => {
  for (let round = 0; round < 20; round += 1) {
    const { walletFile, presaleFile } = files();
    const user = generateSolanaWallet();
    const treasury = generateSolanaWallet();
    connectUser(walletFile, 12, user, 1000);
    const env = liveEnv(treasury.address);
    seedConfirmed(presaleFile, 200_000_000n, "12");
    const session = createPresaleSession(12, { walletFile, presaleFile, now: 2000 });
    const options = { walletFile, presaleFile, env, now: 3000 };
    const [p1, p2] = await Promise.all([
      preparePresalePayment(session.token, "50000000", options),
      preparePresalePayment(session.token, "50000000", options),
    ]);
    const store = loadPresaleStore(presaleFile);
    const inv = reservationInvariant(store, 3000);
    assert.strictEqual(inv.ok, true, `round ${round}`);
    const userTotal = inv.perUser["12"] || 0n;
    assert.ok(userTotal <= MAX_WALLET_LAMPORTS, `round ${round} total=${userTotal}`);
    const reserved = Object.values(store.orders).filter((item) => item.status === "reserved");
    assert.ok(reserved.length <= 1);
    assert.ok(p1.ok || p2.ok);
  }
});

runTest("per-wallet cap includes payment-ready", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 27, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(27, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, MAX_WALLET_LAMPORTS.toString(), {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  await issueReady(session.token, prepared.orderId, { walletFile, presaleFile, env, now: 2001 });
  const extra = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2002,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(extra.ok, false);
  assert.ok(extra.reason === "wallet-cap" || extra.reason === "wallet-max");
});

runTest("global cap includes payment-ready", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 28, a, 1000);
  connectUser(walletFile, 29, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
  const sA = createPresaleSession(28, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(29, { walletFile, presaleFile, now: 2001 });
  const pA = await preparePresalePayment(sA.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000,
  });
  await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 3001 });
  const pB = await preparePresalePayment(sB.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3002,
    currentBlockHeight: HEIGHT_VALID,
  });
  assert.strictEqual(pB.ok, false);
  assert.strictEqual(pB.reason, "sold-out");
  const inv = reservationInvariant(loadPresaleStore(presaleFile), 3002, HEIGHT_VALID);
  assert.strictEqual(inv.ok, true);
  assert.ok(inv.totals.confirmedLamports + inv.totals.reservedLamports <= HARD_CAP_LAMPORTS);
});

runTest("exact payment verification", () => {
  const user = generateSolanaWallet().address;
  const treasury = generateSolanaWallet().address;
  const other = generateSolanaWallet().address;
  const memo = `${MEMO_PREFIX}order1`;
  const expected = {
    expectedWallet: user,
    treasury,
    expectedLamports: "10000000",
    memo,
    createdAt: 5000,
    recentBlockhash: TEST_BLOCKHASH,
  };
  const sig = fakeSig();
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user,
        to: treasury,
        lamports: 10_000_000,
        memo,
        signature: sig,
        blockTime: 6,
      }),
      expected
    ).ok,
    true
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user,
        to: treasury,
        lamports: 10_000_001,
        memo,
        signature: sig,
        blockTime: 6,
      }),
      expected
    ).reason,
    "wrong-amount"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user,
        to: treasury,
        lamports: 9_999_999,
        memo,
        signature: sig,
        blockTime: 6,
      }),
      expected
    ).reason,
    "wrong-amount"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user,
        to: treasury,
        lamports: 10_000_000,
        memo,
        signature: sig,
        blockTime: 6,
        extraDest: other,
      }),
      expected
    ).reason,
    "wrong-treasury"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: other,
        to: treasury,
        lamports: 10_000_000,
        memo,
        signature: sig,
        blockTime: 6,
      }),
      expected
    ).reason,
    "wrong-sender"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user,
        to: treasury,
        lamports: 10_000_000,
        memo: "",
        signature: sig,
        blockTime: 6,
      }),
      expected
    ).reason,
    "memo-mismatch"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user,
        to: treasury,
        lamports: 10_000_000,
        memo: `${MEMO_PREFIX}other`,
        signature: sig,
        blockTime: 6,
      }),
      expected
    ).reason,
    "memo-mismatch"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user,
        to: treasury,
        lamports: 10_000_000,
        memo,
        signature: sig,
        blockTime: 6,
        extraTransfers: [{ to: treasury, lamports: 10_000_000 }],
      }),
      expected
    ).reason,
    "multiple-transfers"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user,
        to: treasury,
        lamports: 10_000_000,
        memo,
        signature: sig,
        blockTime: 6,
        recentBlockhash: "OtherHash111111111111111111111111111",
      }),
      expected
    ).reason,
    "blockhash-mismatch"
  );
});

runTest("duplicate signature rejected", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 30, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(30, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const issued = await issueReady(session.token, prepared.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  const sig = fakeSig();
  const tx = mockTx({
    from: user.address,
    to: treasury.address,
    lamports: 10_000_000,
    memo: issued.memo,
    signature: sig,
    blockTime: 3,
    recentBlockhash: issued.recentBlockhash,
  });
  const first = await confirmPresalePayment(
    session.token,
    sig,
    withPaymentRpc({
      walletFile,
      presaleFile,
      env,
      now: 3000,
      orderId: issued.orderId,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    })
  );
  assert.strictEqual(first.ok, true);
  const dup = await confirmPresalePayment(
    session.token,
    sig,
    withPaymentRpc({
      walletFile,
      presaleFile,
      env,
      now: 3001,
      orderId: issued.orderId,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    })
  );
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.reason, "duplicate");
});

runTest("restart persistence keeps payment-ready", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 13, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(13, { walletFile, presaleFile, now: 1 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2,
  });
  await issueReady(session.token, prepared.orderId, { walletFile, presaleFile, env, now: 3 });
  const reloaded = loadPresaleStore(presaleFile);
  assert.strictEqual(reloaded.orders[prepared.orderId].status, "payment-ready");
  assert.strictEqual(reloaded.orders[prepared.orderId].recentBlockhash, TEST_BLOCKHASH);
  assert.strictEqual(reloaded.totals.reservedLamports, "10000000");
  const inv = reservationInvariant(reloaded, 4, HEIGHT_VALID);
  assert.strictEqual(inv.ok, true);
});

runTest("last-slot race 20× — exactly one payable order", async () => {
  for (let round = 0; round < 20; round += 1) {
    const { walletFile, presaleFile } = files();
    const a = generateSolanaWallet();
    const b = generateSolanaWallet();
    const treasury = generateSolanaWallet();
    connectUser(walletFile, 10, a, 1000);
    connectUser(walletFile, 11, b, 1000);
    const env = liveEnv(treasury.address);
    seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
    const sA = createPresaleSession(10, { walletFile, presaleFile, now: 2000 });
    const sB = createPresaleSession(11, { walletFile, presaleFile, now: 2001 });
    const options = { walletFile, presaleFile, env, now: 4000 };
    const [p1, p2] = await Promise.all([
      preparePresalePayment(sA.token, "10000000", options),
      preparePresalePayment(sB.token, "10000000", options),
    ]);
    const ok = [p1, p2].filter((item) => item.ok);
    const fail = [p1, p2].filter((item) => !item.ok);
    assert.strictEqual(ok.length, 1, `round ${round} ok=${ok.length}`);
    assert.strictEqual(fail.length, 1, `round ${round} fail=${fail.length}`);
    assert.strictEqual(fail[0].reason, "sold-out");
    const inv = reservationInvariant(loadPresaleStore(presaleFile), 4000);
    assert.strictEqual(inv.ok, true);
    assert.ok(inv.totals.confirmedLamports + inv.totals.reservedLamports <= HARD_CAP_LAMPORTS);
  }
});

runTest("cross-process last-slot prepare", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 14, a, 1000);
  connectUser(walletFile, 15, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
  const sA = createPresaleSession(14, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(15, { walletFile, presaleFile, now: 2001 });
  const payloadA = {
    token: sA.token,
    lamports: "10000000",
    walletFile,
    presaleFile,
    env,
    now: 4000,
  };
  const payloadB = { ...payloadA, token: sB.token };
  const [r1, r2] = await Promise.all([spawnPrepare(payloadA), spawnPrepare(payloadB)]);
  const ok = [r1, r2].filter((item) => item.ok);
  const fail = [r1, r2].filter((item) => !item.ok);
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(fail.length, 1);
  const inv = reservationInvariant(loadPresaleStore(presaleFile), 4000);
  assert.strictEqual(inv.ok, true);
});

runTest("browser-close landed payment reconciles 20×", async () => {
  for (let round = 0; round < 20; round += 1) {
    const { walletFile, presaleFile } = files();
    const a = generateSolanaWallet();
    const b = generateSolanaWallet();
    const treasury = generateSolanaWallet();
    connectUser(walletFile, 40, a, 1000);
    connectUser(walletFile, 41, b, 1000);
    const env = liveEnv(treasury.address);
    seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
    const sA = createPresaleSession(40, { walletFile, presaleFile, now: 2000 });
    const sB = createPresaleSession(41, { walletFile, presaleFile, now: 2001 });
    const pA = await preparePresalePayment(sA.token, "10000000", {
      walletFile,
      presaleFile,
      env,
      now: 3000,
    });
    const issued = await issueReady(sA.token, pA.orderId, {
      walletFile,
      presaleFile,
      env,
      now: 3001,
    });
    const sig = fakeSig();
    const tx = mockTx({
      from: a.address,
      to: treasury.address,
      lamports: 10_000_000,
      memo: issued.memo,
      signature: sig,
      blockTime: 4,
      recentBlockhash: issued.recentBlockhash,
    });
    const pB = await preparePresalePayment(
      sB.token,
      "10000000",
      treasuryHistory(
        [{ signature: sig, blockTime: 4, memo: issued.memo, tx }],
        {
          walletFile,
          presaleFile,
          env,
          now: 3000 + RESERVATION_TTL_MS + 1,
          currentBlockHeight: HEIGHT_EXPIRED,
        }
      )
    );
    assert.strictEqual(pB.ok, false, `round ${round} B must stay sold-out`);
    assert.strictEqual(pB.reason, "sold-out", `round ${round}`);
    const store = loadPresaleStore(presaleFile);
    assert.strictEqual(store.orders[issued.orderId].status, "confirmed", `round ${round}`);
    assert.strictEqual(store.usedTransactions[sig], true);
    const status = getPresaleStatus({
      presaleFile,
      env,
      now: 4000,
      currentBlockHeight: HEIGHT_EXPIRED,
    });
    assert.strictEqual(status.confirmedLamports, HARD_CAP_LAMPORTS.toString());
    assert.strictEqual(status.allocatedMango, "100000");
  }
});

runTest("never-broadcast expires 20×", async () => {
  for (let round = 0; round < 20; round += 1) {
    const { walletFile, presaleFile } = files();
    const a = generateSolanaWallet();
    const b = generateSolanaWallet();
    const treasury = generateSolanaWallet();
    connectUser(walletFile, 42, a, 1000);
    connectUser(walletFile, 43, b, 1000);
    const env = liveEnv(treasury.address);
    seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
    const sA = createPresaleSession(42, { walletFile, presaleFile, now: 2000 });
    const sB = createPresaleSession(43, { walletFile, presaleFile, now: 2001 });
    const pA = await preparePresalePayment(sA.token, "10000000", {
      walletFile,
      presaleFile,
      env,
      now: 3000,
    });
    await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 3001 });
    const pB = await preparePresalePayment(
      sB.token,
      "10000000",
      emptyTreasury({
        walletFile,
        presaleFile,
        env,
        now: 5000,
        currentBlockHeight: HEIGHT_EXPIRED,
      })
    );
    assert.strictEqual(pB.ok, true, `round ${round}`);
    assert.strictEqual(loadPresaleStore(presaleFile).orders[pA.orderId].status, "expired");
  }
});

runTest("RPC failure keeps reservation", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 44, a, 1000);
  connectUser(walletFile, 45, b, 1000);
  const env = liveEnv(treasury.address);
  seedConfirmed(presaleFile, HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS);
  const sA = createPresaleSession(44, { walletFile, presaleFile, now: 2000 });
  const sB = createPresaleSession(45, { walletFile, presaleFile, now: 2001 });
  const pA = await preparePresalePayment(sA.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 3000,
  });
  await issueReady(sA.token, pA.orderId, { walletFile, presaleFile, env, now: 3001 });
  const pB = await preparePresalePayment(sB.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 5000,
    currentBlockHeight: HEIGHT_EXPIRED,
    getSignaturesForAddressImpl: async () => ({ ok: false, reason: "rpc-network" }),
  });
  assert.strictEqual(pB.ok, false);
  assert.strictEqual(pB.reason, "sold-out");
  assert.strictEqual(
    loadPresaleStore(presaleFile).orders[pA.orderId].status,
    "reconciliation-pending"
  );
});

runTest("RPC recovery confirms", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 46, a, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(46, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const issued = await issueReady(session.token, prepared.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  await reconcilePresaleOrder(issued.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 5000,
    currentBlockHeight: HEIGHT_EXPIRED,
    getSignaturesForAddressImpl: async () => ({ ok: false, reason: "rpc-network" }),
  });
  assert.strictEqual(
    loadPresaleStore(presaleFile).orders[issued.orderId].status,
    "reconciliation-pending"
  );
  const sig = fakeSig();
  const tx = mockTx({
    from: a.address,
    to: treasury.address,
    lamports: 10_000_000,
    memo: issued.memo,
    signature: sig,
    blockTime: 4,
    recentBlockhash: issued.recentBlockhash,
  });
  const recovered = await reconcilePresaleOrder(
    issued.orderId,
    treasuryHistory(
      [{ signature: sig, blockTime: 4, memo: issued.memo, tx }],
      {
        walletFile,
        presaleFile,
        env,
        now: 6000,
        currentBlockHeight: HEIGHT_EXPIRED,
      }
    )
  );
  assert.strictEqual(recovered.ok, true);
  assert.strictEqual(loadPresaleStore(presaleFile).orders[issued.orderId].status, "confirmed");
});

runTest("RPC recovery expires when safely absent", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 47, a, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(47, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const issued = await issueReady(session.token, prepared.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  await reconcilePresaleOrder(issued.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 5000,
    currentBlockHeight: HEIGHT_EXPIRED,
    getSignaturesForAddressImpl: async () => ({ ok: false, reason: "rpc-error" }),
  });
  const expired = await reconcilePresaleOrder(
    issued.orderId,
    emptyTreasury({
      walletFile,
      presaleFile,
      env,
      now: 6000,
      currentBlockHeight: HEIGHT_EXPIRED,
    })
  );
  assert.strictEqual(expired.ok, true);
  assert.strictEqual(expired.expired, true);
  assert.strictEqual(loadPresaleStore(presaleFile).orders[issued.orderId].status, "expired");
});

runTest("false positives ignored", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const other = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 48, a, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(48, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const issued = await issueReady(session.token, prepared.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  const entries = [
    {
      signature: fakeSig(),
      blockTime: 4,
      tx: mockTx({
        from: other.address,
        to: treasury.address,
        lamports: 10_000_000,
        memo: issued.memo,
        signature: "wrong-sender",
        blockTime: 4,
        recentBlockhash: issued.recentBlockhash,
      }),
    },
    {
      signature: fakeSig(),
      blockTime: 4,
      tx: mockTx({
        from: a.address,
        to: treasury.address,
        lamports: 10_000_001,
        memo: issued.memo,
        signature: "wrong-amount",
        blockTime: 4,
        recentBlockhash: issued.recentBlockhash,
      }),
    },
    {
      signature: fakeSig(),
      blockTime: 4,
      tx: mockTx({
        from: a.address,
        to: treasury.address,
        lamports: 10_000_000,
        memo: `${issued.memo}-nope`,
        signature: "wrong-memo",
        blockTime: 4,
        recentBlockhash: issued.recentBlockhash,
      }),
    },
    {
      signature: fakeSig(),
      blockTime: 4,
      tx: mockTx({
        from: a.address,
        to: treasury.address,
        lamports: 10_000_000,
        memo: "",
        signature: "no-memo",
        blockTime: 4,
        recentBlockhash: issued.recentBlockhash,
      }),
    },
    {
      signature: fakeSig(),
      blockTime: 4,
      tx: mockTx({
        from: a.address,
        to: treasury.address,
        lamports: 10_000_000,
        memo: issued.memo,
        signature: "extra-transfer",
        blockTime: 4,
        recentBlockhash: issued.recentBlockhash,
        extraTransfers: [{ to: treasury.address, lamports: 10_000_000 }],
      }),
    },
    {
      signature: fakeSig(),
      blockTime: 4,
      err: { InstructionError: [0, "Custom"] },
      tx: mockTx({
        from: a.address,
        to: treasury.address,
        lamports: 10_000_000,
        memo: issued.memo,
        signature: "failed-tx",
        blockTime: 4,
        recentBlockhash: issued.recentBlockhash,
        err: { InstructionError: [0, "Custom"] },
      }),
    },
  ];
  entries[0].tx.transaction.signatures = [entries[0].signature];
  entries[1].tx.transaction.signatures = [entries[1].signature];
  entries[2].tx.transaction.signatures = [entries[2].signature];
  entries[3].tx.transaction.signatures = [entries[3].signature];
  entries[4].tx.transaction.signatures = [entries[4].signature];
  entries[5].tx.transaction.signatures = [entries[5].signature];
  const result = await reconcilePresaleOrder(
    issued.orderId,
    treasuryHistory(entries, {
      walletFile,
      presaleFile,
      env,
      now: 5000,
      currentBlockHeight: HEIGHT_EXPIRED,
    })
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.expired, true);
  assert.strictEqual(loadPresaleStore(presaleFile).orders[issued.orderId].status, "expired");
});

runTest("multiple matching tx fail closed", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 49, a, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(49, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const issued = await issueReady(session.token, prepared.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  const sig1 = fakeSig();
  const sig2 = fakeSig();
  const tx1 = mockTx({
    from: a.address,
    to: treasury.address,
    lamports: 10_000_000,
    memo: issued.memo,
    signature: sig1,
    blockTime: 4,
    recentBlockhash: issued.recentBlockhash,
  });
  const tx2 = mockTx({
    from: a.address,
    to: treasury.address,
    lamports: 10_000_000,
    memo: issued.memo,
    signature: sig2,
    blockTime: 4,
    recentBlockhash: issued.recentBlockhash,
  });
  const result = await reconcilePresaleOrder(
    issued.orderId,
    treasuryHistory(
      [
        { signature: sig1, blockTime: 4, memo: issued.memo, tx: tx1 },
        { signature: sig2, blockTime: 4, memo: issued.memo, tx: tx2 },
      ],
      {
        walletFile,
        presaleFile,
        env,
        now: 5000,
        currentBlockHeight: HEIGHT_EXPIRED,
      }
    )
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "multiple-match");
  assert.strictEqual(
    loadPresaleStore(presaleFile).orders[issued.orderId].status,
    "reconciliation-pending"
  );
  assert.strictEqual(loadPresaleStore(presaleFile).usedTransactions[sig1], undefined);
});

runTest("reconciliation pending persists across restart", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 50, a, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(50, { walletFile, presaleFile, now: 1 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2,
  });
  await issueReady(session.token, prepared.orderId, { walletFile, presaleFile, env, now: 3 });
  await reconcilePresaleOrder(prepared.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 4,
    currentBlockHeight: HEIGHT_EXPIRED,
    getSignaturesForAddressImpl: async () => ({ ok: false, reason: "rpc-network" }),
  });
  const reloaded = loadPresaleStore(presaleFile);
  assert.strictEqual(reloaded.orders[prepared.orderId].status, "reconciliation-pending");
  assert.strictEqual(reloaded.totals.reservedLamports, "10000000");
  const inv = reservationInvariant(reloaded, 5, HEIGHT_EXPIRED);
  assert.strictEqual(inv.ok, true);
});

runTest("cross-process reconciliation", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 51, a, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(51, { walletFile, presaleFile, now: 2000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  const issued = await issueReady(session.token, prepared.orderId, {
    walletFile,
    presaleFile,
    env,
    now: 2001,
  });
  const sig = fakeSig();
  const tx = mockTx({
    from: a.address,
    to: treasury.address,
    lamports: 10_000_000,
    memo: issued.memo,
    signature: sig,
    blockTime: 4,
    recentBlockhash: issued.recentBlockhash,
  });
  const payload = {
    orderId: issued.orderId,
    walletFile,
    presaleFile,
    env,
    now: 5000,
    currentBlockHeight: HEIGHT_EXPIRED,
    signatures: [{ signature: sig, err: null, blockTime: 4, memo: issued.memo, slot: 1 }],
    transactions: { [sig]: tx },
  };
  const [r1, r2] = await Promise.all([spawnReconcile(payload), spawnReconcile(payload)]);
  const confirmed = [r1, r2].filter((item) => item.confirmed);
  const dup = [r1, r2].filter((item) => item.reason === "duplicate");
  assert.strictEqual(confirmed.length, 1);
  assert.ok(dup.length === 1 || confirmed.length === 1);
  const store = loadPresaleStore(presaleFile);
  assert.strictEqual(store.orders[issued.orderId].status, "confirmed");
  assert.strictEqual(store.usedTransactions[sig], true);
});

runTest("tests do not touch production presale file", () => {
  if (fs.existsSync(prodPresale)) {
    assert.ok(!fs.readFileSync(prodPresale, "utf8").includes("mango-presale-res-"));
  }
});

Promise.all(pending).then(() => {
  setPresaleFileForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("presale-reservation tests passed");
});
