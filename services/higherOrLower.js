/**
 * Higher or Lower — lightweight single-player vs ManGoBot in the Games topic.
 * In-session streak only. No XP / Loot / BP / tokens.
 */

const crypto = require("crypto");
const { Markup } = require("telegraf");
const { isAllowedChatFightChat } = require("./chatFight");
const { sanitizePvpDisplayName } = require("./pvpSessionManager");
const {
  createPvpMatchReservation,
  getSharedPvpMatchReservation,
  PLAYER_BUSY_TEXT,
} = require("./pvpMatchReservation");
const {
  GAME_TYPE,
  FINAL_STATE,
  GAME_ENDED_TOAST,
  emptyGameKeyboardExtra,
  withGameCleanupFooter,
  logGameCleanup,
  scheduleGameMessageCleanup,
  clearGameMessageCleanup,
} = require("../utils/gameCleanup");

const GAME_ID = "hol";
const MIN_NUMBER = 1;
const MAX_NUMBER = 100;
const IDLE_MS = 120 * 1000;
const MAX_REROLLS = 32;
const BOT_DISPLAY_NAME = "ManGoBot";

const STATUS = Object.freeze({
  ACTIVE: "active",
  ENDED: "ended",
  FINISHED: "finished",
  EXPIRED: "expired",
});

function defaultRandomInt() {
  return crypto.randomInt(MIN_NUMBER, MAX_NUMBER + 1);
}

function defaultRandomId() {
  return crypto.randomBytes(6).toString("hex");
}

function clampNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    return null;
  }
  if (n < MIN_NUMBER || n > MAX_NUMBER) {
    return null;
  }
  return n;
}

function nextDistinctNumber(current, randomIntFn) {
  const roll =
    typeof randomIntFn === "function" ? randomIntFn : defaultRandomInt;
  function one() {
    const n = clampNumber(roll());
    return n == null ? defaultRandomInt() : n;
  }
  let next = one();
  let guard = 0;
  while (current != null && next === current && guard < MAX_REROLLS) {
    next = one();
    guard += 1;
  }
  if (current != null && next === current) {
    next = current >= MAX_NUMBER ? current - 1 : current + 1;
  }
  return next;
}

function buildPlayCallbackData(action, sessionId, round) {
  return `hol:${action}:${sessionId}:${round}`;
}

function parseHolCallbackData(data) {
  if (typeof data !== "string" || !data.startsWith("hol:")) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 4 || parts[0] !== "hol") {
    return null;
  }
  const action = parts[1];
  if (!["h", "l", "f", "a"].includes(action)) {
    return null;
  }
  const sessionId = parts[2];
  if (!sessionId || !/^[a-f0-9]+$/i.test(sessionId)) {
    return null;
  }
  const round = Number(parts[3]);
  if (!Number.isInteger(round) || round < 1) {
    return null;
  }
  return { game: GAME_ID, action, sessionId, round };
}

function playKeyboard(sessionId, round) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⬆️ Higher", buildPlayCallbackData("h", sessionId, round)),
      Markup.button.callback("⬇️ Lower", buildPlayCallbackData("l", sessionId, round)),
    ],
    [Markup.button.callback("❌ Finish", buildPlayCallbackData("f", sessionId, round))],
  ]);
}

function resultKeyboard(sessionId, round) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔁 Play Again", buildPlayCallbackData("a", sessionId, round)),
      Markup.button.callback("❌ Finish", buildPlayCallbackData("f", sessionId, round)),
    ],
  ]);
}

function numberRangeLine() {
  return `Numbers: ${MIN_NUMBER}–${MAX_NUMBER}`;
}

function buildStartText(session) {
  return `📈 Higher or Lower

${numberRangeLine()}
Current number: ${session.current}
🔥 Streak: ${session.streak}

Will the next number be higher or lower?`;
}

function buildCorrectText(session, previous, next) {
  return `📈 Higher or Lower

${numberRangeLine()}
Previous: ${previous}
Next: ${next}

✅ Correct!
🔥 Streak: ${session.streak}

Current number: ${session.current}
Will the next number be higher or lower?`;
}

