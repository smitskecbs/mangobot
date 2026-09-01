/**
 * Daily Quest — UTC daily activities that award ManGo Loot.
 * Progress is tracked from existing events. Loot is decided at event time.
 * No retroactive awards after a later wallet link.
 *
 * Each UTC day selects exactly 3 quests (1 social + 1 game + 1 progression)
 * for every user. Selection is a pure function of the UTC date.
 */

const { getLinkedWalletForUser } = require("./walletLinks");
const {
  mutateShopStore,
  loadShopStore,
  ensureUser,
  emptyDailyQuest,
} = require("./mangoShopStore");
const { applyLootAwardToStore, getLootAccount } = require("./mangoLoot");
const { error: logError } = require("../utils/logger");
const {
  QUEST_IDS,
  CATEGORY,
  QUEST_DEFS,
  LEGACY_SELECTION,
  getQuestDef,
  questTarget,
  selectQuestsForDate,
  isValidSelection,
  findUtcDateForSelection,
  formatUtcDateLabel,
} = require("./dailyQuestPool");

const ACTIVITY_LOOT = 5;
const FULL_COMPLETION_LOOT = 10;
const XP_TARGET = 3;
const BASE_DAILY_MAX = 25;
const DAY_KEEP = 45;
const DEDUPE_KEEP = 16;

const ACTIVITY = Object.freeze({
  COMMUNITY: "community",
  GAME: "game",
  XP: "xp",
});

const STREAK_MILESTONES = Object.freeze([
  { days: 3, loot: 10 },
  { days: 7, loot: 25 },
  { days: 14, loot: 50 },
  { days: 30, loot: 100 },
]);

const GAME_SOURCES = Object.freeze([
  "trivia",
  "tictactoe",
  "connect4",
  "checkers",
  "chatfight",
  "mangobomb",
  "pvp",
  "blackjack",
]);

const DEDUPE_BUCKETS = Object.freeze(["replies", "media", "messages"]);

let questMessenger = null;

function setDailyQuestMessenger(fn) {
  questMessenger = typeof fn === "function" ? fn : null;
}

function utcDate(now) {
  const d = Number.isFinite(now) ? new Date(now) : new Date();
  return d.toISOString().slice(0, 10);
}

function utcYesterday(today) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(today || ""));
  if (!match) {
    return utcDate();
  }
  const d = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  );
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function normalizeUserId(userId) {
  if (userId == null || userId === "") {
    return null;
  }
  const id = String(userId).trim();
  return id || null;
}

function lootUnlocked(userId, walletFile) {
  return Boolean(getLinkedWalletForUser(userId, walletFile));
}

function emptyQuestSlot(questId) {
  const target = questTarget(questId);
  return {
    progress: 0,
    target,
    completed: false,
    completedAt: 0,
    lootAwarded: false,
    lootSkipped: false,
  };
}

function emptyDedupe() {
  return { replies: [], media: [], messages: [] };
}

function emptyBinarySlot() {
  return {
    completed: false,
    completedAt: 0,
    lootAwarded: false,
    lootSkipped: false,
  };
}

function blankDay(date) {
  const selected = date ? selectQuestsForDate(date) : [...LEGACY_SELECTION];
  const quests = {};
  for (const id of selected) {
    quests[id] = emptyQuestSlot(id);
  }
  return {
    community: emptyBinarySlot(),
    game: emptyBinarySlot(),
    xp: {
      progress: 0,
      target: XP_TARGET,
      completed: false,
      completedAt: 0,
      lootAwarded: false,
      lootSkipped: false,
    },
    selected: [...selected],
    quests,
    dedupe: emptyDedupe(),
    fullCompletionAt: 0,
    fullLootAwarded: false,
    fullLootSkipped: false,
    lootAwardedToday: 0,
  };
}

function hasLegacyProgress(day) {
  if (!day) {
    return false;
  }
  return Boolean(
    (day.community && day.community.completed) ||
      (day.game && day.game.completed) ||
      (day.xp && (day.xp.completed || (day.xp.progress || 0) > 0))
  );
}

function overlayLegacySlot(slot, legacy, target) {
  if (!slot || !legacy) {
    return;
  }
  if (legacy.completed) {
    slot.completed = true;
    slot.progress = target;
    slot.completedAt = Number(legacy.completedAt) || slot.completedAt;
    slot.lootAwarded = Boolean(legacy.lootAwarded);
    slot.lootSkipped = Boolean(legacy.lootSkipped);
  } else if (Number(legacy.progress) > 0) {
    slot.progress = Math.min(target, Number(legacy.progress));
    if (slot.progress >= target) {
      slot.completed = true;
    }
  }
}

