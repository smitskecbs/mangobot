/**
 * ChatFight — short group challenges; first correct answer wins XP.
 * Flow: waiting_for_reveal → active (60s) → won | expired.
 * In-memory only (no restore after restart).
 */

const { Markup } = require("telegraf");
const { scheduleExpiredMessageCleanup } = require("../utils/expiredMessageCleanup");
const {
  GAME_TYPE,
  FINAL_STATE,
  logGameCleanup,
  emptyGameKeyboardExtra,
} = require("../utils/gameCleanup");

const CHAT_FIGHT_DURATION_MS = 60 * 1000;
const CHAT_FIGHT_REVEAL_WAIT_MS = 5 * 60 * 1000;
const CHAT_FIGHT_COOLDOWN_MS = 60 * 60 * 1000;
const CHAT_FIGHT_XP = 2;

/** Opaque callback — never embeds answers or challenge text. */
const REVEAL_CALLBACK_DATA = "cfight:reveal";

const FIGHT_STATUS = Object.freeze({
  WAITING_FOR_REVEAL: "waiting_for_reveal",
  /** Memory / Quick Tap: shown but answers not accepted yet. */
  PREPARE: "prepare",
  ACTIVE: "active",
  WON: "won",
  EXPIRED: "expired",
});

const FIGHT_TYPES = Object.freeze({
  TYPE_RUSH: "type_rush",
  MATH_RUSH: "math_rush",
  EMOJI_GUESS: "emoji_guess",
  UNSCRAMBLE: "unscramble",
  MISSING_LETTER: "missing_letter",
  MEMORY: "memory",
  QUICK_TAP: "quick_tap",
});

/** Race-mode types (PvP board games are separate mode). */
const RACE_FIGHT_TYPES = Object.freeze([
  FIGHT_TYPES.TYPE_RUSH,
  FIGHT_TYPES.MATH_RUSH,
  FIGHT_TYPES.EMOJI_GUESS,
  FIGHT_TYPES.UNSCRAMBLE,
  FIGHT_TYPES.MISSING_LETTER,
  FIGHT_TYPES.MEMORY,
  FIGHT_TYPES.QUICK_TAP,
]);

const ALL_FIGHT_TYPES = RACE_FIGHT_TYPES;

const TYPE_ALIASES = Object.freeze({
  type: FIGHT_TYPES.TYPE_RUSH,
  rush: FIGHT_TYPES.TYPE_RUSH,
  typerush: FIGHT_TYPES.TYPE_RUSH,
  math: FIGHT_TYPES.MATH_RUSH,
  mathrush: FIGHT_TYPES.MATH_RUSH,
  emoji: FIGHT_TYPES.EMOJI_GUESS,
  emojiguess: FIGHT_TYPES.EMOJI_GUESS,
  unscramble: FIGHT_TYPES.UNSCRAMBLE,
  scramble: FIGHT_TYPES.UNSCRAMBLE,
  missing: FIGHT_TYPES.MISSING_LETTER,
  missingletter: FIGHT_TYPES.MISSING_LETTER,
  memory: FIGHT_TYPES.MEMORY,
  quicktap: FIGHT_TYPES.QUICK_TAP,
  tap: FIGHT_TYPES.QUICK_TAP,
});

const TYPE_RUSH_WORDS = Object.freeze([
  "MANGO",
  "MANGOMEME",
  "GMANGO",
  "GNANGO",
  "BOUNCH",
  "SNAKE",
  "COMMUNITY",
  "BUILDER",
  "HODL",
  "MEME",
]);

const EMOJI_MAP = Object.freeze({
  "😂": Object.freeze(["laugh", "laughing", "funny"]),
  "😍": Object.freeze(["love", "loving", "in love"]),
  "😡": Object.freeze(["angry", "mad"]),
  "😢": Object.freeze(["sad", "crying"]),
  "😱": Object.freeze(["shocked", "scared", "surprised"]),
  "🥳": Object.freeze(["party", "celebrating", "celebration"]),
  "😴": Object.freeze(["sleepy", "tired", "sleeping"]),
});

