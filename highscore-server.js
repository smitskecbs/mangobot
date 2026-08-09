require("dotenv").config();
/**
 * ManGo games high-score API — run on the Hetzner bot server.
 *
 * Copy this file to your bot server (e.g. /home/adje/mangobot/highscore-server.js)
 * and start it alongside the bot:
 *
 *   cd /home/adje/mangobot
 *   BOT_TOKEN=your_token TELEGRAM_CHAT_ID=your_chat_id PORT=8787 node highscore-server.js
 *
 * Endpoints:
 *   POST /snake-highscore
 *   POST /bounch-highscore
 *   GET  /health
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

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
const SCORES_FILE = getScoresFilePath();
const BOUNCH_SCORES_FILE = bounchScores.getScoresFilePath();

const RATE_LIMIT_MS = 30_000;

const ALLOWED_ORIGINS = new Set([
  "https://mangomeme.fun",
  "https://www.mangomeme.fun",
  "http://mangomeme.fun",
  "http://www.mangomeme.fun",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

/** @type {Map<string, number>} */
const lastSubmitByIp = new Map();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
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

    req.on("error", reject);
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
  const last = lastSubmitByIp.get(ip) ?? 0;

  if (now - last < RATE_LIMIT_MS) {
    return true;
  }

  lastSubmitByIp.set(ip, now);
  return false;
}

function corsOrigin(req) {
  const origin = req.headers.origin;

  if (typeof origin === "string") {
    const normalized = origin.trim();

    if (ALLOWED_ORIGINS.has(normalized)) {
      return normalized;
    }
  }

  return null;
}

function applyCorsHeaders(res, origin) {
  if (!origin) {
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, body, origin, identity) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");

  applyCorsHeaders(res, origin);

  if (identity) {
    body = {
      ...body,
      identity: {
        verified: Boolean(identity.verified),
      },
    };
  }

  res.end(JSON.stringify(body));
}

async function sendTelegramMessage(text) {
  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  return response.ok;
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

  let submission;

  try {
    submission = submitScore(SCORES_FILE, name, score);
  } catch {
    sendJson(res, 500, { ok: false, error: "Failed to save score." }, origin);
    return;
  }

  if (submission.error) {
    sendJson(res, 400, { ok: false, error: submission.error }, origin);
    return;
  }

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
      identity
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
      identity
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
      identity
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
      identity
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

  let submission;

  try {
    submission = bounchScores.submitLevel(BOUNCH_SCORES_FILE, name, level);
  } catch {
    sendJson(res, 500, { ok: false, error: "Failed to save level." }, origin);
    return;
  }

  if (submission.error) {
    sendJson(res, 400, { ok: false, error: submission.error }, origin);
    return;
  }

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
      identity
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
      identity
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
      identity
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
      identity
    );
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split("?")[0] || "/";
  const origin = corsOrigin(req);
  const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : "(none)";

  console.log(`[ManGo Highscore API] ${req.method} ${url} Origin: ${requestOrigin}`);

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

  if (url === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, service: "mango-snake-highscore" }, origin);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" }, origin);
});

server.listen(PORT, () => {
  console.log(`ManGo high-score API listening on port ${PORT}`);
  console.log(`Snake scores file: ${SCORES_FILE}`);
  console.log(`Bounch scores file: ${BOUNCH_SCORES_FILE}`);

  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured — scores will be saved but not posted.");
  }
});
