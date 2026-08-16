/**
 * Public wallet verification HTTP handlers for the Hetzner highscore API.
 *
 * Frontend may call:
 *   POST /wallet/challenge
 *   POST /wallet/verify
 *
 * Link-token creation is NOT public — the Telegram bot creates tokens internally.
 */

const {
  createChallenge,
  verifyWalletSignature,
} = require("./walletVerification");

const MAX_BODY_BYTES = 16 * 1024;

function applyCorsHeaders(res, origin) {
  if (!origin) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, body, origin) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  applyCorsHeaders(res, origin);
  res.end(JSON.stringify(body));
}

function readJsonBodyLimited(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        settled = true;
        reject(new Error("payload-too-large"));
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid-json"));
      }
    });

    req.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
  });
}

function publicResult(result) {
  if (!result || result.ok !== true) {
    return {
      status: (result && result.status) || 400,
      body: {
        ok: false,
        error: (result && result.error) || "Invalid request.",
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      challengeId: result.challengeId,
      message: result.message,
      expiresAt: result.expiresAt,
    },
  };
}

function publicVerifyResult(result) {
  if (!result || result.ok !== true) {
    return {
      status: (result && result.status) || 400,
      body: {
        ok: false,
        error: (result && result.error) || "Invalid request.",
      },
    };
  }
  return {
    status: 200,
    body: { ok: true },
  };
}

async function handleWalletChallenge(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(
      res,
      tooLarge ? 413 : 400,
      { ok: false, error: "Invalid request." },
      origin
    );
    return;
  }

  const result = createChallenge(body, options);
  const mapped = publicResult(result);
  sendJson(res, mapped.status, mapped.body, origin);
}

async function handleWalletVerify(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(
      res,
      tooLarge ? 413 : 400,
      { ok: false, error: "Invalid request." },
      origin
    );
    return;
  }

  const result = verifyWalletSignature(body, options);
  const mapped = publicVerifyResult(result);
  sendJson(res, mapped.status, mapped.body, origin);
}

/**
 * @returns {boolean} true if the request was handled
 */
async function tryHandleWalletRequest(req, res, origin, url, method, options = {}) {
  if (url !== "/wallet/challenge" && url !== "/wallet/verify") {
    return false;
  }

  if (method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed." }, origin);
    return true;
  }

  try {
    if (url === "/wallet/challenge") {
      await handleWalletChallenge(req, res, origin, options);
      return true;
    }

    await handleWalletVerify(req, res, origin, options);
    return true;
  } catch {
    sendJson(res, 500, { ok: false, error: "Invalid request." }, origin);
    return true;
  }
}

module.exports = {
  MAX_BODY_BYTES,
  applyCorsHeaders,
  sendJson,
  readJsonBodyLimited,
  handleWalletChallenge,
  handleWalletVerify,
  tryHandleWalletRequest,
};
