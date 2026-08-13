/**
 * Generic in-memory PvP session registry.
 * Restart clears all active sessions (acceptable for v1).
 *
 * Connect Four can reuse: ids, chat indexing, pair cooldown, timers, locks.
 */

const crypto = require("crypto");

const DEFAULT_PAIR_COOLDOWN_MS = 30 * 60 * 1000;

function createPvpSessionManager(options = {}) {
  const nowFn =
    typeof options.now === "function" ? options.now : () => Date.now();
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function"
      ? options.setTimeoutFn
      : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn =
    typeof options.clearTimeoutFn === "function"
      ? options.clearTimeoutFn
      : (id) => clearTimeout(id);
  const pairCooldownMs =
    typeof options.pairCooldownMs === "number" && options.pairCooldownMs >= 0
      ? options.pairCooldownMs
      : DEFAULT_PAIR_COOLDOWN_MS;
  const randomIdFn =
    typeof options.randomIdFn === "function"
      ? options.randomIdFn
      : () => crypto.randomBytes(6).toString("hex");

  /** @type {Map<string, object>} */
  const sessions = new Map();
  /** @type {Map<string, string>} chatKey -> sessionId */
  const activeByChatGame = new Map();
  /** @type {Map<string, number>} pairKey -> cooldownUntilMs */
  const pairCooldowns = new Map();
  /** @type {Set<string>} */
  const mutating = new Set();

  function chatGameKey(chatId, game) {
    return `${String(chatId)}:${String(game)}`;
  }

  function makePairKey(userIdA, userIdB) {
    const a = String(userIdA);
    const b = String(userIdB);
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  function generateSessionId() {
    let id = randomIdFn();
    while (sessions.has(id)) {
      id = randomIdFn();
    }
    return id;
  }

  function getSession(sessionId) {
    if (!sessionId) {
      return null;
    }
    return sessions.get(String(sessionId)) || null;
  }

  function getActiveSession(chatId, game) {
    const id = activeByChatGame.get(chatGameKey(chatId, game));
    if (!id) {
      return null;
    }
    return getSession(id);
  }

  function isGameOpen(chatId, game) {
    const session = getActiveSession(chatId, game);
    if (!session) {
      return false;
    }
    return session.status === "waiting" || session.status === "active";
  }

  function hasAnyOpenGame(game) {
    for (const session of sessions.values()) {
      if (
        session.game === game &&
        (session.status === "waiting" || session.status === "active")
      ) {
        return true;
      }
    }
    return false;
  }

  function registerSession(session) {
    sessions.set(session.id, session);
    activeByChatGame.set(chatGameKey(session.chatId, session.game), session.id);
    return session;
  }

  function clearActiveIndex(session) {
    const key = chatGameKey(session.chatId, session.game);
    if (activeByChatGame.get(key) === session.id) {
      activeByChatGame.delete(key);
    }
  }

  function removeSession(sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      return;
    }
    clearTimers(session);
    clearActiveIndex(session);
    sessions.delete(session.id);
  }

  function clearTimers(session) {
    if (!session || !session.timers) {
      return;
    }
    if (session.timers.joinTimeoutId != null) {
      clearTimeoutFn(session.timers.joinTimeoutId);
      session.timers.joinTimeoutId = null;
    }
    if (session.timers.turnTimeoutId != null) {
      clearTimeoutFn(session.timers.turnTimeoutId);
      session.timers.turnTimeoutId = null;
    }
  }

  function schedule(session, kind, delayMs, fn) {
    if (!session.timers) {
      session.timers = { joinTimeoutId: null, turnTimeoutId: null };
    }
    if (kind === "join") {
      if (session.timers.joinTimeoutId != null) {
        clearTimeoutFn(session.timers.joinTimeoutId);
      }
      session.timers.joinTimeoutId = setTimeoutFn(fn, delayMs);
      return session.timers.joinTimeoutId;
    }
    if (kind === "turn") {
      if (session.timers.turnTimeoutId != null) {
        clearTimeoutFn(session.timers.turnTimeoutId);
      }
      session.timers.turnTimeoutId = setTimeoutFn(fn, delayMs);
      return session.timers.turnTimeoutId;
    }
    return null;
  }

  function isPairOnCooldown(userIdA, userIdB, game) {
    const key = `${String(game)}:${makePairKey(userIdA, userIdB)}`;
    const until = pairCooldowns.get(key);
    if (until == null) {
      return false;
    }
    if (nowFn() >= until) {
      pairCooldowns.delete(key);
      return false;
    }
    return true;
  }

  function markPairCooldown(userIdA, userIdB, game) {
    const key = `${String(game)}:${makePairKey(userIdA, userIdB)}`;
    pairCooldowns.set(key, nowFn() + pairCooldownMs);
  }

  function getPairCooldownRemainingMs(userIdA, userIdB, game) {
    const key = `${String(game)}:${makePairKey(userIdA, userIdB)}`;
    const until = pairCooldowns.get(key);
    if (until == null) {
      return 0;
    }
    return Math.max(0, until - nowFn());
  }

  /**
   * Sync mutation guard — reject re-entry while a mutation is in progress.
   * Prefer completing claims before any await.
   */
  function withSessionLock(sessionId, fn) {
    const id = String(sessionId);
    if (mutating.has(id)) {
      return { ok: false, reason: "busy" };
    }
    mutating.add(id);
    try {
      return fn();
    } finally {
      mutating.delete(id);
    }
  }

  function resetAll() {
    for (const session of sessions.values()) {
      clearTimers(session);
    }
    sessions.clear();
    activeByChatGame.clear();
    pairCooldowns.clear();
    mutating.clear();
  }

  function listSessions() {
    return Array.from(sessions.values());
  }

  return {
    now: nowFn,
    pairCooldownMs,
    generateSessionId,
    getSession,
    getActiveSession,
    isGameOpen,
    hasAnyOpenGame,
    registerSession,
    removeSession,
    clearActiveIndex,
    clearTimers,
    schedule,
    makePairKey,
    isPairOnCooldown,
    markPairCooldown,
    getPairCooldownRemainingMs,
    withSessionLock,
    resetAll,
    listSessions,
  };
}

/**
 * Safe Telegram display name for PvP messages (not identity).
 */
function sanitizePvpDisplayName(fromOrName, maxLen = 24) {
  let raw = "";
  if (fromOrName && typeof fromOrName === "object") {
    raw =
      (typeof fromOrName.first_name === "string" && fromOrName.first_name) ||
      (typeof fromOrName.username === "string" && fromOrName.username) ||
      "";
  } else if (typeof fromOrName === "string") {
    raw = fromOrName;
  }
  let name = String(raw)
    .replace(/[<>&"'`/\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) {
    name = "Player";
  }
  const limit = Math.max(1, Number(maxLen) || 24);
  if (name.length > limit) {
    name = name.slice(0, limit);
  }
  return name;
}

module.exports = {
  createPvpSessionManager,
  sanitizePvpDisplayName,
  DEFAULT_PAIR_COOLDOWN_MS,
};
