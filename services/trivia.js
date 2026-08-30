/**
 * Community Trivia — category hub + 5-question auto rounds.
 * Hub: Games → category → unlimited questions, Next / Change Category / Games.
 * Auto: 5-question community race, Random category, auto-advance.
 * Per valid answer: one daily attempt. First 5 UTC attempts can earn +1 XP if correct.
 * Restart clears in-memory sessions; daily attempts live in points.json.
 */

const crypto = require("crypto");
const { Markup } = require("telegraf");
const { isAllowedChatFightChat } = require("./chatFight");
const { sanitizePvpDisplayName } = require("./pvpSessionManager");
const {
  TRIVIA_QUESTIONS,
  TRIVIA_HUB_CATEGORIES,
  ANTI_REPEAT_WINDOW,
  pickTriviaQuestion,
  getCategoryMeta,
  isHubCategoryId,
} = require("./triviaQuestions");
const {
  TRIVIA_ROUND_WIN_XP,
  TRIVIA_TIE_XP,
  TRIVIA_DAILY_REWARD_CAP,
  TRIVIA_DAILY_ATTEMPT_CAP,
} = require("./points");
const {
  emptyInlineKeyboardExtra,
} = require("../utils/expiredMessageCleanup");
const {
  GAME_TYPE,
  FINAL_STATE,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  buildFinalGameText,
  logGameCleanup,
  logCleanupRenderFailed,
  emptyGameKeyboardExtra,
  scheduleGameMessageCleanup,
} = require("../utils/gameCleanup");

const TRIVIA_ROUND_QUESTIONS = 5;
const TRIVIA_QUESTION_TIMEOUT_MS = 60 * 1000;
const TRIVIA_NEXT_QUESTION_DELAY_MS = 5 * 1000;
const TRIVIA_WRONG_ANSWER_NEXT_DELAY_MS = 2500;
const TRIVIA_STALE_MS = GAME_MESSAGE_CLEANUP_DELAY_MS;
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
  if (sessionId.toLowerCase() === "cat") {
    return null;
  }
  const answerIndex = Number(parts[2]);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
    return null;
  }
  return { sessionId, answerIndex };
}

const TRIVIA_HUB_ACTION = Object.freeze({
  CHOOSER: "trivia:hub",
  NEXT: "trivia:next",
  CHANGE: "trivia:change",
  GAMES: "trivia:games",
});

function buildCategoryCallbackData(categoryId) {
  return `trivia:cat:${categoryId}`;
}

/**
 * Hub navigation callbacks. No user ids.
 */
function parseTriviaHubCallback(data) {
  if (typeof data !== "string") {
    return null;
  }
  if (data === TRIVIA_HUB_ACTION.CHOOSER) {
    return { action: "hub" };
  }
  if (data === TRIVIA_HUB_ACTION.NEXT) {
    return { action: "next" };
  }
  if (data === TRIVIA_HUB_ACTION.CHANGE) {
    return { action: "change" };
  }
  if (data === TRIVIA_HUB_ACTION.GAMES) {
    return { action: "games" };
  }
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "trivia" || parts[1] !== "cat") {
    return null;
  }
  if (!isHubCategoryId(parts[2])) {
    return null;
  }
  return { action: "category", category: parts[2] };
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
    difficulty: raw.difficulty || null,
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

function buildHubResultKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➡️ Next Question", TRIVIA_HUB_ACTION.NEXT)],
    [Markup.button.callback("🔄 Change Category", TRIVIA_HUB_ACTION.CHANGE)],
    [Markup.button.callback("⬅️ Games", TRIVIA_HUB_ACTION.GAMES)],
  ]);
}

function buildTriviaChooserKeyboard() {
  const rows = TRIVIA_HUB_CATEGORIES.map((row) => [
    Markup.button.callback(
      `${row.emoji} ${row.label}`,
      buildCategoryCallbackData(row.id)
    ),
  ]);
  rows.push([Markup.button.callback("⬅️ Back", TRIVIA_HUB_ACTION.GAMES)]);
  return Markup.inlineKeyboard(rows);
}

