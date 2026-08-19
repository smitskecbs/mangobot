/**
 * Best-effort community-group announcement after a Mystery Gift is sent.
 * Never rolls back sent status. Never posts wallet, rewardId, tx, or amount.
 * General chat only — never a Games topic thread.
 */

const { escapeTelegramHtml } = require("../utils/solanaWallet");
const { normalizeUserId } = require("./walletLinks");
const {
  sanitizeTelegramUsername,
  sanitizeDisplayName,
  claimMysteryGiftGroupAnnouncement,
  finishMysteryGiftGroupAnnouncement,
} = require("./memberRewards");
const { fetchWithTimeout, TELEGRAM_TIMEOUT_MS } = require("../utils/safeFetch");
const { error: logError, log } = require("../utils/logger");

const ANONYMOUS_CONGRATS = "Congrats to one of our ManGo community members! 🥭";

function isLikelyTestProcess() {
  for (const arg of process.argv) {
    if (typeof arg !== "string") {
      continue;
    }
    const norm = arg.replace(/\\/g, "/");
    if (norm.includes("/tests/") || /\.test\.js$/i.test(norm)) {
      return true;
    }
  }
  return false;
}

function resolveBotToken(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "botToken")) {
    return typeof options.botToken === "string" ? options.botToken.trim() : "";
  }
  return typeof process.env.BOT_TOKEN === "string" ? process.env.BOT_TOKEN.trim() : "";
}

function resolveChatId(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "chatId")) {
    const value = options.chatId;
    return value === undefined || value === null ? "" : String(value).trim();
  }
  return typeof process.env.TELEGRAM_CHAT_ID === "string"
    ? process.env.TELEGRAM_CHAT_ID.trim()
    : "";
}

function lookupPointsDisplayName(userId, pointsFile) {
  if (pointsFile === undefined && isLikelyTestProcess()) {
    return null;
  }
  try {
    const { loadPoints, getUserRecord } = require("./points");
    const user = getUserRecord(loadPoints(pointsFile), userId);
    if (!user || typeof user.name !== "string" || user.name === "Unknown") {
      return null;
    }
    return sanitizeDisplayName(user.name);
  } catch {
    return null;
  }
}

function isSafeTelegramUserId(uid) {
  return typeof uid === "string" && /^\d{1,20}$/.test(uid);
}

/**
 * Server-side identity only. Never uses frontend request fields.
 */
function resolveAnnouncementIdentity(reward, options = {}) {
  const uid = normalizeUserId(reward && reward.telegramUserId);
  const username = sanitizeTelegramUsername(reward && reward.telegramUsername);
  if (username) {
    return { kind: "username", username, telegramUserId: uid };
  }

  let displayName = sanitizeDisplayName(reward && reward.displayNameSnapshot);
  if (!displayName) {
    displayName = lookupPointsDisplayName(uid, options.pointsFile);
  }
  if (displayName && isSafeTelegramUserId(uid)) {
    return { kind: "mention", displayName, telegramUserId: uid };
  }
  return { kind: "anonymous", telegramUserId: uid || null };
}

function buildCongratsLine(identity) {
  if (!identity || identity.kind === "anonymous") {
    return ANONYMOUS_CONGRATS;
  }
  if (identity.kind === "username") {
    return `Congrats @${identity.username}! 🥭`;
  }
  const name = escapeTelegramHtml(identity.displayName);
  return `Congrats <a href="tg://user?id=${identity.telegramUserId}">${name}</a>! 🥭`;
}

function buildMysteryGiftDeliveredMessage(identity) {
  return [
    "🎁 Mystery Gift delivered!",
    "",
    buildCongratsLine(identity),
    "Your Mystery Gift has been successfully delivered.",
    "",
    "✅ Delivered",
    "",
    "Another reward sent to an active ManGo community member. 💛",
  ].join("\n");
}

function visibleAnnouncementText(html) {
  return String(html || "")
    .replace(/<a\s+href="tg:\/\/user\?id=\d+"[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/<[^>]+>/g, "");
}

async function announceMysteryGiftDelivered(rewardId, options = {}) {
  if (isLikelyTestProcess() && options.announceMysteryGift !== true) {
    return { sent: false, skipped: true, reason: "test-process" };
  }

  const botToken = resolveBotToken(options);
  const chatId = resolveChatId(options);
  if (!botToken || !chatId) {
    return { sent: false, skipped: true, reason: "unconfigured" };
  }

  const claimed = claimMysteryGiftGroupAnnouncement(rewardId, {
    rewardsFile: options.rewardsFile,
    now: options.now,
  });
  if (!claimed.ok) {
    return {
      sent: false,
      skipped: true,
      reason: claimed.reason || "not-claimed",
      announced: Boolean(claimed.announced),
    };
  }

  const identity = resolveAnnouncementIdentity(claimed.reward, options);
  const text = buildMysteryGiftDeliveredMessage(identity);
  const fetchFn = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  try {
    const response = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs:
        Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? options.timeoutMs
          : TELEGRAM_TIMEOUT_MS,
      fetchImpl: fetchFn,
    });
    const ok = Boolean(response && response.ok === true);
    finishMysteryGiftGroupAnnouncement(rewardId, ok, {
      rewardsFile: options.rewardsFile,
      now: options.now,
    });
    if (!ok) {
      logError("[delivery] group announcement failed");
      return { sent: false, reason: "telegram_http" };
    }
    log("[delivery] group announcement sent");
    return { sent: true };
  } catch (err) {
    finishMysteryGiftGroupAnnouncement(rewardId, false, {
      rewardsFile: options.rewardsFile,
      now: options.now,
    });
    logError("[delivery] group announcement failed");
    void err;
    return { sent: false, reason: "telegram_error" };
  }
}

module.exports = {
  ANONYMOUS_CONGRATS,
  resolveAnnouncementIdentity,
  buildMysteryGiftDeliveredMessage,
  buildCongratsLine,
  visibleAnnouncementText,
  announceMysteryGiftDelivered,
};
