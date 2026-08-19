/**
 * Central XP eligibility: linked wallet (manual registered OR signature verified).
 * Presale stays on getVerifiedWalletForUser elsewhere. No private keys.
 */

const crypto = require("node:crypto");
const { encodeBase58 } = require("../utils/base58");
const { pruneTimestampMap } = require("../utils/boundedMap");
const {
  getLinkedWalletForUser,
  getVerifiedWalletForUser,
  registerManualWallet,
} = require("./walletLinks");

const XP_WALLET_REQUIRED = "wallet-required";
const XP_WALLET_REMINDER_COOLDOWN_MS = 60 * 60 * 1000;
const REMINDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMINDER_MAX_KEYS = 4000;

const XP_WALLET_REMINDER_TEXT = `🔒 Link your wallet to earn XP

Use /wallet and choose:

🌐 Connect & Verify
or
⌨️ Enter Wallet Address

Both methods unlock XP earning. 🥭`;

const XP_WALLET_LOCKED_POINTS_LINE = `🔒 XP earning locked
Link a wallet with /wallet to continue earning XP.`;

const XP_EARNING_ENABLED_LINE = "XP earning: ✅ Enabled";
const XP_EARNING_LOCKED_LINE = "XP earning: 🔒 Locked — link wallet";

const reminderStamps = new Map();
let xpWalletAutoLinkForTests = false;

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

function deterministicTestWallet(userId) {
  const bytes = crypto.createHash("sha256").update(`mango-xp-autolink:${userId}`).digest();
  return encodeBase58(bytes);
}

function maybeAutoLinkTestWallet(userId, walletFile) {
  if (!xpWalletAutoLinkForTests || !isLikelyTestProcess()) {
    return;
  }
  registerManualWallet(userId, deterministicTestWallet(userId), walletFile);
}

/**
 * XP earning is allowed when getLinkedWalletForUser returns a wallet.
 * Manual registered and signature verified both count. Not verified-only.
 * @param {string|number} userId
 * @param {string} [walletFile]
 * @returns {boolean}
 */
function canEarnXp(userId, walletFile) {
  if (getLinkedWalletForUser(userId, walletFile)) {
    return true;
  }
  maybeAutoLinkTestWallet(userId, walletFile);
  return getLinkedWalletForUser(userId, walletFile) !== null;
}

/**
 * @param {string|number} userId
 * @param {string} [walletFile]
 * @returns {"none"|"registered"|"verified"}
 */
function getXpWalletLinkStatus(userId, walletFile) {
  const linked = getLinkedWalletForUser(userId, walletFile);
  if (!linked || !linked.wallet) {
    return "none";
  }
  if (linked.verified || getVerifiedWalletForUser(userId, walletFile)) {
    return "verified";
  }
  return "registered";
}

function setXpWalletAutoLinkForTests(enabled) {
  if (enabled && !isLikelyTestProcess()) {
    throw new Error("XP wallet auto-link is test-only");
  }
  xpWalletAutoLinkForTests = Boolean(enabled);
}

function takeXpWalletReminder(userId, now = Date.now()) {
  const uid = userId == null ? "" : String(userId);
  if (!uid) {
    return false;
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  pruneTimestampMap(reminderStamps, ts, REMINDER_MAX_AGE_MS, REMINDER_MAX_KEYS);
  const previous = reminderStamps.get(uid);
  if (typeof previous === "number" && ts - previous < XP_WALLET_REMINDER_COOLDOWN_MS) {
    return false;
  }
  reminderStamps.set(uid, ts);
  return true;
}

function resetXpWalletRemindersForTests() {
  reminderStamps.clear();
}

function reminderForBlockedXp(userId, results, now) {
  const blocked = (Array.isArray(results) ? results : [results]).some(
    (row) => row && row.reason === XP_WALLET_REQUIRED
  );
  if (!blocked) {
    return null;
  }
  if (!takeXpWalletReminder(userId, now)) {
    return null;
  }
  return XP_WALLET_REMINDER_TEXT;
}

module.exports = {
  XP_WALLET_REQUIRED,
  XP_WALLET_REMINDER_COOLDOWN_MS,
  XP_WALLET_REMINDER_TEXT,
  XP_WALLET_LOCKED_POINTS_LINE,
  XP_EARNING_ENABLED_LINE,
  XP_EARNING_LOCKED_LINE,
  canEarnXp,
  getXpWalletLinkStatus,
  takeXpWalletReminder,
  resetXpWalletRemindersForTests,
  setXpWalletAutoLinkForTests,
  reminderForBlockedXp,
};