function formatTriviaXpStatusLine(status, { fullLimitCopy = false } = {}) {
  const used =
    status && typeof status.attemptsUsed === "number" ? status.attemptsUsed : 0;
  const cap =
    status && typeof status.dailyCap === "number"
      ? status.dailyCap
      : TRIVIA_DAILY_ATTEMPT_CAP;
  if (used >= cap) {
    if (fullLimitCopy) {
      return "🎮 Daily Trivia XP limit reached.\n\nYou can keep playing for fun. 🥭";
    }
    return "🎮 Daily Trivia XP limit reached.";
  }
  return `🎯 XP-eligible plays: ${used} / ${cap}`;
}

function buildTriviaChooserText(status) {
  const lines = ["🧠 ManGo Trivia", "", "Choose a category:", ""];
  lines.push(formatTriviaXpStatusLine(status, { fullLimitCopy: true }));
  return lines.join("\n");
}

function categoryHeader(session) {
  const meta = getCategoryMeta(
    (session && (session.questionCategory || session.category)) || "random"
  );
  return `${meta.emoji} ${meta.label} Trivia`;
}

function buildQuestionText(session, status) {
  const hub = Boolean(session && session.hubMode);
  const lines = hub
    ? [categoryHeader(session), "", `Question ${session.questionNumber}`, ""]
    : [
        "🧠 MANGO TRIVIA",
        categoryHeader(session),
        `Question ${session.questionNumber} / ${session.totalQuestions}`,
        "",
      ];
  lines.push(session.question, "");
  for (let i = 0; i < 4; i += 1) {
    lines.push(`${LETTERS[i]}. ${session.answers[i]}`);
  }
  lines.push("");
  lines.push("Answer using inline buttons.");
  if (status) {
    lines.push("");
    lines.push(formatTriviaXpStatusLine(status));
  } else if (hub) {
    lines.push("");
    lines.push(formatTriviaXpStatusLine({ attemptsUsed: 0 }));
  }
  return lines.join("\n");
}

function buildAutoIntroPrefix() {
  return `🧠 MANGO TRIVIA

A 5-question community round is starting!

`;
}

function xpResultLines(xpResult, { correct } = {}) {
  if (!xpResult) {
    return [];
  }
  const lines = [];
  if (xpResult.funPlay || xpResult.limitReached || xpResult.reason === "daily-cap") {
    if (correct) {
      lines.push("", "✅ Correct!", "", "Daily Trivia XP limit reached.", "Playing for fun. 🥭");
    } else {
      lines.push("", "Daily Trivia XP limit reached.", "Playing for fun. 🥭");
    }
    return lines;
  }
  if (xpResult.reason === "wallet-required") {
    lines.push("");
    lines.push(correct ? "+0 XP" : "+0 XP");
    lines.push("Trivia XP: 🔒 0 XP — wallet not linked — /wallet");
    lines.push("");
    lines.push(formatTriviaXpStatusLine(xpResult));
    return lines;
  }
  if (correct && xpResult.awarded) {
    lines.push("", "+1 XP", "", formatTriviaXpStatusLine(xpResult));
    return lines;
  }
  lines.push("", "+0 XP", "", formatTriviaXpStatusLine(xpResult));
  return lines;
}

