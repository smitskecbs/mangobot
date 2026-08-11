/**
 * ChatFight — short group challenges; first correct answer wins XP.
 * Flow: waiting_for_reveal → active (60s) → won | expired.
 * In-memory only (no restore after restart).
 */

const { Markup } = require("telegraf");

const CHAT_FIGHT_DURATION_MS = 60 * 1000;
const CHAT_FIGHT_REVEAL_WAIT_MS = 5 * 60 * 1000;
const CHAT_FIGHT_COOLDOWN_MS = 60 * 60 * 1000;
const CHAT_FIGHT_XP = 2;

/** Opaque callback — never embeds answers or challenge text. */
const REVEAL_CALLBACK_DATA = "cfight:reveal";

const FIGHT_STATUS = Object.freeze({
  WAITING_FOR_REVEAL: "waiting_for_reveal",
  ACTIVE: "active",
  WON: "won",
  EXPIRED: "expired",
});

const FIGHT_TYPES = Object.freeze({
  TYPE_RUSH: "type_rush",
  MATH_RUSH: "math_rush",
  EMOJI_GUESS: "emoji_guess",
});

const TYPE_ALIASES = Object.freeze({
  type: FIGHT_TYPES.TYPE_RUSH,
  rush: FIGHT_TYPES.TYPE_RUSH,
  typerush: FIGHT_TYPES.TYPE_RUSH,
  math: FIGHT_TYPES.MATH_RUSH,
  mathrush: FIGHT_TYPES.MATH_RUSH,
  emoji: FIGHT_TYPES.EMOJI_GUESS,
  emojiguess: FIGHT_TYPES.EMOJI_GUESS,
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
/chatfight emoji — Emoji Guess`;

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
  const lines = [`⚔️ ${userName} wins the ChatFight!`, `+${CHAT_FIGHT_XP} XP 🥭`];
  if (awardResult && awardResult.rankUp && awardResult.rank) {
    lines.push(`${awardResult.rank.emoji} Rank up: ${awardResult.rank.title}!`);
  }
  return lines.join("\n");
}

function buildTimeoutMessage(fight) {
  const answer =
    fight && fight.revealAnswer != null ? String(fight.revealAnswer) : null;
  if (answer) {
    return `⚔️ ChatFight over!\nNo winner this round.\nAnswer: ${answer}`;
  }
  return "⚔️ ChatFight over!\nNo winner this round.";
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
    const notify =
      fight && typeof fight.sendMessage === "function"
        ? fight.sendMessage
        : sendMessage;
    if (typeof notify === "function" && fight) {
      Promise.resolve(notify(fight.chatId, text)).catch(() => {});
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
      notifyTimeout("⚔️ ChatFight expired.\nNobody revealed the challenge.");
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

  function startFight({ chatId, type = null, sendMessage: startSend = null } = {}) {
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
      resolvedType = pickRandom(
        [FIGHT_TYPES.TYPE_RUSH, FIGHT_TYPES.MATH_RUSH, FIGHT_TYPES.EMOJI_GUESS],
        random
      );
    }

    const challenge = generateChallenge(resolvedType, random);
    const startedAt = now();
    const notify =
      typeof startSend === "function"
        ? startSend
        : typeof sendMessage === "function"
          ? sendMessage
          : null;

    fight = {
      id: `cf-${startedAt}`,
      status: FIGHT_STATUS.WAITING_FOR_REVEAL,
      chatId,
      type: challenge.type,
      prompt: challenge.prompt,
      acceptedAnswers: [...challenge.acceptedAnswers],
      revealAnswer: challenge.revealAnswer,
      startedAt,
      revealedAt: null,
      expiresAt: startedAt + revealWaitMs,
      winnerUserId: null,
      meta: challenge.meta || null,
      sendMessage: notify,
      messageId: null,
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
   * First valid reveal click. Sync before any await/edit.
   */
  function revealFight(chatId) {
    if (!fight || fight.status !== FIGHT_STATUS.WAITING_FOR_REVEAL) {
      if (fight && fight.status === FIGHT_STATUS.ACTIVE) {
        return { ok: false, reason: "already-revealed", fight: snapshotFight() };
      }
      return { ok: false, reason: "inactive" };
    }
    if (chatId != null && String(fight.chatId) !== String(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }

    const revealedAt = now();
    fight.status = FIGHT_STATUS.ACTIVE;
    fight.revealedAt = revealedAt;
    fight.expiresAt = revealedAt + durationMs;
    scheduleAnswerTimeout(fight);

    return {
      ok: true,
      prompt: fight.prompt,
      fight: snapshotFight(),
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
        ? "⚔️ ChatFight expired.\nNobody revealed the challenge."
        : buildTimeoutMessage(fight);
      notifyTimeout(text);
      return { timedOut: true, message: text, phase: wasWaiting ? "reveal" : "answer" };
    }
    return { timedOut: true, message: null };
  }

  function reset() {
    clearFightTimer();
    fight = null;
    lastStartedAt = null;
    timeoutMessageSent = false;
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
    clearFightTimer,
    buildWinnerReply,
    buildTimeoutMessage,
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
  buildTeaserText,
  getRevealKeyboard,
  generateChallenge,
  generateTypeRush,
  generateMathRush,
  generateEmojiGuess,
  createChatFightService,
  startFight: (...args) => defaultService.startFight(...args),
  revealFight: (...args) => defaultService.revealFight(...args),
  tryClaimWinner: (...args) => defaultService.tryClaimWinner(...args),
  getActiveFight: (...args) => defaultService.getActiveFight(...args),
  getFightSnapshot: (...args) => defaultService.getFightSnapshot(...args),
  getCooldownRemainingMs: (...args) =>
    defaultService.getCooldownRemainingMs(...args),
  isOnCooldown: (...args) => defaultService.isOnCooldown(...args),
  forceTimeout: (...args) => defaultService.forceTimeout(...args),
  resetChatFightState: (...args) => defaultService.reset(...args),
  setFightMessageId: (...args) => defaultService.setFightMessageId(...args),
  buildWinnerReplyDefault: (...args) => defaultService.buildWinnerReply(...args),
  _defaultService: defaultService,
};
