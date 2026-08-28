/**
 * Best-effort private Mystery Gift DM after verified Sent.
 * Never rolls back sent. Never includes amount, wallet, tx, or rewardId.
 */

const { normalizeUserId } = require("./walletLinks");
const {
  claimMysteryGiftRecipientNotification,
  finishMysteryGiftRecipientNotification,
} = require("./memberRewards");
const { fetchWithTimeout, TELEGRAM_TIMEOUT_MS } = require("../utils/safeFetch");
const { error: logError, log } = require("../utils/logger");

const RECIPIENT_MESSAGE = [
  "🎁 Mystery Gift delivered!",
  "",
  "Your Mystery Gift has been successfully delivered to your registered Solana wallet.",
  "",
  "Status: ✅ Sent",
].join("\n");

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

function isOffchainSent(reward) {
  if (!reward || reward.status !== "sent") {
    return false;
  }
  return reward.assetType === "offchain" || reward.deliveryType === "offchain";
}

function offchainRecipientMessage(label) {
  return [
    "🎁 Mystery Gift delivered!",
    "",
    "You received:",
    label,
    "",
    "Status: ✅ Delivered",
  ].join("\n");
}

function buildMysteryGiftRecipientMessage(reward) {
  const label =
    isOffchainSent(reward) && typeof reward.offchainGiftLabel === "string"
      ? reward.offchainGiftLabel.trim()
      : "";
  if (label) {
    return offchainRecipientMessage(label);
  }
  return RECIPIENT_MESSAGE;
}

async function notifyMysteryGiftRecipient(rewardId, options = {}) {
  if (isLikelyTestProcess() && options.notifyMysteryGift !== true) {
    return { sent: false, skipped: true, reason: "test-process" };
  }

  const botToken = resolveBotToken(options);
  if (!botToken) {
    return { sent: false, skipped: true, reason: "unconfigured" };
  }

  const claimed = claimMysteryGiftRecipientNotification(rewardId, {
    rewardsFile: options.rewardsFile,
    now: options.now,
  });
  if (!claimed.ok) {
    return {
      sent: false,
      skipped: true,
      reason: claimed.reason || "not-claimed",
      notified: Boolean(claimed.notified || claimed.done),
    };
  }

  const uid = normalizeUserId(claimed.reward && claimed.reward.telegramUserId);
  if (!uid) {
    finishMysteryGiftRecipientNotification(rewardId, false, {
      rewardsFile: options.rewardsFile,
      now: options.now,
    });
    return { sent: false, skipped: true, reason: "missing-user" };
  }

  const fetchFn = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const payload = {
    chat_id: uid,
    text: buildMysteryGiftRecipientMessage(claimed.reward),
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
    finishMysteryGiftRecipientNotification(rewardId, ok, {
      rewardsFile: options.rewardsFile,
      now: options.now,
    });
    if (!ok) {
      logError("[reward-notification] failed error=telegram_http");
      return { sent: false, reason: "telegram_http" };
    }
    log("[reward-notification] recipient sent");
    return { sent: true };
  } catch (err) {
    finishMysteryGiftRecipientNotification(rewardId, false, {
      rewardsFile: options.rewardsFile,
      now: options.now,
    });
    logError("[reward-notification] failed error=telegram_error");
    void err;
    return { sent: false, reason: "telegram_error" };
  }
}

module.exports = {
  RECIPIENT_MESSAGE,
  buildMysteryGiftRecipientMessage,
  notifyMysteryGiftRecipient,
};
