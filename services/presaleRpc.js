/**
 * Trusted Solana JSON-RPC for presale verification.
 * Injectable fetch / getTransaction for tests. No web3.js.
 */

const { getPresaleConfig } = require("./presaleConfig");

const GENERIC_RPC_ERROR = "This transaction could not be verified.";

async function rpcCall(method, params, options = {}) {
  const fetchFn = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const config = getPresaleConfig(options.env);
  const rpcUrl = options.rpcUrl || config.rpcUrl;
  if (!rpcUrl) {
    return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-missing" };
  }
  let response;
  try {
    response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
  } catch {
    return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-network" };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-json" };
  }
  if (!response.ok || (payload && payload.error)) {
    return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-error" };
  }
  return { ok: true, result: payload.result };
}

async function getTransaction(signature, options = {}) {
  if (typeof options.getTransactionImpl === "function") {
    return options.getTransactionImpl(signature, options);
  }
  return rpcCall(
    "getTransaction",
    [
      signature,
      {
        encoding: "jsonParsed",
        commitment: options.commitment || "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ],
    options
  );
}

async function getLatestBlockhash(options = {}) {
  if (typeof options.getLatestBlockhashImpl === "function") {
    return options.getLatestBlockhashImpl(options);
  }
  const result = await rpcCall(
    "getLatestBlockhash",
    [{ commitment: options.commitment || "finalized" }],
    options
  );
  if (!result.ok) {
    return result;
  }
  const value = result.result && result.result.value;
  const blockhash = value && typeof value.blockhash === "string" ? value.blockhash : "";
  const lastValidBlockHeight = Number(value && value.lastValidBlockHeight);
  if (!blockhash || !Number.isFinite(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-blockhash" };
  }
  return { ok: true, blockhash, lastValidBlockHeight };
}

async function getBlockHeight(options = {}) {
  if (typeof options.getBlockHeightImpl === "function") {
    return options.getBlockHeightImpl(options);
  }
  if (options.currentBlockHeight !== undefined && options.currentBlockHeight !== null) {
    const height = Number(options.currentBlockHeight);
    if (!Number.isFinite(height) || height < 0) {
      return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-height" };
    }
    return { ok: true, height };
  }
  const result = await rpcCall("getBlockHeight", [{ commitment: options.commitment || "finalized" }], options);
  if (!result.ok) {
    return result;
  }
  const height = Number(result.result);
  if (!Number.isFinite(height) || height < 0) {
    return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-height" };
  }
  return { ok: true, height };
}

async function getSignaturesForAddress(address, pageOptions = {}, options = {}) {
  if (typeof options.getSignaturesForAddressImpl === "function") {
    return options.getSignaturesForAddressImpl(address, pageOptions, options);
  }
  if (typeof address !== "string" || !address) {
    return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-address" };
  }
  const params = {
    limit: pageOptions.limit || 100,
    commitment: options.commitment || "finalized",
  };
  if (typeof pageOptions.before === "string" && pageOptions.before) {
    params.before = pageOptions.before;
  }
  const result = await rpcCall("getSignaturesForAddress", [address, params], options);
  if (!result.ok) {
    return result;
  }
  if (!Array.isArray(result.result)) {
    return { ok: false, error: GENERIC_RPC_ERROR, reason: "rpc-signatures" };
  }
  return { ok: true, result: result.result };
}

module.exports = {
  rpcCall,
  getTransaction,
  getLatestBlockhash,
  getBlockHeight,
  getSignaturesForAddress,
  GENERIC_RPC_ERROR,
};
