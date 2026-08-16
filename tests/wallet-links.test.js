/**
 * Persistent wallet-link storage: uniqueness, replace, disconnect, token hashing.
 * Run: node tests/wallet-links.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const {
  getVerifiedWalletForUser,
  isWalletVerified,
  disconnectWallet,
  loadWalletStore,
  mutateWalletStore,
} = require("../services/walletLinks");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  hashToken,
  createMemoryRateLimiter,
  LINK_TTL_MS,
  ERRORS,
} = require("../services/walletVerification");
const { signEd25519Detached } = require("../utils/ed25519");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-links-"));
let fileIndex = 0;

function walletFile() {
  fileIndex += 1;
  return path.join(tempDir, `wallet-links-${fileIndex}.json`);
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

function signAndVerify(file, token, wallet, now) {
  const limiter = createMemoryRateLimiter();
  const challenge = createChallenge(
    { token, wallet: wallet.address },
    { walletFile: file, now, rateLimiter: limiter }
  );
  assert.strictEqual(challenge.ok, true, challenge.error);
  const signature = wallet.sign(challenge.message).toString("base64");
  return verifyWalletSignature(
    {
      token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature,
    },
    { walletFile: file, now: now + 1, rateLimiter: limiter }
  );
}

runTest("9. token hash stored, raw token not stored", () => {
  const file = walletFile();
  const created = createLinkToken(111, { walletFile: file, now: 1_000_000 });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(created.token));
  assert.ok(raw.includes(created.tokenHash));
  assert.strictEqual(created.tokenHash, hashToken(created.token));
  const store = loadWalletStore(file);
  assert.ok(store.linkTokens[created.tokenHash]);
  assert.strictEqual(store.linkTokens[created.tokenHash].telegramUserId, "111");
  assert.ok(!JSON.stringify(store).includes(created.token));
});

runTest("6. token random", () => {
  const file = walletFile();
  const a = createLinkToken(1, { walletFile: file, now: 1 });
  const b = createLinkToken(1, { walletFile: file, now: 2 });
  assert.notStrictEqual(a.token, b.token);
  assert.notStrictEqual(a.tokenHash, b.tokenHash);
  const store = loadWalletStore(file);
  assert.strictEqual(Object.keys(store.linkTokens).length, 1);
  assert.ok(store.linkTokens[b.tokenHash]);
  assert.ok(!store.linkTokens[a.tokenHash]);
});

runTest("5. opaque token no uid in URL", () => {
  const file = walletFile();
  const created = createLinkToken(987654321, {
    walletFile: file,
    now: 50,
    walletConnectUrl: "https://mangomeme.fun/wallet-connect",
  });
  assert.ok(created.url.startsWith("https://mangomeme.fun/wallet-connect?t="));
  assert.ok(!created.url.includes("987654321"));
  assert.ok(!created.url.includes("telegram"));
  assert.ok(!created.url.includes("uid"));
});

runTest("33. successful persistence + helpers", () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  const now = 1_700_000_000_000;
  const created = createLinkToken(42, { walletFile: file, now });
  const result = signAndVerify(file, created.token, wallet, now + 10);
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(isWalletVerified(42, file), true);
  const record = getVerifiedWalletForUser(42, file);
  assert.strictEqual(record.wallet, wallet.address);
  assert.ok(record.verifiedAt);
});

runTest("18. wallet uniqueness", () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  const now = 2_000_000_000_000;
  const a = createLinkToken(1, { walletFile: file, now });
  assert.strictEqual(signAndVerify(file, a.token, wallet, now + 1).ok, true);
  const b = createLinkToken(2, { walletFile: file, now: now + 2 });
  const taken = signAndVerify(file, b.token, wallet, now + 3);
  assert.strictEqual(taken.ok, false);
  assert.strictEqual(taken.error, ERRORS.taken);
  assert.ok(!taken.error.includes("1"));
  assert.ok(!taken.error.includes("2"));
  assert.strictEqual(getVerifiedWalletForUser(1, file).wallet, wallet.address);
  assert.strictEqual(getVerifiedWalletForUser(2, file), null);
});

runTest("19. Telegram uniqueness — one active wallet", () => {
  const file = walletFile();
  const first = generateSolanaWallet();
  const second = generateSolanaWallet();
  const now = 3_000_000_000_000;
  const a = createLinkToken(9, { walletFile: file, now });
  assert.strictEqual(signAndVerify(file, a.token, first, now + 1).ok, true);
  const b = createLinkToken(9, { walletFile: file, now: now + 2 });
  assert.strictEqual(signAndVerify(file, b.token, second, now + 3).ok, true);
  assert.strictEqual(getVerifiedWalletForUser(9, file).wallet, second.address);
  const store = loadWalletStore(file);
  assert.ok(!store.wallets[first.address]);
  assert.strictEqual(store.wallets[second.address], "9");
});

runTest("16. replace leaves old wallet until success", () => {
  const file = walletFile();
  const oldWallet = generateSolanaWallet();
  const newWallet = generateSolanaWallet();
  const now = 4_000_000_000_000;
  const first = createLinkToken(5, { walletFile: file, now });
  assert.strictEqual(signAndVerify(file, first.token, oldWallet, now + 1).ok, true);
  createLinkToken(5, { walletFile: file, now: now + 2 });
  assert.strictEqual(getVerifiedWalletForUser(5, file).wallet, oldWallet.address);
  const challenge = createChallenge(
    { token: createLinkToken(5, { walletFile: file, now: now + 3 }).token, wallet: newWallet.address },
    { walletFile: file, now: now + 4, rateLimiter: createMemoryRateLimiter() }
  );
  assert.strictEqual(challenge.ok, true);
  assert.strictEqual(getVerifiedWalletForUser(5, file).wallet, oldWallet.address);
});

runTest("17. successful replace", () => {
  const file = walletFile();
  const oldWallet = generateSolanaWallet();
  const newWallet = generateSolanaWallet();
  const now = 5_000_000_000_000;
  const first = createLinkToken(8, { walletFile: file, now });
  assert.strictEqual(signAndVerify(file, first.token, oldWallet, now + 1).ok, true);
  const second = createLinkToken(8, { walletFile: file, now: now + 2 });
  assert.strictEqual(signAndVerify(file, second.token, newWallet, now + 3).ok, true);
  assert.strictEqual(getVerifiedWalletForUser(8, file).wallet, newWallet.address);
});

runTest("disconnect removes mapping", () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  const now = 6_000_000_000_000;
  const created = createLinkToken(3, { walletFile: file, now });
  assert.strictEqual(signAndVerify(file, created.token, wallet, now + 1).ok, true);
  const result = disconnectWallet(3, file);
  assert.strictEqual(result.disconnected, true);
  assert.strictEqual(isWalletVerified(3, file), false);
  assert.strictEqual(loadWalletStore(file).wallets[wallet.address], undefined);
});

runTest("34. signature not permanently stored", () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  const now = 7_000_000_000_000;
  const created = createLinkToken(4, { walletFile: file, now });
  const limiter = createMemoryRateLimiter();
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile: file, now: now + 1, rateLimiter: limiter }
  );
  const signature = wallet.sign(challenge.message).toString("base64");
  assert.strictEqual(
    verifyWalletSignature(
      {
        token: created.token,
        wallet: wallet.address,
        challengeId: challenge.challengeId,
        signature,
      },
      { walletFile: file, now: now + 2, rateLimiter: limiter }
    ).ok,
    true
  );
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(signature));
  const store = loadWalletStore(file);
  const saved = store.challenges[challenge.challengeId];
  assert.ok(saved.usedAt);
  assert.ok(!saved.message);
  assert.ok(!saved.nonce);
});

runTest("no XP fields written to wallet store", () => {
  const file = walletFile();
  const wallet = generateSolanaWallet();
  const now = 8_000_000_000_000;
  const created = createLinkToken(6, { walletFile: file, now });
  signAndVerify(file, created.token, wallet, now + 1);
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!/"xp"\s*:/.test(raw));
  assert.ok(!/"points"\s*:/.test(raw));
});

runTest("mutateWalletStore lock + atomic write", () => {
  const file = walletFile();
  mutateWalletStore((store) => {
    store.users["1"] = { wallet: "x", verifiedAt: 1, updatedAt: 1 };
  }, file);
  assert.strictEqual(loadWalletStore(file).users["1"].wallet, "x");
});

runTest("corrupt wallet-links.json is not overwritten with empty store", () => {
  const file = walletFile();
  fs.writeFileSync(file, "{not-json", "utf8");
  assert.throws(() => {
    mutateWalletStore((store) => {
      store.users["1"] = { wallet: "x", verifiedAt: 1, updatedAt: 1 };
    }, file);
  }, /Failed to read wallet-links.json/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "{not-json");
});

runTest("LINK_TTL_MS is 10 minutes", () => {
  assert.strictEqual(LINK_TTL_MS, 10 * 60 * 1000);
});

console.log("wallet-links tests passed");
