/**
 * Community Trivia — 5-question rounds (manual + Activity Engine auto).
 * Per-question race: first correct earns 1 round point.
 * Round XP only at the end (sole winner +3 / tie +2), with daily reward cap.
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
const {
  TRIVIA_ROUND_WIN_XP,
  TRIVIA_TIE_XP,
  TRIVIA_DAILY_REWARD_CAP,
} = require("./points");
const {
  emptyInlineKeyboardExtra,
} = require("../utils/expiredMessageCleanup");

const TRIVIA_ROUND_QUESTIONS = 5;
const TRIVIA_QUESTION_TIMEOUT_MS = 60 * 1000;
const TRIVIA_NEXT_QUESTION_DELAY_MS = 5 * 1000;
const TRIVIA_WRONG_ANSWER_NEXT_DELAY_MS = 2500;
const LETTERS = Object.freeze(["A", "B", "C", "D"]);

const STATUS = Object.freeze({
  ACTIVE: "active",
  COMPLETE: "complete",
  ABORTED: "aborted",
});

const QUESTION_PHASE = Object.freeze({
  OPEN: "open",
  RESOLVED: "resolved",
});

function buildAnswerCallbackData(sessionId, answerIndex) {
  return `trivia:${sessionId}:${answerIndex}`;
}

/**
 * Opaque callback: trivia:<sessionId>:<answerIndex>
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

function buildAnswerKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("A", buildAnswerCallbackData(sessionId, 0)),
      Markup.button.callback("B", buildAnswerCallbackData(sessionId, 1)),
    ],
    [
      Markup.button.callback("C", buildAnswerCallbackData(sessionId, 2)),
      Markup.button.callback("D", buildAnswerCallbackData(sessionId, 3)),
    ],
  ]);
}

function buildQuestionText(session) {
  const lines = [
    "🧠 MANGO TRIVIA",
    `Question ${session.questionNumber} / ${session.totalQuestions}`,
    "",
    session.question,
    "",
  ];
  for (let i = 0; i < 4; i += 1) {
    lines.push(`${LETTERS[i]}. ${session.answers[i]}`);
  }
  lines.push("");
  lines.push("Answer using inline buttons.");
  return lines.join("\n");
}

function buildAutoIntroPrefix() {
  return `🧠 MANGO TRIVIA

A 5-question community round is starting!

`;
}

function buildQuestionWonText(session, winnerName) {
  const score =
    (session.scores[String(session.questionWinnerId)] &&
      session.scores[String(session.questionWinnerId)].score) ||
    1;
  return [
    "✅ Correct!",
    "",
    `${session.answers[session.correctIndex]} was the right answer.`,
    "",
    `🏆 ${winnerName} wins this question.`,
    `Score: ${score}`,
    "",
    "Next question in 5 seconds... 🥭",
  ].join("\n");
}

function buildQuestionWrongText(session) {
  const answer =
    session && Array.isArray(session.answers)
      ? session.answers[session.correctIndex]
      : "";
  return [
    "❌ Wrong answer!",
    "",
    "Correct answer:",
    `✅ ${answer}`,
    "",
    "Next question coming up... 🥭",
  ].join("\n");
}

function buildQuestionTimeoutText(session) {
  return [
    "⏱ TIME'S UP",
    "",
    `Correct answer: ${session.answers[session.correctIndex]}`,
    "",
    "No point awarded.",
    "",
    "Next question in 5 seconds...",
  ].join("\n");
}

function rankRoundScores(scores) {
  return Object.entries(scores || {})
    .map(([userId, entry]) => ({
      userId,
      displayName: (entry && entry.displayName) || "Player",
      score: entry && typeof entry.score === "number" ? entry.score : 0,
    }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.displayName).localeCompare(String(b.displayName))
    );
}

function buildFinalScoreboardText(session, xpSummary) {
  const ranked = rankRoundScores(session.scores);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = ["🏆 MANGO TRIVIA COMPLETE", ""];

  if (ranked.length === 0) {
    lines.push("No Trivia winner — nobody scored.");
  } else {
    ranked.slice(0, 10).forEach((row, index) => {
      const prefix = medals[index] || `${index + 1}.`;
      lines.push(`${prefix} ${row.displayName} — ${row.score}`);
    });
  }

  lines.push("");

  const topScore = ranked.length ? ranked[0].score : 0;
  const firsts = ranked.filter((r) => r.score === topScore);
  if (topScore <= 0 || firsts.length === 0) {
    lines.push("No Trivia XP this round.");
  } else if (firsts.length === 1) {
    lines.push(`Winner: ${firsts[0].displayName} 🥭`);
  } else {
    lines.push("🤝 Trivia tie!");
    firsts.forEach((row) => {
      lines.push(`${row.displayName} — ${row.score}`);
    });
  }

  if (xpSummary && typeof xpSummary.line === "string" && xpSummary.line) {
    lines.push("");
    lines.push(xpSummary.line);
  }

  return lines.join("\n");
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
  const questionTimeoutMs =
    typeof options.questionTimeoutMs === "number" && options.questionTimeoutMs >= 0
      ? options.questionTimeoutMs
      : TRIVIA_QUESTION_TIMEOUT_MS;
  const nextQuestionDelayMs =
    typeof options.nextQuestionDelayMs === "number" &&
    options.nextQuestionDelayMs >= 0
      ? options.nextQuestionDelayMs
      : TRIVIA_NEXT_QUESTION_DELAY_MS;
  const wrongAnswerNextDelayMs =
    typeof options.wrongAnswerNextDelayMs === "number" &&
    options.wrongAnswerNextDelayMs >= 0
      ? options.wrongAnswerNextDelayMs
      : TRIVIA_WRONG_ANSWER_NEXT_DELAY_MS;
  const totalQuestions =
    typeof options.totalQuestions === "number" && options.totalQuestions > 0
      ? options.totalQuestions
      : TRIVIA_ROUND_QUESTIONS;
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
  let questionTimer = null;
  /** @type {*|null} */
  let advanceTimer = null;
  /** @type {Function|null} */
  let editMessage = null;
  /** @type {Function|null} */
  let onRoundComplete = null;
  /** @type {Function|null} */
  let awardXpFn = null;

  function clearQuestionTimer() {
    if (questionTimer != null) {
      clearTimeoutFn(questionTimer);
      questionTimer = null;
    }
  }

  function clearAdvanceTimer() {
    if (advanceTimer != null) {
      clearTimeoutFn(advanceTimer);
      advanceTimer = null;
    }
  }

  function clearAllTimers() {
    clearQuestionTimer();
    clearAdvanceTimer();
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

  function snapshot(includeSecret = false) {
    if (!session) {
      return null;
    }
    const snap = {
      id: session.id,
      roundId: session.roundId,
      chatId: session.chatId,
      status: session.status,
      questionPhase: session.questionPhase,
      questionNumber: session.questionNumber,
      totalQuestions: session.totalQuestions,
      questionId: session.questionId,
      question: session.question,
      answers: session.answers.slice(),
      scores: { ...session.scores },
      answeredUsers: { ...session.answeredUsers },
      questionWinnerId: session.questionWinnerId,
      startedAt: session.startedAt,
      roundStartedAt: session.roundStartedAt,
      expiresAt: session.expiresAt,
      messageId: session.messageId,
      source: session.source,
      xpClaimed: session.xpClaimed,
    };
    if (includeSecret) {
      snap.correctIndex = session.correctIndex;
    }
    return snap;
  }

  function safeEdit(text, extra) {
    if (!session || session.messageId == null || typeof editMessage !== "function") {
      return Promise.resolve(false);
    }
    return Promise.resolve(
      editMessage(
        session.chatId,
        session.messageId,
        text,
        extra != null ? extra : emptyInlineKeyboardExtra()
      )
    )
      .then(() => true)
      .catch(() => false);
  }

  function pickNextMaterialized() {
    const picked = pickTriviaQuestion(
      questions,
      recentQuestionIds,
      random,
      antiRepeatWindow
    );
    if (!picked.question) {
      return null;
    }
    recentQuestionIds = picked.recentIds;
    return materializeQuestion(picked.question, random);
  }

  function applyQuestionToSession(materialized) {
    session.questionId = materialized.id;
    session.question = materialized.question;
    session.answers = materialized.answers;
    session.correctIndex = materialized.correctIndex;
    session.questionPhase = QUESTION_PHASE.OPEN;
    session.answeredUsers = {};
    session.questionWinnerId = null;
    session.expiresAt = now() + questionTimeoutMs;
  }

  function scheduleQuestionTimeout(target) {
    clearQuestionTimer();
    const expectedNumber = target.questionNumber;
    questionTimer = setTimeoutFn(() => {
      questionTimer = null;
      if (!session || session !== target) {
        return;
      }
      if (session.status !== STATUS.ACTIVE) {
        return;
      }
      if (session.questionNumber !== expectedNumber) {
        return;
      }
      if (session.questionPhase !== QUESTION_PHASE.OPEN) {
        return;
      }
      resolveQuestionTimeout();
    }, questionTimeoutMs);
  }

  function resolveQuestionTimeout() {
    if (!session || session.status !== STATUS.ACTIVE) {
      return;
    }
    if (session.questionPhase !== QUESTION_PHASE.OPEN) {
      return;
    }
    session.questionPhase = QUESTION_PHASE.RESOLVED;
    clearQuestionTimer();
    const text = buildQuestionTimeoutText(session);
    Promise.resolve(safeEdit(text, emptyInlineKeyboardExtra())).catch(() => {});
    scheduleAdvance();
  }

  function scheduleAdvance(delayMs) {
    clearAdvanceTimer();
    const target = session;
    const wait =
      typeof delayMs === "number" && delayMs >= 0 ? delayMs : nextQuestionDelayMs;
    advanceTimer = setTimeoutFn(() => {
      advanceTimer = null;
      if (!session || session !== target) {
        return;
      }
      if (session.status !== STATUS.ACTIVE) {
        return;
      }
      advanceRound();
    }, wait);
  }

  function computeRoundClaim() {
    const ranked = rankRoundScores(session.scores);
    const topScore = ranked.length ? ranked[0].score : 0;
    const firsts =
      topScore > 0 ? ranked.filter((r) => r.score === topScore) : [];
    if (firsts.length === 0) {
      return {
        winners: [],
        tie: false,
        pointsToAdd: 0,
        shouldAward: false,
      };
    }
    if (firsts.length === 1) {
      return {
        winners: firsts,
        tie: false,
        pointsToAdd: TRIVIA_ROUND_WIN_XP,
        shouldAward: true,
      };
    }
    return {
      winners: firsts,
      tie: true,
      pointsToAdd: TRIVIA_TIE_XP,
      shouldAward: true,
    };
  }

  /**
   * Sync XP claim flag before any await award writes.
   */
  function claimRoundXp() {
    if (!session) {
      return { ok: false, reason: "invalid-session", shouldAward: false };
    }
    if (session.status !== STATUS.COMPLETE) {
      return { ok: false, reason: "not-complete", shouldAward: false };
    }
    if (session.xpClaimed) {
      return { ok: false, reason: "already-claimed", shouldAward: false };
    }
    session.xpClaimed = true;
    const claim = computeRoundClaim();
    return { ok: true, ...claim, session: snapshot(true) };
  }

  function formatXpSummaryLine(xpResults, claim) {
    if (!claim || !claim.shouldAward || !claim.winners.length) {
      return "Trivia XP: none";
    }
    const awarded = (xpResults || []).filter((r) => r && r.awarded);
    if (awarded.length === 0) {
      const capped = (xpResults || []).some((r) => r && r.reason === "daily-cap");
      if (capped) {
        return "Trivia XP: daily cap reached";
      }
      return "Trivia XP: none";
    }
    return `Trivia XP: +${claim.pointsToAdd}`;
  }

  function finishRound() {
    if (!session) {
      return;
    }
    session.status = STATUS.COMPLETE;
    session.questionPhase = QUESTION_PHASE.RESOLVED;
    clearAllTimers();

    const claim = claimRoundXp();
    const xpResults = [];
    if (claim.ok && claim.shouldAward && typeof awardXpFn === "function") {
      for (const winner of claim.winners) {
        try {
          xpResults.push(
            awardXpFn(winner.userId, winner.displayName, claim.pointsToAdd)
          );
        } catch (_err) {
          xpResults.push({
            awarded: false,
            reason: "award-error",
            pointsToAdd: 0,
          });
        }
      }
    }

    const xpSummary = {
      line: formatXpSummaryLine(xpResults, claim),
      results: xpResults,
      claim,
    };
    session.lastXpSummary = xpSummary;
    const text = buildFinalScoreboardText(session, xpSummary);

    const payload = {
      session: snapshot(true),
      claim,
      xpResults,
      text,
      extra: emptyInlineKeyboardExtra(),
    };

    if (typeof onRoundComplete === "function") {
      Promise.resolve(onRoundComplete(payload)).catch(() => {});
    } else {
      Promise.resolve(safeEdit(text, emptyInlineKeyboardExtra())).catch(() => {});
    }
    return payload;
  }

  function advanceRound() {
    if (!session || session.status !== STATUS.ACTIVE) {
      return null;
    }
    if (session.questionNumber >= session.totalQuestions) {
      return finishRound();
    }

    const next = pickNextMaterialized();
    if (!next) {
      return abortRound("no-questions");
    }

    session.questionNumber += 1;
    applyQuestionToSession(next);
    scheduleQuestionTimeout(session);
    const text = buildQuestionText(session);
    const extra = buildAnswerKeyboard(session.id);
    Promise.resolve(safeEdit(text, extra)).catch(() => {
      abortRound("edit-failed");
    });
    return {
      advanced: true,
      session: snapshot(true),
      text,
      keyboard: extra,
    };
  }

  function abortRound(reason) {
    clearAllTimers();
    if (session) {
      session.status = STATUS.ABORTED;
      session.abortReason = reason || "aborted";
    }
    return { ok: false, reason: reason || "aborted", session: snapshot(true) };
  }

  function startTrivia({
    chatId,
    source = "manual",
    question: forcedQuestion,
    autoIntro = false,
  } = {}) {
    if (!isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }
    if (isTriviaOpen()) {
      return { ok: false, reason: "already-active" };
    }

    clearAllTimers();

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
      materialized = pickNextMaterialized();
      if (!materialized) {
        return { ok: false, reason: "no-questions" };
      }
    }

    const startedAt = now();
    const id = generateSessionId();
    session = {
      id,
      roundId: id,
      chatId,
      status: STATUS.ACTIVE,
      questionPhase: QUESTION_PHASE.OPEN,
      questionNumber: 1,
      totalQuestions,
      scores: {},
      answeredUsers: {},
      questionWinnerId: null,
      startedAt,
      roundStartedAt: startedAt,
      expiresAt: startedAt + questionTimeoutMs,
      messageId: null,
      source: source || "manual",
      xpClaimed: false,
      lastXpSummary: null,
      abortReason: null,
    };
    applyQuestionToSession(materialized);
    scheduleQuestionTimeout(session);

    const questionBody = buildQuestionText(session);
    const text =
      autoIntro || source === "auto"
        ? `${buildAutoIntroPrefix()}${questionBody}`
        : questionBody;

    return {
      ok: true,
      session: snapshot(true),
      text,
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

  function setRoundCompleteHandler(fn) {
    onRoundComplete = typeof fn === "function" ? fn : null;
  }

  function setAwardXpHandler(fn) {
    awardXpFn = typeof fn === "function" ? fn : null;
  }

  /**
   * Fully synchronous answer attempt for the current question.
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
    if (target.status !== STATUS.ACTIVE) {
      return { ok: false, reason: "finished" };
    }
    if (target.questionPhase !== QUESTION_PHASE.OPEN) {
      return { ok: false, reason: "question-closed" };
    }
    if (now() >= target.expiresAt) {
      resolveQuestionTimeout();
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

    target.answeredUsers[uid] = { answerIndex, at: now() };

    if (answerIndex !== target.correctIndex) {
      target.questionPhase = QUESTION_PHASE.RESOLVED;
      clearQuestionTimer();
      const rendered = {
        text: buildQuestionWrongText(target),
        extra: emptyInlineKeyboardExtra(),
      };
      scheduleAdvance(wrongAnswerNextDelayMs);
      return {
        ok: true,
        correct: false,
        toast: "❌ Wrong answer!",
        session: snapshot(true),
        rendered,
      };
    }

    // Sync question winner before any await.
    target.questionPhase = QUESTION_PHASE.RESOLVED;
    target.questionWinnerId = uid;
    const name = sanitizePvpDisplayName(displayName || { first_name: "Player" });
    if (!target.scores[uid]) {
      target.scores[uid] = { score: 0, displayName: name };
    }
    target.scores[uid].score += 1;
    target.scores[uid].displayName = name;
    clearQuestionTimer();

    const rendered = {
      text: buildQuestionWonText(target, name),
      extra: emptyInlineKeyboardExtra(),
    };
    scheduleAdvance();

    return {
      ok: true,
      correct: true,
      questionWon: true,
      session: snapshot(true),
      rendered,
    };
  }

  function forceQuestionTimeout() {
    if (!session || session.status !== STATUS.ACTIVE) {
      return { timedOut: false };
    }
    if (session.questionPhase !== QUESTION_PHASE.OPEN) {
      return { timedOut: false };
    }
    resolveQuestionTimeout();
    return {
      timedOut: true,
      session: snapshot(true),
      message: buildQuestionTimeoutText(session),
    };
  }

  function forceCompleteRound() {
    if (!session || session.status !== STATUS.ACTIVE) {
      return { ok: false, reason: "inactive" };
    }
    clearAllTimers();
    return finishRound();
  }

  function reset() {
    clearAllTimers();
    session = null;
    recentQuestionIds = [];
    editMessage = null;
    onRoundComplete = null;
    awardXpFn = null;
  }

  function getRecentQuestionIds() {
    return recentQuestionIds.slice();
  }

  function getPendingTimerCount() {
    let n = 0;
    if (questionTimer != null) n += 1;
    if (advanceTimer != null) n += 1;
    return n;
  }

  return {
    TRIVIA_ROUND_QUESTIONS: totalQuestions,
    TRIVIA_QUESTION_TIMEOUT_MS: questionTimeoutMs,
    TRIVIA_NEXT_QUESTION_DELAY_MS: nextQuestionDelayMs,
    TRIVIA_WRONG_ANSWER_NEXT_DELAY_MS: wrongAnswerNextDelayMs,
    TRIVIA_ROUND_WIN_XP,
    TRIVIA_TIE_XP,
    TRIVIA_DAILY_REWARD_CAP,
    STATUS,
    QUESTION_PHASE,
    startTrivia,
    tryAnswer,
    claimRoundXp,
    setMessageId,
    setEditMessageHandler,
    setRoundCompleteHandler,
    setAwardXpHandler,
    isTriviaOpen,
    getSession,
    getSnapshot: () => snapshot(true),
    forceQuestionTimeout,
    forceCompleteRound,
    advanceRound,
    abortRound,
    reset,
    clearAllTimers,
    getRecentQuestionIds,
    getPendingTimerCount,
    buildQuestionText,
    buildQuestionWonText,
    buildQuestionWrongText,
    buildQuestionTimeoutText,
    buildFinalScoreboardText,
    buildAnswerKeyboard,
    rankRoundScores,
    formatXpSummaryLine,
  };
}

const defaultService = createTriviaService();

module.exports = {
  TRIVIA_ROUND_QUESTIONS,
  TRIVIA_QUESTION_TIMEOUT_MS,
  TRIVIA_NEXT_QUESTION_DELAY_MS,
  TRIVIA_WRONG_ANSWER_NEXT_DELAY_MS,
  TRIVIA_TIMEOUT_MS: TRIVIA_QUESTION_TIMEOUT_MS,
  TRIVIA_ROUND_WIN_XP,
  TRIVIA_TIE_XP,
  TRIVIA_DAILY_REWARD_CAP,
  STATUS,
  QUESTION_PHASE,
  LETTERS,
  createTriviaService,
  buildAnswerCallbackData,
  parseTriviaCallbackData,
  materializeQuestion,
  buildQuestionText,
  buildQuestionWonText,
  buildQuestionWrongText,
  buildQuestionTimeoutText,
  buildFinalScoreboardText,
  buildAnswerKeyboard,
  rankRoundScores,
  sanitizePvpDisplayName,
  triviaRuntime: defaultService,
  getTriviaRuntime: () => defaultService,
  startTrivia: (...args) => defaultService.startTrivia(...args),
  tryAnswer: (...args) => defaultService.tryAnswer(...args),
  claimRoundXp: (...args) => defaultService.claimRoundXp(...args),
  isTriviaOpen: (...args) => defaultService.isTriviaOpen(...args),
  setTriviaMessageId: (...args) => defaultService.setMessageId(...args),
  resetTrivia: (...args) => defaultService.reset(...args),
};
