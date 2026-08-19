/**
 * Server-side mint inspection for generic SPL / NFT delivery.
 * Tokenkeg only. Token-2022 is rejected. No Helius keys in responses.
 */

const { rpcCall } = require("./presaleRpc");
const { normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  parseBaseUnits,
} = require("./deliveryConstants");

const UNSUPPORTED_TOKEN_2022 = "Unsupported token type for automatic delivery.";
const UNSUPPORTED_NFT = "Unsupported NFT type for automatic delivery.";

function decodeAccountData(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value.data) && typeof value.data[0] === "string") {
    try {
      return Buffer.from(value.data[0], value.data[1] === "base64" ? "base64" : "utf8");
    } catch {
      return null;
    }
  }
  if (value.data && typeof value.data === "object" && typeof value.data.parsed === "object") {
    return value.data;
  }
  return null;
}

function parseMintLayout(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 45) {
    return null;
  }
  const supply = buf.readBigUInt64LE(36);
  const decimals = buf.readUInt8(44);
  const initialized = buf.readUInt8(45);
  if (initialized !== 1) {
    return null;
  }
  return { supply: supply.toString(), decimals };
}

async function inspectMint(mint, options = {}) {
  const normalized = normalizeSolanaPublicKey(mint);
  if (!normalized) {
    return { ok: false, reason: "invalid-mint", error: "Enter a valid Solana mint address." };
  }
  const rpcOptions = { rpcUrl: options.rpcUrl, env: options.env };
  const info = await rpcCall(
    "getAccountInfo",
    [normalized, { encoding: "base64", commitment: "finalized" }],
    rpcOptions
  );
  if (!info.ok || !info.result || !info.result.value) {
    return { ok: false, reason: "mint-not-found", error: "This mint could not be loaded." };
  }
  const value = info.result.value;
  const owner = typeof value.owner === "string" ? value.owner : "";
  if (owner === TOKEN_2022_PROGRAM_ID) {
    return {
      ok: false,
      reason: "unsupported-token-2022",
      error: options.expectNft ? UNSUPPORTED_NFT : UNSUPPORTED_TOKEN_2022,
    };
  }
  if (owner !== TOKEN_PROGRAM_ID) {
    return {
      ok: false,
      reason: "unsupported-token-program",
      error: options.expectNft ? UNSUPPORTED_NFT : UNSUPPORTED_TOKEN_2022,
    };
  }
  const raw = decodeAccountData(value);
  const parsed = Buffer.isBuffer(raw) ? parseMintLayout(raw) : null;
  if (!parsed) {
    return { ok: false, reason: "invalid-mint", error: "This mint could not be loaded." };
  }

  let sourceAmount = null;
  if (options.sourceOwner) {
    const ownerKey = normalizeSolanaPublicKey(options.sourceOwner);
    const accounts = await rpcCall(
      "getTokenAccountsByOwner",
      [
        ownerKey,
        { mint: normalized },
        { encoding: "jsonParsed", commitment: "finalized" },
      ],
      rpcOptions
    );
    if (accounts.ok && accounts.result && Array.isArray(accounts.result.value)) {
      let total = 0n;
      for (const row of accounts.result.value) {
        const amount =
          row &&
          row.account &&
          row.account.data &&
          row.account.data.parsed &&
          row.account.data.parsed.info &&
          row.account.data.parsed.info.tokenAmount &&
          row.account.data.parsed.info.tokenAmount.amount;
        const parsedAmount = parseBaseUnits(amount);
        if (parsedAmount.ok) {
          total += BigInt(parsedAmount.lamports);
        }
      }
      sourceAmount = total.toString();
    }
  }

  return {
    ok: true,
    mint: normalized,
    tokenProgram: TOKEN_PROGRAM_ID,
    decimals: parsed.decimals,
    supply: parsed.supply,
    sourceAmount,
  };
}

function validateSplMintInfo(info, { amountBaseUnits, expectNft } = {}) {
  if (!info || !info.ok) {
    return info || { ok: false, reason: "invalid-mint", error: "This mint could not be loaded." };
  }
  if (info.tokenProgram !== TOKEN_PROGRAM_ID) {
    return {
      ok: false,
      reason: "unsupported-token-program",
      error: expectNft ? UNSUPPORTED_NFT : UNSUPPORTED_TOKEN_2022,
    };
  }
  if (expectNft) {
    if (info.decimals !== 0 || String(info.supply) !== "1") {
      return { ok: false, reason: "unsupported-nft", error: UNSUPPORTED_NFT };
    }
    if (String(amountBaseUnits) !== "1") {
      return { ok: false, reason: "invalid-amount", error: "NFT amount must be 1." };
    }
    if (info.sourceAmount != null && BigInt(info.sourceAmount) < 1n) {
      return {
        ok: false,
        reason: "insufficient-balance",
        error: "Distribution wallet does not own this NFT.",
      };
    }
    return { ok: true };
  }
  const amount = parseBaseUnits(amountBaseUnits);
  if (!amount.ok || BigInt(amount.lamports) <= 0n) {
    return { ok: false, reason: "invalid-amount", error: "Enter a valid token amount." };
  }
  if (info.sourceAmount != null && BigInt(info.sourceAmount) < BigInt(amount.lamports)) {
    return {
      ok: false,
      reason: "insufficient-balance",
      error: "Distribution wallet does not have enough of this token.",
    };
  }
  return { ok: true };
}

module.exports = {
  TOKEN_2022_PROGRAM_ID,
  UNSUPPORTED_TOKEN_2022,
  UNSUPPORTED_NFT,
  inspectMint,
  validateSplMintInfo,
  parseMintLayout,
};
