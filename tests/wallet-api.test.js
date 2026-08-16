/**
 * Wallet verification API: challenge/verify security cases.
 * Run: node tests/wallet-api.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { Readable } = require("stream");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
  LINK_TTL_MS,
  CHALLENGE_TTL_MS,
  ERRORS,
  hashToken,
} = require("../services/walletVerification");
const {
  tryHandleWalletRequest,
  MAX_BODY_BYTES,
} = require("../services/walletApi");
const { loadWalletStore } = require("../services/walletLinks");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-api-"));
let fileIndex = 0;

function walletFile() {
  fileIndex += 1;
  return path.join(tempDir, `wallet-${fileIndex}.json`);
}

function runTest(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result
        .then(() => console.log(`✓ ${name}`))
        .catch((err) => {
          console.error(`✗ ${name}`);
          throw err;
        });
    }
    console.log(`✓ ${name}`);
    return Promise.resolve();
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    privateKey,
    publicKeyRaw,
    address: encodeBase58(publicKeyRaw),
    sign(message) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      return signEd25519Detached(buf, privateKey);
    },
  };
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload || "";
    },
  };
}

function jsonReq(body, method = "POST") {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.method = method;
  req.headers = { origin: "https://mangomeme.fun" };
  return req;
}

const pending = [];

pending.push(
  runTest("21. valid challenge", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 1_000;
    const created = createLinkToken(11, { walletFile: file, now });
    const result = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: createMemoryRateLimiter() }
    );
    assert.strictEqual(result.ok, true, result.error);
    assert.ok(result.challengeId);
    assert.ok(result.message.includes("ManGo Wallet Verification"));
    assert.ok(result.message.includes("Domain: mangomeme.fun"));
    assert.ok(result.message.includes("No transaction will be sent."));
    assert.ok(result.message.includes("ManGo Telegram account"));
    assert.ok(!result.message.includes("telegramUserId"));
    assert.ok(!result.message.includes("telegram"));
    assert.strictEqual(result.expiresAt, now + 1 + CHALLENGE_TTL_MS);
  })
);

pending.push(
  runTest("22. expired link rejected", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 2_000;
    const created = createLinkToken(12, { walletFile: file, now });
    const result = createChallenge(
      { token: created.token, wallet: wallet.address },
      {
        walletFile: file,
        now: now + LINK_TTL_MS + 1,
        rateLimiter: createMemoryRateLimiter(),
      }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, ERRORS.expired);
  })
);

pending.push(
  runTest("23. used link rejected", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 3_000;
    const created = createLinkToken(13, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const verified = verifyWalletSignature(
      {
        token: created.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature: wallet.sign(challenge.message).toString("base64"),
      },
      { walletFile: file, now: now + 2, rateLimiter: limiter }
    );
    assert.strictEqual(verified.ok, true);
    const again = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 3, rateLimiter: createMemoryRateLimiter() }
    );
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.error, ERRORS.used);
  })
);

pending.push(
  runTest("24. invalid public key rejected", () => {
    const file = walletFile();
    const created = createLinkToken(14, { walletFile: file, now: 4_000 });
    const result = createChallenge(
      { token: created.token, wallet: "not-a-solana-key" },
      { walletFile: file, now: 4_001, rateLimiter: createMemoryRateLimiter() }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, ERRORS.invalid);
  })
);

pending.push(
  runTest("25. challenge bound to wallet", () => {
    const file = walletFile();
    const a = generateSolanaWallet();
    const b = generateSolanaWallet();
    const now = 5_000;
    const created = createLinkToken(15, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: a.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const result = verifyWalletSignature(
      {
        token: created.token,
        wallet: b.address,
        challengeId: challenge.challengeId,
        signature: b.sign(challenge.message).toString("base64"),
      },
      { walletFile: file, now: now + 2, rateLimiter: limiter }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, ERRORS.failed);
  })
);

pending.push(
  runTest("26. challenge bound to token", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 6_000;
    const tokenA = createLinkToken(16, { walletFile: file, now });
    const tokenB = createLinkToken(17, { walletFile: file, now: now + 1 });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: tokenA.token, wallet: wallet.address },
      { walletFile: file, now: now + 2, rateLimiter: limiter }
    );
    const result = verifyWalletSignature(
      {
        token: tokenB.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature: wallet.sign(challenge.message).toString("base64"),
      },
      { walletFile: file, now: now + 3, rateLimiter: limiter }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, ERRORS.failed);
  })
);

pending.push(
  runTest("27. valid Ed25519 signature accepted", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 7_000;
    const created = createLinkToken(18, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const result = verifyWalletSignature(
      {
        token: created.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature: wallet.sign(challenge.message).toString("base64"),
      },
      { walletFile: file, now: now + 2, rateLimiter: limiter }
    );
    assert.strictEqual(result.ok, true, result.error);
  })
);

pending.push(
  runTest("28. invalid signature rejected", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 8_000;
    const created = createLinkToken(19, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const bad = wallet.sign(challenge.message);
    bad[3] ^= 0xff;
    const result = verifyWalletSignature(
      {
        token: created.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature: bad.toString("base64"),
      },
      { walletFile: file, now: now + 2, rateLimiter: limiter }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, ERRORS.failed);
  })
);

pending.push(
  runTest("29. modified message rejected", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 9_000;
    const created = createLinkToken(20, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const result = verifyWalletSignature(
      {
        token: created.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature: wallet.sign("tampered message").toString("base64"),
      },
      { walletFile: file, now: now + 2, rateLimiter: limiter }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, ERRORS.failed);
  })
);

pending.push(
  runTest("30. replay rejected", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 10_000;
    const created = createLinkToken(21, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const payload = {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    };
    assert.strictEqual(
      verifyWalletSignature(payload, { walletFile: file, now: now + 2, rateLimiter: limiter }).ok,
      true
    );
    const replay = verifyWalletSignature(payload, {
      walletFile: file,
      now: now + 3,
      rateLimiter: limiter,
    });
    assert.strictEqual(replay.ok, false);
    assert.strictEqual(replay.error, ERRORS.failed);
  })
);

pending.push(
  runTest("31. expired challenge rejected", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 11_000;
    const created = createLinkToken(22, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const result = verifyWalletSignature(
      {
        token: created.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature: wallet.sign(challenge.message).toString("base64"),
      },
      {
        walletFile: file,
        now: now + 1 + CHALLENGE_TTL_MS + 1,
        rateLimiter: limiter,
      }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, ERRORS.failed);
  })
);

pending.push(
  runTest("32. duplicate wallet rejected", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 12_000;
    const a = createLinkToken(30, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challengeA = createChallenge(
      { token: a.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    assert.strictEqual(
      verifyWalletSignature(
        {
          token: a.token,
          wallet: wallet.address,
          challengeId: challengeA.challengeId,
          signature: wallet.sign(challengeA.message).toString("base64"),
        },
        { walletFile: file, now: now + 2, rateLimiter: limiter }
      ).ok,
      true
    );
    const b = createLinkToken(31, { walletFile: file, now: now + 3 });
    const challengeB = createChallenge(
      { token: b.token, wallet: wallet.address },
      { walletFile: file, now: now + 4, rateLimiter: createMemoryRateLimiter() }
    );
    const taken = verifyWalletSignature(
      {
        token: b.token,
        wallet: wallet.address,
        challengeId: challengeB.challengeId,
        signature: wallet.sign(challengeB.message).toString("base64"),
      },
      { walletFile: file, now: now + 5, rateLimiter: createMemoryRateLimiter() }
    );
    assert.strictEqual(taken.ok, false);
    assert.strictEqual(taken.error, ERRORS.taken);
    assert.ok(!taken.error.includes("30"));
    assert.ok(!taken.error.includes("31"));
  })
);

pending.push(
  runTest("35. rate limit safe", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 13_000;
    const created = createLinkToken(40, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    let limited = false;
    for (let i = 0; i < 11; i += 1) {
      const result = createChallenge(
        { token: created.token, wallet: wallet.address },
        { walletFile: file, now: now + i, rateLimiter: limiter }
      );
      if (result.error === ERRORS.rate) {
        limited = true;
        assert.strictEqual(result.status, 429);
      }
    }
    assert.strictEqual(limited, true);
  })
);

pending.push(
  runTest("36. malformed payload safe", async () => {
    const file = walletFile();
    const res = mockRes();
    const req = Readable.from(["{not-json"]);
    req.method = "POST";
    req.headers = {};
    await tryHandleWalletRequest(req, res, "https://mangomeme.fun", "/wallet/challenge", "POST", {
      walletFile: file,
      rateLimiter: createMemoryRateLimiter(),
    });
    assert.strictEqual(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, "Invalid request.");

    const missing = createChallenge(
      { token: 1, wallet: null },
      { walletFile: file, now: 1, rateLimiter: createMemoryRateLimiter() }
    );
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error, ERRORS.invalid);

    const huge = verifyWalletSignature(
      { token: "x", wallet: "y", challengeId: "z", signature: "!!" },
      { walletFile: file, now: 1, rateLimiter: createMemoryRateLimiter() }
    );
    assert.strictEqual(huge.ok, false);
  })
);

pending.push(
  runTest("HTTP challenge + verify + CORS + no public link create", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 14_000;
    const created = createLinkToken(50, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const origin = "https://mangomeme.fun";

    const challengeRes = mockRes();
    await tryHandleWalletRequest(
      jsonReq({ token: created.token, wallet: wallet.address }),
      challengeRes,
      origin,
      "/wallet/challenge",
      "POST",
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    assert.strictEqual(challengeRes.statusCode, 200);
    assert.strictEqual(challengeRes.headers["Access-Control-Allow-Origin"], origin);
    const challengeBody = JSON.parse(challengeRes.body);
    assert.strictEqual(challengeBody.ok, true);

    const verifyRes = mockRes();
    await tryHandleWalletRequest(
      jsonReq({
        token: created.token,
        wallet: wallet.address,
        challengeId: challengeBody.challengeId,
        signature: wallet.sign(challengeBody.message).toString("base64"),
      }),
      verifyRes,
      origin,
      "/wallet/verify",
      "POST",
      { walletFile: file, now: now + 2, rateLimiter: limiter }
    );
    assert.strictEqual(verifyRes.statusCode, 200);
    assert.strictEqual(JSON.parse(verifyRes.body).ok, true);

    const createRes = mockRes();
    const handled = await tryHandleWalletRequest(
      jsonReq({ telegramUserId: "1" }),
      createRes,
      origin,
      "/wallet/link/create",
      "POST",
      { walletFile: file }
    );
    assert.strictEqual(handled, false);

    const getRes = mockRes();
    await tryHandleWalletRequest(
      jsonReq({}),
      getRes,
      origin,
      "/wallet/challenge",
      "GET",
      { walletFile: file }
    );
    assert.strictEqual(getRes.statusCode, 405);
  })
);

pending.push(
  runTest("highscore-server mounts wallet routes, no public create", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "highscore-server.js"),
      "utf8"
    );
    assert.ok(source.includes("tryHandleWalletRequest"));
    assert.ok(source.includes("/wallet/challenge"));
    assert.ok(source.includes("/wallet/verify"));
    assert.ok(!source.includes("/wallet/link/create"));
  })
);

pending.push(
  runTest("raw token never stored after challenge/verify", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const created = createLinkToken(60, { walletFile: file, now: 20_000 });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: 20_001, rateLimiter: limiter }
    );
    verifyWalletSignature(
      {
        token: created.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature: wallet.sign(challenge.message).toString("base64"),
      },
      { walletFile: file, now: 20_002, rateLimiter: limiter }
    );
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes(created.token));
    assert.ok(raw.includes(hashToken(created.token)) || loadWalletStore(file).users["60"]);
  })
);

pending.push(
  runTest("MAX_BODY_BYTES is bounded", () => {
    assert.ok(MAX_BODY_BYTES <= 16 * 1024);
  })
);

Promise.all(pending).then(() => {
  console.log("wallet-api tests passed");
});