function buildWrongText(session, previous, next) {
  return `📈 Higher or Lower

Previous: ${previous}
Next: ${next}

❌ Wrong!
🔥 Final streak: ${session.streak}`;
}

function buildFinishedText(session) {
  return withGameCleanupFooter(`📈 Higher or Lower

❌ Finished.
🔥 Final streak: ${session.streak}`);
}

function buildExpiredText(session) {
  return withGameCleanupFooter(`📈 Higher or Lower cancelled

This game has ended.

🔥 Final streak: ${session && session.streak != null ? session.streak : 0}`);
}

function renderMessage(session) {
  if (!session) {
    return {
      text: withGameCleanupFooter("📈 Higher or Lower\n\nThis game has ended."),
      extra: emptyGameKeyboardExtra(),
    };
  }
  if (session.status === STATUS.ACTIVE) {
    if (session.lastReveal && session.lastReveal.correct) {
      return {
        text: buildCorrectText(
          session,
          session.lastReveal.previous,
          session.lastReveal.next
        ),
        extra: playKeyboard(session.id, session.round),
      };
    }
    return {
      text: buildStartText(session),
      extra: playKeyboard(session.id, session.round),
    };
  }
  if (session.status === STATUS.ENDED) {
    if (session.lastReveal && session.lastReveal.correct === false) {
      return {
        text: buildWrongText(
          session,
          session.lastReveal.previous,
          session.lastReveal.next
        ),
        extra: resultKeyboard(session.id, session.round),
      };
    }
    return {
      text: buildFinishedText(session),
      extra: resultKeyboard(session.id, session.round),
    };
  }
  return {
    text:
      session.status === STATUS.FINISHED
        ? buildFinishedText(session)
        : buildExpiredText(session),
    extra: emptyGameKeyboardExtra(),
  };
}

let holRuntime = null;

