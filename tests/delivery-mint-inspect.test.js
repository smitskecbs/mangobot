/**
 * Token-2022 mint inspection allowlist. Temp/mocked RPC only.
 * Run: node tests/delivery-mint-inspect.test.js
 */

const assert = require("assert");
const { generateKeyPairSync } = require("node:crypto");
const { encodeBase58 } = require("../utils/base58");
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require("../services/deliveryConstants");
const {
  inspectMint,
  validateSplMintInfo,
  parseToken2022MintExtensions,
  assessToken2022Extensions,
  encodeToken2022MintAccount,
  UNSUPPORTED_EXTENSION,
  UNSUPPORTED_TOKEN_2022_NFT,
} = require("../services/deliveryMintInspect");

const PUMP_MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";

function pubkey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  return encodeBase58(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
}

function pumpMintAccount() {
  return {
    owner: TOKEN_2022_PROGRAM_ID,
    data: {
      parsed: {
        info: {
          decimals: 6,
          extensions: [
            {
              extension: "metadataPointer",
              state: { authority: null, metadataAddress: PUMP_MINT },
            },
            {
              extension: "tokenMetadata",
              state: {
                additionalMetadata: [],
                mint: PUMP_MINT,
                name: "The Black Bull",
                symbol: "ANSEM",
                updateAuthority: null,
                uri: "https://example.invalid/meta",
              },
            },
          ],
          freezeAuthority: null,
          isInitialized: true,
          mintAuthority: null,
          supply: "998039891015230",
        },
        type: "mint",
      },
      program: "spl-token-2022",
    },
  };
}

function mockRpc(accountValue, { tokenAccounts = [], onCall } = {}) {
  return async (method, params) => {
    if (typeof onCall === "function") {
      onCall(method, params);
    }
    if (method === "getAccountInfo") {
      return { ok: true, result: { value: accountValue } };
    }
    if (method === "getTokenAccountsByOwner") {
      return { ok: true, result: { value: tokenAccounts } };
    }
    return { ok: false };
  };
}

function runTest(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.then(() => console.log(`✓ ${name}`));
  }
  console.log(`✓ ${name}`);
  return result;
}

