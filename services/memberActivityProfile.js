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

module.exports = {
  getMemberActivityProfile,
};
