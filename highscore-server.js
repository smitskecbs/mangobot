const path = require("path");
const { loadAppEnv } = require("./utils/loadEnv");
loadAppEnv({ envPath: path.join(__dirname, ".env") });
/**
 * ManGo games high-score API — run on the Hetzner bot server.
 *
 * Copy this file to your bot server (e.g. /home/adje/mangobot/highscore-server.js)
 * and start it alongside the bot:
 *
 *   cd /home/adje/mangobot
 *   BOT_TOKEN=your_token TELEGRAM_CHAT_ID=your_chat_id TELEGRAM_BOT_USERNAME=YourBot PORT=8787 node highscore-server.js
 *
 * TELEGRAM_BOT_USERNAME is optional but recommended so highscore announcements can
 * deep-link into private /start snake|bounch (no signed tokens in group messages).
 *
 * Endpoints:
 *   POST /snake-highscore
 *   POST /bounch-highscore
 *   POST /wallet/challenge
 *   POST /wallet/verify
 *   POST /presale/status
 *   POST /presale/prepare
 *   POST /presale/payment
 *   POST /presale/confirm
 *   POST /delivery/status
 *   POST /delivery/payment
 *   POST /delivery/confirm
 *   GET  /health
 *
 * Wallet link tokens are created by the Telegram bot, not by a public HTTP route.
 */

const http = require("node:http");
const {
  getScoresFilePath,
  parseScore,
  sanitizeName,
  submitScore,
  buildApiResponse,
  buildGlobalHighscoreMessage,
  buildPersonalBestMessage,
} = require("./services/snakeScores");
const bounchScores = require("./services/bounchScores");
const { verifyOptionalGameIdentity } = require("./utils/gameIdentity");
const {
  awardSnakeGameXp,
  awardBounchGameXp,
  emptyGameXpPayload,
} = require("./services/points");
const { tryHandleWalletRequest } = require("./services/walletApi");
const { tryHandlePresaleRequest, startPresaleReconciliationTimer, stopPresaleReconciliationTimer } = require("./services/presaleApi");
const { tryHandleDeliveryRequest } = require("./services/deliveryApi");
const { resolveWalletFile } = require("./services/walletLinks");
const { buildApiHealthPayload } = require("./services/apiHealth");
const {
  resolveAllowedOrigin,
  applyCorsHeaders,
} = require("./services/httpCors");
const { fetchWithTimeout, TELEGRAM_TIMEOUT_MS } = require("./utils/safeFetch");
const { pruneTimestampMap } = require("./utils/boundedMap");
const { installProcessGuards } = require("./utils/processGuards");
const { noteRuntimeEvent } = require("./utils/runtimeHealth");
const { error: logError, log } = require("./utils/logger");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
const SCORES_FILE = getScoresFilePath();
const BOUNCH_SCORES_FILE = bounchScores.getScoresFilePath();

const RATE_LIMIT_MS = 30_000;
const RATE_LIMIT_MAX_KEYS = 5000;
const MAX_BODY_BYTES = 32 * 1024;

/** @type {Map<string, number>} */
const lastSubmitByIp = new Map();

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
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
        reject(new Error("Invalid JSON"));
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

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  pruneTimestampMap(lastSubmitByIp, now, RATE_LIMIT_MS * 4, RATE_LIMIT_MAX_KEYS);
  const last = lastSubmitByIp.get(ip) ?? 0;

  if (now - last < RATE_LIMIT_MS) {
    return true;
  }

  lastSubmitByIp.set(ip, now);
  return false;
}

function corsOrigin(req) {
  return resolveAllowedOrigin(req && req.headers ? req.headers.origin : "");
}

function sendJson(res, statusCode, body, origin, identity, xp) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");

  applyCorsHeaders(res, origin);

  let payload = body;

  if (identity) {
    payload = {
      ...payload,
      identity: {
        verified: Boolean(identity.verified),
      },
    };
  }

  if (xp) {
    payload = {
      ...payload,
      xp: {
        awarded: Number(xp.awarded) || 0,
        dailyPlay: Number(xp.dailyPlay) || 0,
        unlock: Number(xp.unlock) || 0,
      },
    };
  }

  res.end(JSON.stringify(payload));
}

function publicXpFromAward(result) {
  if (!result || !result.xp) {
    return emptyGameXpPayload();
  }

  return {
    awarded: result.xp.awarded || 0,
    dailyPlay: result.xp.dailyPlay || 0,
    unlock: result.xp.unlock || 0,
  };
}

/**
 * Award game XP only for verified identity. Never throws to callers.
 * Score persistence must remain successful even if this fails.
 */
