/**
 * Full wallet verify persistence: write to disk, reload, mapping survives.
 * Run: node tests/wallet-verify-persistence.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
  hashToken,
} = require("../services/walletVerification");
const {
  DEFAULT_WALLET_FILE,
  getVerifiedWalletForUser,
  getWalletStoreCounts,
  loadWalletStore,
} = require("../services/walletLinks");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-persist-"));
let fileIndex = 0;

function walletFile() {
  fileIndex += 1;
  return path.join(tempDir, `persist-${fileIndex}.json`);
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

function runOnce(label) {
  const file = walletFile();
  const userId = String(7000 + fileIndex);
  const wallet = generateSolanaWallet();
  const now = Date.now();
  const limiter = createMemoryRateLimiter();

  const created = createLinkToken(userId, { walletFile: file, now });
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile: file, now: now + 1, rateLimiter: limiter }
  );
  assert.strictEqual(challenge.ok, true, `${label} challenge: ${challenge.error}`);

  const verified = verifyWalletSignature(
    {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    },
    { walletFile: file, now: now + 2, rateLimiter: limiter }
  );
  assert.strictEqual(verified.ok, true, `${label} verify: ${verified.error}`);
  assert.strictEqual(verified.status, 200);
  assert.strictEqual(verified.persistedUserId, undefined);
  assert.strictEqual(verified.persistedWallet, undefined);

  const raw = fs.readFileSync(file, "utf8");
  const disk = JSON.parse(raw);
  assert.ok(disk.users[userId], `${label} disk users missing`);
  assert.strictEqual(disk.users[userId].wallet, wallet.address);
  assert.strictEqual(disk.wallets[wallet.address], userId);
  assert.ok(disk.linkTokens[hashToken(created.token)].usedAt);
  assert.ok(disk.challenges[challenge.challengeId].usedAt);
  assert.ok(!raw.includes(created.token));

  const reloaded = loadWalletStore(file);
  assert.strictEqual(reloaded.users[userId].wallet, wallet.address);
  const mapped = getVerifiedWalletForUser(userId, file);
  assert.ok(mapped);
  assert.strictEqual(mapped.wallet, wallet.address);

  const counts = getWalletStoreCounts(file);
  assert.strictEqual(counts.users, 1);
  assert.strictEqual(counts.wallets, 1);
  assert.ok(counts.linkTokens >= 1);
  assert.ok(counts.challenges >= 1);
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("bot and API default wallet-links path is identical", () => {
  const expected = path.resolve(__dirname, "..", "data", "wallet-links.json");
  assert.strictEqual(DEFAULT_WALLET_FILE, expected);
  const hs = fs.readFileSync(path.join(__dirname, "..", "highscore-server.js"), "utf8");
  assert.ok(hs.includes("tryHandleWalletRequest(req, res, origin, url, req.method)"));
  assert.ok(hs.includes("Wallet links file:"));
  assert.ok(hs.includes("resolveWalletFile()"));
  assert.equal(/walletFile:\s*["']/.test(hs), false);
});

runTest("verify persistence survives disk reload x3", () => {
  runOnce("pass-1");
  runOnce("pass-2");
  runOnce("pass-3");
});

runTest("wallet-verify logs have no secrets", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "services", "walletVerification.js"),
    "utf8"
  );
  assert.ok(src.includes("[wallet-verify] verified persistence success"));
  assert.ok(src.includes("[wallet-verify] persistence failed error="));
  assert.equal(/console\.(log|error)\([^)]*token/.test(src), false);
  assert.equal(/console\.(log|error)\([^)]*signature/.test(src), false);
  assert.equal(/console\.(log|error)\([^)]*telegramUserId/.test(src), false);
});

console.log("wallet-verify-persistence tests passed");
