/**
 * Admin-only /membercheck — reply to a member to review activity + wallet status.
 * Uses existing verified-wallet mapping. Shortens wallets. No private keys.
 */

const { isAdmin } = require("../services/points");
const { getMemberActivityProfile } = require("../services/memberActivityProfile");
const { getReplyTargetUser } = require("../utils/telegramReplyTarget");
const { shortenWallet, formatVerifiedDate } = require("../utils/solanaWallet");
const { isPrivateChat } = require("../utils/botMenu");

const USAGE = "Reply to a member's message with /membercheck.";
const ADMIN_ONLY = "This command is admin only.";

function formatMemberCheck(profile, displayName) {
  const name = displayName || profile.displayName || "Member";
  const walletLine = profile.wallet.verified
    ? `Wallet: ✅ Verified\nWallet: ${shortenWallet(profile.wallet.address)}`
    : "Wallet: ⬜ Not connected";
  const verifiedDate = formatVerifiedDate(profile.wallet.verifiedAt);
  const lastActive = profile.streak.lastActiveLabel || "—";
  const presale =
    profile.presalePublic && profile.presalePublic.live
      ? profile.presale.recorded
        ? "Participating"
        : "No participation recorded"
      : "Coming soon";
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
    "",
    `Weekly XP: ${profile.xp.weekly}`,
    `Lifetime XP: ${profile.xp.lifetime}`,
    `Current streak: ${profile.streak.current} days`,
    `Longest streak: ${profile.streak.longest} days`,
    `Last active: ${lastActive}`,
    "",
    `Pending rewards: ${pending}`,
    `Sent rewards: ${sent}`,
    `Presale: ${presale}`
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