const USAGE_TEXT = `⚔️ ChatFight usage:
/chatfight — random challenge
/chatfight type — Type Rush
/chatfight math — Math Rush
/chatfight emoji — Emoji Guess
/chatfight unscramble — Unscramble
/chatfight missing — Missing Letter
/chatfight memory — Memory
/chatfight tap — Quick Tap`;

const TEASER_TEXT = `⚔️ CHAT FIGHT

A new challenge is ready!

Be the first to solve it and win +${CHAT_FIGHT_XP} XP.`;

function getConfiguredCommunityChatId() {
  const raw = process.env.TELEGRAM_CHAT_ID;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed || null;
}

function isAllowedChatFightChat(chatId) {
  const configured = getConfiguredCommunityChatId();
  if (!configured) {
    return true;
  }
  return String(chatId) === String(configured);
}

function parseFightTypeArg(arg) {
  if (arg === undefined || arg === null || String(arg).trim() === "") {
    return { ok: true, type: null, random: true };
  }
  const key = String(arg).trim().toLowerCase().replace(/[\s_-]+/g, "");
  const type = TYPE_ALIASES[key];
  if (!type) {
    return { ok: false, type: null, random: false };
  }
  return { ok: true, type, random: false };
}

function pickRandom(list, random) {
  const index = Math.floor(random() * list.length);
  return list[Math.max(0, Math.min(list.length - 1, index))];
}

/**
 * Pick a fight type, avoiding immediate repeat when alternatives exist.
 * @param {string[]} [types]
 * @param {string|null} [avoidType]
 * @param {() => number} random
 */
function selectFightType(types, avoidType, random) {
  const pool =
    Array.isArray(types) && types.length > 0 ? types : [...ALL_FIGHT_TYPES];
  if (avoidType && pool.length > 1) {
    const filtered = pool.filter((t) => t !== avoidType);
    if (filtered.length > 0) {
      return pickRandom(filtered, random);
    }
  }
  return pickRandom(pool, random);
}

function randomIntInclusive(min, max, random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return lo + Math.floor(random() * (hi - lo + 1));
}

function generateTypeRush(random) {
  const word = pickRandom(TYPE_RUSH_WORDS, random);
  return {
    type: FIGHT_TYPES.TYPE_RUSH,
    prompt: `⚔️ CHAT FIGHT — TYPE RUSH\n\nType this exactly:\n\n${word}\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
    acceptedAnswers: [word.toLowerCase()],
    revealAnswer: word,
  };
}

function generateMathRush(random) {
  const kind = pickRandom(["add", "sub", "mul"], random);
  let a;
  let b;
  let result;
  let expression;

  if (kind === "add") {
    a = randomIntInclusive(1, 50, random);
    b = randomIntInclusive(1, 50, random);
    result = a + b;
    expression = `${a} + ${b}`;
  } else if (kind === "sub") {
    a = randomIntInclusive(10, 100, random);
    b = randomIntInclusive(1, a, random);
    result = a - b;
    expression = `${a} - ${b}`;
  } else {
    a = randomIntInclusive(2, 12, random);
    b = randomIntInclusive(2, 12, random);
    result = a * b;
    expression = `${a} × ${b}`;
  }

  return {
    type: FIGHT_TYPES.MATH_RUSH,
    prompt: `⚔️ CHAT FIGHT — MATH RUSH\n\nSolve:\n\n${expression} = ?\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
    acceptedAnswers: [String(result)],
    revealAnswer: String(result),
    meta: { a, b, kind, result },
  };
}