function ensureQuestSlots(day) {
  if (!day.quests || typeof day.quests !== "object") {
    day.quests = {};
  }
  if (!day.dedupe || typeof day.dedupe !== "object") {
    day.dedupe = emptyDedupe();
  }
  for (const bucket of DEDUPE_BUCKETS) {
    if (!Array.isArray(day.dedupe[bucket])) {
      day.dedupe[bucket] = [];
    }
  }
  for (const id of day.selected || []) {
    if (!day.quests[id]) {
      day.quests[id] = emptyQuestSlot(id);
    } else {
      day.quests[id].target = questTarget(id);
    }
  }
}

function hydrateDay(day, date) {
  if (!day.selected || !isValidSelection(day.selected)) {
    const legacy = hasLegacyProgress(day);
    day.selected = legacy ? [...LEGACY_SELECTION] : selectQuestsForDate(date);
    ensureQuestSlots(day);
    if (legacy) {
      overlayLegacySlot(
        day.quests[QUEST_IDS.COMMUNITY_ACTIVITY],
        day.community,
        1
      );
      overlayLegacySlot(day.quests[QUEST_IDS.BOT_GAME_1], day.game, 1);
      overlayLegacySlot(day.quests[QUEST_IDS.EARN_XP_3], day.xp, XP_TARGET);
    }
  } else {
    ensureQuestSlots(day);
  }
  return day;
}

function pruneDays(days, today) {
  const keys = Object.keys(days).sort();
  if (keys.length <= DAY_KEEP) {
    return;
  }
  const drop = keys.length - DAY_KEEP;
  for (let i = 0; i < drop; i += 1) {
    if (keys[i] !== today) {
      delete days[keys[i]];
    }
  }
}

function ensureDay(user, date) {
  if (!user.dailyQuest) {
    user.dailyQuest = emptyDailyQuest();
  }
  if (!user.dailyQuest.days[date]) {
    user.dailyQuest.days[date] = blankDay(date);
  }
  return hydrateDay(user.dailyQuest.days[date], date);
}

function completedCount(day) {
  if (!day) {
    return 0;
  }
  if (Array.isArray(day.selected) && day.selected.length === 3 && day.quests) {
    let n = 0;
    for (const id of day.selected) {
      const slot = day.quests[id];
      if (slot && slot.completed) {
        n += 1;
      }
    }
    return n;
  }
  let n = 0;
  if (day.community && day.community.completed) n += 1;
  if (day.game && day.game.completed) n += 1;
  if (day.xp && day.xp.completed) n += 1;
  return n;
}

function syncLegacyAliases(day) {
  const community = day.quests && day.quests[QUEST_IDS.COMMUNITY_ACTIVITY];
  if (community) {
    day.community = {
      completed: Boolean(community.completed),
      completedAt: community.completedAt || 0,
      lootAwarded: Boolean(community.lootAwarded),
      lootSkipped: Boolean(community.lootSkipped),
    };
  }
  const game =
    (day.quests && day.quests[QUEST_IDS.BOT_GAME_1]) ||
    selectedQuestSlot(day, CATEGORY.GAME);
  if (game) {
    day.game = {
      completed: Boolean(game.completed),
      completedAt: game.completedAt || 0,
      lootAwarded: Boolean(game.lootAwarded),
      lootSkipped: Boolean(game.lootSkipped),
    };
  }
  const xp = day.quests && day.quests[QUEST_IDS.EARN_XP_3];
  if (xp) {
    day.xp = {
      progress: xp.progress || 0,
      target: xp.target || XP_TARGET,
      completed: Boolean(xp.completed),
      completedAt: xp.completedAt || 0,
      lootAwarded: Boolean(xp.lootAwarded),
      lootSkipped: Boolean(xp.lootSkipped),
    };
  }
}

function selectedQuestId(day, category) {
  if (!day || !Array.isArray(day.selected)) {
    return null;
  }
  for (const id of day.selected) {
    const def = getQuestDef(id);
    if (def && def.category === category) {
      return id;
    }
  }
  return null;
}

function selectedQuestSlot(day, category) {
  const id = selectedQuestId(day, category);
  return id && day.quests ? day.quests[id] : null;
}

function emitNotifications(list) {
  if (!questMessenger || !Array.isArray(list) || !list.length) {
    return;
  }
  for (const row of list) {
    if (!row || !row.userId || !row.text) {
      continue;
    }
    Promise.resolve(questMessenger(row.userId, row.text)).catch(() => {});
  }
}