function createHigherOrLowerService(options = {}) {
  const now =
    typeof options.now === "function" ? options.now : () => Date.now();
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function"
      ? options.setTimeoutFn
      : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn =
    typeof options.clearTimeoutFn === "function"
      ? options.clearTimeoutFn
      : (id) => clearTimeout(id);
  const randomIntFn =
    typeof options.randomIntFn === "function"
      ? options.randomIntFn
      : defaultRandomInt;
  const randomIdFn =
    typeof options.randomIdFn === "function"
      ? options.randomIdFn
      : defaultRandomId;
  const idleMs =
    typeof options.idleMs === "number" && options.idleMs >= 0
      ? options.idleMs
      : IDLE_MS;
  const cleanupDelayMs =
    typeof options.cleanupDelayMs === "number" && options.cleanupDelayMs >= 0
      ? options.cleanupDelayMs
      : undefined;
  const deleteMessageFn =
    typeof options.deleteMessageFn === "function"
      ? options.deleteMessageFn
      : null;
  const reservation =
    options.reservation ||
    createPvpMatchReservation();
  const telegram = options.telegram || null;

  let onRender = null;

  function setRenderHandler(fn) {
    onRender = typeof fn === "function" ? fn : null;
  }

  function notifyRender(result) {
    if (!result || !result.ok || !result.rendered || typeof onRender !== "function") {
      return result;
    }
    try {
      onRender(result);
    } catch (_err) {
      /* ignore */
    }
    return result;
  }

  const sessionsById = new Map();
  const sessionsByUser = new Map();
  const messageOwner = new Map();
  const timers = new Map();

  function snapshot(session) {
    if (!session) {
      return null;
    }
    return {
      id: session.id,
      userId: session.userId,
      displayName: session.displayName,
      chatId: session.chatId,
      threadId: session.threadId,
      messageId: session.messageId,
      status: session.status,
      current: session.current,
      streak: session.streak,
      round: session.round,
      idleGeneration: session.idleGeneration,
      lastReveal: session.lastReveal
        ? { ...session.lastReveal }
        : null,
    };
  }

  function timerKey(sessionId) {
    return String(sessionId);
  }

  function clearIdle(sessionId) {
    const handle = timers.get(timerKey(sessionId));
    if (handle != null) {
      clearTimeoutFn(handle);
      timers.delete(timerKey(sessionId));
    }
  }

  function messageKey(chatId, messageId) {
    return `${String(chatId)}:${String(messageId)}`;
  }

  function rememberMessage(session) {
    if (!session || session.chatId == null || session.messageId == null) {
      return;
    }
    messageOwner.set(messageKey(session.chatId, session.messageId), session.id);
  }

  function forgetMessage(session) {
    if (!session || session.chatId == null || session.messageId == null) {
      return;
    }
    const key = messageKey(session.chatId, session.messageId);
    if (messageOwner.get(key) === session.id) {
      messageOwner.delete(key);
    }
  }

  function shouldDeleteMessage(sessionId, messageId, chatId) {
    return () => {
      const live = sessionsById.get(String(sessionId));
      if (live && (live.status === STATUS.ACTIVE || sessionHasPlayAgain(live))) {
        return false;
      }
      if (live && live.messageId != null && String(live.messageId) !== String(messageId)) {
        return false;
      }
      const owner = messageOwner.get(
        messageKey(chatId != null ? chatId : live && live.chatId, messageId)
      );
      if (owner && owner !== String(sessionId)) {
        return false;
      }
      return true;
    };
  }

  function sessionHasPlayAgain(session) {
    return Boolean(session && session.status === STATUS.ENDED);
  }

  function dropSession(session, { keepMessageOwner } = {}) {
    if (!session) {
      return;
    }
    clearIdle(session.id);
    reservation.release(session.userId, session.id);
    sessionsById.delete(String(session.id));
    const uid = String(session.userId);
    if (sessionsByUser.get(uid) === session.id) {
      sessionsByUser.delete(uid);
    }
    if (!keepMessageOwner) {
      forgetMessage(session);
    }
  }

  function scheduleCleanup(session) {
    if (!session || session.chatId == null || session.messageId == null) {
      return;
    }
    logGameCleanup(GAME_TYPE.HOL, FINAL_STATE.FINISHED);
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.HOL,
      sessionId: session.id,
      chatId: session.chatId,
      messageIds: [session.messageId],
      generation: session.round,
      delayMs: cleanupDelayMs,
      setTimeoutFn,
      clearTimeoutFn,
      deleteMessageFn,
      telegram,
      shouldDeleteFn: shouldDeleteMessage(
        session.id,
        session.messageId,
        session.chatId
      ),
    });
  }

  function closeTerminal(session, status) {
    session.status = status;
    reservation.release(session.userId, session.id);
    const uid = String(session.userId);
    if (sessionsByUser.get(uid) === session.id) {
      sessionsByUser.delete(uid);
    }
    if (status === STATUS.ENDED) {
      scheduleIdle(session);
      return;
    }
    clearGameMessageCleanup(GAME_TYPE.HOL, session.id);
    scheduleCleanup(session);
  }

  function expireSession(sessionId, idleGeneration) {
    const session = sessionsById.get(String(sessionId));
    if (!session) {
      return { ok: false, reason: "invalid-session" };
    }
    if (Number(session.idleGeneration) !== Number(idleGeneration)) {
      return { ok: false, reason: "stale-timer" };
    }
    if (session.status === STATUS.ACTIVE) {
      session.status = STATUS.EXPIRED;
      reservation.release(session.userId, session.id);
      const uid = String(session.userId);
      if (sessionsByUser.get(uid) === session.id) {
        sessionsByUser.delete(uid);
      }
      scheduleCleanup(session);
      return notifyRender({
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session),
      });
    }
    if (session.status === STATUS.ENDED) {
      session.status = STATUS.EXPIRED;
      clearGameMessageCleanup(GAME_TYPE.HOL, session.id);
      scheduleCleanup(session);
      return notifyRender({
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session),
      });
    }
    return { ok: false, reason: "not-active" };
  }

  function scheduleIdle(session) {
    clearIdle(session.id);
    session.idleGeneration += 1;
    const generation = session.idleGeneration;
    const handle = setTimeoutFn(() => {
      timers.delete(timerKey(session.id));
      expireSession(session.id, generation);
    }, idleMs);
    timers.set(timerKey(session.id), handle);
  }

  function generateSessionId() {
    let id = String(randomIdFn());
    let n = 0;
    while (sessionsById.has(id)) {
      n += 1;
      id = `${randomIdFn()}${n}`;
    }
    return id;
  }

  function startGame({ chatId, starter, threadId } = {}) {
    if (!starter || starter.userId == null) {
      return { ok: false, reason: "no-user" };
    }
    if (starter.isBot) {
      return { ok: false, reason: "bot" };
    }
    if (chatId != null && !isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }
    const userId = String(starter.userId);
    const existingId = sessionsByUser.get(userId);
    if (existingId) {
      const existing = sessionsById.get(existingId);
      if (existing && existing.status === STATUS.ACTIVE) {
        return { ok: false, reason: "already-active", session: snapshot(existing) };
      }
    }
    const id = generateSessionId();
    const reserved = reservation.tryReserve(userId, GAME_ID, id);
    if (!reserved.ok) {
      return { ok: false, reason: "player-busy" };
    }
    const current = nextDistinctNumber(null, randomIntFn);
    const session = {
      id,
      userId,
      displayName: sanitizePvpDisplayName(starter.displayName || starter),
      chatId,
      threadId: threadId != null ? threadId : null,
      messageId: null,
      status: STATUS.ACTIVE,
      current,
      streak: 0,
      round: 1,
      idleGeneration: 0,
      lastReveal: null,
    };
    sessionsById.set(id, session);
    sessionsByUser.set(userId, id);
    scheduleIdle(session);
    const rendered = renderMessage(session);
    return {
      ok: true,
      session: snapshot(session),
      text: rendered.text,
      extra: rendered.extra,
      keyboard: rendered.extra,
    };
  }

  function setMessageId(sessionId, messageId) {
    const session = sessionsById.get(String(sessionId));
    if (!session || messageId == null) {
      return false;
    }
    forgetMessage(session);
    session.messageId = messageId;
    rememberMessage(session);
    return true;
  }

  function getSession(sessionId) {
    return snapshot(sessionsById.get(String(sessionId)));
  }

  function getUserSession(userId) {
    const id = sessionsByUser.get(String(userId));
    return id ? snapshot(sessionsById.get(id)) : null;
  }

  function guess({ sessionId, userId, action, round, chatId } = {}) {
    const session = sessionsById.get(String(sessionId));
    if (!session) {
      return { ok: false, reason: "invalid-session", toast: GAME_ENDED_TOAST };
    }
    if (chatId != null && String(chatId) !== String(session.chatId)) {
      return { ok: false, reason: "wrong-chat", toast: "Wrong chat." };
    }
    if (String(userId) !== String(session.userId)) {
      return { ok: false, reason: "outsider", toast: "This game belongs to someone else." };
    }
    if (session.status !== STATUS.ACTIVE) {
      return {
        ok: false,
        reason: "not-active",
        toast: GAME_ENDED_TOAST,
        session: snapshot(session),
        rendered: renderMessage(session),
      };
    }
    if (round != null && Number(round) !== Number(session.round)) {
      return { ok: false, reason: "stale-round", toast: "This round already ended." };
    }
    const previous = session.current;
    const next = nextDistinctNumber(previous, randomIntFn);
    const higher = action === "h";
    const correct = higher ? next > previous : next < previous;
    session.lastReveal = { previous, next, correct };
    if (correct) {
      session.current = next;
      session.streak += 1;
      session.round += 1;
      scheduleIdle(session);
      return {
        ok: true,
        correct: true,
        session: snapshot(session),
        rendered: renderMessage(session),
      };
    }
    closeTerminal(session, STATUS.ENDED);
    return {
      ok: true,
      correct: false,
      session: snapshot(session),
      rendered: renderMessage(session),
    };
  }

  function finish({ sessionId, userId, round, chatId } = {}) {
    const session = sessionsById.get(String(sessionId));
    if (!session) {
      return { ok: false, reason: "invalid-session", toast: GAME_ENDED_TOAST };
    }
    if (chatId != null && String(chatId) !== String(session.chatId)) {
      return { ok: false, reason: "wrong-chat", toast: "Wrong chat." };
    }
    if (String(userId) !== String(session.userId)) {
      return { ok: false, reason: "outsider", toast: "This game belongs to someone else." };
    }
    if (
      round != null &&
      Number(round) !== Number(session.round) &&
      session.status === STATUS.ACTIVE
    ) {
      return { ok: false, reason: "stale-round", toast: "This round already ended." };
    }
    if (session.status === STATUS.FINISHED || session.status === STATUS.EXPIRED) {
      return {
        ok: false,
        reason: "not-active",
        toast: GAME_ENDED_TOAST,
        session: snapshot(session),
        rendered: renderMessage(session),
      };
    }
    session.lastReveal = null;
    closeTerminal(session, STATUS.FINISHED);
    return {
      ok: true,
      session: snapshot(session),
      rendered: renderMessage(session),
    };
  }

  function playAgain({ sessionId, userId, round, chatId } = {}) {
    const previous = sessionsById.get(String(sessionId));
    if (!previous) {
      return { ok: false, reason: "invalid-session", toast: GAME_ENDED_TOAST };
    }
    if (chatId != null && String(chatId) !== String(previous.chatId)) {
      return { ok: false, reason: "wrong-chat", toast: "Wrong chat." };
    }
    if (String(userId) !== String(previous.userId)) {
      return { ok: false, reason: "outsider", toast: "This game belongs to someone else." };
    }
    if (previous.status !== STATUS.ENDED) {
      if (previous.status === STATUS.ACTIVE) {
        return { ok: false, reason: "already-active", toast: "This round is still open." };
      }
      return { ok: false, reason: "not-active", toast: GAME_ENDED_TOAST };
    }
    if (round != null && Number(round) !== Number(previous.round)) {
      return { ok: false, reason: "stale-round", toast: "This round already ended." };
    }
    clearIdle(previous.id);
    clearGameMessageCleanup(GAME_TYPE.HOL, previous.id);
    const chat = previous.chatId;
    const threadId = previous.threadId;
    const messageId = previous.messageId;
    const displayName = previous.displayName;
    dropSession(previous, { keepMessageOwner: true });
    const started = startGame({
      chatId: chat,
      threadId,
      starter: { userId, displayName, isBot: false },
    });
    if (!started.ok) {
      forgetMessage(previous);
      return started;
    }
    if (messageId != null) {
      setMessageId(started.session.id, messageId);
      started.session = getSession(started.session.id);
    }
    return started;
  }

  function isOpen() {
    for (const session of sessionsById.values()) {
      if (session.status === STATUS.ACTIVE) {
        return true;
      }
    }
    return false;
  }

  function hasActiveUser(userId) {
    const session = sessionsById.get(sessionsByUser.get(String(userId)) || "");
    return Boolean(session && session.status === STATUS.ACTIVE);
  }

  function clearAllTimers() {
    for (const handle of timers.values()) {
      clearTimeoutFn(handle);
    }
    timers.clear();
  }

  function reset() {
    clearAllTimers();
    sessionsById.clear();
    sessionsByUser.clear();
    messageOwner.clear();
    reservation.reset();
  }

  function getPendingTimerCount() {
    return timers.size;
  }

  return {
    GAME_ID,
    STATUS,
    startGame,
    setMessageId,
    getSession,
    getUserSession,
    guess,
    finish,
    playAgain,
    expireSession,
    renderMessage,
    setRenderHandler,
    isOpen,
    hasActiveUser,
    clearAllTimers,
    reset,
    reservation,
    getPendingTimerCount,
  };
}

function getHigherOrLowerRuntime() {
  if (!holRuntime) {
    holRuntime = createHigherOrLowerService({
      reservation: getSharedPvpMatchReservation(),
    });
  }
  return holRuntime;
}

function startHigherOrLowerGame(params) {
  return getHigherOrLowerRuntime().startGame(params);
}

module.exports = {
  GAME_ID,
  MIN_NUMBER,
  MAX_NUMBER,
  IDLE_MS,
  STATUS,
  PLAYER_BUSY_TEXT,
  BOT_DISPLAY_NAME,
  GAME_ENDED_TOAST,
  defaultRandomInt,
  nextDistinctNumber,
  parseHolCallbackData,
  buildPlayCallbackData,
  playKeyboard,
  resultKeyboard,
  renderMessage,
  createHigherOrLowerService,
  getHigherOrLowerRuntime,
  startHigherOrLowerGame,
};
