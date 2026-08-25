/**
 * Daily Quest — UTC daily activities that award ManGo Loot.
 * Progress is tracked from existing events. Loot is decided at event time.
 * No retroactive awards after a later wallet link.
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

const ACTIVITY_LOOT = 5;
const FULL_COMPLETION_LOOT = 10;
const XP_TARGET = 3;
const BASE_DAILY_MAX = 25;
const DAY_KEEP = 45;

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
  "snake",
  "bounch",
  "trivia",
  "tictactoe",
  "connect4",
  "chatfight",
  "mangobomb",
  "pvp",
]);

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

function blankDay() {
  return {
    community: {
      completed: false,
      completedAt: 0,
      lootAwarded: false,
      lootSkipped: false,
    },
    game: {
      completed: false,
      completedAt: 0,
      lootAwarded: false,
      lootSkipped: false,
    },
    xp: {
      progress: 0,
      target: XP_TARGET,
      completed: false,
      completedAt: 0,
      lootAwarded: false,
      lootSkipped: false,
    },
    fullCompletionAt: 0,
    fullLootAwarded: false,
    fullLootSkipped: false,
    lootAwardedToday: 0,
  };
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
    user.dailyQuest.days[date] = blankDay();
  }
  return user.dailyQuest.days[date];
}

function completedCount(day) {
  let n = 0;
  if (day.community.completed) n += 1;
  if (day.game.completed) n += 1;
  if (day.xp.completed) n += 1;
  return n;
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

function awardSlotLoot(store, userId, day, slot, activityKey, date, linked, now) {
  if (slot.lootAwarded || slot.lootSkipped) {
    return;
  }
  if (!linked) {
    slot.lootSkipped = true;
    return;
  }
  const refMap = {
    community: "community-message",
    game: "game",
    xp: "xp",
  };
  const referenceId = `daily:${date}:${refMap[activityKey]}:${userId}`;
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

function completeBinaryActivity(userId, activityKey, options = {}) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { ok: false, reason: "no-user" };
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
      const slot = day[activityKey];
      const already = Boolean(slot.completed);
      if (!already) {
        slot.completed = true;
        slot.completedAt = now;
        awardSlotLoot(store, id, day, slot, activityKey, date, linked, now);
      }
      maybeCompleteDay(store, user, id, day, date, linked, now, notifications);
      return {
        ok: true,
        already,
        completed: true,
        lootUnlocked: linked,
        lootAwardedToday: day.lootAwardedToday,
        completedToday: completedCount(day),
        streak: user.dailyQuest.streak.current,
      };
    }, options.shopFile);
  } catch (err) {
    logError("[daily-quest] mutate failed:", err && err.message ? err.message : err);
    return { ok: false, reason: "store" };
  }
  emitNotifications(notifications);
  return result;
}

function noteDailyQuestCommunity(userId, options = {}) {
  return completeBinaryActivity(userId, ACTIVITY.COMMUNITY, options);
}

function noteDailyQuestGame(userId, game, options = {}) {
  const source = String(game || "").toLowerCase();
  if (!GAME_SOURCES.includes(source)) {
    return { ok: false, reason: "game" };
  }
  return completeBinaryActivity(userId, ACTIVITY.GAME, options);
}

function noteDailyQuestXp(userId, amount, options = {}) {
  const id = normalizeUserId(userId);
  const qty = Number(amount);
  if (!id) {
    return { ok: false, reason: "no-user" };
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
      if (!day.xp.completed) {
        day.xp.progress = Math.min(XP_TARGET, day.xp.progress + qty);
        if (day.xp.progress >= XP_TARGET) {
          day.xp.completed = true;
          day.xp.completedAt = now;
          awardSlotLoot(store, id, day, day.xp, ACTIVITY.XP, date, linked, now);
        }
      }
      maybeCompleteDay(store, user, id, day, date, linked, now, notifications);
      return {
        ok: true,
        progress: day.xp.progress,
        completed: day.xp.completed,
        lootUnlocked: linked,
        lootAwardedToday: day.lootAwardedToday,
        completedToday: completedCount(day),
        streak: user.dailyQuest.streak.current,
      };
    }, options.shopFile);
  } catch (err) {
    logError("[daily-quest] xp mutate failed:", err && err.message ? err.message : err);
    return { ok: false, reason: "store" };
  }
  emitNotifications(notifications);
  return result;
}

function afterXpAward(userId, result, extras = {}) {
  try {
    if (extras && GAME_SOURCES.includes(String(extras.game || "").toLowerCase())) {
      noteDailyQuestGame(userId, extras.game, extras);
    }
    if (result && result.awarded && Number(result.pointsToAdd) > 0) {
      noteDailyQuestXp(userId, result.pointsToAdd, extras);
    }
  } catch (err) {
    logError("[daily-quest] afterXpAward failed:", err && err.message ? err.message : err);
  }
}

function getDailyQuestSnapshot(userId, options = {}) {
  const id = normalizeUserId(userId);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const date = options.date || utcDate(now);
  const empty = blankDay();
  if (!id) {
    return {
      date,
      lootUnlocked: false,
      loot: 0,
      community: empty.community,
      game: empty.game,
      xp: empty.xp,
      completedToday: 0,
      totalActivities: 3,
      fullComplete: false,
      lootAwardedToday: 0,
      streak: 0,
      longestStreak: 0,
      cycleId: null,
      lastCompletedDate: null,
    };
  }
  const store = loadShopStore(options.shopFile);
  const user = store.users[id];
  const quest = user && user.dailyQuest ? user.dailyQuest : emptyDailyQuest();
  const today = quest.days[date] || empty;
  return {
    date,
    lootUnlocked: lootUnlocked(id, options.walletFile),
    loot: getLootAccount(id, options.shopFile).balance,
    community: today.community,
    game: today.game,
    xp: today.xp,
    completedToday: completedCount(today),
    totalActivities: 3,
    fullComplete: Boolean(today.fullCompletionAt),
    lootAwardedToday: today.lootAwardedToday,
    streak: quest.streak.current || 0,
    longestStreak: quest.streak.longest || 0,
    cycleId: quest.streak.cycleId,
    lastCompletedDate: quest.streak.lastCompletedDate,
  };
}

function formatDailyQuestProgressLine(userId, options = {}) {
  try {
    const snap = getDailyQuestSnapshot(userId, options);
    return [
      `🔥 Daily Streak: ${snap.streak}`,
      `🎯 Today: ${snap.completedToday}/3`,
    ].join("\n");
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
  utcDate,
  utcYesterday,
  setDailyQuestMessenger,
  noteDailyQuestCommunity,
  noteDailyQuestGame,
  noteDailyQuestXp,
  afterXpAward,
  getDailyQuestSnapshot,
  formatDailyQuestProgressLine,
  lootUnlocked,
};
