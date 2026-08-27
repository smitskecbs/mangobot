/**
 * ManGo 24/7 Community Activity Engine
 *
 * One crossed wall-clock slot → at most ONE group action.
 * Weighted selection with eligibility fallbacks.
 * ChatFight uses shared chatFightRuntime (same as /chatfight).
 */

const { log, error: logError } = require("../utils/logger");
const {
  wasActiveWithin,
  getLastCommunityActivityAtMs,
} = require("../utils/communityActivityPulse");
const {
  chatFightRuntime,
  getRevealKeyboard,
  RACE_FIGHT_TYPES,
} = require("./chatFight");
const {
  parseAutoEnabledFlag,
  parseAutoFightTypes,
  tryStartAutoChatFight,
  emptyAutoChatFightState,
  normalizeAutoChatFightState,
} = require("./autoChatFight");
const {
  COMMUNITY_QUESTIONS,
  ANTI_REPEAT_WINDOW,
  DEFAULT_QUESTION_MIN_GAP_MINUTES,
  pickCommunityQuestion,
  formatCommunityQuestionMessage,
  emptyCommunityQuestionState,
  normalizeCommunityQuestionState,
} = require("./communityQuestions");

const DEFAULT_ACTIVITY_INTERVAL_MINUTES = 30;
const DEFAULT_AUTO_FIGHT_MIN_GAP_MINUTES = 120;
const QUIET_GROUP_MS = 60 * 60 * 1000;

const ACTION_IDS = Object.freeze({
  CHATFIGHT: "chatfight",
  TRIVIA: "trivia",
  QUESTION: "question",
  GAME: "game",
  COMMUNITY: "community",
  WEEKLY: "weekly",
  SNAKE: "snake",
  BOUNCH: "bounch",
  GMGN: "gmgn",
  LEADERBOARD: "leaderboard",
  CHECKIN: "checkin",
  SKIP: "skip",
});

/**
 * Exact total weight 100.
 * Before question: chatfight 18, trivia 15, game 11, community 10, weekly 8,
 * snake 8, bounch 8, gmgn 6, leaderboard 6, checkin 6, skip 4.
 */
const ACTION_WEIGHTS = Object.freeze({
  [ACTION_IDS.CHATFIGHT]: 18,
  [ACTION_IDS.TRIVIA]: 15,
  [ACTION_IDS.QUESTION]: 11,
  [ACTION_IDS.GAME]: 10,
  [ACTION_IDS.COMMUNITY]: 7,
  [ACTION_IDS.WEEKLY]: 7,
  [ACTION_IDS.SNAKE]: 7,
  [ACTION_IDS.BOUNCH]: 8,
  [ACTION_IDS.LEADERBOARD]: 5,
  [ACTION_IDS.GMGN]: 4,
  [ACTION_IDS.CHECKIN]: 4,
  [ACTION_IDS.SKIP]: 4,
});

const INTERACTIVE_ACTIONS = new Set([
  ACTION_IDS.CHATFIGHT,
  ACTION_IDS.TRIVIA,
  ACTION_IDS.SNAKE,
  ACTION_IDS.BOUNCH,
  ACTION_IDS.WEEKLY,
  ACTION_IDS.LEADERBOARD,
  ACTION_IDS.GAME,
]);

const PASSIVE_ACTIONS = new Set([
  ACTION_IDS.COMMUNITY,
  ACTION_IDS.CHECKIN,
  ACTION_IDS.GMGN,
  ACTION_IDS.QUESTION,
]);

