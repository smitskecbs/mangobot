/**
 * Admin-only /membercheck — reply to a member to review activity + wallet status.
 * Shows Registered vs Verified from wallet-links.json. Shortens wallets. No private keys.
 */

const { isAdmin } = require("../services/points");
const { getMemberActivityProfile } = require("../services/memberActivityProfile");
const { getReplyTargetUser } = require("../utils/telegramReplyTarget");
const { shortenWallet, formatVerifiedDate } = require("../utils/solanaWallet");
const { isPrivateChat } = require("../utils/botMenu");
const { formatLamportsAsSol } = require("../services/presaleConstants");
const {
  XP_EARNING_ENABLED_LINE,
  XP_EARNING_LOCKED_LINE,
} = require("../services/xpWalletGate");

const USAGE = "Reply to a member's message with /membercheck.";
const ADMIN_ONLY = "This command is admin only.";

function formatMemberCheck(profile, displayName) {
  const name = displayName || profile.displayName || "Member";
  const walletLine = profile.wallet.verified
    ? `Wallet: 🟢 Verified\nWallet: ${shortenWallet(profile.wallet.address)}`
    : profile.wallet.registered || profile.wallet.address
      ? `Wallet: 🟡 Registered\nWallet: ${shortenWallet(profile.wallet.address)}`
      : "Wallet: ⬜ Not linked";
  const xpEarningLine =
    profile.wallet.registered || profile.wallet.verified || profile.wallet.address
      ? XP_EARNING_ENABLED_LINE
      : XP_EARNING_LOCKED_LINE;
  const verifiedDate = formatVerifiedDate(profile.wallet.verifiedAt);
  const lastActive = profile.streak.lastActiveLabel || "—";
  const publicLive = profile.presalePublic && profile.presalePublic.live;
  const recorded = profile.presale && profile.presale.recorded;
  const contributionLine = recorded
    ? `${formatLamportsAsSol(
        profile.presale.contributedLamports || profile.presale.confirmedLamports || "0"
      )} SOL`
    : publicLive
      ? "None"
      : "Coming soon";
  const allocationLine = recorded
    ? `${profile.presale.allocation || "0"} MANGO`
    : "—";
  const distributionLine = recorded
    ? profile.presale.distributionStatus === "sent"
      ? "Sent"
      : "Pending"
    : "—";
  const pending = (profile.rewards && profile.rewards.pending) || 0;
  const sent = (profile.rewards && profile.rewards.delivered) || 0;

  const lines = [
    "🥭 ManGo Member Profile",
    "",
    `User: ${name}`,
    "",
    walletLine,
  ];
  if (verifiedDate) {
    lines.push(`Verified: ${verifiedDate}`);
  }
  lines.push(
    xpEarningLine,
    "",
    `Weekly XP: ${profile.xp.weekly}`,
    `Lifetime XP: ${profile.xp.lifetime}`,
    `Current streak: ${profile.streak.current} days`,
    `Longest streak: ${profile.streak.longest} days`,
    `Last active: ${lastActive}`,
    "",
    `Pending rewards: ${pending}`,
    `Sent rewards: ${sent}`,
    `Presale contribution: ${contributionLine}`,
    `Presale allocation: ${allocationLine}`,
    `Presale distribution: ${distributionLine}`
  );
  return lines.join("\n");
}

function handleMemberCheck(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }

  const target = getReplyTargetUser(ctx);
  if (!target) {
    return ctx.reply(USAGE);
  }

  const profile = getMemberActivityProfile(target.id, options);
  return ctx.reply(formatMemberCheck(profile, target.firstName));
}

module.exports = (bot) => {
  bot.command("membercheck", (ctx) => handleMemberCheck(ctx));
};

module.exports.handleMemberCheck = handleMemberCheck;
module.exports.formatMemberCheck = formatMemberCheck;
module.exports.USAGE = USAGE;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
