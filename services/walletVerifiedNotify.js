/**
 * Best-effort private Telegram confirmation after a wallet is persisted.
 * Never rolls back verification. Never logs tokens, signatures, user ids, or wallets.
 */

const { shortenWallet } = require("../utils/solanaWallet");
const { normalizeUserId } = require("./walletLinks");

function buildWalletVerifiedMessage(wallet) {
  const short = shortenWallet(wallet);
  return [
    "🥭 Wallet verified!",
    "",
    "Your Solana wallet is now securely linked to your ManGo profile.",
    "",
    `Wallet: ${short}`,
    "",
    "You’re ready for future ManGo rewards, Mystery Gifts and presale participation. 🎁",
  ].join("\n");
}

function resolveBotToken(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "botToken")) {
    return typeof options.botToken === "string" ? options.botToken.trim() : "";
  }
  return typeof process.env.BOT_TOKEN === "string" ? process.env.BOT_TOKEN.trim() : "";
}

/**
 * @param {{ telegramUserId?: unknown, wallet?: unknown }} payload
 * @param {{ botToken?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ sent: boolean, skipped?: boolean }>}
 */
async function notifyWalletVerified(payload, options = {}) {
  const uid = normalizeUserId(payload && payload.telegramUserId);
  const wallet = typeof payload.wallet === "string" ? payload.wallet : "";
  const botToken = resolveBotToken(options);
  if (!uid || !wallet || !botToken) {
    return { sent: false, skipped: true };
  }

  const text = buildWalletVerifiedMessage(wallet);
  const fetchFn = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;

  try {
    const response = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: uid,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!response || response.ok !== true) {
      console.error("[wallet-verify] notify failed error=telegram_http");
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    const code = (err && err.code) || (err && err.name) || "Error";
    console.error(`[wallet-verify] notify failed error=${code}`);
    return { sent: false };
  }
}

module.exports = {
  buildWalletVerifiedMessage,
  notifyWalletVerified,
};
