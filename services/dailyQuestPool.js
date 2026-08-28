/**
 * Daily Quest v1 pool and UTC-date selection.
 * Pure: no I/O. Restart-safe because selection is a function of the UTC date.
 */

const QUEST_IDS = Object.freeze({
  COMMUNITY_ACTIVITY: "community-activity",
  REPLIES_5: "replies-5",
  MEDIA_2: "media-2",
  MESSAGES_5: "messages-5",
  BOT_GAME_1: "bot-game-1",
  PVP_GAME_1: "pvp-game-1",
  TRIVIA_1: "trivia-1",
  EARN_XP_3: "earn-xp-3",
  GREETING: "greeting",
});

const CATEGORY = Object.freeze({
  SOCIAL: "social",
  GAME: "game",
  PROGRESSION: "progression",
});

const QUEST_DEFS = Object.freeze({
  [QUEST_IDS.COMMUNITY_ACTIVITY]: Object.freeze({
    id: QUEST_IDS.COMMUNITY_ACTIVITY,
    category: CATEGORY.SOCIAL,
    emoji: "💬",
    title: "Be Active",
    hint: "Complete 1 valid community activity.",
    progressHint: "Complete a community activity",
    target: 1,
  }),
  [QUEST_IDS.REPLIES_5]: Object.freeze({
    id: QUEST_IDS.REPLIES_5,
    category: CATEGORY.SOCIAL,
    emoji: "↩️",
    title: "Join the Conversation",
    hint: "Reply to 5 messages from other members.",
    progressHint: "Reply to 5 members",
    target: 5,
  }),
  [QUEST_IDS.MEDIA_2]: Object.freeze({
    id: QUEST_IDS.MEDIA_2,
    category: CATEGORY.SOCIAL,
    emoji: "📸",
    title: "Share Something",
    hint: "Send 2 photos, videos or GIFs.",
    progressHint: "Send 2 photos, videos or GIFs",
    target: 2,
  }),
  [QUEST_IDS.MESSAGES_5]: Object.freeze({
    id: QUEST_IDS.MESSAGES_5,
    category: CATEGORY.SOCIAL,
    emoji: "💬",
    title: "Get Talking",
    hint: "Send 5 valid community messages.",
    progressHint: "Send 5 community messages",
    target: 5,
  }),
  [QUEST_IDS.BOT_GAME_1]: Object.freeze({
    id: QUEST_IDS.BOT_GAME_1,
    category: CATEGORY.GAME,
    emoji: "🎮",
    title: "Play a Bot Game",
    hint: "Complete 1 eligible Telegram bot game.",
    progressHint: "Telegram bot games only.\nSnake and Bounch do not count.",
    extraLines: Object.freeze([
      "Telegram bot games only.",
      "Trivia, Tic-Tac-Toe, Connect Four, ChatFight or ManGo Bomb.",
      "Snake and Bounch do not count.",
    ]),
    target: 1,
  }),
  [QUEST_IDS.PVP_GAME_1]: Object.freeze({
    id: QUEST_IDS.PVP_GAME_1,
    category: CATEGORY.GAME,
    emoji: "⚔️",
    title: "Play PvP",
    hint: "Complete 1 human-vs-human PvP match.",
    progressHint: "Complete a PvP match",
    extraLines: Object.freeze([
      "Tic-Tac-Toe, Connect Four or Blackjack against another member.",
    ]),
    target: 1,
  }),
  [QUEST_IDS.TRIVIA_1]: Object.freeze({
    id: QUEST_IDS.TRIVIA_1,
    category: CATEGORY.GAME,
    emoji: "🧠",
    title: "Trivia Time",
    hint: "Submit 1 valid Trivia answer.",
    progressHint: "Submit a Trivia answer",
    extraLines: Object.freeze(["Correct or incorrect both count. Opening Trivia does not."]),
    target: 1,
  }),
  [QUEST_IDS.EARN_XP_3]: Object.freeze({
    id: QUEST_IDS.EARN_XP_3,
    category: CATEGORY.PROGRESSION,
    emoji: "⭐",
    title: "Earn XP",
    hint: "Earn at least 3 awarded XP today.",
    progressHint: "Earn 3 XP",
    target: 3,
  }),
  [QUEST_IDS.GREETING]: Object.freeze({
    id: QUEST_IDS.GREETING,
    category: CATEGORY.PROGRESSION,
    emoji: "🥭",
    title: "ManGo Greeting",
    hint: "Claim one valid GMango or GNango activity.",
    progressHint: "Claim GMango or GNango",
    extraLines: Object.freeze(["GM or GN without mango does not count."]),
    target: 1,
  }),
});