const ACTION_REGISTRY = Object.freeze({
  [ACTION_IDS.CHATFIGHT]: Object.freeze({
    id: ACTION_IDS.CHATFIGHT,
    mode: "race",
    category: "chatfight",
  }),
  [ACTION_IDS.TRIVIA]: Object.freeze({
    id: ACTION_IDS.TRIVIA,
    mode: "race",
    category: "trivia",
    enabledForAuto: true,
  }),
  [ACTION_IDS.QUESTION]: Object.freeze({
    id: ACTION_IDS.QUESTION,
    mode: "prompt",
    category: "question",
    enabledForAuto: true,
  }),
  [ACTION_IDS.GAME]: Object.freeze({
    id: ACTION_IDS.GAME,
    mode: "prompt",
    category: "game",
  }),
  [ACTION_IDS.COMMUNITY]: Object.freeze({
    id: ACTION_IDS.COMMUNITY,
    mode: "prompt",
    category: "community",
  }),
  [ACTION_IDS.WEEKLY]: Object.freeze({
    id: ACTION_IDS.WEEKLY,
    mode: "prompt",
    category: "weekly",
  }),
  [ACTION_IDS.SNAKE]: Object.freeze({
    id: ACTION_IDS.SNAKE,
    mode: "prompt",
    category: "snake",
  }),
  [ACTION_IDS.BOUNCH]: Object.freeze({
    id: ACTION_IDS.BOUNCH,
    mode: "prompt",
    category: "bounch",
  }),
  [ACTION_IDS.GMGN]: Object.freeze({
    id: ACTION_IDS.GMGN,
    mode: "prompt",
    category: "gmgn",
  }),
  [ACTION_IDS.LEADERBOARD]: Object.freeze({
    id: ACTION_IDS.LEADERBOARD,
    mode: "prompt",
    category: "leaderboard",
  }),
  [ACTION_IDS.CHECKIN]: Object.freeze({
    id: ACTION_IDS.CHECKIN,
    mode: "prompt",
    category: "checkin",
  }),
  [ACTION_IDS.SKIP]: Object.freeze({
    id: ACTION_IDS.SKIP,
    mode: "skip",
    category: "skip",
  }),
  // Future PvP (not started by this engine yet):
  tictactoe: Object.freeze({
    id: "tictactoe",
    mode: "pvp",
    category: "pvp",
    enabledForAuto: false,
  }),
  connect4: Object.freeze({
    id: "connect4",
    mode: "pvp",
    category: "pvp",
    enabledForAuto: false,
  }),
  // Alias kept for older tests that read ACTION_REGISTRY.trivia
  trivia: Object.freeze({
    id: "trivia",
    mode: "race",
    category: "trivia",
    enabledForAuto: true,
  }),
  question: Object.freeze({
    id: "question",
    mode: "prompt",
    category: "question",
    enabledForAuto: true,
  }),
});

const MESSAGE_POOLS = Object.freeze({
  [ACTION_IDS.GAME]: Object.freeze([
    `🎮 Quick ManGo mission

Play one verified game today:

🐍 Snake
🏀 Bounch

Use /menu to play and earn XP.`,
    `🎮 Gaming check
What are you playing lately?

Or jump into /menu for Snake or Bounch.`,
  ]),
  [ACTION_IDS.SNAKE]: Object.freeze([
    `🐍 Snake challenge
Can you beat today's best score?

Open /menu and play with your profile.`,
    `🐍 Snake warm-up
One verified run can earn daily game XP.

/menu → Snake`,
  ]),
  [ACTION_IDS.BOUNCH]: Object.freeze([
    `🏀 Bounch challenge
How far can you get today?

Open /menu → Bounch and play with your profile.`,
    `🏀 Bounce into XP
Clear a Bounch level with your personal profile.

Start from /menu.`,
  ]),
  [ACTION_IDS.WEEKLY]: Object.freeze([
    `🏆 Weekly race
Check /weekly and see who you're chasing.

Can you climb a spot today?`,
    `📅 Weekly climb
Who is on top this week?

Use /weekly — then send a message or play a game.`,
  ]),
  [ACTION_IDS.LEADERBOARD]: Object.freeze([
    `🏆 ManGo challenge
Can you improve your Snake or Bounch score today?

Open /menu and give it a try.`,
    `🌳 Leaderboard check
See the ManGo trees with /leaderboard.

Then earn XP with a real message or game.`,
  ]),
  [ACTION_IDS.COMMUNITY]: Object.freeze([
    `🥭 Community question
What's the best meme you've seen today?`,
    `🛠 Builder check
Working on something today?

Drop what you're building.`,
    `🥭 Community XP
Your first real message today earns XP.

Join the conversation and keep ManGo active.`,
  ]),
  [ACTION_IDS.GMGN]: Object.freeze([
    `☀️ Somewhere in the world it's GM.
GMango 🥭`,
    `🌙 Somewhere in the world it's GN.
GNango 🥭`,
    `🥭 Remember:
GM / GMango / GN / GNango can earn daily XP.

Check /points to see what you still have available.`,
  ]),
  [ACTION_IDS.CHECKIN]: Object.freeze([
    `🥭 ManGo check-in
What are you building, playing or watching today?`,
    `🔥 Momentum
A short message now can claim today's community XP.

Then try /menu for Snake or Bounch.`,
    `🌱 Keep growing
Drop a real message in the chat for daily activity XP.`,
  ]),
});