function generateEmojiGuess(random) {
  const emojis = Object.keys(EMOJI_MAP);
  const emoji = pickRandom(emojis, random);
  const answers = EMOJI_MAP[emoji];
  return {
    type: FIGHT_TYPES.EMOJI_GUESS,
    prompt: `⚔️ CHAT FIGHT — EMOJI GUESS\n\nGuess the emotion:\n\n${emoji}\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
    acceptedAnswers: answers.map((a) => a.toLowerCase()),
    revealAnswer: answers[0],
    meta: { emoji },
  };
}

const UNSCRAMBLE_PAIRS = Object.freeze([
  Object.freeze({ scrambled: "OGNAM", answer: "MANGO" }),
  Object.freeze({ scrambled: "EKANS", answer: "SNAKE" }),
  Object.freeze({ scrambled: "HCNOUB", answer: "BOUNCH" }),
  Object.freeze({ scrambled: "EMEAMNGOM", answer: "MANGOMEME" }),
  Object.freeze({ scrambled: "YTINUMMOC", answer: "COMMUNITY" }),
]);

const MISSING_LETTER_PAIRS = Object.freeze([
  Object.freeze({ puzzle: "M_NGO", answer: "MANGO" }),
  Object.freeze({ puzzle: "SN_KE", answer: "SNAKE" }),
  Object.freeze({ puzzle: "BOU_CH", answer: "BOUNCH" }),
  Object.freeze({ puzzle: "GM_NGO", answer: "GMANGO" }),
  Object.freeze({ puzzle: "GN_NGO", answer: "GNANGO" }),
]);

const MEMORY_WORDS = Object.freeze([
  "MANGO42",
  "SNAKE7",
  "BOUNCH3",
  "GMANGO",
  "BUILDER9",
]);

function generateUnscramble(random) {
  const pair = pickRandom(UNSCRAMBLE_PAIRS, random);
  return {
    type: FIGHT_TYPES.UNSCRAMBLE,
    prompt: `⚔️ CHAT FIGHT — UNSCRAMBLE\n\nUnscramble:\n\n${pair.scrambled}\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
    acceptedAnswers: [pair.answer.toLowerCase()],
    revealAnswer: pair.answer,
    meta: { scrambled: pair.scrambled },
  };
}

function generateMissingLetter(random) {
  const pair = pickRandom(MISSING_LETTER_PAIRS, random);
  return {
    type: FIGHT_TYPES.MISSING_LETTER,
    prompt: `⚔️ CHAT FIGHT — MISSING LETTER\n\nFill the blank:\n\n${pair.puzzle}\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
    acceptedAnswers: [pair.answer.toLowerCase()],
    revealAnswer: pair.answer,
    meta: { puzzle: pair.puzzle },
  };
}

function generateMemory(random) {
  const word = pickRandom(MEMORY_WORDS, random);
  return {
    type: FIGHT_TYPES.MEMORY,
    prompt: `⚔️ CHAT FIGHT — MEMORY\n\nRemember:\n\n${word}\n\n(Memorize — the question comes next!)`,
    answerPrompt: `⚔️ CHAT FIGHT — MEMORY\n\nWhat was the word?\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
    acceptedAnswers: [word.toLowerCase()],
    revealAnswer: word,
    meta: { prepareMs: 5000, mode: "race" },
  };
}

function generateQuickTap(random) {
  const delayMs = randomIntInclusive(2000, 5000, random);
  return {
    type: FIGHT_TYPES.QUICK_TAP,
    prompt: `⚔️ CHAT FIGHT — QUICK TAP\n\nGet ready...`,
    answerPrompt: `⚔️ CHAT FIGHT — QUICK TAP\n\n⚡ TAP NOW!\n\nType TAP first to win +${CHAT_FIGHT_XP} XP!`,
    acceptedAnswers: ["tap"],
    revealAnswer: "TAP",
    meta: { prepareMs: delayMs, mode: "race" },
  };
}

function generateChallenge(type, random) {
  if (type === FIGHT_TYPES.TYPE_RUSH) {
    return generateTypeRush(random);
  }
  if (type === FIGHT_TYPES.MATH_RUSH) {
    return generateMathRush(random);
  }
  if (type === FIGHT_TYPES.EMOJI_GUESS) {
    return generateEmojiGuess(random);
  }
  if (type === FIGHT_TYPES.UNSCRAMBLE) {
    return generateUnscramble(random);
  }
  if (type === FIGHT_TYPES.MISSING_LETTER) {
    return generateMissingLetter(random);
  }
  if (type === FIGHT_TYPES.MEMORY) {
    return generateMemory(random);
  }
  if (type === FIGHT_TYPES.QUICK_TAP) {
    return generateQuickTap(random);
  }
  throw new Error(`Unknown ChatFight type: ${type}`);
}

