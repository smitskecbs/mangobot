/**
 * Trivia — personal multi-session hub + community 5-question auto rounds.
 * Personal: Games → category → unlimited questions, isolated by chatId + userId.
 * Community/auto: 5-question race, Random category, auto-advance, per-chat namespace.
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
  if (/^(cat|hub|next|change|games)$/i.test(sessionId)) {
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

function buildHubNavCallbackData(action, sessionId) {
  const prefix =
    action === "next"
      ? TRIVIA_HUB_ACTION.NEXT
      : action === "change"
        ? TRIVIA_HUB_ACTION.CHANGE
        : TRIVIA_HUB_ACTION.GAMES;
  if (!sessionId) {
    return prefix;
  }
  return `${prefix}:${sessionId}`;
}

function buildCategoryCallbackData(categoryId) {
  return `trivia:cat:${categoryId}`;
}

/**
 * Hub navigation callbacks. Optional session id: trivia:next:<hex>
 */
function parseTriviaHubCallback(data) {
  if (typeof data !== "string") {
    return null;
  }
  if (data === TRIVIA_HUB_ACTION.CHOOSER) {
    return { action: "hub" };
  }
  const nav = /^(trivia):(next|change|games)(?::([a-f0-9]+))?$/i.exec(data);
  if (nav) {
    return {
      action: nav[2].toLowerCase(),
      sessionId: nav[3] || null,
    };
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

function buildHubResultKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "➡️ Next Question",
        buildHubNavCallbackData("next", sessionId)
      ),
    ],
    [
      Markup.button.callback(
        "🔄 Change Category",
        buildHubNavCallbackData("change", sessionId)
      ),
    ],
    [
      Markup.button.callback(
        "⬅️ Games",
        buildHubNavCallbackData("games", sessionId)
      ),
    ],
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

function formatTriviaUnauthorizedToast(displayName) {
  const name =
    typeof displayName === "string" ? displayName.replace(/\s+/g, " ").trim() : "";
  if (name) {
    return `This Trivia game belongs to ${name}.`;
  }
  return "This Trivia game belongs to another player.";
}

function personalTriviaKey(chatId, userId) {
  return `p:${chatId}:${userId == null || userId === "" ? "anon" : userId}`;
}

function communityTriviaKey(chatId) {
  return `c:${chatId}`;
}

function chooserTriviaKey(chatId, messageId) {
  return `ch:${chatId}:${messageId}`;
}

