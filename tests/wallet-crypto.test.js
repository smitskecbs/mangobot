/**
 * Base58, Ed25519, and wallet display helpers.
 * Run: node tests/wallet-crypto.test.js
 */

const assert = require("assert");
const crypto = require("node:crypto");
const { encodeBase58, decodeBase58 } = require("../utils/base58");
const {
  verifyEd25519Detached,
  signEd25519Detached,
} = require("../utils/ed25519");
const {
  normalizeSolanaPublicKey,
  isValidSolanaPublicKey,
  shortenWallet,
  escapeTelegramHtml,
  formatVerifiedDate,
} = require("../utils/solanaWallet");

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
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyRaw = spki.subarray(-32);
  return {
    privateKey,
    publicKeyRaw,
    address: encodeBase58(publicKeyRaw),
  };
}

runTest("base58 roundtrip 32-byte keys", () => {
  const bytes = crypto.randomBytes(32);
  const encoded = encodeBase58(bytes);
  const decoded = decodeBase58(encoded);
  assert.ok(decoded);
  assert.deepStrictEqual(decoded, bytes);
});

runTest("base58 system program zeros", () => {
  const zeros = Buffer.alloc(32);
  const encoded = encodeBase58(zeros);
  assert.strictEqual(encoded, "1".repeat(32));
  assert.deepStrictEqual(decodeBase58(encoded), zeros);
});

runTest("invalid base58 rejected", () => {
  assert.strictEqual(decodeBase58("0OIl"), null);
  assert.strictEqual(decodeBase58(""), null);
  assert.strictEqual(normalizeSolanaPublicKey("not-a-key"), null);
  assert.strictEqual(isValidSolanaPublicKey("short"), false);
});

runTest("normalizeSolanaPublicKey accepts generated wallet", () => {
  const wallet = generateSolanaWallet();
  assert.strictEqual(normalizeSolanaPublicKey(wallet.address), wallet.address);
  assert.strictEqual(isValidSolanaPublicKey(wallet.address), true);
});

runTest("Ed25519 valid signature accepted", () => {
  const wallet = generateSolanaWallet();
  const message = Buffer.from("ManGo Wallet Verification\nNonce: abc", "utf8");
  const signature = signEd25519Detached(message, wallet.privateKey);
  assert.strictEqual(signature.length, 64);
  assert.strictEqual(
    verifyEd25519Detached(message, signature, wallet.publicKeyRaw),
    true
  );
});

runTest("Ed25519 invalid signature rejected", () => {
  const wallet = generateSolanaWallet();
  const message = Buffer.from("hello", "utf8");
  const signature = signEd25519Detached(message, wallet.privateKey);
  signature[0] ^= 0xff;
  assert.strictEqual(
    verifyEd25519Detached(message, signature, wallet.publicKeyRaw),
    false
  );
});

runTest("Ed25519 modified message rejected", () => {
  const wallet = generateSolanaWallet();
  const message = Buffer.from("original", "utf8");
  const signature = signEd25519Detached(message, wallet.privateKey);
  assert.strictEqual(
    verifyEd25519Detached(Buffer.from("tampered", "utf8"), signature, wallet.publicKeyRaw),
    false
  );
});

runTest("shortenWallet 4...4", () => {
  assert.strictEqual(shortenWallet("7AbcDEFG9XYZMango"), "7Abc...ango");
  assert.strictEqual(shortenWallet("12345678"), "12345678");
  assert.strictEqual(shortenWallet(""), "");
});

runTest("escapeTelegramHtml", () => {
  assert.strictEqual(escapeTelegramHtml("<b>&"), "&lt;b&gt;&amp;");
});

runTest("formatVerifiedDate UTC", () => {
  assert.strictEqual(formatVerifiedDate(Date.UTC(2026, 7, 16)), "2026-08-16");
});

console.log("wallet-crypto tests passed");