function parseEnabledFlag(raw) {
  if (typeof raw !== "string") {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build activity slots.
 * 24/7 → full day [00:00, 24:00).
 * Else active hours [start, end).
 */
function buildActivitySlots(intervalMinutes, options = {}) {
  const interval = intervalMinutes > 0 ? intervalMinutes : 30;
  const slots = [];
  let startMin = 0;
  let endMin = 24 * 60;
  if (!options.twentyFourSeven) {
    const startHour =
      typeof options.startHour === "number" ? options.startHour : 9;
    const endHour = typeof options.endHour === "number" ? options.endHour : 22;
    startMin = startHour * 60;
    endMin = endHour * 60;
    if (endMin <= startMin) {
      return Object.freeze([]);
    }
  }
  for (let m = startMin; m < endMin; m += interval) {
    const hour = Math.floor(m / 60);
    const minute = m % 60;
    slots.push(
      Object.freeze({
        id: `act${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`,
        hour,
        minute,
        label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      })
    );
  }
  return Object.freeze(slots);
}

function parseActivityEngineConfig(env = process.env, options = {}) {
  const enabled =
    options.enabled !== undefined
      ? Boolean(options.enabled)
      : parseEnabledFlag(env.COMMUNITY_ACTIVITY_ENGINE_ENABLED);
  const twentyFourSeven =
    options.twentyFourSeven !== undefined
      ? Boolean(options.twentyFourSeven)
      : parseEnabledFlag(env.COMMUNITY_ACTIVITY_24_7);
  const intervalMinutes = parsePositiveInt(
    options.intervalMinutes !== undefined
      ? options.intervalMinutes
      : env.COMMUNITY_ACTIVITY_INTERVAL_MINUTES,
    DEFAULT_ACTIVITY_INTERVAL_MINUTES
  );
  const startHour = parsePositiveInt(env.COMMUNITY_ACTIVE_START_HOUR, 9);
  const endHour = parsePositiveInt(env.COMMUNITY_ACTIVE_END_HOUR, 22);
  // parsePositiveInt rejects 0 for start — use dedicated hour parse
  const startH = Number.parseInt(String(env.COMMUNITY_ACTIVE_START_HOUR ?? 9), 10);
  const endH = Number.parseInt(String(env.COMMUNITY_ACTIVE_END_HOUR ?? 22), 10);
  const resolvedStart = Number.isFinite(startH) && startH >= 0 && startH <= 23 ? startH : 9;
  const resolvedEnd = Number.isFinite(endH) && endH >= 0 && endH <= 23 ? endH : 22;

  const autoFightEnabled =
    options.autoFightEnabled !== undefined
      ? Boolean(options.autoFightEnabled)
      : parseAutoEnabledFlag(env.AUTO_CHATFIGHT_ENABLED);

  const minGapRaw =
    env.AUTO_CHATFIGHT_MIN_GAP_MINUTES !== undefined &&
    env.AUTO_CHATFIGHT_MIN_GAP_MINUTES !== ""
      ? env.AUTO_CHATFIGHT_MIN_GAP_MINUTES
      : env.AUTO_CHATFIGHT_MIN_ACTIVITY_GAP_MINUTES;
  const autoFightMinGapMinutes = parsePositiveInt(
    options.autoFightMinGapMinutes !== undefined
      ? options.autoFightMinGapMinutes
      : minGapRaw,
    DEFAULT_AUTO_FIGHT_MIN_GAP_MINUTES
  );

  const skipRecentMinutes = parsePositiveInt(
    env.COMMUNITY_SKIP_IF_RECENT_ACTIVITY_MINUTES,
    10
  );

  const questionMinGapMinutes = parsePositiveInt(
    options.questionMinGapMinutes !== undefined
      ? options.questionMinGapMinutes
      : env.COMMUNITY_QUESTION_MIN_GAP_MINUTES,
    DEFAULT_QUESTION_MIN_GAP_MINUTES
  );

  const slots =
    options.slots ||
    buildActivitySlots(intervalMinutes, {
      twentyFourSeven,
      startHour: resolvedStart,
      endHour: resolvedEnd,
    });

  const fightTypes =
    options.fightTypes || parseAutoFightTypes(env.AUTO_CHATFIGHT_TYPES);

  return {
    enabled,
    twentyFourSeven,
    intervalMinutes,
    startHour: resolvedStart,
    endHour: resolvedEnd,
    autoFightEnabled,
    autoFightMinGapMinutes,
    autoFightMinGapMs: autoFightMinGapMinutes * 60_000,
    skipRecentMs: skipRecentMinutes * 60_000,
    questionMinGapMinutes,
    questionMinGapMs: questionMinGapMinutes * 60_000,
    slots,
    fightTypes: fightTypes.length ? fightTypes : [...RACE_FIGHT_TYPES],
  };
}

function pickWeightedAction(weights, random) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (!total) {
    return ACTION_IDS.SKIP;
  }
  let roll = random() * total;
  for (const [id, weight] of entries) {
    roll -= weight;
    if (roll < 0) {
      return id;
    }
  }
  return entries[entries.length - 1][0];
}

function buildWeights(config, context) {
  const weights = { ...ACTION_WEIGHTS };
  if (!config.autoFightEnabled) {
    weights[ACTION_IDS.CHATFIGHT] = 0;
  }

  const recent =
    context.recentActivity &&
    config.skipRecentMs > 0 &&
    context.wasActiveWithin(config.skipRecentMs, context.nowMs);

  if (recent) {
    for (const id of PASSIVE_ACTIONS) {
      weights[id] = 0;
    }
  }

  const quiet =
    !context.lastActivityAt ||
    context.nowMs - context.lastActivityAt >= QUIET_GROUP_MS;
  if (quiet) {
    weights[ACTION_IDS.CHATFIGHT] = Math.round(
      weights[ACTION_IDS.CHATFIGHT] * 1.4
    );
    weights[ACTION_IDS.TRIVIA] = Math.round(weights[ACTION_IDS.TRIVIA] * 1.3);
    weights[ACTION_IDS.QUESTION] = Math.round(
      weights[ACTION_IDS.QUESTION] * 1.4
    );
    weights[ACTION_IDS.SNAKE] = Math.round(weights[ACTION_IDS.SNAKE] * 1.3);
    weights[ACTION_IDS.BOUNCH] = Math.round(weights[ACTION_IDS.BOUNCH] * 1.3);
    weights[ACTION_IDS.GAME] = Math.round(weights[ACTION_IDS.GAME] * 1.2);
  }

  return weights;
}

function isInteractiveBusy() {
  try {
    const {
      isTriviaBusy,
      isChatFightBusy,
      isMangoBombBusy,
    } = require("./communityGameState");
    return Boolean(
      isChatFightBusy() || isTriviaBusy() || isMangoBombBusy()
    );
  } catch (_err) {
    return false;
  }
}

function isActionEligible(actionId, context) {
  if (actionId === ACTION_IDS.SKIP) {
    return true;
  }
  if (actionId === ACTION_IDS.CHATFIGHT) {
    if (!context.config.autoFightEnabled) {
      return false;
    }
    if (context.chatFight.isFightOpen()) {
      return false;
    }
    try {
      const { isTriviaBusy, isMangoBombBusy } = require("./communityGameState");
      if (isTriviaBusy()) {
        return false;
      }
      if (isMangoBombBusy()) {
        return false;
      }
    } catch (_err) {
      /* ignore */
    }
    if (context.chatFight.isOnCooldown()) {
      return false;
    }
    const last = context.autoState.lastStartedAt;
    if (
      last != null &&
      context.config.autoFightMinGapMs > 0 &&
      context.nowMs - last < context.config.autoFightMinGapMs
    ) {
      return false;
    }
    return true;
  }
  if (actionId === ACTION_IDS.TRIVIA) {
    if (context.chatFight && context.chatFight.isFightOpen()) {
      return false;
    }
    try {
      const { isTriviaBusy, isMangoBombBusy } = require("./communityGameState");
      if (isTriviaBusy()) {
        return false;
      }
      if (isMangoBombBusy()) {
        return false;
      }
    } catch (_err) {
      /* ignore */
    }
    return true;
  }
  if (actionId === ACTION_IDS.QUESTION) {
    const gapMs =
      context.config && typeof context.config.questionMinGapMs === "number"
        ? context.config.questionMinGapMs
        : DEFAULT_QUESTION_MIN_GAP_MINUTES * 60_000;
    const last =
      context.questionState &&
      typeof context.questionState.lastStartedAt === "number"
        ? context.questionState.lastStartedAt
        : null;
    if (last != null && gapMs > 0 && context.nowMs - last < gapMs) {
      return false;
    }
    return true;
  }
  return true;
}

function avoidCategoryRepeat(actionId, recentTypes) {
  if (!recentTypes || recentTypes.length < 2) {
    return false;
  }
  const lastTwo = recentTypes.slice(-2);
  return lastTwo[0] === actionId && lastTwo[1] === actionId;
}

function chooseAction(config, context, random) {
  const weights = buildWeights(config, context);
  const tried = new Set();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const pick = pickWeightedAction(weights, random);
    tried.add(pick);
    if (!isActionEligible(pick, context)) {
      weights[pick] = 0;
      continue;
    }
    if (avoidCategoryRepeat(pick, context.recentActivityTypes)) {
      weights[pick] = Math.max(0, weights[pick] - 8);
      continue;
    }
    return pick;
  }
  // Fallback scan
  for (const id of Object.keys(ACTION_WEIGHTS)) {
    if (!tried.has(id) && isActionEligible(id, context)) {
      return id;
    }
  }
  return ACTION_IDS.SKIP;
}

