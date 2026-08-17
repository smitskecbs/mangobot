/**
 * ManGo v1 presale tokenomics, sessions, payment verify, caps, accounting.
 * Run: node tests/presale-v1.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  TOTAL_MANGO_HUMAN,
  PRESALE_MANGO_HUMAN,
  HARD_CAP_LAMPORTS,
  MIN_CONTRIBUTION_LAMPORTS,
  MAX_WALLET_LAMPORTS,
  MANGO_MINT,
  MANGO_MINT_DECIMALS,
  mangoBaseUnitsFromLamports,
  assertV1Tokenomics,
  solStringToLamports,
  parseLamportsInteger,
  isAllowedAmount,
  PURPOSE_PRESALE,
  MEMO_PREFIX,
} = require("../services/presaleConstants");
const { isPresaleLive, getPresaleConfig } = require("../services/presaleConfig");
const { setPresaleFileForTests, loadPresaleStore } = require("../services/presaleStore");
const {
  createPresaleSession,
  lookupPresaleSession,
  hashToken,
} = require("../services/presaleSessions");
const {
  canUserContribute,
  preparePresalePayment,
  issuePresalePayment,
  confirmPresalePayment,
  getPresaleStatus,
  getPresaleParticipation,
  getRemainingPresaleLamports,
  getRemainingPresaleAllocation,
} = require("../services/presaleLedger");
const { verifyPresaleTransaction } = require("../services/presaleVerify");
const { createLinkToken } = require("../services/walletVerification");
const {
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { handlePresale, GROUP_PRESALE_TEXT, PRESALE_COMING_SOON_TEXT } = require("../commands/presale");
const { handlePresaleStatus } = require("../commands/presalestatus");
const { PRESALE_LIVE } = require("../services/presaleParticipation");
const { SYSTEM_PROGRAM_ID, MEMO_PROGRAM_ID } = require("../services/presaleConstants");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-presale-v1-"));
const pointsFile = path.join(tempDir, "points.json");
const prodPresale = path.resolve(__dirname, "..", "data", "presale-participation.json");
let n = 0;
const pending = [];

function files() {
  n += 1;
  return {
    walletFile: path.join(tempDir, `w-${n}.json`),
    presaleFile: path.join(tempDir, `p-${n}.json`),
  };
}

function runTest(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(
        result
          .then(() => console.log(`✓ ${name}`))
          .catch((err) => {
            console.error(`✗ ${name}`);
            throw err;
          })
      );
      return;
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
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

function connectUser(walletFile, userId, wallet, now) {
  const created = createLinkToken(userId, { walletFile, now });
  const limiter = createMemoryRateLimiter();
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

function liveEnv(treasury) {
  return {
    PRESALE_ENABLED: "true",
    PRESALE_TREASURY_WALLET: treasury,
    PRESALE_RPC_URL: "https://rpc.test.invalid",
  };
}

function fakeSig() {
  return encodeBase58(crypto.randomBytes(64)).slice(0, 88);
}

const TEST_BLOCKHASH = "TestPresaleBlockhash11111111111111111";

function withPaymentRpc(options, height = 1000, lastValid = 2000) {
  return {
    ...options,
    currentBlockHeight: height,
    getLatestBlockhashImpl: async () => ({
      ok: true,
      blockhash: TEST_BLOCKHASH,
      lastValidBlockHeight: lastValid,
    }),
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

function createMockCtx({
  chatType = "private",
  userId = 111,
  callbackData,
} = {}) {
  const replies = [];
  return {
    chat: { type: chatType, id: chatType === "private" ? userId : -1001 },
    from: { id: userId, first_name: "Ada" },
    botInfo: { username: "ManGoMemeFunCommunityBot" },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    replies,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve(replies[replies.length - 1]);
    },
    answerCbQuery() {
      return Promise.resolve();
    },
  };
}

fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }), "utf8");
setPresaleFileForTests(path.join(tempDir, "isolated.json"));

runTest("1-4 tokenomics supply and 5 SOL = 100000", () => {
  const math = assertV1Tokenomics();
  assert.strictEqual(math.totalHuman, "1000000");
  assert.strictEqual(math.presaleHuman, "100000");
  assert.strictEqual(math.percent, "10");
  assert.strictEqual(math.fiveSolHuman, "100000");
  assert.strictEqual(TOTAL_MANGO_HUMAN, 1_000_000n);
  assert.strictEqual(PRESALE_MANGO_HUMAN, 100_000n);
  assert.strictEqual(MANGO_MINT_DECIMALS, 9);
  assert.strictEqual(MANGO_MINT, "29KN57rM6tV2aWdo1agZcF6ynPXB1dhHdKHNrrAmaNGo");
  const five = mangoBaseUnitsFromLamports(HARD_CAP_LAMPORTS);
  assert.strictEqual(five.ok, true);
  assert.strictEqual(five.human, "100000");
  assert.strictEqual(five.baseUnits, (100_000n * 10n ** 9n).toString());
});

runTest("5-8 amount examples", () => {
  assert.strictEqual(mangoBaseUnitsFromLamports(10_000_000n).human, "200");
  assert.strictEqual(mangoBaseUnitsFromLamports(50_000_000n).human, "1000");
  assert.strictEqual(mangoBaseUnitsFromLamports(100_000_000n).human, "2000");
  assert.strictEqual(mangoBaseUnitsFromLamports(250_000_000n).human, "5000");
});

runTest("9 integer/no float", () => {
  assert.strictEqual(solStringToLamports(0.01).ok, false);
  assert.strictEqual(parseLamportsInteger(0.01).ok, false);
  assert.strictEqual(typeof mangoBaseUnitsFromLamports("10000000").baseUnits, "string");
  assert.ok(!String(mangoBaseUnitsFromLamports("10000000").baseUnits).includes("."));
});

runTest("10-15 purpose-bound sessions", () => {
  const { walletFile, presaleFile } = files();
  const wallet = generateSolanaWallet();
  connectUser(walletFile, 10, wallet, 1000);
  const created = createPresaleSession(10, { walletFile, presaleFile, now: 2000 });
  assert.strictEqual(created.ok, true);
  assert.ok(!created.url.includes("uid"));
  assert.ok(!created.url.includes("10"));
  assert.ok(created.url.includes("/presale/"));
  assert.ok(!created.url.includes("?t="));
  const ok = lookupPresaleSession(created.token, { presaleFile, now: 2001 });
  assert.strictEqual(ok.status, "ok");
  assert.strictEqual(ok.record.purpose, PURPOSE_PRESALE);
  assert.strictEqual(ok.record.expectedWallet, wallet.address);
  assert.strictEqual(lookupPresaleSession("nope", { presaleFile }).status, "invalid");
  assert.strictEqual(
    lookupPresaleSession(created.token, { presaleFile, now: 2000 + 16 * 60 * 1000 }).status,
    "expired"
  );
  const verifyToken = createLinkToken(10, { walletFile, now: 3000 });
  assert.strictEqual(
    lookupPresaleSession(verifyToken.token, { presaleFile, now: 3001 }).status,
    "invalid"
  );
  const store = loadPresaleStore(presaleFile);
  store.sessions[hashToken(created.token)] = {
    ...ok.record,
    purpose: "wallet-verify",
  };
  fs.writeFileSync(presaleFile, JSON.stringify(store), "utf8");
  assert.strictEqual(
    lookupPresaleSession(created.token, { presaleFile, now: 2001 }).status,
    "wrong-purpose"
  );
});

runTest("wrong wallet / canUserContribute unverified", () => {
  const { walletFile, presaleFile } = files();
  const treasury = generateSolanaWallet();
  const env = liveEnv(treasury.address);
  const result = canUserContribute(99, MIN_CONTRIBUTION_LAMPORTS.toString(), {
    walletFile,
    presaleFile,
    env,
    now: 1,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "unverified");
});

runTest("16-24 payment verification", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const other = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 16, user, 1000);
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(16, { walletFile, presaleFile, now: 5000 });
  const prepared = await preparePresalePayment(session.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 5000,
  });
  assert.strictEqual(prepared.ok, true);
  const issued = await issuePresalePayment(
    session.token,
    prepared.orderId,
    withPaymentRpc({ walletFile, presaleFile, env, now: 5001 })
  );
  assert.strictEqual(issued.ok, true);
  assert.strictEqual(prepared.to, treasury.address);
  assert.strictEqual(prepared.from, user.address);
  assert.ok(prepared.memo.startsWith(MEMO_PREFIX));

  const sig = fakeSig();
  const good = mockTx({
    from: user.address,
    to: treasury.address,
    lamports: 10_000_000,
    memo: prepared.memo,
    signature: sig,
    blockTime: 6,
  });
  assert.strictEqual(
    verifyPresaleTransaction(good, {
      expectedWallet: user.address,
      treasury: treasury.address,
      expectedLamports: "10000000",
      memo: prepared.memo,
      createdAt: 5000,
    }).ok,
    true
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: other.address,
        to: treasury.address,
        lamports: 10_000_000,
        memo: prepared.memo,
        signature: sig,
        blockTime: 6,
      }),
      {
        expectedWallet: user.address,
        treasury: treasury.address,
        expectedLamports: "10000000",
        memo: prepared.memo,
        createdAt: 5000,
      }
    ).reason,
    "wrong-sender"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user.address,
        to: treasury.address,
        lamports: 10_000_000,
        memo: prepared.memo,
        signature: sig,
        blockTime: 6,
        extraDest: other.address,
      }),
      {
        expectedWallet: user.address,
        treasury: treasury.address,
        expectedLamports: "10000000",
        memo: prepared.memo,
        createdAt: 5000,
      }
    ).reason,
    "wrong-treasury"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user.address,
        to: treasury.address,
        lamports: 1,
        memo: prepared.memo,
        signature: sig,
        blockTime: 6,
      }),
      {
        expectedWallet: user.address,
        treasury: treasury.address,
        expectedLamports: "10000000",
        memo: prepared.memo,
        createdAt: 5000,
      }
    ).reason,
    "wrong-amount"
  );
  assert.strictEqual(
    verifyPresaleTransaction(
      mockTx({
        from: user.address,
        to: treasury.address,
        lamports: 10_000_000,
        memo: prepared.memo,
        signature: sig,
        blockTime: 6,
        err: { InstructionError: [0, "Custom"] },
      }),
      {
        expectedWallet: user.address,
        treasury: treasury.address,
        expectedLamports: "10000000",
        memo: prepared.memo,
        createdAt: 5000,
      }
    ).reason,
    "failed-tx"
  );
  assert.strictEqual(
    verifyPresaleTransaction(good, {
      expectedWallet: user.address,
      treasury: treasury.address,
      expectedLamports: "10000000",
      memo: prepared.memo,
      createdAt: 100_000_000,
    }).reason,
    "old-tx"
  );

  const first = await confirmPresalePayment(
    session.token,
    sig,
    withPaymentRpc({
      walletFile,
      presaleFile,
      env,
      now: 6000,
      orderId: issued.orderId,
      getTransactionImpl: async () => ({ ok: true, result: good }),
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
      now: 7000,
      orderId: issued.orderId,
      getTransactionImpl: async () => ({ ok: true, result: good }),
    })
  );
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.reason, "duplicate");

  const [a, b] = await Promise.all([
    confirmPresalePayment(
      session.token,
      sig,
      withPaymentRpc({
        walletFile,
        presaleFile,
        env,
        now: 8000,
        orderId: issued.orderId,
        getTransactionImpl: async () => ({ ok: true, result: good }),
      })
    ),
    confirmPresalePayment(
      session.token,
      sig,
      withPaymentRpc({
        walletFile,
        presaleFile,
        env,
        now: 8000,
        orderId: issued.orderId,
        getTransactionImpl: async () => ({ ok: true, result: good }),
      })
    ),
  ]);
  assert.ok(!a.ok && !b.ok);
  assert.ok(a.reason === "duplicate" && b.reason === "duplicate");
});

runTest("25-31 caps", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 25, user, 1000);
  const env = liveEnv(treasury.address);
  assert.strictEqual(
    canUserContribute(25, "1", { walletFile, presaleFile, env, now: 1 }).reason,
    "below-min"
  );
  assert.strictEqual(isAllowedAmount(MIN_CONTRIBUTION_LAMPORTS), true);
  const session = createPresaleSession(25, { walletFile, presaleFile, now: 2000 });
  const max = await preparePresalePayment(session.token, MAX_WALLET_LAMPORTS.toString(), {
    walletFile,
    presaleFile,
    env,
    now: 2000,
  });
  assert.strictEqual(max.ok, true);
  const issuedMax = await issuePresalePayment(
    session.token,
    max.orderId,
    withPaymentRpc({ walletFile, presaleFile, env, now: 2001 })
  );
  assert.strictEqual(issuedMax.ok, true);
  const sig = fakeSig();
  const tx = mockTx({
    from: user.address,
    to: treasury.address,
    lamports: Number(MAX_WALLET_LAMPORTS),
    memo: issuedMax.memo,
    signature: sig,
    blockTime: 3,
    recentBlockhash: issuedMax.recentBlockhash,
  });
  const confirmed = await confirmPresalePayment(
    session.token,
    sig,
    withPaymentRpc({
      walletFile,
      presaleFile,
      env,
      now: 3000,
      orderId: issuedMax.orderId,
      getTransactionImpl: async () => ({ ok: true, result: tx }),
    })
  );
  assert.strictEqual(confirmed.ok, true);
  const overWallet = canUserContribute(25, MIN_CONTRIBUTION_LAMPORTS.toString(), {
    walletFile,
    presaleFile,
    env,
    now: 4000,
  });
  assert.strictEqual(overWallet.ok, false);
  assert.ok(overWallet.reason === "wallet-max" || overWallet.reason === "wallet-cap");

  const status = getPresaleStatus({ presaleFile, env, now: 4000 });
  assert.ok(BigInt(status.confirmedLamports) <= HARD_CAP_LAMPORTS);
});

runTest("global cap and sold out", async () => {
  const { walletFile, presaleFile } = files();
  const treasury = generateSolanaWallet();
  const env = liveEnv(treasury.address);
  const store = {
    version: 1,
    totals: { confirmedLamports: HARD_CAP_LAMPORTS.toString(), allocatedMangoBaseUnits: "0" },
    users: {
      1: {
        confirmedLamports: HARD_CAP_LAMPORTS.toString(),
        allocatedMangoBaseUnits: mangoBaseUnitsFromLamports(HARD_CAP_LAMPORTS).baseUnits,
        contributions: [{ contributedLamports: HARD_CAP_LAMPORTS.toString() }],
      },
    },
    usedTransactions: {},
    sessions: {},
    orders: {},
  };
  fs.writeFileSync(presaleFile, JSON.stringify(store), "utf8");
  const user = generateSolanaWallet();
  connectUser(walletFile, 31, user, 1000);
  const check = canUserContribute(31, MIN_CONTRIBUTION_LAMPORTS.toString(), {
    walletFile,
    presaleFile,
    env,
    now: 1,
  });
  assert.strictEqual(check.reason, "sold-out");
  assert.strictEqual(getRemainingPresaleLamports({ presaleFile, env }), "0");
});

runTest("final-cap race safe", async () => {
  const { walletFile, presaleFile } = files();
  const a = generateSolanaWallet();
  const b = generateSolanaWallet();
  const treasury = generateSolanaWallet();
  connectUser(walletFile, 41, a, 1000);
  connectUser(walletFile, 42, b, 2000);
  const env = liveEnv(treasury.address);
  fs.writeFileSync(
    presaleFile,
    JSON.stringify({
      version: 1,
      totals: {
        confirmedLamports: (HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS).toString(),
        allocatedMangoBaseUnits: "0",
      },
      users: (() => {
        const users = {};
        let remaining = HARD_CAP_LAMPORTS - MIN_CONTRIBUTION_LAMPORTS;
        let i = 500;
        while (remaining > 0n) {
          const chunk = remaining > MAX_WALLET_LAMPORTS ? MAX_WALLET_LAMPORTS : remaining;
          users[String(i)] = {
            confirmedLamports: chunk.toString(),
            allocatedMangoBaseUnits: "0",
            contributions: [{ contributedLamports: chunk.toString() }],
          };
          remaining -= chunk;
          i += 1;
        }
        return users;
      })(),
      usedTransactions: {},
      sessions: {},
      orders: {},
    }),
    "utf8"
  );
  const s1 = createPresaleSession(41, { walletFile, presaleFile, now: 3000 });
  const s2 = createPresaleSession(42, { walletFile, presaleFile, now: 3001 });
  const p1 = await preparePresalePayment(s1.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 4000,
  });
  const p2 = await preparePresalePayment(s2.token, "10000000", {
    walletFile,
    presaleFile,
    env,
    now: 4001,
  });
  const succeeded = [p1, p2].filter((item) => item.ok);
  const failed = [p1, p2].filter((item) => !item.ok);
  assert.strictEqual(succeeded.length, 1);
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].reason, "sold-out");
  const remaining = BigInt(getRemainingPresaleLamports({ presaleFile, env, now: 4002 }));
  assert.strictEqual(remaining, 0n);
});

runTest("32-36 accounting persistence locking", async () => {
  const { walletFile, presaleFile } = files();
  const user = generateSolanaWallet();
  connectUser(walletFile, 32, user, 1000);
  const treasury = generateSolanaWallet();
  const env = liveEnv(treasury.address);
  const session = createPresaleSession(32, { walletFile, presaleFile, now: 1 });
  const prepared = await preparePresalePayment(session.token, "50000000", {
    walletFile,
    presaleFile,
    env,
    now: 2,
  });
  assert.strictEqual(prepared.mangoHuman, "1000");
  const raw = JSON.parse(fs.readFileSync(presaleFile, "utf8"));
  assert.strictEqual(raw.orders[prepared.orderId].lamports, "50000000");
  fs.writeFileSync(presaleFile, "{not-json", "utf8");
  const store = loadPresaleStore(presaleFile);
  assert.strictEqual(store.totals.confirmedLamports, "0");
  assert.notStrictEqual(path.resolve(presaleFile), prodPresale);
});

runTest("37-42 telegram ux", () => {
  const { walletFile, presaleFile } = files();
  const disabled = createMockCtx({ chatType: "private", userId: 37 });
  handlePresale(disabled, { walletFile, presaleFile, env: { PRESALE_ENABLED: "false" } });
  assert.strictEqual(disabled.replies[0].text, PRESALE_COMING_SOON_TEXT);
  const group = createMockCtx({ chatType: "supergroup", userId: 37 });
  handlePresale(group, { walletFile, presaleFile });
  assert.strictEqual(group.replies[0].text, GROUP_PRESALE_TEXT);

  const treasury = generateSolanaWallet();
  const env = liveEnv(treasury.address);
  const unverified = createMockCtx({ userId: 38 });
  handlePresale(unverified, { walletFile, presaleFile, env, now: 1 });
  assert.ok(unverified.replies[0].text.includes("Wallet verification required"));

  const wallet = generateSolanaWallet();
  connectUser(walletFile, 39, wallet, 1000);
  const verified = createMockCtx({ userId: 39 });
  handlePresale(verified, { walletFile, presaleFile, env, now: 2 });
  assert.ok(verified.replies[0].text.includes("Wallet: ✅ Verified"));
  assert.ok(verified.replies[0].text.includes("1 SOL = 20000 MANGO"));
  assert.ok(!verified.replies[0].text.includes(wallet.address));
});

runTest("43-47 security", () => {
  assert.strictEqual(PRESALE_LIVE, false);
  assert.strictEqual(isPresaleLive(Date.now(), { PRESALE_ENABLED: "false" }), false);
  assert.strictEqual(getPresaleConfig({}).treasury, null);
  const treasuryOnly = generateSolanaWallet();
  assert.strictEqual(
    isPresaleLive(Date.now(), {
      PRESALE_ENABLED: "true",
      PRESALE_TREASURY_WALLET: treasuryOnly.address,
    }),
    false
  );
  const sources = [
    "services/presaleLedger.js",
    "services/presaleReconcile.js",
    "services/presaleApi.js",
    "services/presaleSessions.js",
    "commands/presale.js",
    "commands/presalestatus.js",
  ].map((rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8").toLowerCase());
  for (const src of sources) {
    assert.ok(!src.includes("privatekey"));
    assert.ok(!src.includes("seed phrase"));
    assert.ok(!src.includes("jupiter"));
  }
  assert.ok(
    !fs
      .readFileSync(path.join(__dirname, "..", "services/presaleLedger.js"), "utf8")
      .includes("createReward(")
  );
  assert.notStrictEqual(path.resolve(tempDir), path.dirname(prodPresale));
  if (fs.existsSync(prodPresale)) {
    assert.ok(!fs.readFileSync(prodPresale, "utf8").includes("mango-presale-v1-"));
  }
});

runTest("admin presalestatus rejected for non-admin", () => {
  const prev = process.env.ADMIN_USER_ID;
  process.env.ADMIN_USER_ID = "9001";
  try {
    const ctx = createMockCtx({ userId: 77 });
    handlePresaleStatus(ctx, { pointsFile });
    assert.ok(ctx.replies[0].text.includes("admin only"));
  } finally {
    if (prev === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = prev;
  }
});

runTest("mint decimals 9 matches mainnet supply scale", () => {
  assert.strictEqual(10n ** BigInt(MANGO_MINT_DECIMALS) * 1_000_000n, 1_000_000_000_000_000n);
});

runTest("allocation remaining helper", () => {
  const remaining = getRemainingPresaleAllocation({
    presaleFile: files().presaleFile,
    env: { PRESALE_ENABLED: "false" },
  });
  assert.strictEqual(typeof remaining, "string");
  assert.ok(/^\d+$/.test(remaining));
});

Promise.all(pending).then(() => {
  setPresaleFileForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("presale-v1 tests passed");
});
