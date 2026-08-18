/**
 * Public admin-delivery HTTP handlers.
 *
 *   POST /delivery/status
 *   POST /delivery/payment
 *   POST /delivery/confirm
 *
 * Tokens are created by Telegram /deliver. Frontend never supplies destination/mint/amount.
 */

const { handleCorsPreflight } = require("./httpCors");
const { readJsonBodyLimited, sendJson } = require("./walletApi");
const { error: logError } = require("../utils/logger");
const {
  lookupDeliverySession,
  issueDeliveryPayment,
  confirmDelivery,
  publicStatusForSession,
  ignoreClientOverrides,
} = require("./rewardDelivery");
const {
  getDeliveryConfig,
  safeRpcHost,
  safeLogReason,
  safeErrorName,
  safeErrorCode,
} = require("./deliveryConfig");

const TEMPORARY_ERROR = "Delivery is temporarily unavailable. Please try again.";

function logDeliveryRpcFailure(kind, reason, env) {
  const config = getDeliveryConfig(env);
  const host = safeRpcHost(config.rpcUrl);
  const parts = [
    `[delivery] ${kind} failed`,
    `reason=${safeLogReason(reason)}`,
    `rpcConfigured=${Boolean(config.rpcUrl)}`,
  ];
  if (host) {
    parts.push(`rpcHost=${host}`);
  }
  logError(parts.join(" "));
}

function logDeliveryUnhandled(err) {
  const name = safeErrorName(err);
  const code = safeErrorCode(err);
  const parts = [`[delivery] unhandled error name=${name}`];
  if (code) {
    parts.push(`code=${code}`);
  }
  logError(parts.join(" "));
}

function sessionError(status) {
  if (status === "expired") {
    return {
      status: 400,
      body: { ok: false, error: "This delivery link has expired.", reason: "expired" },
    };
  }
  if (status === "wrong-purpose") {
    return { status: 400, body: { ok: false, error: "Invalid request.", reason: "wrong-purpose" } };
  }
  return { status: 400, body: { ok: false, error: "Invalid request.", reason: "invalid" } };
}

async function handleDeliveryStatus(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(res, tooLarge ? 413 : 400, { ok: false, error: "Invalid request." }, origin);
    return;
  }
  const session = lookupDeliverySession(body && body.token, options);
  if (session.status !== "ok") {
    const mapped = sessionError(session.status);
    sendJson(res, mapped.status, mapped.body, origin);
    return;
  }
  const override = ignoreClientOverrides(body, session.record);
  if (!override.ok) {
    sendJson(res, 400, { ok: false, error: "Invalid request.", reason: override.reason }, origin);
    return;
  }
  sendJson(res, 200, publicStatusForSession(session.record), origin);
}

async function handleDeliveryPayment(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(res, tooLarge ? 413 : 400, { ok: false, error: "Invalid request." }, origin);
    return;
  }
  const result = await issueDeliveryPayment(body && body.token, {
    ...options,
    connectedWallet: body && body.connectedWallet,
    body,
  });
  if (!result.ok) {
    if (typeof result.reason === "string" && result.reason.startsWith("rpc-")) {
      logDeliveryRpcFailure("payment preparation", result.reason, options.env);
    }
    sendJson(res, 400, { ok: false, error: result.error || "Invalid request." }, origin);
    return;
  }
  sendJson(res, 200, result, origin);
}

async function handleDeliveryConfirm(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(res, tooLarge ? 413 : 400, { ok: false, error: "Invalid request." }, origin);
    return;
  }
  const result = await confirmDelivery(body && body.token, body && body.signature, {
    ...options,
    body,
  });
  if (!result.ok) {
    if (typeof result.reason === "string" && result.reason.startsWith("rpc-")) {
      logDeliveryRpcFailure("confirm", result.reason, options.env);
    }
    sendJson(res, 400, { ok: false, error: result.error || "Invalid request.", reason: result.reason }, origin);
    return;
  }
  sendJson(
    res,
    200,
    {
      ok: true,
      signature: result.signature,
      idempotent: Boolean(result.idempotent),
      kind: result.kind,
    },
    origin
  );
}

async function tryHandleDeliveryRequest(req, res, origin, url, method, options = {}) {
  if (url !== "/delivery/status" && url !== "/delivery/payment" && url !== "/delivery/confirm") {
    return false;
  }

  if (method === "OPTIONS") {
    handleCorsPreflight(res, origin);
    return true;
  }

  if (method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed." }, origin);
    return true;
  }

  const config = getDeliveryConfig(options.env);
  if (!config.distributionWallet) {
    sendJson(res, 400, { ok: false, error: "Distribution wallet is not configured." }, origin);
    return true;
  }

  try {
    if (url === "/delivery/status") {
      await handleDeliveryStatus(req, res, origin, options);
      return true;
    }
    if (url === "/delivery/payment") {
      await handleDeliveryPayment(req, res, origin, options);
      return true;
    }
    await handleDeliveryConfirm(req, res, origin, options);
    return true;
  } catch (err) {
    logDeliveryUnhandled(err);
    sendJson(res, 500, { ok: false, error: TEMPORARY_ERROR }, origin);
    return true;
  }
}

module.exports = {
  tryHandleDeliveryRequest,
  handleDeliveryStatus,
  handleDeliveryPayment,
  handleDeliveryConfirm,
};
