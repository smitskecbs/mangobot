/**
 * Read-only community activity metrics for admin member review.
 * Separate fields only — no opaque quality score.
 * Does not mutate points.json or wallet-links.json.
 */

const {
  loadPoints,
  getUserRecord,
  getEffectiveWeeklyPoints,
  getRank,
  readStreak,
  formatLastActiveLabel,
  hasClaimedSnakeToday,
  hasClaimedBounchToday,
  getBounchUnlockedMaxForDisplay,
  getPvpRewardedWinsToday,
  getTriviaRewardedRoundsToday,
} = require("./points");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const { getMemberWalletProfile } = require("./memberWalletProfile");
const { normalizeUserId } = require("./walletLinks");
const {
  XP_EARNING_ENABLED_LINE,
  XP_EARNING_LOCKED_LINE,
} = require("./xpWalletGate");
const { getLootAccount } = require("./mangoLoot");
const { readAlltimeBp } = require("./mangoShop");

function getMemberActivityProfile(userId, options = {}) {
  const telegramUserId = normalizeUserId(userId);
  const wallet = getMemberWalletProfile(telegramUserId, options);
  const data = loadPoints(options.pointsFile);
  const user = telegramUserId
    ? getUserRecord(data, telegramUserId)
    : getUserRecord({ users: {} }, "");
  const streak = readStreak(user);
  const lifetimeXp = user && typeof user.points === "number" ? user.points : 0;
  const weeklyXp = getEffectiveWeeklyPoints(user || {});
  const rank = getRank(lifetimeXp);

  return {
    telegramUserId,
    displayName:
      user && typeof user.name === "string" && user.name.trim()
        ? user.name.trim()
        : "Unknown",
    wallet: {
      verified: wallet.verified,
      registered: Boolean(wallet.registered || wallet.wallet),
      address: wallet.wallet,
      verifiedAt: wallet.verifiedAt,
      registrationMethod: wallet.registrationMethod || null,
      rewardEligible: wallet.rewardEligible,
    },
    streak: {
      current: streak.current,
      longest: streak.longest,
      lastActiveDate: streak.lastActiveDate,
      lastActiveLabel: formatLastActiveLabel(streak.lastActiveDate),
    },
    xp: {
      lifetime: lifetimeXp,
      weekly: weeklyXp,
    },
    rank: {
      emoji: rank.emoji,
      title: rank.title,
    },
    games: {
      snakeClaimedToday: hasClaimedSnakeToday(user),
      bounchClaimedToday: hasClaimedBounchToday(user),
      bounchUnlockedMax: getBounchUnlockedMaxForDisplay(user),
    },
    pvp: {
      rewardedWinsToday: getPvpRewardedWinsToday(user),
    },
    trivia: {
      rewardedRoundsToday: getTriviaRewardedRoundsToday(user),
    },
    competitionExcluded: isCommunityCompetitionExcluded(telegramUserId),
    presale: wallet.presale,
    rewards: wallet.rewards,
    presalePublic: wallet.presalePublic,
  };
}

function formatMemberStatusCard(userId, options = {}) {
  const profile = getMemberActivityProfile(userId, options);
  const rawName =
    typeof options.displayName === "string" && options.displayName.trim()
      ? options.displayName.trim()
      : profile.displayName;
  const name = rawName || "there";
  let loot = 0;
  let bp = 0;
  try {
    loot = getLootAccount(userId, options.shopFile).balance;
  } catch (_err) {
    loot = 0;
  }
  try {
    const value = readAlltimeBp(userId, options);
    bp = typeof value === "number" ? value : 0;
  } catch (_err) {
    bp = 0;
  }
  const xpEnabled = Boolean(
    profile.wallet && (profile.wallet.verified || profile.wallet.registered)
  );
  const walletLine = profile.wallet.verified
    ? "Wallet: ✅ Verified"
    : profile.wallet.registered
      ? "Wallet: 🟡 Registered"
      : "Wallet: ⬜ Not linked";
  return [
    "👤 My Profile",
    "Your ManGo progress at a glance.",
    "",
    `Name: ${name}`,
    walletLine,
    "",
    `XP: ${profile.xp.lifetime}`,
    `Weekly XP: ${profile.xp.weekly}`,
    `Rank: ${profile.rank.emoji} ${profile.rank.title}`,
    "",
    `🔥 Activity Streak: ${profile.streak.current} days`,
    `🏆 Longest Activity Streak: ${profile.streak.longest} days`,
    "",
    `🤝 Builder Points (BP, not XP): ${bp}`,
    `🥭 ManGo Loot: ${loot}`,
    "",
    xpEnabled ? XP_EARNING_ENABLED_LINE : XP_EARNING_LOCKED_LINE,
    "",
    "Looking for today's activities? Open 🎯 Daily Quest.",
  ].join("\n");
}

module.exports = {
  getMemberActivityProfile,
  formatMemberStatusCard,
};
