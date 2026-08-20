/**
 * Server-side mint inspection for generic SPL / NFT delivery.
 * Tokenkeg and Token-2022 with a fail-closed mint-extension allowlist.
 * No Helius keys in responses. No secrets in logs.
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
const UNSUPPORTED_EXTENSION =
  "This Token-2022 asset uses extensions that are not supported for automatic delivery.";
const UNSUPPORTED_TOKEN_2022_NFT =
  "Unsupported Token-2022 NFT configuration for automatic delivery.";

const MINT_SIZE = 82;
const ACCOUNT_SIZE = 165;
const ACCOUNT_TYPE_MINT = 1;

const EXTENSION_TYPE_BY_ID = {
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  24: "ConfidentialMintBurn",
  25: "ScaledUiAmount",
  26: "Pausable",
  27: "PausableAccount",
  28: "PermissionedBurn",
};

const SAFE_MINT_EXTENSIONS = new Set(["MintCloseAuthority", "MetadataPointer", "TokenMetadata"]);

const PARSED_EXTENSION_ALIASES = {
  metadatapointer: "MetadataPointer",
  tokenmetadata: "TokenMetadata",
  mintcloseauthority: "MintCloseAuthority",
  transferfeeconfig: "TransferFeeConfig",
  transferfeeamount: "TransferFeeAmount",
  confidentialtransfermint: "ConfidentialTransferMint",
  confidentialtransferaccount: "ConfidentialTransferAccount",
  confidentialtransferfeeconfig: "ConfidentialTransferFeeConfig",
  confidentialtransferfeeamount: "ConfidentialTransferFeeAmount",
  confidentialmintburn: "ConfidentialMintBurn",
  defaultaccountstate: "DefaultAccountState",
  immutableowner: "ImmutableOwner",
  memotransfer: "MemoTransfer",
  nontransferable: "NonTransferable",
  nontransferableaccount: "NonTransferableAccount",
  interestbearingconfig: "InterestBearingConfig",
  cpiguard: "CpiGuard",
  permanentdelegate: "PermanentDelegate",
  transferhook: "TransferHook",
  transferhookaccount: "TransferHookAccount",
  grouppointer: "GroupPointer",
  tokengroup: "TokenGroup",
  groupmemberpointer: "GroupMemberPointer",
  tokengroupmember: "TokenGroupMember",
  scaleduiamount: "ScaledUiAmount",
  scaleduiamountconfig: "ScaledUiAmount",
  pausable: "Pausable",
  pausableaccount: "PausableAccount",
  permissionedburn: "PermissionedBurn",
};

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

function canonicalExtensionName(raw) {
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return EXTENSION_TYPE_BY_ID[raw] || `unknown-${raw}`;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return "unknown";
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("unknown-")) {
    return trimmed;
  }
  if (EXTENSION_TYPE_BY_ID[trimmed]) {
    return EXTENSION_TYPE_BY_ID[trimmed];
  }
  if (SAFE_MINT_EXTENSIONS.has(trimmed) || Object.values(EXTENSION_TYPE_BY_ID).includes(trimmed)) {
    return trimmed;
  }
  const compact = trimmed.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return PARSED_EXTENSION_ALIASES[compact] || `unknown-${compact || "extension"}`;
}

function parseToken2022MintExtensions(buf) {
  if (!Buffer.isBuffer(buf)) {
    return { ok: false, reason: "invalid-mint", extensions: [] };
  }
  if (buf.length <= ACCOUNT_SIZE) {
    return { ok: true, extensions: [] };
  }
  const accountType = buf.readUInt8(ACCOUNT_SIZE);
  if (accountType !== ACCOUNT_TYPE_MINT) {
    return { ok: false, reason: "unsupported-token-2022", extensions: [] };
  }
  const names = [];
  let offset = ACCOUNT_SIZE + 1;
  while (offset + 4 <= buf.length) {
    const typeId = buf.readUInt16LE(offset);
    const length = buf.readUInt16LE(offset + 2);
    offset += 4;
    if (length < 0 || offset + length > buf.length) {
      return { ok: false, reason: "unsupported-token-2022", extensions: names };
    }
    offset += length;
    const name = canonicalExtensionName(typeId);
    if (name === "Uninitialized") {
      continue;
    }
    names.push(name);
  }
  return { ok: true, extensions: names };
}

function extensionsFromParsedInfo(info) {
  if (!info || typeof info !== "object" || !Array.isArray(info.extensions)) {
    return [];
  }
  return info.extensions
    .map((row) => canonicalExtensionName(row && (row.extension || row.extensionType)))
    .filter((name) => name && name !== "Uninitialized");
}

function assessToken2022Extensions(extensions, { expectNft } = {}) {
  const list = Array.isArray(extensions) ? extensions : [];
  for (const raw of list) {
    const name = canonicalExtensionName(raw);
    if (SAFE_MINT_EXTENSIONS.has(name)) {
      continue;
    }
    return {
      ok: false,
      reason: `unsupported-extension:${name}`,
      error: expectNft ? UNSUPPORTED_TOKEN_2022_NFT : UNSUPPORTED_EXTENSION,
      extension: name,
    };
  }
  return { ok: true, extensions: list.map(canonicalExtensionName).filter((n) => n !== "Uninitialized") };
}

function encodeToken2022MintAccount({ decimals = 6, supply = "1000000", extensions = [] } = {}) {
  const mint = Buffer.alloc(ACCOUNT_SIZE);
  mint.writeBigUInt64LE(BigInt(supply), 36);
  mint.writeUInt8(Number(decimals), 44);
  mint.writeUInt8(1, 45);
  const parts = [mint, Buffer.from([ACCOUNT_TYPE_MINT])];
  for (const ext of extensions) {
    const typeId = Number(ext.type);
    const data = Buffer.isBuffer(ext.data) ? ext.data : Buffer.alloc(Number(ext.length) || 0);
    const header = Buffer.alloc(4);
    header.writeUInt16LE(typeId, 0);
    header.writeUInt16LE(data.length, 2);
    parts.push(header, data);
  }
  return Buffer.concat(parts);
}

function parseMintFromAccountValue(value) {
  const owner = typeof value.owner === "string" ? value.owner : "";
  const raw = decodeAccountData(value);
  if (Buffer.isBuffer(raw)) {
    const base = parseMintLayout(raw);
    if (!base) {
      return null;
    }
    if (owner === TOKEN_2022_PROGRAM_ID) {
      const parsedExt = parseToken2022MintExtensions(raw);
      if (!parsedExt.ok) {
        return { owner, base, extensions: [], extensionParseFailed: true };
      }
      return { owner, base, extensions: parsedExt.extensions };
    }
    return { owner, base, extensions: [] };
  }
  if (raw && raw.parsed && raw.parsed.info && typeof raw.parsed.info === "object") {
    const info = raw.parsed.info;
    const decimals = Number(info.decimals);
    const supply = info.supply == null ? null : String(info.supply);
    if (!Number.isInteger(decimals) || supply == null) {
      return null;
    }
    return {
      owner,
      base: { decimals, supply },
      extensions: owner === TOKEN_2022_PROGRAM_ID ? extensionsFromParsedInfo(info) : [],
    };
  }
  return null;
}

async function loadSourceAmount(ownerKey, mint, tokenProgram, rpcCallFn, rpcOptions) {
  const filter =
    tokenProgram === TOKEN_2022_PROGRAM_ID ? { programId: TOKEN_2022_PROGRAM_ID } : { mint };
  const accounts = await rpcCallFn(
    "getTokenAccountsByOwner",
    [ownerKey, filter, { encoding: "jsonParsed", commitment: "finalized" }],
    rpcOptions
  );
  if (!accounts.ok || !accounts.result || !Array.isArray(accounts.result.value)) {
    return null;
  }
  let total = 0n;
  for (const row of accounts.result.value) {
    const parsedInfo =
      row &&
      row.account &&
      row.account.data &&
      row.account.data.parsed &&
      row.account.data.parsed.info;
    const rowMint = parsedInfo && parsedInfo.mint;
    if (normalizeSolanaPublicKey(rowMint) && normalizeSolanaPublicKey(rowMint) !== mint) {
      continue;
    }
    const amount = parsedInfo && parsedInfo.tokenAmount && parsedInfo.tokenAmount.amount;
    const parsedAmount = parseBaseUnits(amount);
    if (parsedAmount.ok) {
      total += BigInt(parsedAmount.lamports);
    }
  }
  return total.toString();
}

async function inspectMint(mint, options = {}) {
  const normalized = normalizeSolanaPublicKey(mint);
  if (!normalized) {
    return { ok: false, reason: "invalid-mint", error: "Enter a valid Solana mint address." };
  }
  const rpcOptions = { rpcUrl: options.rpcUrl, env: options.env };
  const call = typeof options.rpcCall === "function" ? options.rpcCall : rpcCall;
  const info = await call(
    "getAccountInfo",
    [normalized, { encoding: "base64", commitment: "finalized" }],
    rpcOptions
  );
  if (!info.ok || !info.result || !info.result.value) {
    return { ok: false, reason: "mint-not-found", error: "This mint could not be loaded." };
  }
  const value = info.result.value;
  const parsed = parseMintFromAccountValue(value);
  if (!parsed || !parsed.base) {
    return { ok: false, reason: "invalid-mint", error: "This mint could not be loaded." };
  }
  const owner = parsed.owner;
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) {
    return {
      ok: false,
      reason: "unsupported-token-program",
      error: options.expectNft ? UNSUPPORTED_NFT : UNSUPPORTED_TOKEN_2022,
    };
  }
  if (owner === TOKEN_2022_PROGRAM_ID) {
    if (parsed.extensionParseFailed) {
      return {
        ok: false,
        reason: "unsupported-token-2022",
        error: options.expectNft ? UNSUPPORTED_TOKEN_2022_NFT : UNSUPPORTED_EXTENSION,
      };
    }
    const safety = assessToken2022Extensions(parsed.extensions, { expectNft: options.expectNft });
    if (!safety.ok) {
      return safety;
    }
  }

  let sourceAmount = null;
  if (options.sourceOwner) {
    const ownerKey = normalizeSolanaPublicKey(options.sourceOwner);
    if (ownerKey) {
      sourceAmount = await loadSourceAmount(ownerKey, normalized, owner, call, rpcOptions);
    }
  }

  return {
    ok: true,
    mint: normalized,
    tokenProgram: owner,
    decimals: parsed.base.decimals,
    supply: parsed.base.supply,
    extensions: owner === TOKEN_2022_PROGRAM_ID ? parsed.extensions : [],
    sourceAmount,
  };
}

function validateSplMintInfo(info, { amountBaseUnits, expectNft } = {}) {
  if (!info || !info.ok) {
    return info || { ok: false, reason: "invalid-mint", error: "This mint could not be loaded." };
  }
  if (info.tokenProgram === TOKEN_2022_PROGRAM_ID) {
    const safety = assessToken2022Extensions(info.extensions, { expectNft });
    if (!safety.ok) {
      return safety;
    }
  } else if (info.tokenProgram !== TOKEN_PROGRAM_ID) {
    return {
      ok: false,
      reason: "unsupported-token-program",
      error: expectNft ? UNSUPPORTED_NFT : UNSUPPORTED_TOKEN_2022,
    };
  }
  if (expectNft) {
    if (info.decimals !== 0 || String(info.supply) !== "1") {
      return {
        ok: false,
        reason: "unsupported-nft",
        error: info.tokenProgram === TOKEN_2022_PROGRAM_ID ? UNSUPPORTED_TOKEN_2022_NFT : UNSUPPORTED_NFT,
      };
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
  UNSUPPORTED_EXTENSION,
  UNSUPPORTED_TOKEN_2022_NFT,
  SAFE_MINT_EXTENSIONS,
  EXTENSION_TYPE_BY_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  inspectMint,
  validateSplMintInfo,
  parseMintLayout,
  parseToken2022MintExtensions,
  assessToken2022Extensions,
  encodeToken2022MintAccount,
  canonicalExtensionName,
};