function tryAwardSnakeGameXp(identity, playerName) {
  if (!identity || !identity.verified || !identity.uid) {
    return emptyGameXpPayload();
  }

  try {
    return publicXpFromAward(awardSnakeGameXp(identity.uid, playerName));
  } catch {
    console.error("[ManGo Highscore API] Failed to award Snake XP");
    return emptyGameXpPayload();
  }
}

function tryAwardBounchGameXp(identity, playerName, level) {
  if (!identity || !identity.verified || !identity.uid) {
    return emptyGameXpPayload();
  }

  try {
    return publicXpFromAward(awardBounchGameXp(identity.uid, playerName, level));
  } catch {
    console.error("[ManGo Highscore API] Failed to award Bounch XP");
    return emptyGameXpPayload();
  }
}

async function sendTelegramMessage(text) {
  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  try {
    const response = await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
      timeoutMs: TELEGRAM_TIMEOUT_MS,
    });
    return response.ok;
  } catch (err) {
    const code = (err && err.code) || (err && err.name) || "Error";
    console.error(`[api] telegram notify failed error=${code}`);
    return false;
  }
}

async function handleSnakeHighscore(req, res, origin) {
  if (isRateLimited(clientIp(req))) {
    sendJson(res, 429, { ok: false, error: "Too many submissions. Try again later." }, origin);
    return;
  }

  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body." }, origin);
    return;
  }

  const score = parseScore(body.score);

  if (score === null) {
    sendJson(res, 400, { ok: false, error: "Invalid score." }, origin);
    return;
  }

  const name = sanitizeName(body.name);

  if (!name) {
    sendJson(res, 400, { ok: false, error: "Invalid name." }, origin);
    return;
  }

  // Optional signed game token — never blocks public submit; uid never trusted from body.
  const identity = verifyOptionalGameIdentity(body.t, "snake");
  const verifiedTelegramUserId =
    identity && identity.verified && identity.uid ? identity.uid : undefined;

  let submission;

  try {
    submission = submitScore(SCORES_FILE, name, score, {
      verifiedTelegramUserId,
    });
  } catch {
    sendJson(res, 500, { ok: false, error: "Failed to save score." }, origin);
    return;
  }

  if (submission.error) {
    sendJson(res, 400, { ok: false, error: submission.error }, origin);
    return;
  }

  // XP only after a valid persisted submit; failures here must not undo the score.
  const xp = tryAwardSnakeGameXp(identity, name);

  const { data, result } = submission;

  const responseBase = {
    score: result.score,
    personalBestScore: result.personalBestScore,
    rank: result.rank,
    isNewGlobal: result.isNewGlobal,
    gamesPlayed: result.gamesPlayed,
    lastScore: result.lastScore,
    lastPlayedAt: result.lastPlayedAt,
  };

  if (!result.personalBest) {
    sendJson(
      res,
      200,
      buildApiResponse(data, {
        ...responseBase,
        posted: false,
        personalBest: false,
        personalBestImproved: false,
        reason: "not_personal_best",
      }),
      origin,
      identity,
      xp
    );
    return;
  }

  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    sendJson(
      res,
      200,
      buildApiResponse(data, {
        ...responseBase,
        posted: false,
        personalBest: true,
        personalBestImproved: true,
        reason: "telegram_not_configured",
      }),
      origin,
      identity,
      xp
    );
    return;
  }

  const telegramText = result.isNewGlobal
    ? buildGlobalHighscoreMessage(result.name, result.score)
    : buildPersonalBestMessage(result.name, result.score, result.rank);

  try {
    const posted = await sendTelegramMessage(telegramText);

    sendJson(
      res,
      200,
      buildApiResponse(data, {
        ...responseBase,
        posted,
        personalBest: true,
        personalBestImproved: true,
        reason: posted ? undefined : "telegram_send_failed",
      }),
      origin,
      identity,
      xp
    );
  } catch {
    sendJson(
      res,
      502,
      buildApiResponse(data, {
        ...responseBase,
        posted: false,
        personalBest: true,
        personalBestImproved: true,
        reason: "telegram_send_failed",
      }),
      origin,
      identity,
      xp
    );
  }
}

