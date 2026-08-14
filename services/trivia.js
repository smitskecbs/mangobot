/**
 * Community Trivia race — first correct inline answer wins.
 * Manual start only (Activity Engine enabledForAuto: false).
 * Restart clears in-memory sessions.
 */

const crypto = require("crypto");
const { Markup } = require("telegraf");
const { isAllowedChatFightChat } = require("./chatFight");
const { sanitizePvpDisplayName } = require("./pvpSessionManager");
const {
  TRIVIA_QUESTIONS,
  ANTI_REPEAT_WINDOW,
  pickTriviaQuestion,
} = require("./triviaQuestions");
const { TRIVIA_WIN_XP } = require("./points");

const TRIVIA_TIMEOUT_MS = 60 * 1000;
const LETTERS = Object.freeze(["A", "B", "C", "D"]);

const STATUS = Object.freeze({
  ACTIVE: "active",
  WON: "won",
  EXPIRED: "expired",
});

function buildAnswerCallbackData(sessionId, answerIndex) {
  return `trivia:${sessionId}:${answerIndex}`;
}

/**
 * Opaque callback: trivia:<sessionId>:<answerIndex>
 * No user id, no correct flag, no answer text.
 * @param {string} data
 * @returns {{ sessionId: string, answerIndex: number }|null}
 */
function parseTriviaCallbackData(data) {
  if (typeof data !== "string") {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "trivia") {
    return null;
  }
  const sessionId = parts[1];
  if (!sessionId || !/^[a-f0-9]+$/i.test(sessionId)) {
    return null;
  }
  const answerIndex = Number(parts[2]);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
    return null;
  }
  return { sessionId, answerIndex };
}

function materializeQuestion(raw, random) {
  const answers = raw.answers.slice();
  const correctText = answers[raw.correctIndex];
  for (let i = answers.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = answers[i];
    answers[i] = answers[j];
    answers[j] = tmp;
  }
  return {
    id: raw.id,
    category: raw.category,
    question: raw.question,
    answers,
    correctIndex: answers.indexOf(correctText),
  };
}

function buildQuestionText(session) {
  const lines = [
    "🧠 MANGO TRIVIA",
    "",
    session.question,
    "",
  ];
  for (let i = 0; i < 4; i += 1) {
    lines.push(`[${LETTERS[i]}] ${session.answers[i]}`);
  }
  lines.push("");
  lines.push("Answer using inline buttons.");
  return lines.join("\n");
}

function buildAnswerKeyboard(sessionId) {
  const row = LETTERS.map((letter, index) =>
    Markup.button.callback(letter, buildAnswerCallbackData(sessionId, index))
  );
  return Markup.inlineKeyboard([row]);
}

function buildCompleteText(session, awardResult) {
  const lines = [
    "🧠 TRIVIA COMPLETE",
    "",
    `🏆 Winner: ${session.winnerName || "Player"}`,
    `Correct answer: ${session.answers[session.correctIndex]}`,
  ];
  if (awardResult && awardResult.awarded) {
    const xp =
      typeof awardResult.pointsToAdd === "number"
        ? awardResult.pointsToAdd
        : TRIVIA_WIN_XP;
    lines.push(`Reward: +${xp} XP`);
  }
  if (awardResult && awardResult.rankUp && awardResult.rank) {
    lines.push(
      `${awardResult.rank.emoji} Rank up: ${awardResult.rank.title}!`
    );
  }
  return lines.join("\n");
}

function buildTimeoutText(session) {
  return [
    "🧠 TRIVIA OVER",
    "",
    "Nobody got it this time.",
    "",
    `Correct answer: ${session.answers[session.correctIndex]}`,
  ].join("\n");
}

