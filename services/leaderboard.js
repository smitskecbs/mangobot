/**
 * Shared leaderboard formatting and ranking helpers.
 */

const MEDALS = ["🥇", "🥈", "🥉"];

function formatRankPrefix(index) {
  return MEDALS[index] || `${index + 1}.`;
}

function getLifetimeTop(users, limit = 10) {
  return Object.values(users)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

function getWeeklyTop(users, getEffectiveWeeklyPoints, limit = 10) {
  return Object.values(users)
    .map((user) => ({ ...user, weeklyPoints: getEffectiveWeeklyPoints(user) }))
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
