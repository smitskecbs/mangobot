/**
 * Best-effort private Telegram confirmation after a presale contribution is persisted.
 * Never rolls back the ledger. Never logs tokens, signatures, user ids, or wallets.
 */

const { shortenWallet } = require("../utils/solanaWallet");
const { normalizeUserId } = require("./walletLinks");
const { formatLamportsAsSol, formatMangoHuman } = require("./presaleConstants");

function buildPresaleConfirmedMessage(contribution) {
  const short = shortenWallet(contribution && contribution.walletSnapshot);
  const sol = formatLamportsAsSol(contribution && contribution.contributedLamports);
  const mango = formatMangoHuman(contribution && contribution.mangoAllocationBaseUnits);
  return [
    "🥭 Presale contribution confirmed!",
    "",
    `Contribution: ${sol} SOL`,
    `MANGO allocation: ${mango} MANGO`,
    "",
    `Wallet: ${short}`,
    "",
    "Your allocation is recorded for future distribution.",
  ].join("\n");
}

function resolveBotToken(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "botToken")) {
    return typeof options.botToken === "string" ? options.botToken.trim() : "";
  }
  return typeof process.env.BOT_TOKEN === "string" ? process.env.BOT_TOKEN.trim() : "";
}

async function notifyPresaleConfirmed(payload, options = {}) {
  const uid = normalizeUserId(payload && payload.telegramUserId);
  const contribution = payload && payload.contribution;
  const botToken = resolveBotToken(options);
  if (!uid || !contribution || !botToken) {
    return { sent: false, skipped: true };
  }

  const text = buildPresaleConfirmedMessage(contribution);
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
      console.error("[presale] notify failed error=telegram_http");
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    const code = (err && err.code) || (err && err.name) || "Error";
    console.error(`[presale] notify failed error=${code}`);
    return { sent: false };
  }
}

module.exports = {
  buildPresaleConfirmedMessage,
  notifyPresaleConfirmed,
};
