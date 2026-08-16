/**
 * Ed25519 detached-signature verification for Solana signMessage.
 * Uses Node crypto only — no frontend trust.
 *
 * Solana public keys are 32 raw bytes. Node 20 createPublicKey does not
 * accept format:"raw", so we wrap them in the Ed25519 SPKI DER prefix.
 */

const crypto = require("node:crypto");

/** SPKI prefix for a 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * @param {Buffer} publicKey32
 * @returns {crypto.KeyObject|null}
 */
function publicKeyFromSolanaBytes(publicKey32) {
  if (!Buffer.isBuffer(publicKey32) || publicKey32.length !== 32) {
    return null;
  }
  try {
    return crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey32]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/**
 * @param {Buffer} message
 * @param {Buffer} signature 64 bytes
 * @param {Buffer} publicKey 32 bytes
 * @returns {boolean}
 */
function verifyEd25519Detached(message, signature, publicKey) {
  if (!Buffer.isBuffer(message) || message.length === 0) {
    return false;
  }
  if (!Buffer.isBuffer(signature) || signature.length !== 64) {
    return false;
  }
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) {
    return false;
  }

  const key = publicKeyFromSolanaBytes(publicKey);
  if (!key) {
    return false;
  }

  try {
    return crypto.verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/**
 * @param {Buffer} message
 * @param {crypto.KeyObject} privateKey
 * @returns {Buffer}
 */
function signEd25519Detached(message, privateKey) {
  return crypto.sign(null, message, privateKey);
}

module.exports = {
  ED25519_SPKI_PREFIX,
  publicKeyFromSolanaBytes,
  verifyEd25519Detached,
  signEd25519Detached,
};
