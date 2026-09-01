/**
 * Cross-game active-match reservation: one interactive PvP match per user.
 * Covers Tic-Tac-Toe, Connect Four, Checkers, and Blackjack.
 */

const PLAYER_BUSY_TEXT = `🎮 You already have an active game.

Finish your current match before starting or joining another one.`;

const BOT_USER_ID = "bot";

function isBotUserId(userId) {
  return userId == null || String(userId) === BOT_USER_ID;
}

function createPvpMatchReservation() {
  /** @type {Map<string, { game: string, matchId: string }>} */
  const byUser = new Map();
  /** @type {Map<string, Set<string>>} */
  const byMatch = new Map();

  function get(userId) {
    if (isBotUserId(userId)) {
      return null;
    }
    return byUser.get(String(userId)) || null;
  }

  function has(userId) {
    return Boolean(get(userId));
  }

  function tryReserve(userId, game, matchId) {
    if (isBotUserId(userId)) {
      return { ok: true, skipped: true };
    }
    const uid = String(userId);
    const gid = String(game || "");
    const mid = String(matchId || "");
    if (!gid || !mid) {
      return { ok: false, reason: "invalid" };
    }
    const existing = byUser.get(uid);
    if (existing) {
      if (existing.matchId === mid && existing.game === gid) {
        return { ok: true, already: true, matchId: mid, game: gid };
      }
      return { ok: false, reason: "player-busy", matchId: existing.matchId, game: existing.game };
    }
    byUser.set(uid, { game: gid, matchId: mid });
    let members = byMatch.get(mid);
    if (!members) {
      members = new Set();
      byMatch.set(mid, members);
    }
    members.add(uid);
    return { ok: true, matchId: mid, game: gid };
  }

  function release(userId, matchId) {
    if (isBotUserId(userId)) {
      return false;
    }
    const uid = String(userId);
    const existing = byUser.get(uid);
    if (!existing) {
      return false;
    }
    if (matchId != null && existing.matchId !== String(matchId)) {
      return false;
    }
    byUser.delete(uid);
    const members = byMatch.get(existing.matchId);
    if (members) {
      members.delete(uid);
      if (members.size === 0) {
        byMatch.delete(existing.matchId);
      }
    }
    return true;
  }

  function releaseMatch(matchId) {
    const mid = String(matchId || "");
    const members = byMatch.get(mid);
    if (!members) {
      return 0;
    }
    let n = 0;
    for (const uid of members) {
      const existing = byUser.get(uid);
      if (existing && existing.matchId === mid) {
        byUser.delete(uid);
        n += 1;
      }
    }
    byMatch.delete(mid);
    return n;
  }

  function reset() {
    byUser.clear();
    byMatch.clear();
  }

  function size() {
    return byUser.size;
  }

  return {
    tryReserve,
    release,
    releaseMatch,
    get,
    has,
    reset,
    size,
  };
}

let sharedReservation = null;

function getSharedPvpMatchReservation() {
  if (!sharedReservation) {
    sharedReservation = createPvpMatchReservation();
  }
  return sharedReservation;
}

module.exports = {
  PLAYER_BUSY_TEXT,
  BOT_USER_ID,
  createPvpMatchReservation,
  getSharedPvpMatchReservation,
  isBotUserId,
};