async function handleBounchHighscore(req, res, origin) {
  if (isRateLimited(clientIp(req))) {
    sendJson(res, 429, { ok: false, error: "Too many submissions. Try again later." }, origin);
    return;
  }

  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body." }, origin);
    return;
  }

  const level = bounchScores.parseLevel(body.level);

  if (level === null) {
    sendJson(res, 400, { ok: false, error: "Invalid level." }, origin);
    return;
  }

  const name = bounchScores.sanitizeName(body.name);

  if (!name) {
    sendJson(res, 400, { ok: false, error: "Invalid name." }, origin);
    return;
  }

  // Optional signed game token — never blocks public submit; uid never trusted from body.
  const identity = verifyOptionalGameIdentity(body.t, "bounch");
  const verifiedTelegramUserId =
    identity && identity.verified && identity.uid ? identity.uid : undefined;

  let submission;

  try {
    submission = bounchScores.submitLevel(BOUNCH_SCORES_FILE, name, level, {
      verifiedTelegramUserId,
    });
  } catch {
    sendJson(res, 500, { ok: false, error: "Failed to save level." }, origin);
    return;
  }

  if (submission.error) {
    sendJson(res, 400, { ok: false, error: submission.error }, origin);
    return;
  }

  // XP only after a valid persisted submit; failures here must not undo the level.
  const xp = tryAwardBounchGameXp(identity, name, level);

  const { data, result } = submission;

  const responseBase = {
    name: result.name,
    level: result.level,
    bestLevel: result.bestLevel,
    rank: result.rank,
    isNewGlobal: result.isNewGlobal,
    gamesPlayed: result.gamesPlayed,
    lastLevel: result.lastLevel,
    lastPlayedAt: result.lastPlayedAt,
  };

  if (!result.personalBest) {
    sendJson(
      res,
      200,
      bounchScores.buildApiResponse(data, {
        ...responseBase,
        posted: false,
        personalBest: false,
        personalBestImproved: false,
        reason: "not_personal_best",
      }),
      origin,
      identity,
      xp
    );
    return;
  }

  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    sendJson(
      res,
      200,
      bounchScores.buildApiResponse(data, {
        ...responseBase,
        posted: false,
        personalBest: true,
        personalBestImproved: true,
        reason: "telegram_not_configured",
      }),
      origin,
      identity,
      xp
    );
    return;
  }

  const telegramText = result.isNewGlobal
    ? bounchScores.buildGlobalBestMessage(result.name, result.level)
    : bounchScores.buildPersonalBestMessage(result.name, result.level, result.rank);

  try {
    const posted = await sendTelegramMessage(telegramText);

    sendJson(
      res,
      200,
      bounchScores.buildApiResponse(data, {
        ...responseBase,
        posted,
        personalBest: true,
        personalBestImproved: true,
        reason: posted ? undefined : "telegram_send_failed",
      }),
      origin,
      identity,
      xp
    );
  } catch {
    sendJson(
      res,
      502,
      bounchScores.buildApiResponse(data, {
        ...responseBase,
        posted: false,
        personalBest: true,
        personalBestImproved: true,
        reason: "telegram_send_failed",
      }),
      origin,
      identity,
      xp
    );
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split("?")[0] || "/";
  const origin = corsOrigin(req);
  const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : "(none)";

  log(`[api] ${req.method} ${url} origin=${requestOrigin}`);

  try {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      applyCorsHeaders(res, origin);
      res.end();
      return;
    }

    if (url === "/snake-highscore" && req.method === "POST") {
      await handleSnakeHighscore(req, res, origin);
      return;
    }

    if (url === "/bounch-highscore" && req.method === "POST") {
      await handleBounchHighscore(req, res, origin);
      return;
    }

    if (await tryHandleWalletRequest(req, res, origin, url, req.method)) {
      return;
    }

    if (await tryHandlePresaleRequest(req, res, origin, url, req.method)) {
      return;
    }

    if (await tryHandleDeliveryRequest(req, res, origin, url, req.method)) {
      return;
    }

    if (url === "/health" && req.method === "GET") {
      const payload = buildApiHealthPayload({
        walletFile: resolveWalletFile(),
      });
      sendJson(res, payload.ok ? 200 : 503, payload, origin);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" }, origin);
  } catch (err) {
    const code = (err && err.code) || (err && err.name) || "Error";
    logError(`[api] request failed code=${code}`);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "Temporary error." }, origin);
    }
  }
});

server.listen(PORT, () => {
  log(`[startup] highscore-api listening port=${PORT}`);
  log(`[startup] snake-file=${SCORES_FILE}`);
  log(`[startup] bounch-file=${BOUNCH_SCORES_FILE}`);
  log(`[startup] wallet-file-configured=yes`);

  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("[startup] telegram notify disabled");
  }
  startPresaleReconciliationTimer();
});

let shuttingDown = false;
function shutdownApi(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  noteRuntimeEvent("shutdown");
  log(`[shutdown] highscore-api signal=${signal}`);
  stopPresaleReconciliationTimer();
  server.close(() => {
    log("[shutdown] highscore-api closed");
  });
}

process.once("SIGINT", () => shutdownApi("SIGINT"));
process.once("SIGTERM", () => shutdownApi("SIGTERM"));
installProcessGuards({
  name: "highscore-api",
  shutdown: () => shutdownApi("crash"),
  logError,
});