function createTriviaService(options = {}) {
  const now =
    typeof options.now === "function" ? options.now : () => Date.now();
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function"
      ? options.setTimeoutFn
      : (fn, ms) => {
          const handle = setTimeout(fn, ms);
          if (handle && typeof handle.unref === "function") {
            handle.unref();
          }
          return handle;
        };
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

  /** @type {Map<string, object>} */
  const sessionsById = new Map();
  /** @type {Map<string, object>} */
  const personalByKey = new Map();
  /** @type {Map<string, object>} */
  const communityByChat = new Map();
  /** @type {Map<string, { userId: string, displayName: string, rememberedAt: number }>} */
  const chooserByMessage = new Map();
  /** Last touched session — snapshot/compat for single-session callers. */
  let lastSession = null;
  /** @type {string[]} */
  let recentQuestionIds = [];
  /** @type {Function|null} */
  let editMessage = null;
  /** @type {Function|null} */
  let onRoundComplete = null;
  /** @type {Function|null} */
  let awardXpFn = null;
  /** @type {Function|null} */
  let deleteMessageFn =
    typeof options.deleteMessageFn === "function" ? options.deleteMessageFn : null;

  function clearSessionTimer(target, name) {
    if (!target || target[name] == null) {
      return;
    }
    clearTimeoutFn(target[name]);
    target[name] = null;
  }

  function clearSessionTimers(target) {
    if (!target) {
      return;
    }
    clearSessionTimer(target, "questionTimer");
    clearSessionTimer(target, "advanceTimer");
    clearSessionTimer(target, "hubIdleTimer");
  }

  function clearAllTimers() {
    for (const row of sessionsById.values()) {
      clearSessionTimers(row);
    }
  }

  function touchActivity(target) {
    const row = target || lastSession;
    if (row) {
      row.lastActivityAt = now();
    }
  }

  function scheduleHubIdleTimeout(target) {
    if (!target || !target.hubMode || target.status !== STATUS.ACTIVE) {
      return;
    }
    clearSessionTimer(target, "hubIdleTimer");
    const expectedActivity = target.lastActivityAt;
    target.hubIdleTimer = setTimeoutFn(() => {
      target.hubIdleTimer = null;
      if (sessionsById.get(target.id) !== target) {
        return;
      }
      if (target.status !== STATUS.ACTIVE) {
        return;
      }
      if (target.lastActivityAt !== expectedActivity) {
        return;
      }
      abortRound("stale-idle", { session: target });
    }, staleAfterMs);
  }

  function isTimerlessAbandoned(target) {
    if (!target || target.status !== STATUS.ACTIVE) {
      return false;
    }
    if (
      target.questionTimer != null ||
      target.advanceTimer != null ||
      target.hubIdleTimer != null
    ) {
      return false;
    }
    if (target.hubMode && target.questionPhase === QUESTION_PHASE.RESOLVED) {
      return false;
    }
    return true;
  }

  function isSessionStale(target) {
    const row = target || lastSession;
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
    let recovered = false;
    for (const row of [...sessionsById.values()]) {
      if (!row || row.status !== STATUS.ACTIVE) {
        continue;
      }
      if (!isSessionStale(row)) {
        continue;
      }
      abortRound("stale", { session: row });
      recovered = true;
    }
    return recovered;
  }

  const MAX_CHOOSERS = 2000;
  const MAX_CHOOSER_AGE_MS = 24 * 60 * 60 * 1000;

  function removeSessionFromIndexes(target) {
    if (!target) {
      return;
    }
    if (target.hubMode) {
      const key = personalTriviaKey(target.chatId, target.ownerUserId);
      if (personalByKey.get(key) === target) {
        personalByKey.delete(key);
      }
    } else {
      const key = communityTriviaKey(target.chatId);
      if (communityByChat.get(key) === target) {
        communityByChat.delete(key);
      }
    }
    if (target.id != null) {
      sessionsById.delete(String(target.id));
    }
  }

  function pruneChooserOwners() {
    const ts = now();
    for (const [key, record] of chooserByMessage.entries()) {
      if (!record || ts - record.rememberedAt > MAX_CHOOSER_AGE_MS) {
        chooserByMessage.delete(key);
      }
    }
    while (chooserByMessage.size > MAX_CHOOSERS) {
      const oldest = chooserByMessage.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      chooserByMessage.delete(oldest);
    }
  }

  function resolveSession(sessionId, fallback = lastSession) {
    if (sessionId) {
      return sessionsById.get(String(sessionId)) || null;
    }
    return fallback || null;
  }

  function scheduleTriviaMessageCleanup(target, { silent } = {}) {
    if (silent) {
      return;
    }
    const row = target || lastSession;
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
    let id = String(randomIdFn());
    let n = 0;
    while (sessionsById.has(id)) {
      n += 1;
      id = `${randomIdFn()}${n}`;
    }
    return id;
  }

  function hasActiveSession(row) {
    return Boolean(row && row.status === STATUS.ACTIVE);
  }

  function isTriviaOpen() {
    recoverStaleSession();
    for (const row of sessionsById.values()) {
      if (hasActiveSession(row)) {
        return true;
      }
    }
    return false;
  }

  function isCommunityTriviaOpen(chatId) {
    recoverStaleSession();
    if (chatId != null && chatId !== "") {
      return hasActiveSession(communityByChat.get(communityTriviaKey(chatId)));
    }
    for (const row of communityByChat.values()) {
      if (hasActiveSession(row)) {
        return true;
      }
    }
    return false;
  }

  function isPersonalTriviaOpen(chatId, userId) {
    recoverStaleSession();
    return hasActiveSession(
      personalByKey.get(personalTriviaKey(chatId, userId))
    );
  }

  function getPersonalSession(chatId, userId) {
    recoverStaleSession();
    return personalByKey.get(personalTriviaKey(chatId, userId)) || null;
  }

  function getCommunitySession(chatId) {
    recoverStaleSession();
    return communityByChat.get(communityTriviaKey(chatId)) || null;
  }

  function getSession(sessionId) {
    if (!sessionId) {
      return null;
    }
    return sessionsById.get(String(sessionId)) || null;
  }

  function rememberChooserOwner(chatId, messageId, userId, displayName) {
    const key = chooserTriviaKey(chatId, messageId);
    if (!key || userId == null || userId === "") {
      return null;
    }
    pruneChooserOwners();
    const record = {
      userId: String(userId),
      displayName: sanitizePvpDisplayName(displayName),
      rememberedAt: now(),
    };
    chooserByMessage.set(key, record);
    return record;
  }

  function getChooserOwner(chatId, messageId) {
    const key = chooserTriviaKey(chatId, messageId);
    if (!key) {
      return null;
    }
    return chooserByMessage.get(key) || null;
  }

  function forgetChooserOwner(chatId, messageId) {
    const key = chooserTriviaKey(chatId, messageId);
    if (!key) {
      return false;
    }
    return chooserByMessage.delete(key);
  }

  function snapshot(includeSecret = false, target) {
    const session = target || lastSession;
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
      ownerUserId: session.ownerUserId || null,
      ownerDisplayName: session.ownerDisplayName || null,
      kind: session.kind || (session.hubMode ? "personal" : "community"),
    };
    if (includeSecret) {
      snap.correctIndex = session.correctIndex;
    }
    return snap;
  }

  function safeEdit(text, extra, target) {
    const session = target || lastSession;
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

  function pickNextMaterialized(categoryOverride, target) {
    const session = target || lastSession;
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

  function applyQuestionToSession(target, materialized) {
    target.questionId = materialized.id;
    target.question = materialized.question;
    target.answers = materialized.answers;
    target.correctIndex = materialized.correctIndex;
    target.questionCategory = materialized.category || null;
    target.questionPhase = QUESTION_PHASE.OPEN;
    target.answeredUsers = {};
    target.questionWinnerId = null;
    target.expiresAt = now() + questionTimeoutMs;
    touchActivity(target);
  }

  function scheduleQuestionTimeout(target) {
    clearSessionTimer(target, "questionTimer");
    const expectedNumber = target.questionNumber;
    target.questionTimer = setTimeoutFn(() => {
      target.questionTimer = null;
      if (sessionsById.get(target.id) !== target) {
        return;
      }
      if (target.status !== STATUS.ACTIVE) {
        return;
      }
      if (target.questionNumber !== expectedNumber) {
        return;
      }
      if (target.questionPhase !== QUESTION_PHASE.OPEN) {
        return;
      }
      resolveQuestionTimeout(target);
    }, questionTimeoutMs);
  }

  function resolveQuestionTimeout(target) {
    const session = target || lastSession;
    if (!session || session.status !== STATUS.ACTIVE) {
      return;
    }
    if (session.questionPhase !== QUESTION_PHASE.OPEN) {
      return;
    }
    session.questionPhase = QUESTION_PHASE.RESOLVED;
    clearSessionTimer(session, "questionTimer");
    const text = buildQuestionTimeoutText(session);
    const extra = session.hubMode
      ? buildHubResultKeyboard(session.id)
      : emptyInlineKeyboardExtra();
    Promise.resolve(safeEdit(text, extra, session)).catch(() => {});
    if (!session.hubMode) {
      scheduleAdvance(session);
    } else {
      touchActivity(session);
      scheduleHubIdleTimeout(session);
    }
  }

  function scheduleAdvance(target, delayMs) {
    const session = target || lastSession;
    if (!session) {
      return;
    }
    clearSessionTimer(session, "advanceTimer");
    const wait =
      typeof delayMs === "number" && delayMs >= 0 ? delayMs : nextQuestionDelayMs;
    session.advanceTimer = setTimeoutFn(() => {
      session.advanceTimer = null;
      if (sessionsById.get(session.id) !== session) {
        return;
      }
      if (session.status !== STATUS.ACTIVE) {
        return;
      }
      advanceRound(session);
    }, wait);
  }

  function computeRoundClaim(target) {
    const session = target || lastSession;
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
  function claimRoundXp(target) {
    const session = target || lastSession;
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
    const claim = computeRoundClaim(session);
    return { ok: true, ...claim, session: snapshot(true, session) };
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

  function finishRound(target) {
    const session = target || lastSession;
    if (!session) {
      return;
    }
    session.status = STATUS.COMPLETE;
    session.questionPhase = QUESTION_PHASE.RESOLVED;
    clearSessionTimers(session);
    removeSessionFromIndexes(session);
    lastSession = session;

    const claim = claimRoundXp(session);
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
      session: snapshot(true, session),
      claim,
      xpResults,
      text,
      extra: emptyInlineKeyboardExtra(),
    };

    if (typeof onRoundComplete === "function") {
      Promise.resolve(onRoundComplete(payload)).catch(() => {});
    } else {
      Promise.resolve(
        safeEdit(text, emptyInlineKeyboardExtra(), session)
      ).catch(() => {});
    }
    scheduleTriviaMessageCleanup(payload.session);
    return payload;
  }

  function advanceRound(target) {
    const session = target || lastSession;
    if (!session || session.status !== STATUS.ACTIVE) {
      return null;
    }
    if (!session.hubMode && session.questionNumber >= session.totalQuestions) {
      return finishRound(session);
    }

    const next = pickNextMaterialized(null, session);
    if (!next) {
      return abortRound("no-questions", { session });
    }

    session.questionNumber += 1;
    applyQuestionToSession(session, next);
    scheduleQuestionTimeout(session);
    const text = buildQuestionText(session, session.lastXpResult || session.xpStatus);
    const extra = buildAnswerKeyboard(session.id);
    Promise.resolve(safeEdit(text, extra, session)).catch(() => {
      abortRound("edit-failed", { session });
    });
    lastSession = session;
    return {
      advanced: true,
      session: snapshot(true, session),
      text,
      keyboard: extra,
    };
  }

  function abortRound(reason, options = {}) {
    const session = options.session || lastSession;
    if (session) {
      clearSessionTimers(session);
      session.status = STATUS.ABORTED;
      session.abortReason = reason || "aborted";
      removeSessionFromIndexes(session);
      lastSession = session;
      logGameCleanup(GAME_TYPE.TRIVIA, FINAL_STATE.CANCELLED);
      if (!options.silent) {
        const text = buildFinalGameText(GAME_TYPE.TRIVIA, FINAL_STATE.CANCELLED);
        Promise.resolve(safeEdit(text, emptyGameKeyboardExtra(), session)).catch(
          () => {
            logCleanupRenderFailed(GAME_TYPE.TRIVIA);
          }
        );
      }
      scheduleTriviaMessageCleanup(session, { silent: Boolean(options.silent) });
    }
    return {
      ok: false,
      reason: reason || "aborted",
      session: snapshot(true, session),
    };
  }

  function releaseHubSession(reason, options = {}) {
    const session =
      options.session ||
      resolveSession(options.sessionId, lastSession);
    if (session && !session.hubMode) {
      return { ok: false, reason: "not-hub", session: snapshot(true, session) };
    }
    return abortRound(reason || "hub-nav", {
      silent: true,
      session,
    });
  }

  function startTrivia({
    chatId,
    source = "manual",
    question: forcedQuestion,
    autoIntro = false,
    category = null,
    hubMode = false,
    xpStatus = null,
    userId = null,
    displayName = null,
  } = {}) {
    if (!isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }
    const useHub = Boolean(hubMode);
    const ownerUserId =
      userId != null && userId !== "" ? String(userId) : null;
    const ownerDisplayName = ownerUserId
      ? sanitizePvpDisplayName(displayName)
      : null;

    if (useHub) {
      const key = personalTriviaKey(chatId, ownerUserId);
      const existing = personalByKey.get(key);
      if (existing && existing.status === STATUS.ACTIVE) {
        if (isSessionStale(existing)) {
          abortRound("stale", { session: existing });
        } else {
          return { ok: false, reason: "already-active" };
        }
      }
    } else {
      const key = communityTriviaKey(chatId);
      const existing = communityByChat.get(key);
      if (existing && existing.status === STATUS.ACTIVE) {
        if (isSessionStale(existing)) {
          abortRound("stale", { session: existing });
        } else {
          return { ok: false, reason: "already-active" };
        }
      }
    }

    const resolvedCategory =
      source === "auto" && !category ? "random" : category;

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
    const session = {
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
      kind: useHub ? "personal" : "community",
      ownerUserId,
      ownerDisplayName,
      questionTimer: null,
      advanceTimer: null,
      hubIdleTimer: null,
    };
    applyQuestionToSession(session, materialized);
    touchActivity(session);
    sessionsById.set(session.id, session);
    if (useHub) {
      personalByKey.set(personalTriviaKey(chatId, ownerUserId), session);
    } else {
      communityByChat.set(communityTriviaKey(chatId), session);
    }
    lastSession = session;
    scheduleQuestionTimeout(session);

    const questionBody = buildQuestionText(session, xpStatus);
    const text =
      autoIntro || source === "auto"
        ? `${buildAutoIntroPrefix()}${questionBody}`
        : questionBody;

    return {
      ok: true,
      session: snapshot(true, session),
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
      return buildHubResultKeyboard(target.id);
    }
    return emptyInlineKeyboardExtra();
  }

  function rejectNotOwner(target) {
    return {
      ok: false,
      reason: "not-owner",
      ownerDisplayName: (target && target.ownerDisplayName) || null,
    };
  }

  function assertAnswerOwner(target, userId) {
    if (!target || !target.hubMode || !target.ownerUserId) {
      return { ok: true };
    }
    if (userId == null || userId === "" || String(userId) !== String(target.ownerUserId)) {
      return rejectNotOwner(target);
    }
    return { ok: true };
  }

  function assertPersonalOwner(target, userId) {
    if (!target || !target.hubMode || !target.ownerUserId) {
      return { ok: true };
    }
    if (userId == null || userId === "") {
      return { ok: true };
    }
    if (String(userId) !== String(target.ownerUserId)) {
      return rejectNotOwner(target);
    }
    return { ok: true };
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
    const ownerGate = assertAnswerOwner(target, userId);
    if (!ownerGate.ok) {
      return ownerGate;
    }
    if (target.status !== STATUS.ACTIVE) {
      return { ok: false, reason: "finished" };
    }
    if (target.questionPhase !== QUESTION_PHASE.OPEN) {
      return { ok: false, reason: "question-closed" };
    }
    if (now() >= target.expiresAt) {
      resolveQuestionTimeout(target);
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
    clearSessionTimer(target, "questionTimer");

    const xpResult = awardAttempt(uid, name, correct);
    target.lastXpResult = xpResult;
    touchActivity(target);
    lastSession = target;

    if (!correct) {
      const rendered = {
        text: buildQuestionWrongText(target, xpResult),
        extra: resultExtra(target),
      };
      if (!target.hubMode) {
        scheduleAdvance(target, wrongAnswerNextDelayMs);
      } else {
        scheduleHubIdleTimeout(target);
      }
      return {
        ok: true,
        correct: false,
        toast: "❌ Wrong answer!",
        xpResult,
        session: snapshot(true, target),
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
      scheduleAdvance(target);
    } else {
      scheduleHubIdleTimeout(target);
    }

    return {
      ok: true,
      correct: true,
      questionWon: true,
      xpResult,
      session: snapshot(true, target),
      rendered,
    };
  }

  function nextHubQuestion(sessionId, userId) {
    const target = resolveSession(sessionId, lastSession);
    if (!target || target.status !== STATUS.ACTIVE) {
      return { ok: false, reason: "inactive" };
    }
    if (!target.hubMode) {
      return { ok: false, reason: "not-hub" };
    }
    const ownerGate = assertPersonalOwner(target, userId);
    if (!ownerGate.ok) {
      return ownerGate;
    }
    if (target.questionPhase === QUESTION_PHASE.OPEN) {
      return { ok: false, reason: "question-open" };
    }
    const advanced = advanceRound(target);
    if (!advanced || !advanced.advanced) {
      return {
        ok: false,
        reason: (advanced && advanced.reason) || "advance-failed",
      };
    }
    return { ok: true, ...advanced };
  }

  function forceQuestionTimeout(sessionId) {
    const session = resolveSession(sessionId, lastSession);
    if (!session || session.status !== STATUS.ACTIVE) {
      return { timedOut: false };
    }
    if (session.questionPhase !== QUESTION_PHASE.OPEN) {
      return { timedOut: false };
    }
    resolveQuestionTimeout(session);
    return {
      timedOut: true,
      session: snapshot(true, session),
      message: buildQuestionTimeoutText(session),
    };
  }

  function forceCompleteRound(sessionId) {
    const session = resolveSession(sessionId, lastSession);
    if (!session || session.status !== STATUS.ACTIVE) {
      return { ok: false, reason: "inactive" };
    }
    clearSessionTimers(session);
    return finishRound(session);
  }

  function reset() {
    clearAllTimers();
    sessionsById.clear();
    personalByKey.clear();
    communityByChat.clear();
    chooserByMessage.clear();
    lastSession = null;
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
    for (const row of sessionsById.values()) {
      if (row.questionTimer != null) n += 1;
      if (row.advanceTimer != null) n += 1;
      if (row.hubIdleTimer != null) n += 1;
    }
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
    isCommunityTriviaOpen,
    isPersonalTriviaOpen,
    getPersonalSession,
    getCommunitySession,
    getSession,
    getSnapshot: (sessionId) =>
      snapshot(true, sessionId ? getSession(sessionId) : lastSession),
    rememberChooserOwner,
    getChooserOwner,
    forgetChooserOwner,
    forceQuestionTimeout,
    forceCompleteRound,
    advanceRound,
    nextHubQuestion,
    abortRound,
    releaseHubSession,
    recoverStaleSession,
    isSessionStale: (target) => isSessionStale(target || lastSession),
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
  buildHubNavCallbackData,
  formatTriviaUnauthorizedToast,
  triviaRuntime: defaultService,
  getTriviaRuntime: () => defaultService,
  startTrivia: (...args) => defaultService.startTrivia(...args),
  tryAnswer: (...args) => defaultService.tryAnswer(...args),
  claimRoundXp: (...args) => defaultService.claimRoundXp(...args),
  isTriviaOpen: (...args) => defaultService.isTriviaOpen(...args),
  isCommunityTriviaOpen: (...args) =>
    defaultService.isCommunityTriviaOpen(...args),
  isPersonalTriviaOpen: (...args) =>
    defaultService.isPersonalTriviaOpen(...args),
  setTriviaMessageId: (...args) => defaultService.setMessageId(...args),
  resetTrivia: (...args) => defaultService.reset(...args),
};
