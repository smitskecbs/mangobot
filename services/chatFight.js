/**
 * ChatFight v1 — short group challenges; first correct answer wins XP.
 * In-memory state only (no restore after restart). Telegram formatting stays thin.
 */

const CHAT_FIGHT_DURATION_MS = 60 * 1000;
const CHAT_FIGHT_COOLDOWN_MS = 60 * 60 * 1000;
const CHAT_FIGHT_XP = 2;

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

/** Primary accepted answer is listed first for timeout reveal. */
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

function getConfiguredCommunityChatId() {
  const raw = process.env.TELEGRAM_CHAT_ID;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed || null;
}

/**
 * Production: restrict to TELEGRAM_CHAT_ID when set.
 * Development: if unset, any group may run fights.
 * @param {string|number} chatId
 * @returns {boolean}
 */
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
    prompt: `⚔️ CHAT FIGHT\n\nType this exactly:\n\n${word}\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
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
    prompt: `⚔️ CHAT FIGHT\n\nSolve:\n\n${expression} = ?\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
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
    prompt: `⚔️ CHAT FIGHT\n\nGuess the emotion:\n\n${emoji}\n\nFirst correct answer wins +${CHAT_FIGHT_XP} XP!`,
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

/**
 * Type Rush / emoji: trim + lowercase exact match (no punctuation strip).
 * Math: trim only; must equal String(result).
 */
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
  if (!fight || !fight.active) {
    return false;
  }
  const normalized = normalizeAnswer(fight.type, text);
  if (normalized === null) {
    return false;
  }
  return fight.acceptedAnswers.includes(normalized);
}

