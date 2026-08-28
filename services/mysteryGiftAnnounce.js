/**
 * Best-effort community-group announcement after a Mystery Gift is sent.
 * Never rolls back sent status. Never posts wallet, rewardId, tx, or secrets.
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
const {
  ASSET_MANGO,
  ASSET_NFT,
  ASSET_OFFCHAIN,
  MANGO_MINT_DECIMALS,
  formatMangoGrouped,
  formatMangoHuman,
  parseBaseUnits,
} = require("./deliveryConstants");
const { fetchWithTimeout, TELEGRAM_TIMEOUT_MS } = require("../utils/safeFetch");
const { error: logError, log } = require("../utils/logger");
const { safeLogReason } = require("./deliveryConfig");

const ANONYMOUS_CONGRATS = "A ManGo community member received a Mystery Gift. 🥭";

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

function safeRewardId(rewardId) {
  const id = typeof rewardId === "string" ? rewardId.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,24}$/.test(id)) {
    return "unknown";
  }
  return id;
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
    return `@${identity.username} received a ManGo Mystery Gift. 🥭`;
  }
  const name = escapeTelegramHtml(identity.displayName);
  return `<a href="tg://user?id=${identity.telegramUserId}">${name}</a> received a ManGo Mystery Gift. 🥭`;
}

function formatHumanAmount(baseUnits, decimals) {
  const parsed = parseBaseUnits(baseUnits);
  const dec = Number(decimals);
  if (!parsed.ok || !Number.isInteger(dec) || dec < 0 || dec > 18) {
    return "";
  }
  const scale = 10n ** BigInt(dec);
  const value = BigInt(parsed.lamports);
  const whole = value / scale;
  const frac = value % scale;
  if (frac === 0n) {
    return whole.toString();
  }
  return `${whole.toString()}.${frac.toString().padStart(dec, "0").replace(/0+$/, "")}`;
}

function safePublicAssetLabel(value) {
  if (typeof value !== "string") {
    return "";
  }
  const cleaned = value.replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
  if (!cleaned || /wallet|signature|mint|tx/i.test(cleaned)) {
    return "";
  }
  return escapeTelegramHtml(cleaned);
}

/**
 * Public reward line. Never includes wallet, mint, tx, or off-chain gift names.
 */
function formatPublicRewardLine(reward) {
  if (!reward || typeof reward !== "object") {
    return "Reward: a ManGo Mystery Gift";
  }
  const assetType = typeof reward.assetType === "string" ? reward.assetType : "";
  const deliveryType = typeof reward.deliveryType === "string" ? reward.deliveryType : "";
  if (assetType === ASSET_OFFCHAIN || deliveryType === "offchain") {
    return "Reward: a community Mystery Gift";
  }
  if (assetType === ASSET_NFT || deliveryType === "nft") {
    return "Reward: an NFT Mystery Gift";
  }

  let human =
    typeof reward.amountHuman === "string" && reward.amountHuman.trim()
      ? reward.amountHuman.trim()
      : "";
  const decimals = Number.isInteger(reward.decimals)
    ? reward.decimals
    : assetType === ASSET_MANGO || !assetType
      ? MANGO_MINT_DECIMALS
      : null;
  if (!human && reward.amountBaseUnits != null && Number.isInteger(decimals)) {
    human =
      assetType === ASSET_MANGO || !assetType
        ? formatMangoHuman(reward.amountBaseUnits, decimals)
        : formatHumanAmount(reward.amountBaseUnits, decimals);
  }
  if (!human) {
    return "Reward: a ManGo Mystery Gift";
  }
  if (assetType === ASSET_MANGO || !assetType) {
    return `Reward: ${formatMangoGrouped(human)} MANGO`;
  }
  const label = safePublicAssetLabel(reward.assetLabel) || "SPL Token";
  return `Reward: ${escapeTelegramHtml(human)} ${label}`;
}

function buildMysteryGiftDeliveredMessage(identity, reward) {
  return [
    "🎁 Mystery Gift delivered!",
    "",
    buildCongratsLine(identity),
    "",
    formatPublicRewardLine(reward),
    "",
    "Enjoy! 🎉",
  ].join("\n");
}

function visibleAnnouncementText(html) {
  return String(html || "")
    .replace(/<a\s+href="tg:\/\/user\?id=\d+"[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/<[^>]+>/g, "");
}

function logNotification(event, extra = {}) {
  const parts = [`[reward-notification] ${event}`];
  if (extra.rewardId) {
    parts.push(`rewardId=${safeRewardId(extra.rewardId)}`);
  }
  if (extra.error) {
    parts.push(`error=${safeLogReason(extra.error)}`);
  }
  if (event === "failed") {
    logError(parts.join(" "));
    return;
  }
  log(parts.join(" "));
}

async function announceMysteryGiftDelivered(rewardId, options = {}) {
  if (isLikelyTestProcess() && options.announceMysteryGift !== true) {
    return { sent: false, skipped: true, reason: "test-process" };
  }

  const botToken = resolveBotToken(options);
  const chatId = resolveChatId(options);
  if (!botToken || !chatId) {
    logNotification("skipped", { rewardId, error: "unconfigured" });
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

  logNotification("group start", { rewardId });
  const identity = resolveAnnouncementIdentity(claimed.reward, options);
  const text = buildMysteryGiftDeliveredMessage(identity, claimed.reward);
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
      logNotification("failed", { rewardId, error: "telegram_http" });
      return { sent: false, reason: "telegram_http" };
    }
    logNotification("group sent", { rewardId });
    return { sent: true };
  } catch (err) {
    finishMysteryGiftGroupAnnouncement(rewardId, false, {
      rewardsFile: options.rewardsFile,
      now: options.now,
    });
    logNotification("failed", { rewardId, error: "telegram_error" });
    void err;
    return { sent: false, reason: "telegram_error" };
  }
}

module.exports = {
  ANONYMOUS_CONGRATS,
  resolveAnnouncementIdentity,
  buildMysteryGiftDeliveredMessage,
  buildCongratsLine,
  formatPublicRewardLine,
  visibleAnnouncementText,
  announceMysteryGiftDelivered,
};
