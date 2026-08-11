/**
 * Verified Telegram identity helpers for score leaderboard entries.
 * Never trust client-provided uid — only signed game-token identity.
 */

/**
 * @param {unknown} raw
 * @returns {string|null} digits-only Telegram user id string
 */
function normalizeVerifiedTelegramUserId(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  const value = String(raw).trim();
  if (!value || !/^\d{1,20}$/.test(value)) {
    return null;
  }
  return value;
}

/**
 * Resolve telegramUserId for a score entry.
 * - Attach verified uid when missing
 * - Keep existing when equal
 * - Never overwrite an existing different verified uid
 *
 * @param {object|null|undefined} entry
 * @param {unknown} verifiedUid from identity.uid only
 * @returns {{ telegramUserId: string|null, conflict: boolean }}
 */
function resolveEntryTelegramUserId(entry, verifiedUid) {
  const existing = normalizeVerifiedTelegramUserId(
    entry && entry.telegramUserId
  );
  const incoming = normalizeVerifiedTelegramUserId(verifiedUid);

  if (existing && incoming && existing !== incoming) {
    return { telegramUserId: existing, conflict: true };
  }
  if (incoming) {
    return { telegramUserId: incoming, conflict: false };
  }
  return { telegramUserId: existing, conflict: false };
}

/**
 * Apply resolved telegramUserId onto a player entry object (mutates).
 * Omits the field when null (legacy entries stay without uid).
 * @param {object} player
 * @param {unknown} verifiedUid
 * @returns {{ conflict: boolean }}
 */
function applyVerifiedTelegramUserId(player, verifiedUid) {
  const { telegramUserId, conflict } = resolveEntryTelegramUserId(
    player,
    verifiedUid
  );
  if (telegramUserId) {
    player.telegramUserId = telegramUserId;
  } else {
    delete player.telegramUserId;
  }
  return { conflict };
}

module.exports = {
  normalizeVerifiedTelegramUserId,
  resolveEntryTelegramUserId,
  applyVerifiedTelegramUserId,
};