function formatCooldownMinutes(remainingMs) {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return minutes;
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

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {typeof setTimeout} [options.setTimeout]
 * @param {typeof clearTimeout} [options.clearTimeout]
 * @param {() => number} [options.random]
 * @param {number} [options.durationMs]
 * @param {number} [options.cooldownMs]
 * @param {(chatId: string|number, text: string) => void|Promise<void>} [options.sendMessage]
 */
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
  const cooldownMs =
    typeof options.cooldownMs === "number"
      ? options.cooldownMs
      : CHAT_FIGHT_COOLDOWN_MS;
  const sendMessage =
    typeof options.sendMessage === "function" ? options.sendMessage : null;

  /** @type {null|{active:boolean,chatId:*,type:string,prompt:string,acceptedAnswers:string[],revealAnswer:string,startedAt:number,expiresAt:number,winnerUserId:string|null}} */
  let fight = null;
  /** @type {number|null} */
  let lastStartedAt = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timeoutHandle = null;
  let timeoutMessageSent = false;

  function clearFightTimer() {
    if (timeoutHandle != null) {
      clearTimeoutFn(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function getActiveFight() {
    if (!(fight && fight.active)) {
      return null;
    }
    return {
      active: fight.active,
      chatId: fight.chatId,
      type: fight.type,
      prompt: fight.prompt,
      acceptedAnswers: [...fight.acceptedAnswers],
      revealAnswer: fight.revealAnswer,
      startedAt: fight.startedAt,
      expiresAt: fight.expiresAt,
      winnerUserId: fight.winnerUserId,
      meta: fight.meta,
    };
  }

  function getFightSnapshot() {
    if (!fight) {
      return null;
    }
    return {
      active: fight.active,
      chatId: fight.chatId,
      type: fight.type,
      prompt: fight.prompt,
      acceptedAnswers: [...fight.acceptedAnswers],
      revealAnswer: fight.revealAnswer,
      startedAt: fight.startedAt,
      expiresAt: fight.expiresAt,
      winnerUserId: fight.winnerUserId,
      meta: fight.meta,
    };
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

  function scheduleTimeout(active) {
    clearFightTimer();
    timeoutMessageSent = false;
    const delay = Math.max(0, active.expiresAt - now());
    timeoutHandle = setTimeoutFn(() => {
      timeoutHandle = null;
      if (!fight || fight !== active) {
        return;
      }
      if (!fight.active || fight.winnerUserId != null) {
        return;
      }
      // Finish before any async send boundary.
      fight.active = false;
      if (timeoutMessageSent) {
        return;
      }
      timeoutMessageSent = true;
      const text = buildTimeoutMessage(fight);
      const notify =
        typeof fight.sendMessage === "function"
          ? fight.sendMessage
          : sendMessage;
      if (typeof notify === "function") {
        Promise.resolve(notify(fight.chatId, text)).catch(() => {});
      }
    }, delay);
  }

  /**
 * @param {{chatId:string|number,type?:string|null,sendMessage?:Function}} params
 */
  function startFight({ chatId, type = null, sendMessage: startSend = null } = {}) {
    if (chatId === undefined || chatId === null || chatId === "") {
      return { ok: false, reason: "missing-chat" };
    }

    if (!isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }

    if (fight && fight.active) {
      return { ok: false, reason: "already-active", fight: getFightSnapshot() };
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
    const expiresAt = startedAt + durationMs;
    const notify =
      typeof startSend === "function"
        ? startSend
        : typeof sendMessage === "function"
          ? sendMessage
          : null;

    fight = {
      active: true,
      chatId,
      type: challenge.type,
      prompt: challenge.prompt,
      acceptedAnswers: [...challenge.acceptedAnswers],
      revealAnswer: challenge.revealAnswer,
      startedAt,
      expiresAt,
      winnerUserId: null,
      meta: challenge.meta || null,
      sendMessage: notify,
    };
    lastStartedAt = startedAt;
    scheduleTimeout(fight);

    return {
      ok: true,
      fight: getFightSnapshot(),
      prompt: challenge.prompt,
    };
  }

  /**
   * Atomically claim the first winner. Must run before any await.
   * @param {string|number} userId
   * @param {string|number} chatId
   * @param {string} text
   */
  function tryClaimWinner(userId, chatId, text) {
    if (!fight || !fight.active) {
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

    // Finish before XP award / reply (sync claim).
    fight.active = false;
    fight.winnerUserId = String(userId);
    clearFightTimer();

    return {
      claimed: true,
      fight: getFightSnapshot(),
      pointsToAdd: CHAT_FIGHT_XP,
    };
  }

  /** Test/helper: force-expire without waiting. */
  function forceTimeout() {
    if (!fight || !fight.active || fight.winnerUserId != null) {
      return { timedOut: false };
    }
    fight.active = false;
    clearFightTimer();
    if (!timeoutMessageSent) {
      timeoutMessageSent = true;
      const text = buildTimeoutMessage(fight);
      const notify =
        typeof fight.sendMessage === "function"
          ? fight.sendMessage
          : sendMessage;
      if (typeof notify === "function") {
        Promise.resolve(notify(fight.chatId, text)).catch(() => {});
      }
      return { timedOut: true, message: text };
    }
    return { timedOut: true, message: null };
  }

  function reset() {
    clearFightTimer();
    fight = null;
    lastStartedAt = null;
    timeoutMessageSent = false;
  }

  /** Test helper: set lastStartedAt without starting a fight. */
  function setLastStartedAt(ts) {
    lastStartedAt = ts;
  }

  return {
    CHAT_FIGHT_DURATION_MS: durationMs,
    CHAT_FIGHT_COOLDOWN_MS: cooldownMs,
    CHAT_FIGHT_XP,
    FIGHT_TYPES,
    startFight,
    tryClaimWinner,
    getActiveFight,
    getFightSnapshot,
    getCooldownRemainingMs,
    isOnCooldown,
    isCorrectAnswer,
    forceTimeout,
    reset,
    setLastStartedAt,
    clearFightTimer,
    buildWinnerReply,
    buildTimeoutMessage,
    generateChallenge,
  };
}

const defaultService = createChatFightService();

module.exports = {
  CHAT_FIGHT_DURATION_MS,
  CHAT_FIGHT_COOLDOWN_MS,
  CHAT_FIGHT_XP,
  FIGHT_TYPES,
  TYPE_RUSH_WORDS,
  EMOJI_MAP,
  USAGE_TEXT,
  getConfiguredCommunityChatId,
  isAllowedChatFightChat,
  parseFightTypeArg,
  normalizeAnswer,
  isCorrectAnswer,
  formatCooldownMinutes,
  buildWinnerReply,
  buildTimeoutMessage,
  generateChallenge,
  generateTypeRush,
  generateMathRush,
  generateEmojiGuess,
  createChatFightService,
  // Default singleton used by bot commands/events
  startFight: (...args) => defaultService.startFight(...args),
  tryClaimWinner: (...args) => defaultService.tryClaimWinner(...args),
  getActiveFight: (...args) => defaultService.getActiveFight(...args),
  getFightSnapshot: (...args) => defaultService.getFightSnapshot(...args),
  getCooldownRemainingMs: (...args) =>
    defaultService.getCooldownRemainingMs(...args),
  isOnCooldown: (...args) => defaultService.isOnCooldown(...args),
  forceTimeout: (...args) => defaultService.forceTimeout(...args),
  resetChatFightState: (...args) => defaultService.reset(...args),
  buildWinnerReplyDefault: (...args) => defaultService.buildWinnerReply(...args),
  _defaultService: defaultService,
};