function buildQuestionWonText(session, winnerName, xpResult) {
  if (session && session.hubMode) {
    const lines = ["✅ Correct!"];
    if (xpResult && (xpResult.funPlay || xpResult.reason === "daily-cap")) {
      lines.push("", "Daily Trivia XP limit reached.", "Playing for fun. 🥭");
    } else if (xpResult && xpResult.reason === "wallet-required") {
      lines.push("", "+0 XP", "Trivia XP: 🔒 0 XP — wallet not linked — /wallet");
      lines.push("", formatTriviaXpStatusLine(xpResult));
    } else if (xpResult && xpResult.awarded) {
      lines.push("", "+1 XP", "", formatTriviaXpStatusLine(xpResult));
    } else {
      lines.push("", "+0 XP", "", formatTriviaXpStatusLine(xpResult));
    }
    return lines.join("\n");
  }
  const score =
    (session.scores[String(session.questionWinnerId)] &&
      session.scores[String(session.questionWinnerId)].score) ||
    1;
  const lines = [
    "✅ Correct!",
    "",
    `${session.answers[session.correctIndex]} was the right answer.`,
    "",
    `🏆 ${winnerName} wins this question.`,
    `Score: ${score}`,
    "",
    "Next question in 5 seconds... 🥭",
  ];
  if (xpResult) {
    lines.push(...xpResultLines(xpResult, { correct: true }).filter((line) => line !== "✅ Correct!"));
  }
  return lines.join("\n");
}

