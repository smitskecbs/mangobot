/**
 * Group management authorization for Telegram commands.
 * Allowlist (ADMIN_USER_ID) OR Telegram creator/administrator status.
 * Competition boards no longer hide ADMIN_USER_ID; isAdmin() stays permission-only.
 */

const { isAdmin } = require("../services/points");
const { isGroupChat } = require("./botMenu");
const { isCommunityCompetitionExcluded } = require("./competition");

const MANAGE_STATUSES = new Set(["creator", "administrator"]);

/**
 * Community competition boards (lifetime, weekly, streaks).
 * Delegates to the shared participation helper (currently excludes nobody).
 * @param {string|number|null|undefined} userId
 * @returns {boolean}
 */
function shouldHideFromLeaderboards(userId) {
  return isCommunityCompetitionExcluded(userId);
}

/**
 * Snake/Bounch highscores stay visible, including ADMIN_USER_ID,
 * so community members can beat the owner's scores.
 * @param {object|null|undefined} _entry
 * @returns {boolean}
 */
function shouldHideScoreLeaderboardEntry(_entry) {
  return false;
}

/**
 * Whether the user may manage ChatFight (and similar) in this chat.
 *
 * Order:
 * 1. require ctx.from.id and group/supergroup
 * 2. env ADMIN_USER_ID via isAdmin (injectable)
 * 3. Telegram getChatMember → creator | administrator
 * 4. API errors → false (fail closed); env-admin already returned true above
 *
 * @param {object} ctx
 * @param {object} [options]
 * @param {(userId: *) => boolean} [options.isAdminFn]
 * @param {(chatId: *, userId: *) => Promise<object>|object} [options.getChatMember]
 * @returns {Promise<boolean>}
 */
async function canManageGroup(ctx, options = {}) {
  if (!ctx || !ctx.from || ctx.from.id === undefined || ctx.from.id === null) {
    return false;
  }

  if (!isGroupChat(ctx)) {
    return false;
  }

  const userId = ctx.from.id;
  const isAdminFn =
    typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;

  if (isAdminFn(userId)) {
    return true;
  }

  const getChatMember =
    typeof options.getChatMember === "function"
      ? options.getChatMember
      : ctx.telegram && typeof ctx.telegram.getChatMember === "function"
        ? (chatId, uid) => ctx.telegram.getChatMember(chatId, uid)
        : null;

  if (!getChatMember) {
    return false;
  }

  try {
    const member = await getChatMember(ctx.chat.id, userId);
    const status = member && member.status;
    return MANAGE_STATUSES.has(status);
  } catch (_err) {
    return false;
  }
}

module.exports = {
  MANAGE_STATUSES,
  shouldHideFromLeaderboards,
  shouldHideScoreLeaderboardEntry,
  canManageGroup,
  isCommunityCompetitionExcluded,
};
