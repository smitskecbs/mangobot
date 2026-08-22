/**
 * General-chat rank-up announcements after real XP rank transitions.
 * Never changes XP or rank. Never posts to the Games topic.
 */

const { escapeTelegramHtml } = require("../utils/solanaWallet");
const { normalizeUserId } = require("./walletLinks");
const {
  sanitizeTelegramUsername,
  sanitizeDisplayName,
} = require("./memberRewards");
const { fetchWithTimeout, TELEGRAM_TIMEOUT_MS } = require("../utils/safeFetch");
const { error: logError, log } = require("../utils/logger");
const {
  isLikelyTestProcess,
  setRankUpAnnounceFileForTests,
  claimRankUpAnnouncement,
  finishRankUpAnnouncement,
  loadRankUpStore,
  rankUpEventId,
  CLAIM_TTL_MS,
} = require("./rankUpAnnounceStore");

const ANNOUNCE_RANK_TITLES = Object.freeze([
  "Sprout",
  "Tree",
  "Mango Tree",
  "Guardian",
  "Legend",
]);
const ANNOUNCE_RANK_SET = new Set(ANNOUNCE_RANK_TITLES);
const FALLBACK_MEMBER = "A ManGo community member";
const HINT_TTL_MS = 10 * 60 * 1000;
const HINT_MAX = 5_000;

const identityHints = new Map();
let runtimeConfig = {};
let pending = Promise.resolve();

function configureRankUpAnnounceForTests(config) {
  runtimeConfig = config && typeof config === "object" ? { ...config } : {};
  if (Object.prototype.hasOwnProperty.call(runtimeConfig, "storeFile")) {
    setRankUpAnnounceFileForTests(runtimeConfig.storeFile);
  }
}

function enabledInTests(options = {}) {
  return Boolean(
    (options && options.announceRankUp === true) || runtimeConfig.enabled === true
  );
}

function shouldSkipAnnounce(options = {}) {
  return isLikelyTestProcess() && !enabledInTests(options);
}

function resolveBotToken(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "botToken")) {
    return typeof options.botToken === "string" ? options.botToken.trim() : "";
  }
  if (Object.prototype.hasOwnProperty.call(runtimeConfig, "botToken")) {
    return typeof runtimeConfig.botToken === "string"
      ? runtimeConfig.botToken.trim()
      : "";
  }
  return typeof process.env.BOT_TOKEN === "string"
    ? process.env.BOT_TOKEN.trim()
    : "";
}

function resolveChatId(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "chatId")) {
    const value = options.chatId;
    return value === undefined || value === null ? "" : String(value).trim();
  }
  if (runtimeConfig.chatId != null) {
    return String(runtimeConfig.chatId).trim();
  }
  return typeof process.env.TELEGRAM_CHAT_ID === "string"
    ? process.env.TELEGRAM_CHAT_ID.trim()
    : "";
}

function nowMs(options = {}) {
  if (Number.isFinite(options.now)) {
    return options.now;
  }
  if (Number.isFinite(runtimeConfig.now)) {
    return runtimeConfig.now;
  }
  return Date.now();
}

function pruneIdentityHints(now) {
  for (const [key, value] of identityHints.entries()) {
    if (!value || !Number.isFinite(value.at) || now - value.at > HINT_TTL_MS) {
      identityHints.delete(key);
    }
  }
  while (identityHints.size > HINT_MAX) {
    const first = identityHints.keys().next().value;
    identityHints.delete(first);
  }
}

function noteRankUpIdentity(from) {
  if (!from || from.is_bot) {
    return;
  }
  const uid = normalizeUserId(from.id);
  if (!uid) {
    return;
  }
  const now = Date.now();
  pruneIdentityHints(now);
  identityHints.set(uid, {
    username: sanitizeTelegramUsername(from.username),
    displayName:
      sanitizeDisplayName(from.first_name) ||
      sanitizeDisplayName(from.last_name) ||
      null,
    at: now,
  });
}

function lookupPointsDisplayName(userId, pointsFile) {
  const file =
    pointsFile !== undefined
      ? pointsFile
      : runtimeConfig.pointsFile !== undefined
        ? runtimeConfig.pointsFile
        : undefined;
  if (file === undefined) {
    return null;
  }
  try {
    const { loadPoints, getUserRecord } = require("./points");
    const user = getUserRecord(loadPoints(file), userId);
    if (!user || typeof user.name !== "string" || user.name === "Unknown") {
      return null;
    }
    return sanitizeDisplayName(user.name);
  } catch (_err) {
    return null;
  }
}