function buildQuestionWrongText(session, xpResult) {
  const answer =
    session && Array.isArray(session.answers)
      ? session.answers[session.correctIndex]
      : "";
  if (session && session.hubMode) {
    const lines = ["❌ Not quite.", "", "Correct answer:", answer || ""];
    if (xpResult && (xpResult.funPlay || xpResult.reason === "daily-cap")) {
      lines.push("", "Daily Trivia XP limit reached.", "Playing for fun. 🥭");
    } else {
      lines.push("", "+0 XP", "", formatTriviaXpStatusLine(xpResult));
      if (xpResult && xpResult.reason === "wallet-required") {
        lines.push("Trivia XP: 🔒 0 XP — wallet not linked — /wallet");
      }
    }
    return lines.join("\n");
  }
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
  if (session && session.hubMode) {
    return [
      "⏱ TIME'S UP",
      "",
      `Correct answer: ${session.answers[session.correctIndex]}`,
      "",
      "No attempt used.",
    ].join("\n");
  }
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
  const staleAfterMs =
    typeof options.staleAfterMs === "number" && options.staleAfterMs >= 0
      ? options.staleAfterMs
      : TRIVIA_STALE_MS;
  const cleanupDelayMs =
    typeof options.cleanupDelayMs === "number" && options.cleanupDelayMs >= 0
      ? options.cleanupDelayMs
      : GAME_MESSAGE_CLEANUP_DELAY_MS;

  /** @type {object|null} */
  let session = null;
  /** @type {string[]} */
  let recentQuestionIds = [];
  /** @type {*|null} */
  let questionTimer = null;
  /** @type {*|null} */
  let advanceTimer = null;
  /** @type {*|null} */
  let hubIdleTimer = null;
  /** @type {Function|null} */
  let editMessage = null;
  /** @type {Function|null} */
  let onRoundComplete = null;
  /** @type {Function|null} */
  let awardXpFn = null;
  /** @type {Function|null} */
  let deleteMessageFn =
    typeof options.deleteMessageFn === "function" ? options.deleteMessageFn : null;

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

  function clearHubIdleTimer() {
    if (hubIdleTimer != null) {
      clearTimeoutFn(hubIdleTimer);
      hubIdleTimer = null;
    }
  }

  function clearAllTimers() {
    clearQuestionTimer();
    clearAdvanceTimer();
    clearHubIdleTimer();
  }

  function touchActivity(target) {
    const row = target || session;
    if (row) {
      row.lastActivityAt = now();
    }
  }

  function scheduleHubIdleTimeout(target) {
    clearHubIdleTimer();
    if (!target || !target.hubMode || target.status !== STATUS.ACTIVE) {
      return;
    }
    const expectedActivity = target.lastActivityAt;
    hubIdleTimer = setTimeoutFn(() => {
      hubIdleTimer = null;
      if (!session || session !== target) {
        return;
      }
      if (session.status !== STATUS.ACTIVE) {
        return;
      }
      if (session.lastActivityAt !== expectedActivity) {
        return;
      }
      abortRound("stale-idle");
    }, staleAfterMs);
  }

  function isTimerlessAbandoned(target) {
    if (!target || target.status !== STATUS.ACTIVE) {
      return false;
    }
    if (questionTimer != null || advanceTimer != null || hubIdleTimer != null) {
      return false;
    }
    if (target.hubMode && target.questionPhase === QUESTION_PHASE.RESOLVED) {
      return false;
    }
    return true;
  }

  function isSessionStale(target) {
    const row = target || session;
    if (!row || row.status !== STATUS.ACTIVE) {
      return false;
    }
    if (isTimerlessAbandoned(row)) {
      return true;
    }
    const activity =
      typeof row.lastActivityAt === "number"
        ? row.lastActivityAt
        : typeof row.startedAt === "number"
          ? row.startedAt
          : 0;
    if (!activity) {
      return isTimerlessAbandoned(row);
    }
    return now() - activity >= staleAfterMs;
  }

  function recoverStaleSession() {
    if (!session || session.status !== STATUS.ACTIVE) {
      return false;
    }
    if (!isSessionStale(session)) {
      return false;
    }
    abortRound("stale");
    return true;
  }

  function scheduleTriviaMessageCleanup(target, { silent } = {}) {
    if (silent) {
      return;
    }
    const row = target || session;
    if (!row || row.chatId == null || row.messageId == null) {
      return;
    }
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TRIVIA,
      sessionId: row.id,
      chatId: row.chatId,
      messageIds: [row.messageId],
      delayMs: cleanupDelayMs,
      setTimeoutFn,
      clearTimeoutFn,
      deleteMessageFn,
      telegram: options.telegram || null,
    });
  }

  function generateSessionId() {
    let id = randomIdFn();
    while (isTriviaOpen() && session.id === id) {
      id = randomIdFn();
    }
    return id;
  }

  function isTriviaOpen() {
    recoverStaleSession();
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
      lastActivityAt: session.lastActivityAt,
      roundStartedAt: session.roundStartedAt,
      expiresAt: session.expiresAt,
      messageId: session.messageId,
      source: session.source,
      xpClaimed: session.xpClaimed,
      hubMode: Boolean(session.hubMode),
      category: session.category || null,
      questionCategory: session.questionCategory || null,
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

  function pickNextMaterialized(categoryOverride) {
    const category =
      categoryOverride != null
        ? categoryOverride
        : session && session.category;
    const picked = pickTriviaQuestion(
      questions,
      recentQuestionIds,
      random,
      antiRepeatWindow,
      category
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
    session.questionCategory = materialized.category || null;
    session.questionPhase = QUESTION_PHASE.OPEN;
    session.answeredUsers = {};
    session.questionWinnerId = null;
    session.expiresAt = now() + questionTimeoutMs;
    touchActivity(session);
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
    const extra = session.hubMode
      ? buildHubResultKeyboard()
      : emptyInlineKeyboardExtra();
    Promise.resolve(safeEdit(text, extra)).catch(() => {});
    if (!session.hubMode) {
      scheduleAdvance();
    } else {
      touchActivity(session);
      scheduleHubIdleTimeout(session);
    }
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
      const walletLocked = (xpResults || []).some(
        (r) => r && r.reason === "wallet-required"
      );
      if (walletLocked) {
        return "Trivia XP: 🔒 0 XP — wallet not linked — /wallet";
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
    const xpSummary = {
      line: formatXpSummaryLine(xpResults, {
        ...claim,
        shouldAward: false,
      }),
      results: xpResults,
      claim,
    };
    session.lastXpSummary = xpSummary;
    const text = buildFinalScoreboardText(session, xpSummary);
    logGameCleanup(GAME_TYPE.TRIVIA, FINAL_STATE.FINISHED);

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
    scheduleTriviaMessageCleanup(payload.session);
    return payload;
  }

  function advanceRound() {
    if (!session || session.status !== STATUS.ACTIVE) {
      return null;
    }
    if (!session.hubMode && session.questionNumber >= session.totalQuestions) {
      return finishRound();
    }

    const next = pickNextMaterialized();
    if (!next) {
      return abortRound("no-questions");
    }

    session.questionNumber += 1;
    applyQuestionToSession(next);
    scheduleQuestionTimeout(session);
    const text = buildQuestionText(session, session.lastXpResult || session.xpStatus);
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

  function abortRound(reason, options = {}) {
    clearAllTimers();
    if (session) {
      session.status = STATUS.ABORTED;
      session.abortReason = reason || "aborted";
      logGameCleanup(GAME_TYPE.TRIVIA, FINAL_STATE.CANCELLED);
      if (!options.silent) {
        const text = buildFinalGameText(GAME_TYPE.TRIVIA, FINAL_STATE.CANCELLED);
        Promise.resolve(safeEdit(text, emptyGameKeyboardExtra())).catch(() => {
          logCleanupRenderFailed(GAME_TYPE.TRIVIA);
        });
      }
      scheduleTriviaMessageCleanup(session, { silent: Boolean(options.silent) });
    }
    return { ok: false, reason: reason || "aborted", session: snapshot(true) };
  }

  function releaseHubSession(reason) {
    return abortRound(reason || "hub-nav", { silent: true });
  }

  function startTrivia({
    chatId,
    source = "manual",
    question: forcedQuestion,
    autoIntro = false,
    category = null,
    hubMode = false,
    xpStatus = null,
  } = {}) {
    if (!isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }
    recoverStaleSession();
    if (session && session.status === STATUS.ACTIVE) {
      return { ok: false, reason: "already-active" };
    }

    clearAllTimers();

    const resolvedCategory =
      source === "auto" && !category ? "random" : category;
    const useHub = Boolean(hubMode);

    let materialized;
    if (forcedQuestion && typeof forcedQuestion === "object") {
      materialized = {
        id: forcedQuestion.id || "custom",
        category: forcedQuestion.category || resolvedCategory || "custom",
        question: String(forcedQuestion.question || ""),
        answers: forcedQuestion.answers.slice(),
        correctIndex: forcedQuestion.correctIndex,
      };
    } else {
      materialized = pickNextMaterialized(resolvedCategory);
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
      totalQuestions: useHub ? 0 : totalQuestions,
      scores: {},
      answeredUsers: {},
      questionWinnerId: null,
      startedAt,
      lastActivityAt: startedAt,
      roundStartedAt: startedAt,
      expiresAt: startedAt + questionTimeoutMs,
      messageId: null,
      source: source || "manual",
      xpClaimed: false,
      lastXpSummary: null,
      lastXpResult: null,
      xpStatus: xpStatus || null,
      abortReason: null,
      hubMode: useHub,
      category: resolvedCategory || null,
    };
    applyQuestionToSession(materialized);
    touchActivity(session);
    scheduleQuestionTimeout(session);

    const questionBody = buildQuestionText(session, xpStatus);
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

  function setDeleteMessageHandler(fn) {
    deleteMessageFn = typeof fn === "function" ? fn : null;
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

  function awardAttempt(uid, name, correct) {
    if (typeof awardXpFn !== "function") {
      return null;
    }
    try {
      return awardXpFn(uid, name, { correct });
    } catch (_err) {
      return null;
    }
  }

  function resultExtra(target) {
    if (target.hubMode) {
      return buildHubResultKeyboard();
    }
    return emptyInlineKeyboardExtra();
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
    const name = sanitizePvpDisplayName(displayName || { first_name: "Player" });
    const correct = answerIndex === target.correctIndex;

    target.questionPhase = QUESTION_PHASE.RESOLVED;
    clearQuestionTimer();

    const xpResult = awardAttempt(uid, name, correct);
    target.lastXpResult = xpResult;
    touchActivity(target);

    if (!correct) {
      const rendered = {
        text: buildQuestionWrongText(target, xpResult),
        extra: resultExtra(target),
      };
      if (!target.hubMode) {
        scheduleAdvance(wrongAnswerNextDelayMs);
      } else {
        scheduleHubIdleTimeout(target);
      }
      return {
        ok: true,
        correct: false,
        toast: "❌ Wrong answer!",
        xpResult,
        session: snapshot(true),
        rendered,
      };
    }

    target.questionWinnerId = uid;
    if (!target.scores[uid]) {
      target.scores[uid] = { score: 0, displayName: name };
    }
    target.scores[uid].score += 1;
    target.scores[uid].displayName = name;

    const rendered = {
      text: buildQuestionWonText(target, name, xpResult),
      extra: resultExtra(target),
    };
    if (!target.hubMode) {
      scheduleAdvance();
    } else {
      scheduleHubIdleTimeout(target);
    }

    return {
      ok: true,
      correct: true,
      questionWon: true,
      xpResult,
      session: snapshot(true),
      rendered,
    };
  }

  function nextHubQuestion() {
    if (!session || session.status !== STATUS.ACTIVE) {
      return { ok: false, reason: "inactive" };
    }
    if (!session.hubMode) {
      return { ok: false, reason: "not-hub" };
    }
    if (session.questionPhase === QUESTION_PHASE.OPEN) {
      return { ok: false, reason: "question-open" };
    }
    const advanced = advanceRound();
    if (!advanced || !advanced.advanced) {
      return {
        ok: false,
        reason: (advanced && advanced.reason) || "advance-failed",
      };
    }
    return { ok: true, ...advanced };
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
    deleteMessageFn = null;
  }

  function getRecentQuestionIds() {
    return recentQuestionIds.slice();
  }

  function getPendingTimerCount() {
    let n = 0;
    if (questionTimer != null) n += 1;
    if (advanceTimer != null) n += 1;
    if (hubIdleTimer != null) n += 1;
    return n;
  }

  return {
    TRIVIA_ROUND_QUESTIONS: totalQuestions,
    TRIVIA_QUESTION_TIMEOUT_MS: questionTimeoutMs,
    TRIVIA_NEXT_QUESTION_DELAY_MS: nextQuestionDelayMs,
    TRIVIA_WRONG_ANSWER_NEXT_DELAY_MS: wrongAnswerNextDelayMs,
    TRIVIA_STALE_MS: staleAfterMs,
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
    setDeleteMessageHandler,
    setRoundCompleteHandler,
    setAwardXpHandler,
    isTriviaOpen,
    getSession,
    getSnapshot: () => snapshot(true),
    forceQuestionTimeout,
    forceCompleteRound,
    advanceRound,
    nextHubQuestion,
    abortRound,
    releaseHubSession,
    recoverStaleSession,
    isSessionStale: () => isSessionStale(session),
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
  TRIVIA_STALE_MS,
  TRIVIA_ROUND_WIN_XP,
  TRIVIA_TIE_XP,
  TRIVIA_DAILY_REWARD_CAP,
  STATUS,
  QUESTION_PHASE,
  LETTERS,
  createTriviaService,
  buildAnswerCallbackData,
  parseTriviaCallbackData,
  parseTriviaHubCallback,
  TRIVIA_HUB_ACTION,
  buildCategoryCallbackData,
  materializeQuestion,
  buildQuestionText,
  buildQuestionWonText,
  buildQuestionWrongText,
  buildQuestionTimeoutText,
  buildFinalScoreboardText,
  buildAnswerKeyboard,
  buildHubResultKeyboard,
  buildTriviaChooserText,
  buildTriviaChooserKeyboard,
  formatTriviaXpStatusLine,
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
