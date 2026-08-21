/**
 * Best-effort private DMs for Community Builder milestones.
 * Never rolls back scores. Never logs invite URLs or user ids.
 */

const { normalizeUserId } = require("./walletLinks");
const { fetchWithTimeout, TELEGRAM_TIMEOUT_MS } = require("../utils/safeFetch");

function joinMessage(xpAwarded, walletLocked) {
  if (walletLocked || !xpAwarded) {
    return [
      "🤝 New referral!",
      "",
      "Someone joined ManGo through your invite link.",
      "",
      "+1 Builder Point",
      "🔒 XP not awarded — link your wallet with /wallet",
    ].join("\n");
  }
  return [
    "🤝 New referral!",
    "",
    "Someone joined ManGo through your invite link.",
    "",
    "+1 Builder Point",
    "+1 XP",
  ].join("\n");
}

function walletMessage(xpAwarded, walletLocked) {
  if (walletLocked || !xpAwarded) {
    return [
      "🤝 Referral milestone!",
      "",
      "One of your referrals linked a wallet.",
      "",
      "+1 Builder Point",
      "🔒 XP not awarded — link your wallet with /wallet",
    ].join("\n");
  }
  return [
    "🤝 Referral milestone!",
    "",
    "One of your referrals linked a wallet.",
    "",
    "+1 Builder Point",
    "+1 XP",
  ].join("\n");
}

function activeMessage() {
  return [
    "🌱 Referral became active!",
    "",
    "+2 Builder Points",
  ].join("\n");
}

function buildCommunityBuilderMessage(kind, payload = {}) {
  if (kind === "wallet") {
    return walletMessage(payload.xpAwarded, payload.walletLocked);
  }
  if (kind === "active") {
    return activeMessage();
  }
  if (kind === "manual-award") {
    const points = Number(payload.points) || 0;
    const note =
      typeof payload.note === "string" && payload.note.trim()
        ? payload.note.trim().slice(0, 120)
        : "Builder contribution";
    return [
      "🤝 Community Builder Award!",
      "",
      `You received +${points} BP.`,
      "",
      "Reason:",
      note,
      "",
      "Your Builder Points help you climb the Community Builder leaderboard. 🥭",
    ].join("\n");
  }
  return joinMessage(payload.xpAwarded, payload.walletLocked);
}

function resolveBotToken(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "botToken")) {
    return typeof options.botToken === "string" ? options.botToken.trim() : "";
  }
  return typeof process.env.BOT_TOKEN === "string"
    ? process.env.BOT_TOKEN.trim()
    : "";
}

async function notifyCommunityBuilder(kind, payload, options = {}) {
  const uid = normalizeUserId(
    (payload && (payload.userId || payload.inviterUserId)) || ""
  );
  const botToken = resolveBotToken(options);
  if (!uid || !botToken) {
    return { sent: false, skipped: true };
  }

  const text = buildCommunityBuilderMessage(kind, payload);
  const fetchFn = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;

  try {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: uid,
          text,
          disable_web_page_preview: true,
        }),
        timeoutMs:
          Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : TELEGRAM_TIMEOUT_MS,
        fetchImpl: fetchFn,
      }
    );
    if (!response || response.ok !== true) {
      return { sent: false };
    }
    return { sent: true };
  } catch (_err) {
    return { sent: false };
  }
}

module.exports = {
  buildCommunityBuilderMessage,
  notifyCommunityBuilder,
};