function isSafeTelegramUserId(uid) {
  return typeof uid === "string" && /^\d{1,20}$/.test(uid);
}

function resolveRankUpIdentity(input = {}, options = {}) {
  const uid = normalizeUserId(input.telegramUserId || input.userId);
  const hint = uid ? identityHints.get(uid) : null;
  const username =
    sanitizeTelegramUsername(input.username) ||
    (hint && hint.username) ||
    null;
  if (username) {
    return { kind: "username", username, telegramUserId: uid };
  }

  let displayName =
    sanitizeDisplayName(input.displayName) ||
    sanitizeDisplayName(input.userName) ||
    (hint && hint.displayName) ||
    null;
  if (!displayName) {
    displayName = lookupPointsDisplayName(uid, options.pointsFile);
  }
  if (displayName && isSafeTelegramUserId(uid)) {
    return { kind: "mention", displayName, telegramUserId: uid };
  }
  if (displayName) {
    return { kind: "display", displayName, telegramUserId: uid || null };
  }
  return { kind: "anonymous", telegramUserId: uid || null };
}

function mentionHtml(identity) {
  if (!identity || identity.kind === "anonymous") {
    return escapeTelegramHtml(FALLBACK_MEMBER);
  }
  if (identity.kind === "username") {
    return `@${identity.username}`;
  }
  if (identity.kind === "mention") {
    const name = escapeTelegramHtml(identity.displayName);
    return `<a href="tg://user?id=${identity.telegramUserId}">${name}</a>`;
  }
  return escapeTelegramHtml(identity.displayName || FALLBACK_MEMBER);
}

function buildRankUpAnnouncementHtml(rankTitle, identity) {
  const mention = mentionHtml(identity);
  if (rankTitle === "Sprout") {
    return [
      "🌱 Rank Up!",
      "",
      `Congrats ${mention}! 🥭`,
      "You reached Sprout.",
      "",
      "Keep playing, building and helping the ManGo community grow. 💛",
    ].join("\n");
  }
  if (rankTitle === "Tree") {
    return [
      "🌳 Rank Up!",
      "",
      `Congrats ${mention}! 🥭`,
      "You reached Tree.",
      "",
      "Your activity is starting to leave a mark on the community.",
    ].join("\n");
  }
  if (rankTitle === "Mango Tree") {
    return [
      "🥭 Rank Up!",
      "",
      `Congrats ${mention}! 🥭`,
      "You reached Mango Tree.",
      "",
      "You're becoming a core part of the ManGo community.",
    ].join("\n");
  }
  if (rankTitle === "Guardian") {
    return [
      "🛡 Rank Up!",
      "",
      `${mention} reached Guardian. 🥭`,
      "",
      "One of ManGo's most active community members.",
    ].join("\n");
  }
  if (rankTitle === "Legend") {
    return [
      "🔥 Rank Up!",
      "",
      `${mention} just reached Legend. 🥭`,
      "",
      "That takes real activity and consistency.",
    ].join("\n");
  }
  return "";
}

function visibleAnnouncementText(html) {
  return String(html || "")
    .replace(/<a\s+href="tg:\/\/user\?id=\d+"[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/<[^>]+>/g, "");
}

function rankTitleFromResult(result) {
  return result && result.rank && typeof result.rank.title === "string"
    ? result.rank.title
    : "";
}

function isTrueRankUp(result) {
  if (!result || result.awarded !== true || result.rankUp !== true) {
    return false;
  }
  const rank = rankTitleFromResult(result);
  const previous =
    result.previousRank && typeof result.previousRank.title === "string"
      ? result.previousRank.title
      : "";
  return Boolean(rank && previous !== rank && ANNOUNCE_RANK_SET.has(rank));
}

async function sendRankUpMessage(rankTitle, identity, options = {}) {
  const botToken = resolveBotToken(options);
  const chatId = resolveChatId(options);
  if (!botToken || !chatId) {
    return { sent: false, reason: "unconfigured" };
  }
  const text = buildRankUpAnnouncementHtml(rankTitle, identity);
  if (!text) {
    return { sent: false, reason: "unsupported-rank" };
  }
  const fetchFn =
    typeof options.fetchImpl === "function"
      ? options.fetchImpl
      : typeof runtimeConfig.fetchImpl === "function"
        ? runtimeConfig.fetchImpl
        : fetch;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  try {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs:
          Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : TELEGRAM_TIMEOUT_MS,
        fetchImpl: fetchFn,
      }
    );
    if (!response || response.ok !== true) {
      return { sent: false, reason: "telegram-error" };
    }
    return { sent: true };
  } catch (_err) {
    return { sent: false, reason: "telegram-error" };
  }
}

