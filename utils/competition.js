/**
 * Central owner/admin exclusion from community competition
 * (XP awards, streak boards, lifetime/weekly ranks).
 * Snake/Bounch highscores are NOT filtered here.
 */

/**
 * Whether this Telegram user id is excluded from community competition.
 * Missing ADMIN_USER_ID → exclude nobody.
 * @param {string|number|null|undefined} userId
 * @returns {boolean}
 */
function isCommunityCompetitionExcluded(userId) {
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId) {
    return false;
  }
  if (userId === undefined || userId === null || userId === "") {
    return false;
  }
  return String(userId) === String(adminId);
}

module.exports = {
  isCommunityCompetitionExcluded,
};