async function main() {
  await runTest("TLV parser reads MetadataPointer + TokenMetadata after Account::LEN padding", () => {
    const buf = encodeToken2022MintAccount({
      decimals: 6,
      supply: "1000",
      extensions: [
        { type: 18, data: Buffer.alloc(64) },
        { type: 19, data: Buffer.alloc(32) },
      ],
    });
    const parsed = parseToken2022MintExtensions(buf);
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.extensions, ["MetadataPointer", "TokenMetadata"]);
  });

  await runTest("live-shaped 9cRC...pump jsonParsed is MetadataPointer + TokenMetadata and allowed", async () => {
    const info = await inspectMint(PUMP_MINT, { rpcCall: mockRpc(pumpMintAccount()) });
    assert.strictEqual(info.ok, true, info.error);
    assert.strictEqual(info.tokenProgram, TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(info.decimals, 6);
    assert.deepStrictEqual(info.extensions, ["MetadataPointer", "TokenMetadata"]);
    const safety = assessToken2022Extensions(info.extensions);
    assert.strictEqual(safety.ok, true);
  });

  await runTest("Token-2022 source balance uses programId filter", async () => {
    const owner = pubkey();
    const mint = pubkey();
    const calls = [];
    const account = {
      owner: TOKEN_2022_PROGRAM_ID,
      data: {
        parsed: {
          info: {
            decimals: 6,
            supply: "1000",
            extensions: [{ extension: "metadataPointer" }],
            isInitialized: true,
          },
          type: "mint",
        },
        program: "spl-token-2022",
      },
    };
    const tokenAccounts = [
      {
        account: {
          data: {
            parsed: {
              info: {
                mint,
                tokenAmount: { amount: "42" },
              },
            },
          },
        },
      },
    ];
    const info = await inspectMint(mint, {
      sourceOwner: owner,
      rpcCall: mockRpc(account, {
        tokenAccounts,
        onCall(method, params) {
          calls.push({ method, params });
        },
      }),
    });
    assert.strictEqual(info.ok, true, info.error);
    assert.strictEqual(info.sourceAmount, "42");
    const balanceCall = calls.find((row) => row.method === "getTokenAccountsByOwner");
    assert.ok(balanceCall);
    assert.strictEqual(balanceCall.params[1].programId, TOKEN_2022_PROGRAM_ID);
    assert.ok(!balanceCall.params[1].mint);
  });

  const rejectCases = [
    [1, "TransferFeeConfig"],
    [14, "TransferHook"],
    [9, "NonTransferable"],
    [4, "ConfidentialTransferMint"],
    [12, "PermanentDelegate"],
    [6, "DefaultAccountState"],
    [10, "InterestBearingConfig"],
    [20, "GroupPointer"],
    [26, "Pausable"],
    [99, "unknown-99"],
  ];
  for (const [type, name] of rejectCases) {
    await runTest(`reject mint extension ${name}`, () => {
      const buf = encodeToken2022MintAccount({
        extensions: [
          { type: 18, data: Buffer.alloc(64) },
          { type, data: Buffer.alloc(8) },
        ],
      });
      const parsed = parseToken2022MintExtensions(buf);
      const safety = assessToken2022Extensions(parsed.extensions);
      assert.strictEqual(safety.ok, false);
      assert.strictEqual(safety.reason, `unsupported-extension:${name}`);
      assert.strictEqual(safety.error, UNSUPPORTED_EXTENSION);
    });
  }

  await runTest("unsafe Token-2022 NFT uses NFT-specific error", async () => {
    const mint = pubkey();
    const account = {
      owner: TOKEN_2022_PROGRAM_ID,
      data: {
        parsed: {
          info: {
            decimals: 0,
            supply: "1",
            extensions: [{ extension: "transferFeeConfig" }],
            isInitialized: true,
          },
          type: "mint",
        },
        program: "spl-token-2022",
      },
    };
    const info = await inspectMint(mint, { expectNft: true, rpcCall: mockRpc(account) });
    assert.strictEqual(info.ok, false);
    assert.strictEqual(info.error, UNSUPPORTED_TOKEN_2022_NFT);
    assert.ok(String(info.reason).startsWith("unsupported-extension:"));
  });

  await runTest("Tokenkeg mint still inspects without extension allowlist", async () => {
    const mint = pubkey();
    const buf = Buffer.alloc(82);
    buf.writeBigUInt64LE(1000n, 36);
    buf.writeUInt8(9, 44);
    buf.writeUInt8(1, 45);
    const account = {
      owner: TOKEN_PROGRAM_ID,
      data: [buf.toString("base64"), "base64"],
    };
    const info = await inspectMint(mint, { rpcCall: mockRpc(account) });
    assert.strictEqual(info.ok, true, info.error);
    assert.strictEqual(info.tokenProgram, TOKEN_PROGRAM_ID);
    assert.strictEqual(info.decimals, 9);
    assert.deepStrictEqual(info.extensions, []);
  });

  await runTest("validateSplMintInfo allows safe Token-2022 and rejects TransferFee", () => {
    const ok = validateSplMintInfo(
      {
        ok: true,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        decimals: 6,
        supply: "1000",
        extensions: ["MetadataPointer", "TokenMetadata"],
        sourceAmount: "1000",
      },
      { amountBaseUnits: "10" }
    );
    assert.strictEqual(ok.ok, true);
    const bad = validateSplMintInfo(
      {
        ok: true,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        decimals: 6,
        supply: "1000",
        extensions: ["TransferHook"],
        sourceAmount: "1000",
      },
      { amountBaseUnits: "10" }
    );
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, "unsupported-extension:TransferHook");
  });

  console.log("delivery-mint-inspect tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