async function announceClaimedRank(userId, rankTitle, identity, options) {
  log(`[rank-up] announcement claimed rank=${rankTitle}`);
  const sent = await sendRankUpMessage(rankTitle, identity, options);
  try {
    finishRankUpAnnouncement(userId, rankTitle, sent.sent === true, options);
  } catch (err) {
    logError("[rank-up] announcement finish failed");
  }
  if (!sent.sent) {
    logError(
      `[rank-up] announcement failed rank=${rankTitle} reason=${sent.reason || "telegram-error"}`
    );
    return { sent: false, reason: sent.reason || "telegram-error", rankTitle };
  }
  log(`[rank-up] announcement sent rank=${rankTitle}`);
  return { sent: true, rankTitle };
}

async function announceRankUp(input = {}, options = {}) {
  const opts = { ...runtimeConfig, ...options };
  if (shouldSkipAnnounce(opts)) {
    return { sent: false, skipped: true, reason: "test-process" };
  }
  const result = input.result || input;
  const uid = normalizeUserId(input.telegramUserId || input.userId);
  if (!uid) {
    return { sent: false, skipped: true, reason: "invalid-user" };
  }
  const identity = resolveRankUpIdentity(input, opts);
  const storeOpts = {
    storeFile: opts.storeFile,
    now: nowMs(opts),
  };

  if (isTrueRankUp(result)) {
    const rankTitle = rankTitleFromResult(result);
    let claimed;
    try {
      claimed = claimRankUpAnnouncement(uid, rankTitle, storeOpts);
    } catch (err) {
      logError("[rank-up] announcement claim failed");
      return { sent: false, reason: "store-error" };
    }
    if (!claimed.ok) {
      return {
        sent: false,
        skipped: true,
        reason: claimed.reason,
        announced: Boolean(claimed.announced),
      };
    }
    return announceClaimedRank(uid, rankTitle, identity, opts);
  }

  if (result && result.awarded === true) {
    const current = rankTitleFromResult(result);
    if (!ANNOUNCE_RANK_SET.has(current)) {
      return { sent: false, skipped: true, reason: "not-rank-up" };
    }
    const eventId = rankUpEventId(uid, current);
    const snapshot = loadRankUpStore(opts.storeFile);
    const row = snapshot.announcements && snapshot.announcements[eventId];
    if (!row || row.state === "sent" || Number(row.announcedAt) > 0) {
      return { sent: false, skipped: true, reason: "not-rank-up" };
    }
    if (row.state !== "pending") {
      const claimedAt = Number(row.claimedAt) || 0;
      if (row.state === "sending" && nowMs(opts) - claimedAt < CLAIM_TTL_MS) {
        return { sent: false, skipped: true, reason: "in-flight" };
      }
    }
    let claimed;
    try {
      claimed = claimRankUpAnnouncement(uid, current, storeOpts);
    } catch (err) {
      logError("[rank-up] announcement claim failed");
      return { sent: false, reason: "store-error" };
    }
    if (!claimed.ok) {
      return { sent: false, skipped: true, reason: claimed.reason };
    }
    return announceClaimedRank(uid, current, identity, opts);
  }

  return { sent: false, skipped: true, reason: "not-rank-up" };
}

function maybeAnnounceRankUp(input, options) {
  const job = announceRankUp(input, options).catch((err) => {
    logError("[rank-up] announcement failed rank=unknown reason=internal-error");
    return { sent: false, reason: "internal-error" };
  });
  pending = pending.then(() => job, () => job);
  return job;
}

function queueRankUpAnnouncement(input) {
  if (shouldSkipAnnounce(input)) {
    return;
  }
  maybeAnnounceRankUp(input);
}

function whenRankUpIdle() {
  return pending;
}

module.exports = {
  ANNOUNCE_RANK_TITLES,
  FALLBACK_MEMBER,
  configureRankUpAnnounceForTests,
  noteRankUpIdentity,
  resolveRankUpIdentity,
  mentionHtml,
  buildRankUpAnnouncementHtml,
  visibleAnnouncementText,
  isTrueRankUp,
  announceRankUp,
  maybeAnnounceRankUp,
  queueRankUpAnnouncement,
  whenRankUpIdle,
};
