/**
 * Private Telegram confirmation after persisted wallet verification.
 * Run: node tests/wallet-verified-notify.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");
const { Readable } = require("stream");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const { shortenWallet } = require("../utils/solanaWallet");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
  LINK_TTL_MS,
  ERRORS,
} = require("../services/walletVerification");
const { tryHandleWalletRequest } = require("../services/walletApi");
const { getVerifiedWalletForUser } = require("../services/walletLinks");
const {
  buildWalletVerifiedMessage,
  notifyWalletVerified,
} = require("../services/walletVerifiedNotify");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-notify-"));
let fileIndex = 0;

function walletFile() {
  fileIndex += 1;
  return path.join(tempDir, `notify-${fileIndex}.json`);
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

function jsonReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.method = "POST";
  req.headers = { origin: "https://mangomeme.fun" };
  return req;
}

function recordingFetch(handler) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    if (typeof handler === "function") {
      return handler(url, init);
    }
    return { ok: true };
  }
  return { calls, fetchImpl };
}

async function httpVerify(opts) {
  const {
    file,
    wallet,
    token,
    challenge,
    now,
    limiter,
    extraBody = {},
    fetchImpl,
    botToken = "test-bot-token",
    confirmVerifiedMapping,
    sendVerifiedNotification,
  } = opts;
  const res = mockRes();
  await tryHandleWalletRequest(
    jsonReq({
      token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
      ...extraBody,
    }),
    res,
    "https://mangomeme.fun",
    "/wallet/verify",
    "POST",
    {
      walletFile: file,
      now,
      rateLimiter: limiter,
      fetchImpl,
      botToken,
      confirmVerifiedMapping,
      sendVerifiedNotification,
    }
  );
  return res;
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

const pending = [];

pending.push(
  runTest("message uses shortened wallet and no full address", () => {
    const wallet = "AbCdEFGHijklmnopqrstuvwxyz012345XyZ9";
    const text = buildWalletVerifiedMessage(wallet);
    const short = shortenWallet(wallet);
    assert.ok(text.startsWith("🥭 Wallet verified!"));
    assert.ok(text.includes("Your Solana wallet is now securely linked to your ManGo profile."));
    assert.ok(text.includes(`Wallet: ${short}`));
    assert.ok(text.includes("You’re ready for future ManGo rewards, Mystery Gifts and presale participation. 🎁"));
    assert.equal(text.includes(wallet), false);
    assert.equal(/uid=|telegramUserId|signature|challenge/i.test(text), false);
  })
);

pending.push(
  runTest("successful persisted verify sends one private Telegram notification", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 50_000;
    const telegramUserId = "88001";
    const created = createLinkToken(telegramUserId, { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const { calls, fetchImpl } = recordingFetch();
    const res = await httpVerify({
      file,
      wallet,
      token: created.token,
      challenge,
      now: now + 2,
      limiter,
      fetchImpl,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.telegramUserId, undefined);
    assert.strictEqual(body.notifyTelegramUserId, undefined);
    assert.strictEqual(calls.length, 1);
    const sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(sent.chat_id, telegramUserId);
    assert.ok(sent.text.includes(`Wallet: ${shortenWallet(wallet.address)}`));
    assert.equal(sent.text.includes(wallet.address), false);
    assert.ok(calls[0].url.includes("/sendMessage"));
    assert.equal(getVerifiedWalletForUser(telegramUserId, file).wallet, wallet.address);
  })
);

pending.push(
  runTest("notification uses server-side token userId, not frontend userId", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 51_000;
    const created = createLinkToken("88002", { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const { calls, fetchImpl } = recordingFetch();
    await httpVerify({
      file,
      wallet,
      token: created.token,
      challenge,
      now: now + 2,
      limiter,
      fetchImpl,
      extraBody: { telegramUserId: "1", uid: "1", userId: "1" },
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(JSON.parse(calls[0].init.body).chat_id, "88002");
    assert.notStrictEqual(JSON.parse(calls[0].init.body).chat_id, "1");
  })
);

pending.push(
  runTest("invalid signature does not notify", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 52_000;
    const created = createLinkToken("88003", { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const { calls, fetchImpl } = recordingFetch();
    const res = mockRes();
    await tryHandleWalletRequest(
      jsonReq({
        token: created.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature: wallet.sign("not-the-challenge-message").toString("base64"),
      }),
      res,
      "https://mangomeme.fun",
      "/wallet/verify",
      "POST",
      {
        walletFile: file,
        now: now + 2,
        rateLimiter: limiter,
        fetchImpl,
        botToken: "test-bot-token",
      }
    );
    assert.ok(res.statusCode >= 400);
    assert.strictEqual(JSON.parse(res.body).ok, false);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(getVerifiedWalletForUser("88003", file), null);
  })
);

pending.push(
  runTest("expired token does not notify", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 53_000;
    const { calls, fetchImpl } = recordingFetch();
    const expiredToken = createLinkToken("88004", { walletFile: file, now });
    const expiredChallenge = mockRes();
    await tryHandleWalletRequest(
      jsonReq({ token: expiredToken.token, wallet: wallet.address }),
      expiredChallenge,
      "https://mangomeme.fun",
      "/wallet/challenge",
      "POST",
      {
        walletFile: file,
        now: now + LINK_TTL_MS + 1,
        rateLimiter: createMemoryRateLimiter(),
        fetchImpl,
        botToken: "test-bot-token",
      }
    );
    assert.strictEqual(expiredChallenge.statusCode, 400);
    assert.strictEqual(JSON.parse(expiredChallenge.body).error, ERRORS.expired);
    assert.strictEqual(calls.length, 0);

    const created = createLinkToken("88014", { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const staleVerify = await httpVerify({
      file,
      wallet,
      token: created.token,
      challenge,
      now: now + LINK_TTL_MS + 2,
      limiter,
      fetchImpl,
    });
    assert.ok(staleVerify.statusCode >= 400);
    assert.strictEqual(JSON.parse(staleVerify.body).ok, false);
    assert.strictEqual(calls.length, 0);
  })
);

pending.push(
  runTest("used token replay does not send a second notification", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 54_000;
    const created = createLinkToken("88005", { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const { calls, fetchImpl } = recordingFetch();
    const first = await httpVerify({
      file,
      wallet,
      token: created.token,
      challenge,
      now: now + 2,
      limiter,
      fetchImpl,
    });
    const replay = await httpVerify({
      file,
      wallet,
      token: created.token,
      challenge,
      now: now + 3,
      limiter,
      fetchImpl,
    });
    assert.strictEqual(first.statusCode, 200);
    assert.ok(replay.statusCode >= 400);
    assert.strictEqual(JSON.parse(replay.body).ok, false);
    assert.strictEqual(calls.length, 1);
  })
);

pending.push(
  runTest("persistence failure does not notify", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 55_000;
    const created = createLinkToken("88006", { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const { calls, fetchImpl } = recordingFetch();
    const res = await httpVerify({
      file,
      wallet,
      token: created.token,
      challenge,
      now: now + 2,
      limiter,
      fetchImpl,
      confirmVerifiedMapping: () => null,
    });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).ok, false);
    assert.strictEqual(calls.length, 0);
  })
);

pending.push(
  runTest("Telegram send failure keeps wallet verified and API success", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 56_000;
    const created = createLinkToken("88007", { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const { calls, fetchImpl } = recordingFetch(async () => {
      throw Object.assign(new Error("network"), { code: "ECONNRESET" });
    });
    const errors = [];
    const original = console.error;
    console.error = (...args) => {
      errors.push(args.map(String).join(" "));
    };
    let res;
    try {
      res = await httpVerify({
        file,
        wallet,
        token: created.token,
        challenge,
        now: now + 2,
        limiter,
        fetchImpl,
      });
    } finally {
      console.error = original;
    }
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).ok, true);
    assert.strictEqual(getVerifiedWalletForUser("88007", file).wallet, wallet.address);
    assert.strictEqual(calls.length, 1);
    assert.ok(errors.some((line) => line.includes("[wallet-verify] notify failed error=")));
    assert.equal(errors.some((line) => line.includes("88007")), false);
    assert.equal(errors.some((line) => line.includes(wallet.address)), false);
    assert.equal(errors.some((line) => line.includes(created.token)), false);
  })
);

pending.push(
  runTest("Telegram HTTP error still returns verification success", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 57_000;
    const created = createLinkToken("88008", { walletFile: file, now });
    const limiter = createMemoryRateLimiter();
    const challenge = createChallenge(
      { token: created.token, wallet: wallet.address },
      { walletFile: file, now: now + 1, rateLimiter: limiter }
    );
    const { fetchImpl } = recordingFetch(async () => ({ ok: false, status: 502 }));
    const res = await httpVerify({
      file,
      wallet,
      token: created.token,
      challenge,
      now: now + 2,
      limiter,
      fetchImpl,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).ok, true);
    assert.strictEqual(getVerifiedWalletForUser("88008", file).wallet, wallet.address);
  })
);

pending.push(
  runTest("replace wallet sends the same confirmation once per successful verify", async () => {
    const file = walletFile();
    const firstWallet = generateSolanaWallet();
    const secondWallet = generateSolanaWallet();
    const now = 58_000;
    const { calls, fetchImpl } = recordingFetch();
    const firstToken = createLinkToken("88009", { walletFile: file, now });
    const firstLimiter = createMemoryRateLimiter();
    const firstChallenge = createChallenge(
      { token: firstToken.token, wallet: firstWallet.address },
      { walletFile: file, now: now + 1, rateLimiter: firstLimiter }
    );
    await httpVerify({
      file,
      wallet: firstWallet,
      token: firstToken.token,
      challenge: firstChallenge,
      now: now + 2,
      limiter: firstLimiter,
      fetchImpl,
    });
    const secondToken = createLinkToken("88009", { walletFile: file, now: now + 3 });
    const secondLimiter = createMemoryRateLimiter();
    const secondChallenge = createChallenge(
      { token: secondToken.token, wallet: secondWallet.address },
      { walletFile: file, now: now + 4, rateLimiter: secondLimiter }
    );
    await httpVerify({
      file,
      wallet: secondWallet,
      token: secondToken.token,
      challenge: secondChallenge,
      now: now + 5,
      limiter: secondLimiter,
      fetchImpl,
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(getVerifiedWalletForUser("88009", file).wallet, secondWallet.address);
    const secondText = JSON.parse(calls[1].init.body).text;
    assert.ok(secondText.includes(`Wallet: ${shortenWallet(secondWallet.address)}`));
  })
);

pending.push(
  runTest("challenge creation does not notify", async () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 59_000;
    const created = createLinkToken("88010", { walletFile: file, now });
    const { calls, fetchImpl } = recordingFetch();
    const res = mockRes();
    await tryHandleWalletRequest(
      jsonReq({ token: created.token, wallet: wallet.address }),
      res,
      "https://mangomeme.fun",
      "/wallet/challenge",
      "POST",
      {
        walletFile: file,
        now: now + 1,
        rateLimiter: createMemoryRateLimiter(),
        fetchImpl,
        botToken: "test-bot-token",
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.length, 0);
  })
);

pending.push(
  runTest("direct verify without HTTP still persists and does not require Telegram", () => {
    const file = walletFile();
    const wallet = generateSolanaWallet();
    const now = 60_000;
    const created = createLinkToken("88011", { walletFile: file, now });
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
    assert.strictEqual(verified.notifyTelegramUserId, "88011");
    assert.strictEqual(verified.notifyWallet, wallet.address);
    assert.strictEqual(getVerifiedWalletForUser("88011", file).wallet, wallet.address);
  })
);

pending.push(
  runTest("notify helper skips without bot token and does not throw", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const result = await notifyWalletVerified(
      { telegramUserId: "88012", wallet: "AbCdEFGHijklmnopqrstuvwxyz012345XyZ9" },
      { botToken: "", fetchImpl }
    );
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(calls.length, 0);
  })
);

pending.push(
  runTest("no XP reward or presale side effects in notify path", () => {
    const notifySrc = fs.readFileSync(
      path.join(__dirname, "..", "services", "walletVerifiedNotify.js"),
      "utf8"
    );
    const apiSrc = fs.readFileSync(path.join(__dirname, "..", "services", "walletApi.js"), "utf8");
    const verifySrc = fs.readFileSync(
      path.join(__dirname, "..", "services", "walletVerification.js"),
      "utf8"
    );
    for (const src of [notifySrc, apiSrc, verifySrc]) {
      assert.equal(/awardSnakeGameXp|awardBounchGameXp|createReward|presaleContribution/i.test(src), false);
      assert.equal(/signTransaction|sendTransaction/.test(src), false);
    }
    assert.ok(apiSrc.includes("notifyWalletVerified"));
    const verifyFn = apiSrc.indexOf("async function handleWalletVerify");
    const sendInVerify = apiSrc.indexOf("sendJson(res, mapped.status, mapped.body, origin)", verifyFn);
    const notifyInVerify = apiSrc.indexOf("await notify(", verifyFn);
    assert.ok(sendInVerify >= 0 && notifyInVerify > sendInVerify);
  })
);

pending.push(
  runTest("notify logs never include token signature challenge or userId", () => {
    const notifySrc = fs.readFileSync(
      path.join(__dirname, "..", "services", "walletVerifiedNotify.js"),
      "utf8"
    );
    const apiSrc = fs.readFileSync(path.join(__dirname, "..", "services", "walletApi.js"), "utf8");
    assert.ok(notifySrc.includes("[wallet-verify] notify failed error="));
    assert.ok(notifySrc.includes("error=telegram_http"));
    assert.equal(/console\.(log|error)\([^)]*telegramUserId/.test(notifySrc), false);
    assert.equal(/console\.(log|error)\([^)]*chat_id/.test(notifySrc), false);
    assert.equal(/console\.(log|error)\([^)]*BOT_TOKEN/.test(notifySrc), false);
    assert.equal(/console\.(log|error)\([^)]*payload/.test(notifySrc), false);
    assert.equal(/console\.(log|error)\([^)]*signature/.test(notifySrc), false);
    assert.equal(/console\.(log|error)\([^)]*created\.token/.test(notifySrc), false);
    assert.equal(/console\.(log|error)\([^)]*token/.test(apiSrc), false);
    assert.equal(/new Telegraf/.test(notifySrc), false);
    assert.equal(/new Telegraf/.test(apiSrc), false);
  })
);

Promise.all(pending).then(() => {
  console.log("wallet-verified-notify tests passed");
});