function pickPoolMessage(actionId, avoidKey, random) {
  const pool = MESSAGE_POOLS[actionId];
  if (!pool || !pool.length) {
    return null;
  }
  let index = Math.floor(random() * pool.length);
  let text = pool[index];
  if (avoidKey && pool.length > 1 && text.slice(0, 80) === avoidKey) {
    index = (index + 1) % pool.length;
    text = pool[index];
  }
  return text;
}

function wasSlotProcessed(state, dayKey, slotId) {
  const list = state.sent && state.sent[dayKey];
  return Array.isArray(list) && list.includes(slotId);
}

function markSlotProcessed(state, dayKey, slotId) {
  if (!state.sent[dayKey]) {
    state.sent[dayKey] = [];
  }
  if (!state.sent[dayKey].includes(slotId)) {
    state.sent[dayKey].push(slotId);
  }
}

/**
 * Process one activity slot — at most one Telegram action.
 */
async function processCommunityActivitySlot({
  chatId,
  slot,
  dayKey,
  config,
  state,
  chatFight = chatFightRuntime,
  triviaRuntime = null,
  sendMessage,
  announceChatFight,
  announceTrivia,
  nowMs = Date.now(),
  random = Math.random,
  wasActiveWithinFn = wasActiveWithin,
  forceAction = null,
} = {}) {
  if (!config || !config.enabled) {
    if (slot && slot.label) {
      log(`[activity-engine] skipped slot=${slot.label} reason=disabled`);
    }
    return { action: ACTION_IDS.SKIP, sent: false, reason: "disabled" };
  }
  if (!chatId) {
    if (slot && slot.label) {
      log(`[activity-engine] skipped slot=${slot.label} reason=missing-chat-id`);
    }
    return { action: ACTION_IDS.SKIP, sent: false, reason: "missing-chat-id" };
  }
  if (!slot || wasSlotProcessed(state, dayKey, slot.id)) {
    if (slot && slot.label) {
      log(
        `[activity-engine] skipped slot=${slot.label} reason=already-processed`
      );
    }
    return { action: ACTION_IDS.SKIP, sent: false, reason: "already-processed" };
  }

  if (!state.autoChatFight) {
    state.autoChatFight = emptyAutoChatFightState();
  } else {
    state.autoChatFight = normalizeAutoChatFightState(state.autoChatFight);
  }
  if (!state.communityQuestion) {
    state.communityQuestion = emptyCommunityQuestionState();
  } else {
    state.communityQuestion = normalizeCommunityQuestionState(
      state.communityQuestion
    );
  }
  if (!Array.isArray(state.recentActivityTypes)) {
    state.recentActivityTypes = [];
  }

  let trivia = triviaRuntime;
  if (!trivia) {
    try {
      trivia = require("./trivia").getTriviaRuntime();
    } catch (_err) {
      trivia = null;
    }
  }

  const context = {
    config,
    chatFight,
    autoState: state.autoChatFight,
    questionState: state.communityQuestion,
    nowMs,
    recentActivity: true,
    wasActiveWithin: wasActiveWithinFn,
    lastActivityAt: getLastCommunityActivityAtMs(),
    recentActivityTypes: state.recentActivityTypes,
  };

  let action =
    typeof forceAction === "string" && forceAction
      ? forceAction
      : chooseAction(config, context, random);
  let fallbackFrom = null;

  // Always mark processed to prevent restart spam / catch-up.
  markSlotProcessed(state, dayKey, slot.id);
  state.lastProcessedActivitySlot = `${dayKey} ${slot.label}`;
  state.lastProcessedActivityAt = nowMs;

  function safeSendErrorTag(err) {
    const name =
      err && typeof err.name === "string" && err.name.trim()
        ? err.name.trim()
        : "Error";
    const codeRaw =
      err && err.code != null
        ? err.code
        : err && err.error_code != null
          ? err.error_code
          : null;
    if (codeRaw === undefined || codeRaw === null || codeRaw === "") {
      return name;
    }
    const code = String(codeRaw).replace(/[^\w.-]/g, "").slice(0, 32);
    return code ? `${name}/${code}` : name;
  }

  async function sendPrompt(actionId) {
    const text = pickPoolMessage(actionId, state.lastMessageKey, random);
    if (!text) {
      return { action: actionId, sent: false, reason: "empty-pool" };
    }
    if (typeof sendMessage !== "function") {
      return { action: actionId, sent: false, reason: "missing-sender" };
    }
    try {
      const ok = await sendMessage(chatId, text);
      if (!ok) {
        return { action: actionId, sent: false, reason: "send-failed" };
      }
    } catch (err) {
      logError(
        `[activity-engine] send failed action=${actionId} error=${safeSendErrorTag(err)}`
      );
      return { action: actionId, sent: false, reason: "send-failed" };
    }
    state.lastMessageKey = text.slice(0, 80);
    state.lastActivityType = actionId;
    state.recentActivityTypes = [
      ...state.recentActivityTypes.slice(-4),
      actionId,
    ];
    return { action: actionId, sent: true, reason: "sent" };
  }

  function pickPromptFallback() {
    const promptIds = [
      ACTION_IDS.SNAKE,
      ACTION_IDS.BOUNCH,
      ACTION_IDS.WEEKLY,
      ACTION_IDS.LEADERBOARD,
      ACTION_IDS.GAME,
      ACTION_IDS.COMMUNITY,
    ];
    return promptIds[Math.floor(random() * promptIds.length)];
  }

  async function tryChatFight() {
    if (!isActionEligible(ACTION_IDS.CHATFIGHT, context)) {
      if (chatFight.isFightOpen()) return { ok: false, reason: "active-fight" };
      if (chatFight.isOnCooldown()) return { ok: false, reason: "cooldown" };
      return { ok: false, reason: "min-gap" };
    }
    if (typeof announceChatFight !== "function") {
      return { ok: false, reason: "missing-announcer" };
    }
    const started = chatFight.startFight({
      chatId,
      type: null,
      types: config.fightTypes,
      avoidType: state.autoChatFight.lastType,
      source: "auto",
    });
    if (!started.ok) {
      return { ok: false, reason: started.reason || "start-failed" };
    }
    try {
      const sentMsg = await announceChatFight(
        chatId,
        started.teaser,
        started.revealKeyboard || getRevealKeyboard()
      );
      const messageId =
        sentMsg &&
        (sentMsg.message_id != null ? sentMsg.message_id : sentMsg.messageId);
      if (messageId != null) {
        chatFight.setFightMessageId(messageId);
      }
    } catch (_err) {
      logError("[activity-engine] chatfight announce failed");
      chatFight.abortUnpublishedFight();
      return { ok: false, reason: "send-failed" };
    }
    state.autoChatFight.lastStartedAt = nowMs;
    state.autoChatFight.lastType = started.fight && started.fight.type;
    state.lastActivityType = ACTION_IDS.CHATFIGHT;
    state.lastMessageKey = String(started.teaser || "").slice(0, 80);
    state.recentActivityTypes = [
      ...state.recentActivityTypes.slice(-4),
      ACTION_IDS.CHATFIGHT,
    ];
    return { ok: true, reason: "started" };
  }

  async function tryTrivia() {
    if (!isActionEligible(ACTION_IDS.TRIVIA, context)) {
      return { ok: false, reason: "busy" };
    }
    if (!trivia || typeof trivia.startTrivia !== "function") {
      return { ok: false, reason: "missing-runtime" };
    }
    if (typeof announceTrivia !== "function" && typeof sendMessage !== "function") {
      return { ok: false, reason: "missing-announcer" };
    }
    const started = trivia.startTrivia({
      chatId,
      source: "auto",
      autoIntro: true,
      category: "random",
      hubMode: false,
    });
    if (!started.ok) {
      return { ok: false, reason: started.reason || "start-failed" };
    }
    try {
      const { applyGamesTopicToExtra } = require("../utils/gameTopic");
      let sentMsg;
      if (typeof announceTrivia === "function") {
        sentMsg = await announceTrivia(
          chatId,
          started.text,
          started.keyboard || undefined
        );
      } else {
        const extra = applyGamesTopicToExtra(
          started.keyboard && typeof started.keyboard === "object"
            ? { ...started.keyboard }
            : {}
        );
        sentMsg = await sendMessage(
          chatId,
          started.text,
          Object.keys(extra).length ? extra : undefined
        );
      }
      const messageId =
        sentMsg &&
        (sentMsg.message_id != null ? sentMsg.message_id : sentMsg.messageId);
      if (messageId != null && typeof trivia.setMessageId === "function") {
        trivia.setMessageId(started.session.id, messageId);
      }
    } catch (_err) {
      logError("[activity-engine] trivia announce failed");
      if (typeof trivia.abortRound === "function") {
        trivia.abortRound("send-failed");
      } else if (typeof trivia.reset === "function") {
        trivia.reset();
      }
      return { ok: false, reason: "send-failed" };
    }
    state.lastActivityType = ACTION_IDS.TRIVIA;
    state.lastMessageKey = String(started.text || "").slice(0, 80);
    state.recentActivityTypes = [
      ...state.recentActivityTypes.slice(-4),
      ACTION_IDS.TRIVIA,
    ];
    return { ok: true, reason: "started" };
  }

  async function tryQuestion() {
    if (!isActionEligible(ACTION_IDS.QUESTION, context)) {
      return { ok: false, reason: "cooldown" };
    }
    if (typeof sendMessage !== "function") {
      return { ok: false, reason: "missing-sender" };
    }
    state.communityQuestion = normalizeCommunityQuestionState(
      state.communityQuestion
    );
    let picked;
    try {
      picked = pickCommunityQuestion(
        COMMUNITY_QUESTIONS,
        state.communityQuestion.recentQuestionIds,
        random,
        ANTI_REPEAT_WINDOW
      );
    } catch (_err) {
      return { ok: false, reason: "empty-pool" };
    }
    const text = formatCommunityQuestionMessage(picked.question);
    try {
      // Always General / root chat — never attach Games topic thread.
      const ok = await sendMessage(chatId, text);
      if (!ok) {
        return { ok: false, reason: "send-failed" };
      }
    } catch (err) {
      logError(
        `[activity-engine] send failed action=${ACTION_IDS.QUESTION} error=${safeSendErrorTag(err)}`
      );
      return { ok: false, reason: "send-failed" };
    }
    state.communityQuestion.lastStartedAt = nowMs;
    state.communityQuestion.recentQuestionIds = picked.recentIds;
    state.lastMessageKey = text.slice(0, 80);
    state.lastActivityType = ACTION_IDS.QUESTION;
    state.recentActivityTypes = [
      ...state.recentActivityTypes.slice(-4),
      ACTION_IDS.QUESTION,
    ];
    return { ok: true, reason: "sent", questionId: picked.question.id };
  }

  if (action === ACTION_IDS.SKIP) {
    state.lastActivityType = ACTION_IDS.SKIP;
    log(`[activity-engine] skipped slot=${slot.label} reason=skip`);
    return { action: ACTION_IDS.SKIP, sent: false, reason: "skip" };
  }

  if (action === ACTION_IDS.CHATFIGHT) {
    const fightResult = await tryChatFight();
    if (fightResult.ok) {
      log(
        `[activity-engine] action=chatfight slot=${slot.label} type=${state.autoChatFight.lastType}`
      );
      return { action: ACTION_IDS.CHATFIGHT, sent: true, reason: "started" };
    }
    fallbackFrom = `chatfight-${fightResult.reason}`;
    const weights = buildWeights(config, context);
    weights[ACTION_IDS.CHATFIGHT] = 0;
    action = pickWeightedAction(weights, random);
    if (
      action === ACTION_IDS.CHATFIGHT ||
      action === ACTION_IDS.SKIP ||
      !isActionEligible(action, context)
    ) {
      action = pickPromptFallback();
    }
  }

  if (action === ACTION_IDS.TRIVIA) {
    const triviaResult = await tryTrivia();
    if (triviaResult.ok) {
      if (fallbackFrom) {
        log(
          `[activity-engine] action=trivia slot=${slot.label} fallback=${fallbackFrom}`
        );
        return {
          action: ACTION_IDS.TRIVIA,
          sent: true,
          reason: "started",
          fallback: fallbackFrom,
        };
      }
      log(`[activity-engine] action=trivia slot=${slot.label}`);
      return { action: ACTION_IDS.TRIVIA, sent: true, reason: "started" };
    }
    fallbackFrom = fallbackFrom || `trivia-${triviaResult.reason}`;
    const weights = buildWeights(config, context);
    weights[ACTION_IDS.TRIVIA] = 0;
    weights[ACTION_IDS.CHATFIGHT] = 0;
    action = pickWeightedAction(weights, random);
    if (
      action === ACTION_IDS.TRIVIA ||
      action === ACTION_IDS.CHATFIGHT ||
      action === ACTION_IDS.SKIP ||
      !isActionEligible(action, context)
    ) {
      action = pickPromptFallback();
    }
  }

  if (action === ACTION_IDS.QUESTION) {
    const questionResult = await tryQuestion();
    if (questionResult.ok) {
      if (fallbackFrom) {
        log(
          `[activity-engine] action=question slot=${slot.label} fallback=${fallbackFrom}`
        );
        return {
          action: ACTION_IDS.QUESTION,
          sent: true,
          reason: "sent",
          fallback: fallbackFrom,
        };
      }
      log(`[activity-engine] action=question slot=${slot.label}`);
      return { action: ACTION_IDS.QUESTION, sent: true, reason: "sent" };
    }
    fallbackFrom = fallbackFrom || `question-${questionResult.reason}`;
    const weights = buildWeights(config, context);
    weights[ACTION_IDS.QUESTION] = 0;
    weights[ACTION_IDS.CHATFIGHT] = 0;
    weights[ACTION_IDS.TRIVIA] = 0;
    action = pickWeightedAction(weights, random);
    if (
      action === ACTION_IDS.QUESTION ||
      action === ACTION_IDS.TRIVIA ||
      action === ACTION_IDS.CHATFIGHT ||
      action === ACTION_IDS.SKIP ||
      !isActionEligible(action, context)
    ) {
      action = pickPromptFallback();
    }
  }

  const promptResult = await sendPrompt(action);
  if (promptResult.sent) {
    if (fallbackFrom) {
      log(
        `[activity-engine] action=${action} slot=${slot.label} fallback=${fallbackFrom}`
      );
      return { ...promptResult, fallback: fallbackFrom };
    }
    log(`[activity-engine] action=${action} slot=${slot.label}`);
    return promptResult;
  }
  log(
    `[activity-engine] skipped slot=${slot.label} reason=${promptResult.reason}`
  );
  return promptResult;
}

function nextActivitySlotLabel(config, nowClock) {
  if (!config || !config.slots || !nowClock) {
    return null;
  }
  for (const slot of config.slots) {
    const target = slot.hour * 60 + slot.minute;
    if (nowClock.totalMinutes < target) {
      return slot.label;
    }
  }
  return null;
}

module.exports = {
  ACTION_IDS,
  ACTION_WEIGHTS,
  ACTION_REGISTRY,
  MESSAGE_POOLS,
  INTERACTIVE_ACTIONS,
  PASSIVE_ACTIONS,
  DEFAULT_ACTIVITY_INTERVAL_MINUTES,
  DEFAULT_AUTO_FIGHT_MIN_GAP_MINUTES,
  QUIET_GROUP_MS,
  DEFAULT_QUESTION_MIN_GAP_MINUTES,
  parseActivityEngineConfig,
  buildActivitySlots,
  pickWeightedAction,
  buildWeights,
  chooseAction,
  isActionEligible,
  processCommunityActivitySlot,
  nextActivitySlotLabel,
  // re-export for tests / avoid unused import lint
  emptyCommunityQuestionState,
  normalizeCommunityQuestionState,
  tryStartAutoChatFight,
};
