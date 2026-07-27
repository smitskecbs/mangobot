require("dotenv").config();
 /**
 * ManGo Snake high-score API — run on the Hetzner bot server.
 *
 * Copy this file to your bot server (e.g. /home/adje/mangobot/highscore-server.js)
 * and start it alongside the bot:
 *
 *   cd /home/adje/mangobot
 *   BOT_TOKEN=your_token TELEGRAM_CHAT_ID=your_chat_id PORT=8787 node highscore-server.js
 *
 * From this repo (local test):
 *   BOT_TOKEN=... TELEGRAM_CHAT_ID=... node server/highscore-server.js
 *
 * Website env (Vercel / .env):
 *   VITE_MANGO_HIGHSCORE_API_URL=https://your-hetzner-host/snake-highscore
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
const SCORES_FILE =
  process.env.SNAKE_SCORES_FILE ||
  path.join(__dirname, "snake-highscores.json");

const MAX_SCORE = 100_000;
const MAX_NAME_LENGTH = 24;
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

function loadGlobalHighScore() {
  try {
    if (!fs.existsSync(SCORES_FILE)) {
      return 0;
    }

    const raw = fs.readFileSync(SCORES_FILE, "utf8");
    const data = JSON.parse(raw);
    const score = Number.parseInt(String(data.globalHighScore ?? 0), 10);

    return Number.isFinite(score) && score > 0 ? score : 0;
  } catch {
    return 0;
  }
}

function saveGlobalHighScore(score, name) {
  const payload = {
    globalHighScore: score,
    name,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(SCORES_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function sanitizeName(raw) {
  if (typeof raw !== "string") {
    return "ManGo Player";
  }

  const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
  const safe = trimmed.replace(/[^\w\s-]/gi, "").replace(/\s+/g, " ").trim();

  return safe || "ManGo Player";
}

function parseScore(raw) {
  const score = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);

  if (!Number.isFinite(score) || !Number.isInteger(score)) {
    return null;
  }

  if (score <= 0 || score > MAX_SCORE) {
    return null;
  }

  return score;
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

function sendJson(res, statusCode, body, origin) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");

  applyCorsHeaders(res, origin);

  res.end(JSON.stringify(body));
}

function buildTelegramMessage(name, score) {
  return [
    "🥭 New ManGo Snake high score!",
    "",
    `🏆 ${name}`,
    `Score: ${score}`,
    "",
    "Play ManGo Snake in ManGo Labs 🥭",
  ].join("\n");
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

  const globalHighScore = loadGlobalHighScore();

  if (score <= globalHighScore) {
    sendJson(
      res,
      200,
      {
        ok: true,
        posted: false,
        reason: "not_higher_than_global",
        globalHighScore,
      },
      origin
    );
    return;
  }

  const name = sanitizeName(body.name);
  saveGlobalHighScore(score, name);

  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    sendJson(
      res,
      200,
      {
        ok: true,
        posted: false,
        reason: "telegram_not_configured",
        globalHighScore: score,
      },
      origin
    );
    return;
  }

  try {
    const posted = await sendTelegramMessage(buildTelegramMessage(name, score));

    sendJson(
      res,
      200,
      {
        ok: true,
        posted,
        reason: posted ? undefined : "telegram_send_failed",
        globalHighScore: score,
      },
      origin
    );
  } catch {
    sendJson(
      res,
      502,
      {
        ok: true,
        posted: false,
        reason: "telegram_send_failed",
        globalHighScore: score,
      },
      origin
    );
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split("?")[0] || "/";
  const origin = corsOrigin(req);
  const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : "(none)";

  console.log(`[ManGo Snake API] ${req.method} ${url} Origin: ${requestOrigin}`);

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

  if (url === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, service: "mango-snake-highscore" }, origin);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" }, origin);
});

server.listen(PORT, () => {
  console.log(`ManGo Snake high-score API listening on port ${PORT}`);
  console.log(`Scores file: ${SCORES_FILE}`);

  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured — scores will be saved but not posted.");
  }
});