function normalizeAnswer(type, text) {
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (type === FIGHT_TYPES.MATH_RUSH) {
    return trimmed;
  }
  return trimmed.toLowerCase();
}

function isCorrectAnswer(fight, text) {
  if (!fight || fight.status !== FIGHT_STATUS.ACTIVE) {
    return false;
  }
  const normalized = normalizeAnswer(fight.type, text);
  if (normalized === null) {
    return false;
  }
  return fight.acceptedAnswers.includes(normalized);
}

function formatCooldownMinutes(remainingMs) {
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}

function buildWinnerReply(userName, awardResult) {
  const lines = [`⚔️ ${userName} wins the ChatFight!`];
  if (awardResult && awardResult.awarded) {
    const xp =
      typeof awardResult.pointsToAdd === "number"
        ? awardResult.pointsToAdd
        : CHAT_FIGHT_XP;
    lines.push(`+${xp} XP 🥭`);
  } else if (awardResult && awardResult.reason === "wallet-required") {
    lines.push("🔒 0 XP — wallet not linked — /wallet");
  }
  if (awardResult && awardResult.rankUp && awardResult.rank) {
    lines.push(`${awardResult.rank.emoji} Rank up: ${awardResult.rank.title}!`);
  }
  return lines.join("\n");
}

function buildTimeoutMessage(fight) {
  const answer =
    fight && fight.revealAnswer != null ? String(fight.revealAnswer) : null;
  if (answer) {
    return `⏱ CHAT FIGHT EXPIRED

Nobody solved it in time.

Answer: ${answer}

Challenge closed. 🥭`;
  }
  return `⏱ CHAT FIGHT EXPIRED

Nobody solved it in time.

Challenge closed. 🥭`;
}

function buildRevealTimeoutMessage() {
  return `⏱ CHAT FIGHT EXPIRED

Nobody revealed the challenge.

Challenge closed. 🥭`;
}

function buildTeaserText() {
  return TEASER_TEXT;
}

function getRevealKeyboard() {
  return Markup.inlineKeyboard([
    Markup.button.callback("👀 Reveal challenge", REVEAL_CALLBACK_DATA),
  ]);
}