function createTriviaService(options = {}) {
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
  const random =
    typeof options.random === "function" ? options.random : Math.random;
  const randomIdFn =
    typeof options.randomIdFn === "function"
      ? options.randomIdFn
      : () => crypto.randomBytes(6).toString("hex");
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs >= 0
      ? options.timeoutMs
      : TRIVIA_TIMEOUT_MS;
  const questions = Array.isArray(options.questions)
    ? options.questions
    : TRIVIA_QUESTIONS;
  const antiRepeatWindow =
    typeof options.antiRepeatWindow === "number"
      ? options.antiRepeatWindow
      : ANTI_REPEAT_WINDOW;

  /** @type {object|null} */
  let session = null;
  /** @type {string[]} */
  let recentQuestionIds = [];
  /** @type {*|null} */
  let timeoutHandle = null;
  /** @type {((chatId: *, messageId: *, text: string) => *)|null} */
  let editMessage = null;

  function clearTimer() {
    if (timeoutHandle != null) {
      clearTimeoutFn(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function generateSessionId() {
    let id = randomIdFn();
    while (session && session.id === id) {
      id = randomIdFn();
    }
    return id;
  }

  function isTriviaOpen() {
    return Boolean(session && session.status === STATUS.ACTIVE);
  }

  function getSession(sessionId) {
    if (!session || !sessionId) {
      return null;
    }
    if (String(session.id) !== String(sessionId)) {
      return null;
    }
    return session;
  }

  function getActiveSession() {
    return isTriviaOpen() ? session : null;
  }

  function snapshot(includeSecret = false) {
    if (!session) {
      return null;
    }
    const snap = {
      id: session.id,
      chatId: session.chatId,
      questionId: session.questionId,
      question: session.question,
      answers: session.answers.slice(),
      status: session.status,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      answeredUsers: { ...session.answeredUsers },
      winnerId: session.winnerId,
      winnerName: session.winnerName,
      messageId: session.messageId,
      xpClaimed: session.xpClaimed,
    };
    if (includeSecret) {
      snap.correctIndex = session.correctIndex;
    }
    return snap;
  }

  function notifyTimeout(target) {
    const text = buildTimeoutText(target);
    if (
      editMessage &&
      target.messageId != null &&
      target.chatId != null
    ) {
      Promise.resolve(
        editMessage(target.chatId, target.messageId, text)
      ).catch(() => {});
    }
    return text;
  }

  function scheduleTimeout(target) {
    clearTimer();
    timeoutHandle = setTimeoutFn(() => {
      timeoutHandle = null;
      if (!session || session !== target) {
        return;
      }
      if (session.status !== STATUS.ACTIVE) {
        return;
      }
      if (session.winnerId != null) {
        return;
      }
      session.status = STATUS.EXPIRED;
      notifyTimeout(session);
    }, timeoutMs);
  }

  function startTrivia({ chatId, question: forcedQuestion } = {}) {
    if (!isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }
    if (isTriviaOpen()) {
      return { ok: false, reason: "already-active" };
    }

    clearTimer();

    let materialized;
    if (forcedQuestion && typeof forcedQuestion === "object") {
      materialized = {
        id: forcedQuestion.id || "custom",
        category: forcedQuestion.category || "custom",
        question: String(forcedQuestion.question || ""),
        answers: forcedQuestion.answers.slice(),
        correctIndex: forcedQuestion.correctIndex,
      };
    } else {
      const picked = pickTriviaQuestion(
        questions,
        recentQuestionIds,
        random,
        antiRepeatWindow
      );
      if (!picked.question) {
        return { ok: false, reason: "no-questions" };
      }
      recentQuestionIds = picked.recentIds;
      materialized = materializeQuestion(picked.question, random);
    }

    const startedAt = now();
    const id = generateSessionId();
    session = {
      id,
      chatId,
      questionId: materialized.id,
      question: materialized.question,
      answers: materialized.answers,
      correctIndex: materialized.correctIndex,
      status: STATUS.ACTIVE,
      startedAt,
      expiresAt: startedAt + timeoutMs,
      answeredUsers: {},
      winnerId: null,
      winnerName: null,
      messageId: null,
      xpClaimed: false,
    };

    scheduleTimeout(session);

    return {
      ok: true,
      session: snapshot(true),
      text: buildQuestionText(session),
      keyboard: buildAnswerKeyboard(session.id),
    };
  }

  function setMessageId(sessionId, messageId) {
    const target = getSession(sessionId);
    if (!target) {
      return false;
    }
    target.messageId = messageId;
    return true;
  }

  function setEditMessageHandler(fn) {
    editMessage = typeof fn === "function" ? fn : null;
  }

  /**
   * Fully synchronous answer attempt. Winner flag set before any await XP.
   */
  function tryAnswer({
    sessionId,
    userId,
    answerIndex,
    chatId,
    displayName,
    isBot,
  } = {}) {
    if (isBot) {
      return { ok: false, reason: "bot" };
    }
    const target = getSession(sessionId);
    if (!target) {
      return { ok: false, reason: "invalid-session" };
    }
    if (String(target.chatId) !== String(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }
    if (target.status === STATUS.EXPIRED || target.status === STATUS.WON) {
      return { ok: false, reason: "finished" };
    }
    if (target.status !== STATUS.ACTIVE) {
      return { ok: false, reason: "inactive" };
    }
    if (now() >= target.expiresAt) {
      target.status = STATUS.EXPIRED;
      clearTimer();
      return { ok: false, reason: "finished" };
    }
    if (
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex > 3
    ) {
      return { ok: false, reason: "bad-answer" };
    }

    const uid = String(userId);
    if (Object.prototype.hasOwnProperty.call(target.answeredUsers, uid)) {
      return { ok: false, reason: "already-answered" };
    }

    // Record attempt immediately (one try per user).
    target.answeredUsers[uid] = {
      answerIndex,
      at: now(),
    };

    if (answerIndex !== target.correctIndex) {
      return {
        ok: true,
        correct: false,
        toast: "Wrong answer ❌",
        session: snapshot(true),
      };
    }

    // Sync winner claim before any async XP write.
    target.status = STATUS.WON;
    target.winnerId = uid;
    target.winnerName = sanitizePvpDisplayName(
      displayName || { first_name: "Player" }
    );
    clearTimer();

    return {
      ok: true,
      correct: true,
      won: true,
      session: snapshot(true),
      shouldAward: true,
    };
  }

  /**
   * Mark XP claim synchronously so concurrent handlers cannot double-award.
   */
  function claimXpAward(sessionId) {
    const target = getSession(sessionId);
    if (!target) {
      return { ok: false, reason: "invalid-session" };
    }
    if (target.status !== STATUS.WON || !target.winnerId) {
      return { ok: false, reason: "not-won", shouldAward: false };
    }
    if (target.xpClaimed) {
      return { ok: false, reason: "already-claimed", shouldAward: false };
    }
    target.xpClaimed = true;
    return {
      ok: true,
      shouldAward: true,
      winnerUserId: target.winnerId,
      winnerName: target.winnerName || "Player",
      session: snapshot(true),
    };
  }

  function applyXpResultToRender(sessionId, awardResult) {
    const target = getSession(sessionId);
    if (!target || target.status !== STATUS.WON) {
      return null;
    }
    return {
      text: buildCompleteText(target, awardResult),
      extra: undefined,
    };
  }

  function forceTimeout() {
    if (!session || session.status !== STATUS.ACTIVE) {
      return { timedOut: false };
    }
    if (session.winnerId != null) {
      return { timedOut: false };
    }
    session.status = STATUS.EXPIRED;
    clearTimer();
    const text = notifyTimeout(session);
    return { timedOut: true, message: text, session: snapshot(true) };
  }

  function reset() {
    clearTimer();
    session = null;
    recentQuestionIds = [];
    editMessage = null;
  }

  function getRecentQuestionIds() {
    return recentQuestionIds.slice();
  }

  return {
    TRIVIA_TIMEOUT_MS: timeoutMs,
    TRIVIA_WIN_XP,
    STATUS,
    startTrivia,
    tryAnswer,
    claimXpAward,
    applyXpResultToRender,
    setMessageId,
    setEditMessageHandler,
    isTriviaOpen,
    getSession,
    getActiveSession,
    getSnapshot: () => snapshot(true),
    forceTimeout,
    reset,
    clearTimer,
    getRecentQuestionIds,
    buildQuestionText,
    buildCompleteText,
    buildTimeoutText,
    buildAnswerKeyboard,
  };
}

const defaultService = createTriviaService();

module.exports = {
  TRIVIA_TIMEOUT_MS,
  TRIVIA_WIN_XP,
  STATUS,
  LETTERS,
  createTriviaService,
  buildAnswerCallbackData,
  parseTriviaCallbackData,
  materializeQuestion,
  buildQuestionText,
  buildCompleteText,
  buildTimeoutText,
  sanitizePvpDisplayName,
  triviaRuntime: defaultService,
  getTriviaRuntime: () => defaultService,
  startTrivia: (...args) => defaultService.startTrivia(...args),
  tryAnswer: (...args) => defaultService.tryAnswer(...args),
  claimXpAward: (...args) => defaultService.claimXpAward(...args),
  isTriviaOpen: (...args) => defaultService.isTriviaOpen(...args),
  setTriviaMessageId: (...args) => defaultService.setMessageId(...args),
  resetTrivia: (...args) => defaultService.reset(...args),
};
