/**
 * Base58 encode/decode for Solana public keys (Bitcoin alphabet, no checksum).
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map();
for (let i = 0; i < ALPHABET.length; i += 1) {
  ALPHABET_MAP.set(ALPHABET[i], i);
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {string}
 */
function encodeBase58(bytes) {
  if (!bytes || bytes.length === 0) {
    return "";
  }

  const source = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < source.length && source[zeros] === 0) {
    zeros += 1;
  }

  const size = Math.floor((source.length - zeros) * 138 / 100) + 1;
  const b58 = Buffer.alloc(size);
  let length = 0;

  for (let i = zeros; i < source.length; i += 1) {
    let carry = source[i];
    let j = 0;
    for (let k = size - 1; k >= 0 && (carry !== 0 || j < length); k -= 1, j += 1) {
      carry += 256 * b58[k];
      b58[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }

  let start = size - length;
  while (start < size && b58[start] === 0) {
    start += 1;
  }

  let result = "1".repeat(zeros);
  for (let i = start; i < size; i += 1) {
    result += ALPHABET[b58[i]];
  }
  return result;
}

/**
 * @param {unknown} value
 * @returns {Buffer|null}
 */
function decodeBase58(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") {
    zeros += 1;
  }

  const size = Math.floor((value.length - zeros) * 733 / 1000) + 1;
  const b256 = Buffer.alloc(size);
  let length = 0;

  for (let i = zeros; i < value.length; i += 1) {
    const index = ALPHABET_MAP.get(value[i]);
    if (index === undefined) {
      return null;
    }
    let carry = index;
    let j = 0;
    for (let k = size - 1; k >= 0 && (carry !== 0 || j < length); k -= 1, j += 1) {
      carry += 58 * b256[k];
      b256[k] = carry % 256;
      carry = (carry / 256) | 0;
    }
    length = j;
  }

  let start = size - length;
  while (start < size && b256[start] === 0) {
    start += 1;
  }

  const out = Buffer.alloc(zeros + (size - start));
  let offset = zeros;
  for (let i = start; i < size; i += 1) {
    out[offset] = b256[i];
    offset += 1;
  }
  return out;
}

module.exports = {
  ALPHABET,
  encodeBase58,
  decodeBase58,
};
