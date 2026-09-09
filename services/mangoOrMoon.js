/**
 * ManGo or Moon — lightweight 50/50 vs ManGoBot in the Games topic.
 * Streak milestones 3 and 5 can earn +1 XP, sharing a 2 XP daily cap with Higher or Lower.
 */

const crypto = require("crypto");
const { Markup } = require("telegraf");
const { isAllowedChatFightChat } = require("./chatFight");
const { sanitizePvpDisplayName } = require("./pvpSessionManager");
const { formatLightweightRewardLines } = require("./points");
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

const GAME_ID = "mom";
const IDLE_MS = 120 * 1000;
const BOT_DISPLAY_NAME = "ManGoBot";
const MOM_REWARD_PEER = "Higher or Lower";

const SIDE = Object.freeze({
  MANGO: "mango",
  MOON: "moon",
});

const SIDE_LABEL = Object.freeze({
  mango: "🥭 ManGo",
  moon: "🌙 Moon",
});

const STATUS = Object.freeze({
  ACTIVE: "active",
  ENDED: "ended",
  FINISHED: "finished",
  EXPIRED: "expired",
});

function defaultRandomInt() {
  return crypto.randomInt(0, 2);
}

function defaultRandomId() {
  return crypto.randomBytes(6).toString("hex");
}

function outcomeFromRoll(value) {
  const n = Number(value);
  if (n === 1) {
    return SIDE.MOON;
  }
  return SIDE.MANGO;
}

function sideFromAction(action) {
  if (action === "m") {
    return SIDE.MANGO;
  }
  if (action === "n") {
    return SIDE.MOON;
  }
  return null;
}

function buildPlayCallbackData(action, sessionId, round) {
  return `mom:${action}:${sessionId}:${round}`;
}

function parseMomCallbackData(data) {
  if (typeof data !== "string" || !data.startsWith("mom:")) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 4 || parts[0] !== "mom") {
    return null;
  }
  const action = parts[1];
  if (!["m", "n", "f", "a"].includes(action)) {
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
      Markup.button.callback("🥭 ManGo", buildPlayCallbackData("m", sessionId, round)),
      Markup.button.callback("🌙 Moon", buildPlayCallbackData("n", sessionId, round)),
    ],
    [Markup.button.callback("❌ Finish", buildPlayCallbackData("f", sessionId, round))],
  ]);
}

function resultKeyboard(sessionId, round) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔄 Play Again", buildPlayCallbackData("a", sessionId, round)),
      Markup.button.callback("❌ Finish", buildPlayCallbackData("f", sessionId, round)),
    ],
  ]);
}

function rewardBlock(session) {
  return formatLightweightRewardLines(
    MOM_REWARD_PEER,
    session && session.rewardStatus
  );
}

function buildStartText(session) {
  return `🥭 ManGo or Moon 🌙

Choose ManGo or Moon. One is picked at random.

${rewardBlock(session)}

Choose your side.

🔥 Streak: ${session.streak}`;
}

function buildCorrectText(session, choice, outcome) {
  return `🥭 ManGo or Moon 🌙

${rewardBlock(session)}

You chose: ${SIDE_LABEL[choice]}
Result: ${SIDE_LABEL[outcome]}

✅ Correct!
🔥 Streak: ${session.streak}

Choose your side.`;
}

function buildWrongText(session, choice, outcome) {
  return `🥭 ManGo or Moon 🌙

${rewardBlock(session)}

You chose: ${SIDE_LABEL[choice]}
Result: ${SIDE_LABEL[outcome]}

❌ Wrong!
🔥 Final streak: ${session.streak}`;
}

function buildFinishedText(session) {
  return withGameCleanupFooter(`🥭 ManGo or Moon 🌙

❌ Finished.
🔥 Final streak: ${session.streak}`);
}

function buildExpiredText(session) {
  return withGameCleanupFooter(`🥭 ManGo or Moon cancelled

This game has ended.

🔥 Final streak: ${session && session.streak != null ? session.streak : 0}`);
}

function renderMessage(session) {
  if (!session) {
    return {
      text: withGameCleanupFooter("🥭 ManGo or Moon 🌙\n\nThis game has ended."),
      extra: emptyGameKeyboardExtra(),
    };
  }
  if (session.status === STATUS.ACTIVE) {
    if (session.lastReveal && session.lastReveal.correct) {
      return {
        text: buildCorrectText(
          session,
          session.lastReveal.choice,
          session.lastReveal.outcome
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
          session.lastReveal.choice,
          session.lastReveal.outcome
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

let momRuntime = null;

function createMangoOrMoonService(options = {}) {
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
      streak: session.streak,
      round: session.round,
      idleGeneration: session.idleGeneration,
      lastReveal: session.lastReveal
        ? { ...session.lastReveal }
        : null,
      rewardStatus: session.rewardStatus
        ? { ...session.rewardStatus }
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
    logGameCleanup(GAME_TYPE.MOM, FINAL_STATE.FINISHED);
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.MOM,
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
    clearGameMessageCleanup(GAME_TYPE.MOM, session.id);
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
      clearGameMessageCleanup(GAME_TYPE.MOM, session.id);
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
    const session = {
      id,
      userId,
      displayName: sanitizePvpDisplayName(starter.displayName || starter),
      chatId,
      threadId: threadId != null ? threadId : null,
      messageId: null,
      status: STATUS.ACTIVE,
      streak: 0,
      round: 1,
      idleGeneration: 0,
      lastReveal: null,
      rewardStatus: null,
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

  function setRewardStatus(sessionId, status) {
    const session = sessionsById.get(String(sessionId));
    if (!session) {
      return false;
    }
    session.rewardStatus = status ? { ...status } : null;
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
    const choice = sideFromAction(action);
    if (!choice) {
      return { ok: false, reason: "bad-action", toast: "Choose ManGo or Moon." };
    }
    const roll = randomIntFn();
    const outcome = outcomeFromRoll(roll);
    const correct = choice === outcome;
    session.lastReveal = { choice, outcome, correct, roll };
    if (correct) {
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
    clearGameMessageCleanup(GAME_TYPE.MOM, previous.id);
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
    setRewardStatus,
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

function getMangoOrMoonRuntime() {
  if (!momRuntime) {
    momRuntime = createMangoOrMoonService({
      reservation: getSharedPvpMatchReservation(),
    });
  }
  return momRuntime;
}

function startMangoOrMoonGame(params) {
  return getMangoOrMoonRuntime().startGame(params);
}

module.exports = {
  GAME_ID,
  IDLE_MS,
  STATUS,
  SIDE,
  SIDE_LABEL,
  PLAYER_BUSY_TEXT,
  BOT_DISPLAY_NAME,
  GAME_ENDED_TOAST,
  MOM_REWARD_PEER,
  defaultRandomInt,
  outcomeFromRoll,
  parseMomCallbackData,
  buildPlayCallbackData,
  playKeyboard,
  resultKeyboard,
  renderMessage,
  createMangoOrMoonService,
  getMangoOrMoonRuntime,
  startMangoOrMoonGame,
};
