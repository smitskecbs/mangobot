/**
 * Shared leaderboard formatting and ranking helpers.
 */

const { shouldHideFromLeaderboards } = require("../utils/admin");

const MEDALS = ["🥇", "🥈", "🥉"];

function formatRankPrefix(index) {
  return MEDALS[index] || `${index + 1}.`;
}

/**
 * Top lifetime leaders. Owner (ADMIN_USER_ID) excluded before sort/slice.
 * @param {Record<string, object>} users
 * @param {number} [limit]
 */
function getLifetimeTop(users, limit = 10) {
  return Object.entries(users || {})
    .filter(([userId]) => !shouldHideFromLeaderboards(userId))
    .map(([, user]) => user)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

/**
 * Top weekly leaders. Owner excluded before sort/slice.
 * @param {Record<string, object>} users
 * @param {(user: object) => number} getEffectiveWeeklyPoints
 * @param {number} [limit]
 */
function getWeeklyTop(users, getEffectiveWeeklyPoints, limit = 10) {
  return Object.entries(users || {})
    .filter(([userId]) => !shouldHideFromLeaderboards(userId))
    .map(([, user]) => ({
      ...user,
      weeklyPoints: getEffectiveWeeklyPoints(user),
    }))
    .filter((user) => user.weeklyPoints > 0)
    .sort((a, b) => b.weeklyPoints - a.weeklyPoints)
    .slice(0, limit);
}

function formatLifetimeLines(top, getRank) {
  return top.map((user, index) => {
    const prefix = formatRankPrefix(index);
    const rank = getRank(user.points);
    return `${prefix} ${user.name} — ${user.points} pts ${rank.emoji}`;
  });
}

function formatWeeklyLines(top) {
  return top.map((user, index) => {
    const prefix = formatRankPrefix(index);
    return `${prefix} ${user.name} — ${user.weeklyPoints} pts`;
  });
}

module.exports = {
  getLifetimeTop,
  getWeeklyTop,
  formatLifetimeLines,
  formatWeeklyLines,
};
