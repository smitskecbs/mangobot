/**
 * Community competition exclusion (XP awards, streak boards, lifetime/weekly ranks).
 * ADMIN_USER_ID is an admin identity only — not excluded from participation.
 * Snake/Bounch highscores are NOT filtered here.
 */

/**
 * Whether this Telegram user id is excluded from community competition.
 * Always false: owner/admin and group admins compete like everyone else.
 * Kept as a stable call-site helper so award/leaderboard filters stay centralized.
 * @param {string|number|null|undefined} _userId
 * @returns {boolean}
 */
function isCommunityCompetitionExcluded(_userId) {
  return false;
}

module.exports = {
  isCommunityCompetitionExcluded,
};
