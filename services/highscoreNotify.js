/**
 * Highscore Telegram notify helpers for the public highscore API.
 * Keeps BOT_TOKEN out of logs. Optional TELEGRAM_GAMES_TOPIC_ID only.
 */

const { getGamesTopicIdForApi } = require("../utils/gameTopic");
const { fetchWithTimeout, TELEGRAM_TIMEOUT_MS } = require("../utils/safeFetch");
const { error: defaultLogError, log: defaultLog } = require("../utils/logger");

const TELEGRAM_DESCRIPTION_MAX = 200;

function missingTelegramNotifyKeys(botToken, chatId) {
  const missing = [];
  if (!String(botToken || "").trim()) {
    missing.push("BOT_TOKEN");
  }
  if (!String(chatId || "").trim()) {
    missing.push("TELEGRAM_CHAT_ID");
  }
  return missing;
}

function formatTelegramNotifyDisabledLog(missing) {
  const keys = Array.isArray(missing) && missing.length ? missing.join(",") : "BOT_TOKEN,TELEGRAM_CHAT_ID";
  return `[api] telegram notify skipped missing=${keys}`;
}

function redactTelegramSecrets(text) {
  return String(text || "")
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot<redacted>")
    .replace(/\d{8,}:[A-Za-z0-9_-]{20,}/g, "<redacted>");
}

function summarizeTelegramApiError(status, rawBody) {
  const statusCode = Number.isInteger(status) ? status : 0;
  let errorCode = "";
  let description = "";
  const raw = typeof rawBody === "string" ? rawBody : "";

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (parsed.error_code != null) {
          errorCode = String(parsed.error_code);
        }
        if (typeof parsed.description === "string") {
          description = parsed.description;
        }
      }
    } catch (_err) {
      description = raw.slice(0, TELEGRAM_DESCRIPTION_MAX);
    }
  }

  description = redactTelegramSecrets(description).slice(0, TELEGRAM_DESCRIPTION_MAX);

  return {
    status: statusCode,
    errorCode: errorCode || "none",
    description: description || "none",
  };
}

function formatTelegramNotifyFailureLog(summary) {
  const row = summary && typeof summary === "object" ? summary : summarizeTelegramApiError(0, "");
  return `[api] telegram notify failed status=${row.status} error_code=${row.errorCode} description=${row.description}`;
}

function buildHighscoreSendMessagePayload(text, chatId) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  const threadId = getGamesTopicIdForApi();
  if (threadId != null) {
    payload.message_thread_id = threadId;
  }
  return payload;
}

/**
 * Send a group highscore announcement. Score persistence is the caller's job.
 * @returns {Promise<boolean>}
 */
async function sendHighscoreTelegramMessage(text, options = {}) {
  const logInfo = typeof options.log === "function" ? options.log : defaultLog;
  const logError =
    typeof options.logError === "function" ? options.logError : defaultLogError;
  const fetchFn =
    typeof options.fetchFn === "function" ? options.fetchFn : fetchWithTimeout;
  const botToken = String(
    options.botToken != null ? options.botToken : process.env.BOT_TOKEN || ""
  ).trim();
  const chatId = String(
    options.chatId != null ? options.chatId : process.env.TELEGRAM_CHAT_ID || ""
  ).trim();

  const missing = missingTelegramNotifyKeys(botToken, chatId);
  if (missing.length) {
    logInfo(formatTelegramNotifyDisabledLog(missing));
    return false;
  }

  const payload = buildHighscoreSendMessagePayload(text, chatId);

  try {
    const response = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs: TELEGRAM_TIMEOUT_MS,
    });

    if (response && response.ok) {
      return true;
    }

    let raw = "";
    if (response && typeof response.text === "function") {
      try {
        raw = await response.text();
      } catch (_err) {
        raw = "";
      }
    }

    const summary = summarizeTelegramApiError(response && response.status, raw);
    logError(formatTelegramNotifyFailureLog(summary));
    return false;
  } catch (err) {
    const code = (err && err.code) || (err && err.name) || "Error";
    logError(`[api] telegram notify failed error=${code}`);
    return false;
  }
}

module.exports = {
  missingTelegramNotifyKeys,
  formatTelegramNotifyDisabledLog,
  redactTelegramSecrets,
  summarizeTelegramApiError,
  formatTelegramNotifyFailureLog,
  buildHighscoreSendMessagePayload,
  sendHighscoreTelegramMessage,
};