function awardQuestLoot(store, userId, day, slot, questId, date, linked, now) {
  if (slot.lootAwarded || slot.lootSkipped) {
    return;
  }
  if (!linked) {
    slot.lootSkipped = true;
    return;
  }
  const referenceId = `daily:${date}:quest:${questId}:${userId}`;
  const result = applyLootAwardToStore(
    store,
    userId,
    ACTIVITY_LOOT,
    "daily-activity",
    referenceId,
    now
  );
  if (result && result.ok) {
    slot.lootAwarded = true;
    if (!result.duplicate) {
      day.lootAwardedToday += ACTIVITY_LOOT;
    }
  }
}

function maybeCompleteDay(store, user, userId, day, date, linked, now, notifications) {
  if (completedCount(day) < 3 || day.fullCompletionAt) {
    return;
  }
  day.fullCompletionAt = now;
  if (linked && !day.fullLootAwarded && !day.fullLootSkipped) {
    const result = applyLootAwardToStore(
      store,
      userId,
      FULL_COMPLETION_LOOT,
      "daily-activity",
      `daily:${date}:full-completion:${userId}`,
      now
    );
    if (result && result.ok) {
      day.fullLootAwarded = true;
      if (!result.duplicate) {
        day.lootAwardedToday += FULL_COMPLETION_LOOT;
      }
    }
  } else if (!linked) {
    day.fullLootSkipped = true;
  }

  const streak = user.dailyQuest.streak;
  const yesterday = utcYesterday(date);
  if (streak.lastCompletedDate !== date) {
    if (streak.lastCompletedDate === yesterday) {
      streak.current += 1;
    } else {
      streak.current = 1;
      streak.cycleId = `c:${date}`;
    }
    if (streak.current > streak.longest) {
      streak.longest = streak.current;
    }
    streak.lastCompletedDate = date;
  }
  if (!streak.cycleId) {
    streak.cycleId = `c:${date}`;
  }
  if (!streak.milestones[streak.cycleId]) {
    streak.milestones[streak.cycleId] = {};
  }

  notifications.push({
    userId,
    text: [
      "🎉 Daily Quest complete!",
      "",
      day.fullLootAwarded
        ? `+${FULL_COMPLETION_LOOT} bonus ManGo Loot`
        : "Full day complete.",
      "",
      `🔥 Streak: ${streak.current} days`,
    ].join("\n"),
  });

  for (const row of STREAK_MILESTONES) {
    if (streak.current !== row.days) {
      continue;
    }
    if (streak.milestones[streak.cycleId][String(row.days)]) {
      continue;
    }
    if (!linked) {
      streak.milestones[streak.cycleId][String(row.days)] = "skipped";
      continue;
    }
    const result = applyLootAwardToStore(
      store,
      userId,
      row.loot,
      "daily-streak",
      `streak:${streak.cycleId}:${row.days}:${userId}`,
      now
    );
    if (result && result.ok) {
      streak.milestones[streak.cycleId][String(row.days)] = "awarded";
      if (!result.duplicate) {
        day.lootAwardedToday += row.loot;
      }
      notifications.push({
        userId,
        text: [`🔥 ${row.days}-day streak!`, "", `+${row.loot} bonus ManGo Loot 🥭`].join(
          "\n"
        ),
      });
    }
  }
}

function rememberDedupe(day, bucket, key) {
  if (!bucket || !DEDUPE_BUCKETS.includes(bucket) || !key) {
    return false;
  }
  if (!day.dedupe[bucket]) {
    day.dedupe[bucket] = [];
  }
  if (day.dedupe[bucket].includes(key)) {
    return true;
  }
  day.dedupe[bucket].push(key);
  if (day.dedupe[bucket].length > DEDUPE_KEEP) {
    day.dedupe[bucket] = day.dedupe[bucket].slice(-DEDUPE_KEEP);
  }
  return false;
}

function progressResult(day, user, linked, extra = {}) {
  return Object.assign(
    {
      ok: true,
      lootUnlocked: linked,
      lootAwardedToday: day.lootAwardedToday,
      completedToday: completedCount(day),
      streak: user.dailyQuest.streak.current,
      selected: [...(day.selected || [])],
    },
    extra
  );
}