const SOCIAL_POOL = Object.freeze([
  QUEST_IDS.COMMUNITY_ACTIVITY,
  QUEST_IDS.REPLIES_5,
  QUEST_IDS.MEDIA_2,
  QUEST_IDS.MESSAGES_5,
]);

const GAME_POOL = Object.freeze([
  QUEST_IDS.BOT_GAME_1,
  QUEST_IDS.PVP_GAME_1,
  QUEST_IDS.TRIVIA_1,
]);

const PROGRESSION_POOL = Object.freeze([
  QUEST_IDS.EARN_XP_3,
  QUEST_IDS.GREETING,
]);

const LEGACY_SELECTION = Object.freeze([
  QUEST_IDS.COMMUNITY_ACTIVITY,
  QUEST_IDS.BOT_GAME_1,
  QUEST_IDS.EARN_XP_3,
]);

const ALL_QUEST_IDS = Object.freeze(Object.keys(QUEST_DEFS));

function isQuestId(value) {
  return Boolean(value && QUEST_DEFS[String(value)]);
}

function getQuestDef(questId) {
  return QUEST_DEFS[String(questId)] || null;
}

function questTarget(questId) {
  const def = getQuestDef(questId);
  return def ? def.target : 1;
}

/**
 * Stable FNV-1a of a string. Not cryptographic; date + salt only.
 * @param {string} str
 * @returns {number}
 */
function fnv1a(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickFrom(pool, date, salt) {
  const list = Array.isArray(pool) && pool.length ? pool : [];
  if (!list.length) {
    return null;
  }
  return list[fnv1a(`${date}|${salt}`) % list.length];
}

/**
 * Exact 3 unique quests for a UTC date: 1 social + 1 game + 1 progression.
 * @param {string} date YYYY-MM-DD
 * @returns {string[]}
 */
function selectQuestsForDate(date) {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : "";
  if (!key) {
    return [...LEGACY_SELECTION];
  }
  return [
    pickFrom(SOCIAL_POOL, key, "social"),
    pickFrom(GAME_POOL, key, "game"),
    pickFrom(PROGRESSION_POOL, key, "progression"),
  ];
}

function isValidSelection(selected) {
  if (!Array.isArray(selected) || selected.length !== 3) {
    return false;
  }
  const unique = new Set(selected);
  if (unique.size !== 3) {
    return false;
  }
  const defs = selected.map((id) => getQuestDef(id));
  if (defs.some((d) => !d)) {
    return false;
  }
  return (
    defs[0].category === CATEGORY.SOCIAL &&
    defs[1].category === CATEGORY.GAME &&
    defs[2].category === CATEGORY.PROGRESSION
  );
}

/**
 * Find a UTC day whose selection matches optional id constraints.
 * @param {{ social?: string, game?: string, progression?: string }} wanted
 * @param {number} [startMs]
 * @returns {{ now: number, date: string, selected: string[] }}
 */
function findUtcDateForSelection(wanted = {}, startMs = Date.UTC(2026, 7, 1, 12, 0, 0)) {
  const start = Number.isFinite(startMs) ? startMs : Date.UTC(2026, 7, 1, 12, 0, 0);
  for (let i = 0; i < 180; i += 1) {
    const now = start + i * 24 * 60 * 60 * 1000;
    const date = new Date(now).toISOString().slice(0, 10);
    const selected = selectQuestsForDate(date);
    if (wanted.social && selected[0] !== wanted.social) {
      continue;
    }
    if (wanted.game && selected[1] !== wanted.game) {
      continue;
    }
    if (wanted.progression && selected[2] !== wanted.progression) {
      continue;
    }
    return { now, date, selected };
  }
  throw new Error("no UTC date matches Daily Quest selection constraints");
}

function formatUtcDateLabel(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) {
    return String(date || "");
  }
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const month = months[Number(match[2]) - 1] || match[2];
  const day = String(Number(match[3]));
  return `${month} ${day} · UTC`;
}

module.exports = {
  QUEST_IDS,
  CATEGORY,
  QUEST_DEFS,
  SOCIAL_POOL,
  GAME_POOL,
  PROGRESSION_POOL,
  LEGACY_SELECTION,
  ALL_QUEST_IDS,
  isQuestId,
  getQuestDef,
  questTarget,
  selectQuestsForDate,
  isValidSelection,
  findUtcDateForSelection,
  formatUtcDateLabel,
  fnv1a,
};