function createChatFightService(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const setTimeoutFn =
    typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimeoutFn =
    typeof options.clearTimeout === "function"
      ? options.clearTimeout
      : clearTimeout;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const durationMs =
    typeof options.durationMs === "number"
      ? options.durationMs
      : CHAT_FIGHT_DURATION_MS;
  const revealWaitMs =
    typeof options.revealWaitMs === "number"
      ? options.revealWaitMs
      : CHAT_FIGHT_REVEAL_WAIT_MS;
  const cooldownMs =
    typeof options.cooldownMs === "number"
      ? options.cooldownMs
      : CHAT_FIGHT_COOLDOWN_MS;
  const sendMessage =
    typeof options.sendMessage === "function" ? options.sendMessage : null;
  let editMessage =
    typeof options.editMessage === "function" ? options.editMessage : null;

  let fight = null;
  let lastStartedAt = null;
  let timeoutHandle = null;
  let timeoutMessageSent = false;

  function clearFightTimer() {
    if (timeoutHandle != null) {
      clearTimeoutFn(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function snapshotFight() {
    if (!fight) {
      return null;
    }
    return {
      id: fight.id,
      status: fight.status,
      active: fight.status === FIGHT_STATUS.ACTIVE,
      chatId: fight.chatId,
      type: fight.type,
      source: fight.source || "manual",
      prompt: fight.prompt,
      acceptedAnswers: [...fight.acceptedAnswers],
      revealAnswer: fight.revealAnswer,
      startedAt: fight.startedAt,
      revealedAt: fight.revealedAt,
      expiresAt: fight.expiresAt,
      winnerUserId: fight.winnerUserId,
      meta: fight.meta,
      messageId: fight.messageId,
    };
  }

  function getActiveFight() {
    return fight && fight.status === FIGHT_STATUS.ACTIVE ? snapshotFight() : null;
  }

  function getFightSnapshot() {
    return snapshotFight();
  }

  function isFightOpen() {
    return Boolean(
      fight &&
        (fight.status === FIGHT_STATUS.WAITING_FOR_REVEAL ||
          fight.status === FIGHT_STATUS.PREPARE ||
          fight.status === FIGHT_STATUS.ACTIVE)
    );
  }

  function getCooldownRemainingMs() {
    if (lastStartedAt == null) {
      return 0;
    }
    const remaining = lastStartedAt + cooldownMs - now();
    return remaining > 0 ? remaining : 0;
  }

  function isOnCooldown() {
    return getCooldownRemainingMs() > 0;
  }

  function notifyTimeout(text) {
    if (!fight) {
      return;
    }
    const extra = emptyGameKeyboardExtra();
    const chatId = fight.chatId;
    const messageId = fight.messageId;
    logGameCleanup(GAME_TYPE.CHATFIGHT, FINAL_STATE.EXPIRED);

    const afterEdit = () => {
      if (messageId != null) {
        scheduleExpiredMessageCleanup({
          chatId,
          messageId,
          setTimeoutFn,
          clearTimeoutFn,
          deleteMessageFn:
            typeof options.deleteMessageFn === "function"
              ? options.deleteMessageFn
              : null,
          telegram: options.telegram || null,
        });
      }
    };

    if (typeof editMessage === "function" && messageId != null) {
      Promise.resolve(editMessage(chatId, messageId, text, extra))
        .then(afterEdit)
        .catch(() => {
          const notify =
            typeof fight.sendMessage === "function"
              ? fight.sendMessage
              : sendMessage;
          if (typeof notify === "function") {
            Promise.resolve(notify(chatId, text)).catch(() => {});
          }
        });
      return;
    }

    const notify =
      typeof fight.sendMessage === "function" ? fight.sendMessage : sendMessage;
    if (typeof notify === "function") {
      Promise.resolve(notify(chatId, text)).catch(() => {});
    }
  }

  function scheduleRevealTimeout(target) {
    clearFightTimer();
    timeoutMessageSent = false;
    const delay = Math.max(0, target.expiresAt - now());
    timeoutHandle = setTimeoutFn(() => {
      timeoutHandle = null;
      if (!fight || fight !== target) {
        return;
      }
      if (fight.status !== FIGHT_STATUS.WAITING_FOR_REVEAL) {
        return;
      }
      fight.status = FIGHT_STATUS.EXPIRED;
      if (timeoutMessageSent) {
        return;
      }
      timeoutMessageSent = true;
      notifyTimeout(buildRevealTimeoutMessage());
    }, delay);
  }

  function scheduleAnswerTimeout(target) {
    clearFightTimer();
    timeoutMessageSent = false;
    const delay = Math.max(0, target.expiresAt - now());
    timeoutHandle = setTimeoutFn(() => {
      timeoutHandle = null;
      if (!fight || fight !== target) {
        return;
      }
      if (fight.status !== FIGHT_STATUS.ACTIVE || fight.winnerUserId != null) {
        return;
      }
      fight.status = FIGHT_STATUS.EXPIRED;
      if (timeoutMessageSent) {
        return;
      }
      timeoutMessageSent = true;
      notifyTimeout(buildTimeoutMessage(fight));
    }, delay);
  }

  function startFight({
    chatId,
    type = null,
    types = null,
    avoidType = null,
    source = "manual",
    sendMessage: startSend = null,
  } = {}) {
    if (chatId === undefined || chatId === null || chatId === "") {
      return { ok: false, reason: "missing-chat" };
    }

    if (!isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }

    if (isFightOpen()) {
      return { ok: false, reason: "already-active", fight: snapshotFight() };
    }

    const remainingMs = getCooldownRemainingMs();
    if (remainingMs > 0) {
      return {
        ok: false,
        reason: "cooldown",
        remainingMs,
        remainingMinutes: formatCooldownMinutes(remainingMs),
      };
    }

    let resolvedType = type;
    if (!resolvedType) {
      resolvedType = selectFightType(types, avoidType, random);
    }

    const challenge = generateChallenge(resolvedType, random);
    const startedAt = now();
    const notify =
      typeof startSend === "function"
        ? startSend
        : typeof sendMessage === "function"
          ? sendMessage
          : null;
    const previousLastStartedAt = lastStartedAt;

    fight = {
      id: `cf-${startedAt}`,
      status: FIGHT_STATUS.WAITING_FOR_REVEAL,
      chatId,
      type: challenge.type,
      source: source === "auto" ? "auto" : "manual",
      prompt: challenge.prompt,
      answerPrompt: challenge.answerPrompt || null,
      acceptedAnswers: [...challenge.acceptedAnswers],
      revealAnswer: challenge.revealAnswer,
      startedAt,
      revealedAt: null,
      expiresAt: startedAt + revealWaitMs,
      winnerUserId: null,
      meta: challenge.meta || null,
      sendMessage: notify,
      messageId: null,
      previousLastStartedAt,
    };
    lastStartedAt = startedAt;
    scheduleRevealTimeout(fight);

    return {
      ok: true,
      fight: snapshotFight(),
      teaser: buildTeaserText(),
      prompt: challenge.prompt,
      revealKeyboard: getRevealKeyboard(),
      callbackData: REVEAL_CALLBACK_DATA,
    };
  }

  function setFightMessageId(messageId) {
    if (fight && messageId != null) {
      fight.messageId = messageId;
    }
  }

  /**
   * Roll back a fight that never reached Telegram (send failure).
   * Restores prior cooldown clock. No-op if already published/revealed.
   */
  function abortUnpublishedFight() {
    if (!fight || fight.status !== FIGHT_STATUS.WAITING_FOR_REVEAL) {
      return { aborted: false, reason: "not-waiting" };
    }
    if (fight.messageId != null) {
      return { aborted: false, reason: "already-published" };
    }
    const restore = fight.previousLastStartedAt;
    clearFightTimer();
    lastStartedAt = restore == null ? null : restore;
    fight = null;
    timeoutMessageSent = false;
    return { aborted: true };
  }

  function getRuntimeStatus() {
    const snap = snapshotFight();
    let currentFight = "none";
    if (snap) {
      if (snap.status === FIGHT_STATUS.WAITING_FOR_REVEAL) {
        currentFight = "waiting";
      } else if (snap.status === FIGHT_STATUS.PREPARE) {
        currentFight = "prepare";
      } else if (snap.status === FIGHT_STATUS.ACTIVE) {
        currentFight = "active";
      } else {
        currentFight = snap.status;
      }
    }
    const remainingMs = getCooldownRemainingMs();
    const openish =
      snap &&
      (snap.status === FIGHT_STATUS.WAITING_FOR_REVEAL ||
        snap.status === FIGHT_STATUS.PREPARE ||
        snap.status === FIGHT_STATUS.ACTIVE);
    return {
      currentFight,
      type: openish ? snap.type : null,
      source: openish ? snap.source : null,
      cooldownRemainingMs: remainingMs,
      cooldownRemainingMinutes: formatCooldownMinutes(remainingMs),
      isFightOpen: isFightOpen(),
      isOnCooldown: remainingMs > 0,
    };
  }

  /**
   * First valid reveal click. Sync before any await/edit.
   * Memory / Quick Tap enter PREPARE then become ACTIVE after delay.
   */
  function revealFight(chatId) {
    if (!fight || fight.status !== FIGHT_STATUS.WAITING_FOR_REVEAL) {
      if (
        fight &&
        (fight.status === FIGHT_STATUS.ACTIVE ||
          fight.status === FIGHT_STATUS.PREPARE)
      ) {
        return { ok: false, reason: "already-revealed", fight: snapshotFight() };
      }
      return { ok: false, reason: "inactive", fight: snapshotFight() };
    }
    if (chatId != null && String(fight.chatId) !== String(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }

    const revealedAt = now();
    fight.revealedAt = revealedAt;

    const needsPrepare =
      fight.type === FIGHT_TYPES.MEMORY || fight.type === FIGHT_TYPES.QUICK_TAP;

    if (needsPrepare) {
      fight.status = FIGHT_STATUS.PREPARE;
      const prepareMs =
        fight.meta && typeof fight.meta.prepareMs === "number"
          ? fight.meta.prepareMs
          : 5000;
      // Keep reveal-wait timer replaced by prepare → answer window after.
      clearFightTimer();
      timeoutMessageSent = false;
      const target = fight;
      timeoutHandle = setTimeoutFn(() => {
        timeoutHandle = null;
        if (!fight || fight !== target) {
          return;
        }
        if (fight.status !== FIGHT_STATUS.PREPARE) {
          return;
        }
        fight.status = FIGHT_STATUS.ACTIVE;
        fight.expiresAt = now() + durationMs;
        scheduleAnswerTimeout(fight);
        const text = fight.answerPrompt || fight.prompt;
        const edit =
          typeof editMessage === "function"
            ? editMessage
            : null;
        if (edit && fight.messageId != null) {
          Promise.resolve(
            edit(fight.chatId, fight.messageId, text, emptyGameKeyboardExtra())
          ).catch(() => {});
        } else if (typeof fight.sendMessage === "function") {
          Promise.resolve(fight.sendMessage(fight.chatId, text)).catch(() => {});
        }
      }, Math.max(0, prepareMs));

      return {
        ok: true,
        prompt: fight.prompt,
        fight: snapshotFight(),
        phase: "prepare",
      };
    }

    fight.status = FIGHT_STATUS.ACTIVE;
    fight.expiresAt = revealedAt + durationMs;
    scheduleAnswerTimeout(fight);

    return {
      ok: true,
      prompt: fight.prompt,
      fight: snapshotFight(),
      phase: "active",
    };
  }

  function tryClaimWinner(userId, chatId, text) {
    if (!fight || fight.status !== FIGHT_STATUS.ACTIVE) {
      return { claimed: false, reason: "inactive" };
    }
    if (String(fight.chatId) !== String(chatId)) {
      return { claimed: false, reason: "wrong-chat" };
    }
    if (fight.winnerUserId != null) {
      return { claimed: false, reason: "already-won" };
    }
    if (!isCorrectAnswer(fight, text)) {
      return { claimed: false, reason: "wrong-answer" };
    }

    fight.status = FIGHT_STATUS.WON;
    fight.winnerUserId = String(userId);
    clearFightTimer();

    return {
      claimed: true,
      fight: snapshotFight(),
      pointsToAdd: CHAT_FIGHT_XP,
    };
  }

  function forceTimeout() {
    if (!fight) {
      return { timedOut: false };
    }
    if (
      fight.status !== FIGHT_STATUS.WAITING_FOR_REVEAL &&
      fight.status !== FIGHT_STATUS.PREPARE &&
      fight.status !== FIGHT_STATUS.ACTIVE
    ) {
      return { timedOut: false };
    }
    if (fight.winnerUserId != null) {
      return { timedOut: false };
    }
    const wasWaiting = fight.status === FIGHT_STATUS.WAITING_FOR_REVEAL;
    fight.status = FIGHT_STATUS.EXPIRED;
    clearFightTimer();
    if (!timeoutMessageSent) {
      timeoutMessageSent = true;
      const text = wasWaiting
        ? buildRevealTimeoutMessage()
        : buildTimeoutMessage(fight);
      notifyTimeout(text);
      return {
        timedOut: true,
        message: text,
        phase: wasWaiting ? "reveal" : "answer",
      };
    }
    return { timedOut: true, message: null };
  }

  function reset() {
    clearFightTimer();
    fight = null;
    lastStartedAt = null;
    timeoutMessageSent = false;
  }

  function setEditMessageHandler(fn) {
    editMessage = typeof fn === "function" ? fn : null;
  }

  function setLastStartedAt(ts) {
    lastStartedAt = ts;
  }

  return {
    CHAT_FIGHT_DURATION_MS: durationMs,
    CHAT_FIGHT_REVEAL_WAIT_MS: revealWaitMs,
    CHAT_FIGHT_COOLDOWN_MS: cooldownMs,
    CHAT_FIGHT_XP,
    FIGHT_STATUS,
    startFight,
    revealFight,
    tryClaimWinner,
    getActiveFight,
    getFightSnapshot,
    getCooldownRemainingMs,
    isOnCooldown,
    isFightOpen,
    isCorrectAnswer,
    forceTimeout,
    reset,
    setLastStartedAt,
    setFightMessageId,
    setEditMessageHandler,
    abortUnpublishedFight,
    getRuntimeStatus,
    clearFightTimer,
    buildWinnerReply,
    buildTimeoutMessage,
    buildRevealTimeoutMessage,
    buildTeaserText,
    getRevealKeyboard,
    generateChallenge,
  };
}

const defaultService = createChatFightService();

module.exports = {
  CHAT_FIGHT_DURATION_MS,
  CHAT_FIGHT_REVEAL_WAIT_MS,
  CHAT_FIGHT_COOLDOWN_MS,
  CHAT_FIGHT_XP,
  REVEAL_CALLBACK_DATA,
  FIGHT_STATUS,
  FIGHT_TYPES,
  RACE_FIGHT_TYPES,
  TYPE_RUSH_WORDS,
  EMOJI_MAP,
  USAGE_TEXT,
  TEASER_TEXT,
  getConfiguredCommunityChatId,
  isAllowedChatFightChat,
  parseFightTypeArg,
  normalizeAnswer,
  isCorrectAnswer,
  formatCooldownMinutes,
  buildWinnerReply,
  buildTimeoutMessage,
  buildRevealTimeoutMessage,
  buildTeaserText,
  getRevealKeyboard,
  generateChallenge,
  generateTypeRush,
  generateMathRush,
  generateEmojiGuess,
  createChatFightService,
  selectFightType,
  ALL_FIGHT_TYPES,
  generateUnscramble,
  generateMissingLetter,
  generateMemory,
  generateQuickTap,
  /** Shared production runtime — manual + auto must use this instance. */
  chatFightRuntime: defaultService,
  startFight: (...args) => defaultService.startFight(...args),
  revealFight: (...args) => defaultService.revealFight(...args),
  tryClaimWinner: (...args) => defaultService.tryClaimWinner(...args),
  getActiveFight: (...args) => defaultService.getActiveFight(...args),
  getFightSnapshot: (...args) => defaultService.getFightSnapshot(...args),
  getCooldownRemainingMs: (...args) =>
    defaultService.getCooldownRemainingMs(...args),
  isOnCooldown: (...args) => defaultService.isOnCooldown(...args),
  isFightOpen: (...args) => defaultService.isFightOpen(...args),
  forceTimeout: (...args) => defaultService.forceTimeout(...args),
  resetChatFightState: (...args) => defaultService.reset(...args),
  setFightMessageId: (...args) => defaultService.setFightMessageId(...args),
  setEditMessageHandler: (...args) =>
    defaultService.setEditMessageHandler(...args),
  abortUnpublishedFight: (...args) =>
    defaultService.abortUnpublishedFight(...args),
  getRuntimeStatus: (...args) => defaultService.getRuntimeStatus(...args),
  buildWinnerReplyDefault: (...args) => defaultService.buildWinnerReply(...args),
  _defaultService: defaultService,
};
