/**
 * Shared leaderboard formatting and ranking helpers.
 */

const { isCommunityCompetitionExcluded } = require("../utils/competition");
const { readStreak } = require("./points");

const MEDALS = ["🥇", "🥈", "🥉"];

function formatRankPrefix(index) {
  return MEDALS[index] || `${index + 1}.`;
}

function competitionEntries(users) {
  return Object.entries(users || {}).filter(
    ([userId]) => !isCommunityCompetitionExcluded(userId)
  );
}

/**
 * Top lifetime leaders.
 * @param {Record<string, object>} users
 * @param {number} [limit]
 */
function getLifetimeTop(users, limit = 10) {
  return competitionEntries(users)
    .map(([, user]) => user)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

/**
 * Weekly XP standings. No slice.
 * @param {Record<string, object>} users
 * @param {(user: object) => number} getEffectiveWeeklyPoints
 */
function getWeeklyRanked(users, getEffectiveWeeklyPoints) {
  return competitionEntries(users)
    .map(([userId, user]) => ({
      ...user,
      userId: String(userId),
      weeklyPoints: getEffectiveWeeklyPoints(user),
    }))
    .filter((user) => user.weeklyPoints > 0)
    .sort((a, b) => b.weeklyPoints - a.weeklyPoints);
}

/**
 * Top weekly leaders.
 * @param {Record<string, object>} users
 * @param {(user: object) => number} getEffectiveWeeklyPoints
 * @param {number} [limit]
 */
function getWeeklyTop(users, getEffectiveWeeklyPoints, limit = 10) {
  return getWeeklyRanked(users, getEffectiveWeeklyPoints).slice(0, limit);
}

function withStreakFields(user) {
  const streak = readStreak(user);
  return {
    ...user,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    lastActiveDate: streak.lastActiveDate,
  };
}

/**
 * Current community-active streak board.
 * @param {Record<string, object>} users
 * @param {number} [limit]
 */
function getCurrentStreakTop(users, limit = 10) {
  return competitionEntries(users)
    .map(([, user]) => withStreakFields(user))
    .filter((user) => user.currentStreak > 0)
    .sort(
      (a, b) =>
        b.currentStreak - a.currentStreak ||
        b.longestStreak - a.longestStreak ||
        (b.points || 0) - (a.points || 0)
    )
    .slice(0, limit);
}

/**
 * All-time longest streak board.
 * @param {Record<string, object>} users
 * @param {number} [limit]
 */
function getLongestStreakTop(users, limit = 10) {
  return competitionEntries(users)
    .map(([, user]) => withStreakFields(user))
    .filter((user) => user.longestStreak > 0)
    .sort(
      (a, b) =>
        b.longestStreak - a.longestStreak ||
        b.currentStreak - a.currentStreak ||
        (b.points || 0) - (a.points || 0)
    )
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

function formatCurrentStreakLines(top) {
  return top.map((user, index) => {
    const prefix = formatRankPrefix(index);
    return `${prefix} ${user.name} — ${user.currentStreak} days`;
  });
}

function formatLongestStreakLines(top) {
  return top.map((user, index) => {
    const prefix = formatRankPrefix(index);
    return `${prefix} ${user.name} — ${user.longestStreak} days`;
  });
}

module.exports = {
  getLifetimeTop,
  getWeeklyRanked,
  getWeeklyTop,
  getCurrentStreakTop,
  getLongestStreakTop,
  formatLifetimeLines,
  formatWeeklyLines,
  formatCurrentStreakLines,
  formatLongestStreakLines,
  formatRankPrefix,
};