function noteQuestProgress(userId, questId, amount, options = {}) {
  const id = normalizeUserId(userId);
  const def = getQuestDef(questId);
  const qty = Number(amount);
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  if (!def) {
    return { ok: false, reason: "quest" };
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, reason: "amount" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const date = options.date || utcDate(now);
  const linked = lootUnlocked(id, options.walletFile);
  const notifications = [];
  let result;
  try {
    result = mutateShopStore((store) => {
      const user = ensureUser(store, id);
      const day = ensureDay(user, date);
      pruneDays(user.dailyQuest.days, date);
      if (!day.selected.includes(def.id)) {
        return progressResult(day, user, linked, {
          ignored: true,
          reason: "not-selected",
          questId: def.id,
        });
      }
      if (options.dedupeKey && rememberDedupe(day, options.dedupeBucket, options.dedupeKey)) {
        const slot = day.quests[def.id];
        return progressResult(day, user, linked, {
          duplicate: true,
          questId: def.id,
          progress: slot.progress,
          completed: slot.completed,
        });
      }
      const slot = day.quests[def.id];
      const already = Boolean(slot.completed);
      if (!already) {
        slot.progress = Math.min(slot.target, slot.progress + qty);
        if (slot.progress >= slot.target) {
          slot.completed = true;
          slot.completedAt = now;
          awardQuestLoot(store, id, day, slot, def.id, date, linked, now);
        }
      }
      syncLegacyAliases(day);
      maybeCompleteDay(store, user, id, day, date, linked, now, notifications);
      return progressResult(day, user, linked, {
        already,
        questId: def.id,
        progress: slot.progress,
        completed: slot.completed,
        lootAwarded: slot.lootAwarded,
        lootSkipped: slot.lootSkipped,
      });
    }, options.shopFile);
  } catch (err) {
    logError("[daily-quest] mutate failed:", err && err.message ? err.message : err);
    return { ok: false, reason: "store" };
  }
  emitNotifications(notifications);
  return result;
}

function fillDailyQuest(userId, questId, options = {}) {
  const def = getQuestDef(questId);
  if (!def) {
    return { ok: false, reason: "quest" };
  }
  return noteQuestProgress(userId, def.id, def.target, options);
}

function completeSelectedQuests(userId, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const date = options.date || utcDate(now);
  const selected = selectQuestsForDate(date);
  let last = { ok: false };
  for (const questId of selected) {
    last = fillDailyQuest(userId, questId, Object.assign({}, options, { now, date }));
  }
  return last;
}

function noteDailyQuestCommunity(userId, options = {}) {
  return noteQuestProgress(userId, QUEST_IDS.COMMUNITY_ACTIVITY, 1, options);
}

function noteDailyQuestGame(userId, game, options = {}) {
  const source = String(game || "").toLowerCase();
  if (!GAME_SOURCES.includes(source)) {
    return { ok: false, reason: "game" };
  }
  const bot = noteQuestProgress(userId, QUEST_IDS.BOT_GAME_1, 1, options);
  if (source === "trivia") {
    noteQuestProgress(userId, QUEST_IDS.TRIVIA_1, 1, options);
  }
  return bot;
}

function noteDailyQuestPvp(userId, options = {}) {
  return noteQuestProgress(userId, QUEST_IDS.PVP_GAME_1, 1, options);
}

function noteDailyQuestTrivia(userId, options = {}) {
  const trivia = noteQuestProgress(userId, QUEST_IDS.TRIVIA_1, 1, options);
  noteQuestProgress(userId, QUEST_IDS.BOT_GAME_1, 1, options);
  return trivia;
}

function noteDailyQuestXp(userId, amount, options = {}) {
  return noteQuestProgress(userId, QUEST_IDS.EARN_XP_3, amount, options);
}

function noteDailyQuestGreeting(userId, options = {}) {
  return noteQuestProgress(userId, QUEST_IDS.GREETING, 1, options);
}

function noteDailyQuestReply(userId, options = {}) {
  return noteQuestProgress(userId, QUEST_IDS.REPLIES_5, 1, options);
}

function noteDailyQuestMedia(userId, options = {}) {
  return noteQuestProgress(userId, QUEST_IDS.MEDIA_2, 1, options);
}

function noteDailyQuestMessage(userId, options = {}) {
  return noteQuestProgress(userId, QUEST_IDS.MESSAGES_5, 1, options);
}

function afterXpAward(userId, result, extras = {}) {
  try {
    const game = String((extras && extras.game) || "").toLowerCase();
    if (GAME_SOURCES.includes(game)) {
      noteDailyQuestGame(userId, game, extras);
    }
    if (result && result.awarded && Number(result.pointsToAdd) > 0) {
      noteDailyQuestXp(userId, result.pointsToAdd, extras);
    }
  } catch (err) {
    logError("[daily-quest] afterXpAward failed:", err && err.message ? err.message : err);
  }
}

function binaryFromSlot(slot) {
  if (!slot) {
    return emptyBinarySlot();
  }
  return {
    completed: Boolean(slot.completed),
    completedAt: slot.completedAt || 0,
    lootAwarded: Boolean(slot.lootAwarded),
    lootSkipped: Boolean(slot.lootSkipped),
  };
}

function buildQuestList(day) {
  const list = [];
  for (const id of day.selected || []) {
    const def = getQuestDef(id);
    const slot = (day.quests && day.quests[id]) || emptyQuestSlot(id);
    if (!def) {
      continue;
    }
    list.push({
      id: def.id,
      category: def.category,
      emoji: def.emoji,
      title: def.title,
      hint: def.hint,
      progressHint: def.progressHint,
      extraLines: def.extraLines ? [...def.extraLines] : [],
      progress: slot.progress || 0,
      target: slot.target || def.target,
      completed: Boolean(slot.completed),
      completedAt: slot.completedAt || 0,
      lootAwarded: Boolean(slot.lootAwarded),
      lootSkipped: Boolean(slot.lootSkipped),
    });
  }
  return list;
}

function snapshotFromDay(day, date, extras) {
  const questList = buildQuestList(day);
  const communitySlot = day.quests && day.quests[QUEST_IDS.COMMUNITY_ACTIVITY];
  const xpSlot = day.quests && day.quests[QUEST_IDS.EARN_XP_3];
  const gameSlot = selectedQuestSlot(day, CATEGORY.GAME);
  const xp = xpSlot || {
    progress: 0,
    target: XP_TARGET,
    completed: false,
    completedAt: 0,
    lootAwarded: false,
    lootSkipped: false,
  };
  return Object.assign(
    {
      date,
      dateLabel: formatUtcDateLabel(date),
      selected: [...(day.selected || [])],
      questList,
      community: binaryFromSlot(communitySlot),
      game: binaryFromSlot(gameSlot),
      xp: {
        progress: xp.progress || 0,
        target: xp.target || XP_TARGET,
        completed: Boolean(xp.completed),
        completedAt: xp.completedAt || 0,
        lootAwarded: Boolean(xp.lootAwarded),
        lootSkipped: Boolean(xp.lootSkipped),
      },
      completedToday: completedCount(day),
      totalActivities: 3,
      fullComplete: Boolean(day.fullCompletionAt),
      lootAwardedToday: day.lootAwardedToday || 0,
    },
    extras
  );
}

function getDailyQuestSnapshot(userId, options = {}) {
  const id = normalizeUserId(userId);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const date = options.date || utcDate(now);
  const empty = blankDay(date);
  if (!id) {
    return snapshotFromDay(empty, date, {
      lootUnlocked: false,
      loot: 0,
      streak: 0,
      longestStreak: 0,
      cycleId: null,
      lastCompletedDate: null,
    });
  }
  const store = loadShopStore(options.shopFile);
  const user = store.users[id];
  const quest = user && user.dailyQuest ? user.dailyQuest : emptyDailyQuest();
  const raw = quest.days[date];
  const today = raw ? hydrateDay(raw, date) : empty;
  return snapshotFromDay(today, date, {
    lootUnlocked: lootUnlocked(id, options.walletFile),
    loot: getLootAccount(id, options.shopFile).balance,
    streak: quest.streak.current || 0,
    longestStreak: quest.streak.longest || 0,
    cycleId: quest.streak.cycleId,
    lastCompletedDate: quest.streak.lastCompletedDate,
  });
}

function formatDailyQuestProgressLine(userId, options = {}) {
  try {
    const snap = getDailyQuestSnapshot(userId, options);
    return [`🔥 Daily Streak: ${snap.streak}`, `🎯 Today: ${snap.completedToday}/3`].join(
      "\n"
    );
  } catch (_err) {
    return "";
  }
}

module.exports = {
  ACTIVITY,
  ACTIVITY_LOOT,
  FULL_COMPLETION_LOOT,
  XP_TARGET,
  BASE_DAILY_MAX,
  STREAK_MILESTONES,
  GAME_SOURCES,
  QUEST_IDS,
  CATEGORY,
  QUEST_DEFS,
  utcDate,
  utcYesterday,
  setDailyQuestMessenger,
  noteDailyQuestCommunity,
  noteDailyQuestGame,
  noteDailyQuestPvp,
  noteDailyQuestTrivia,
  noteDailyQuestXp,
  noteDailyQuestGreeting,
  noteDailyQuestReply,
  noteDailyQuestMedia,
  noteDailyQuestMessage,
  noteQuestProgress,
  fillDailyQuest,
  completeSelectedQuests,
  afterXpAward,
  getDailyQuestSnapshot,
  formatDailyQuestProgressLine,
  lootUnlocked,
  selectQuestsForDate,
  findUtcDateForSelection,
  formatUtcDateLabel,
};
