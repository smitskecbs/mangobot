/**
 * Daily activity types, streaks, GM interaction, owner exclusion.
 * Run: node tests/streak-activity.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  awardDailyActivityPoint,
  awardTriggerPoints,
  awardChatFightXp,
  awardPvpWinXp,
  awardSnakeGameXp,
  loadPoints,
  savePoints,
  readStreak,
  applyDailyActivityStreak,
  needsSameDayStreakRepair,
  utcYesterday,
  getTodayDate,
  getCombinedRankUpReply,
  formatPersonalStreakMessage,
  formatPointsCard,
} = require("../services/points");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const {
  getCurrentStreakTop,
  getLongestStreakTop,
  getLifetimeTop,
  getWeeklyTop,
} = require("../services/leaderboard");
const { getEffectiveWeeklyPoints } = require("../services/points");
const {
  processCommunityMessage,
  isEligibleCommunityActivityMessage,
  shouldSkipCommunityActivity,
} = require("../events/points-trigger");
const { handleStreak, handleStreakRecord, handleMyStreak } = require("../commands/streak");
const { handlePoints } = require("../commands/points");
const { shouldHideScoreLeaderboardEntry } = require("../utils/admin");
const {
  writeScoresFile,
  createEmptyScores,
  getDisplayLeaderboard: getSnakeDisplay,
} = require("../services/snakeScores");
const bounchScores = require("../services/bounchScores");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-streak-"));
const COMMUNITY_CHAT = -1001234567890;
const OTHER_CHAT = -1009999999999;
const OWNER_ID = "999001";
const ALICE = 111;
const BOB = 222;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;

process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
process.env.ADMIN_USER_ID = OWNER_ID;

let n = 0;
function pointsFile() {
  n += 1;
  return path.join(tempDir, `points-${n}.json`);
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
}

function getWeekIdForTest() {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getMonth(), diff))
    .toISOString()
    .slice(0, 10);
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function groupCtx({
  userId = ALICE,
  firstName = "Alice",
  chatId = COMMUNITY_CHAT,
  chatType = "supergroup",
  isBot = false,
  message = { text: "hello" },
  callbackQuery,
} = {}) {
  return {
    from: { id: userId, first_name: firstName, is_bot: isBot },
    chat: { id: chatId, type: chatType },
    message,
    callbackQuery,
    state: {},
  };
}

runTest("1. first activity → current 1 longest 1", () => {
  const file = pointsFile();
  const r = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  assert.strictEqual(r.awarded, true);
  assert.strictEqual(r.streak.current, 1);
  assert.strictEqual(r.streak.longest, 1);
  assert.strictEqual(r.streak.lastActiveDate, "2026-08-10");
  assert.deepStrictEqual(readStreak(loadPoints(file).users[String(ALICE)]), {
    current: 1,
    longest: 1,
    lastActiveDate: "2026-08-10",
  });
});

runTest("2. second message same date → stays 1", () => {
  const file = pointsFile();
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  const r = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  assert.strictEqual(r.awarded, false);
  assert.strictEqual(r.streak.current, 1);
  assert.strictEqual(readStreak(loadPoints(file).users[String(ALICE)]).current, 1);
  assert.strictEqual(loadPoints(file).users[String(ALICE)].points, 1);
});

runTest("3. next day → current 2", () => {
  const file = pointsFile();
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  const r = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-11");
  assert.strictEqual(r.awarded, true);
  assert.strictEqual(r.streak.current, 2);
  assert.strictEqual(r.streak.longest, 2);
});

runTest("4. third consecutive → 3", () => {
  const file = pointsFile();
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-11");
  const r = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-12");
  assert.strictEqual(r.streak.current, 3);
  assert.strictEqual(r.streak.longest, 3);
});

runTest("5. miss a day → reset 1", () => {
  const file = pointsFile();
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-11");
  const r = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-13");
  assert.strictEqual(r.streak.current, 1);
});

runTest("6. longest keeps old record after miss", () => {
  const file = pointsFile();
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-11");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-12");
  const r = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-14");
  assert.strictEqual(r.streak.current, 1);
  assert.strictEqual(r.streak.longest, 3);
});

runTest("7. current can later pass longest", () => {
  const file = pointsFile();
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-01");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-02");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-04");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-05");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-06");
  const r = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-07");
  assert.strictEqual(r.streak.current, 4);
  assert.strictEqual(r.streak.longest, 4);
});

runTest("8. legacy no streak → safe", () => {
  const file = pointsFile();
  savePoints(
    {
      users: {
        [String(ALICE)]: {
          points: 4,
          weeklyPoints: 0,
          weekId: "2026-08-10",
          name: "Alice",
          triggerDate: null,
          triggersUsed: [],
          activityDate: null,
        },
      },
    },
    file
  );
  const legacy = loadPoints(file).users[String(ALICE)];
  assert.deepStrictEqual(readStreak(legacy), {
    current: 0,
    longest: 0,
    lastActiveDate: null,
  });
  const r = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  assert.strictEqual(r.awarded, true);
  assert.strictEqual(r.streak.current, 1);
});

runTest("9. UTC date boundary", () => {
  assert.strictEqual(getTodayDate(new Date("2026-08-14T00:00:00.000Z")), "2026-08-14");
  assert.strictEqual(getTodayDate(new Date("2026-08-13T23:59:59.999Z")), "2026-08-13");
  assert.strictEqual(utcYesterday("2026-08-14"), "2026-08-13");
  const user = { streak: { current: 1, longest: 1, lastActiveDate: "2026-08-13" } };
  const next = applyDailyActivityStreak(user, "2026-08-14");
  assert.strictEqual(next.current, 2);
});

runTest("10. two users independent", () => {
  const file = pointsFile();
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-11");
  awardDailyActivityPoint(BOB, "Bob", file, "2026-08-11");
  const data = loadPoints(file);
  assert.strictEqual(readStreak(data.users[String(ALICE)]).current, 2);
  assert.strictEqual(readStreak(data.users[String(BOB)]).current, 1);
});

runTest("11. concurrent same-day messages increment streak once", () => {
  const file = pointsFile();
  const a = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  const b = awardDailyActivityPoint(ALICE, "Alice", file, "2026-08-10");
  assert.strictEqual(a.awarded, true);
  assert.strictEqual(b.awarded, false);
  assert.strictEqual(loadPoints(file).users[String(ALICE)].points, 1);
  assert.strictEqual(readStreak(loadPoints(file).users[String(ALICE)]).current, 1);
});

runTest("12. owner excluded / no community award", () => {
  const file = pointsFile();
  assert.strictEqual(isCommunityCompetitionExcluded(OWNER_ID), true);
  const r = awardDailyActivityPoint(OWNER_ID, "Kevin", file, "2026-08-10");
  assert.strictEqual(r.awarded, false);
  assert.strictEqual(r.reason, "excluded");
  assert.strictEqual(loadPoints(file).users[OWNER_ID], undefined);
});

runTest("13. normal text counts", () => {
  const file = pointsFile();
  const ctx = groupCtx({ message: { text: "hello community" } });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), true);
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult.awarded, true);
});

runTest("14. reply counts", () => {
  const file = pointsFile();
  const ctx = groupCtx({
    message: { text: "nice one", reply_to_message: { message_id: 9, text: "hi" } },
  });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), true);
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult.awarded, true);
});

runTest("15. sticker counts", () => {
  const file = pointsFile();
  const ctx = groupCtx({ message: { sticker: { file_id: "sticker-1" } } });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), true);
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult.awarded, true);
  assert.strictEqual(result.triggerResult, null);
});

runTest("16. GIF/animation counts", () => {
  const file = pointsFile();
  const ctx = groupCtx({ message: { animation: { file_id: "gif-1" } } });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), true);
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult.awarded, true);
});

runTest("17. photo/caption counts", () => {
  const file = pointsFile();
  const ctx = groupCtx({
    message: { photo: [{ file_id: "p1" }], caption: "look at this" },
  });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), true);
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult.awarded, true);
});

runTest("18. video/media counts", () => {
  const file = pointsFile();
  const videoCtx = groupCtx({ message: { video: { file_id: "v1" } } });
  const noteCtx = groupCtx({ userId: BOB, message: { video_note: { file_id: "vn1" } } });
  assert.strictEqual(isEligibleCommunityActivityMessage(videoCtx), true);
  assert.strictEqual(isEligibleCommunityActivityMessage(noteCtx), true);
  assert.strictEqual(
    processCommunityMessage(videoCtx, { pointsFile: file }).activityResult.awarded,
    true
  );
  assert.strictEqual(
    processCommunityMessage(noteCtx, { pointsFile: file }).activityResult.awarded,
    true
  );
});

runTest("19. slash command does not count", () => {
  const file = pointsFile();
  const ctx = groupCtx({ message: { text: "/points" } });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), false);
  assert.strictEqual(shouldSkipCommunityActivity(ctx, "/points"), true);
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult, null);
});

runTest("20. callback does not count", () => {
  const ctx = groupCtx({
    callbackQuery: { data: "gmenu:streak" },
    message: undefined,
  });
  ctx.message = undefined;
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), false);
});

runTest("21. bot does not count", () => {
  const ctx = groupCtx({ isBot: true, message: { text: "hello" } });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), false);
});

runTest("22. service message does not count", () => {
  const ctx = groupCtx({
    message: { new_chat_members: [{ id: 1, first_name: "x" }] },
  });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), false);
});

runTest("private hello is not community activity", () => {
  const ctx = {
    from: { id: ALICE, first_name: "Alice", is_bot: false },
    chat: { id: ALICE, type: "private" },
    message: { text: "hello" },
  };
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), false);
  assert.strictEqual(shouldSkipCommunityActivity(ctx, "hello"), true);
  const file = pointsFile();
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult, null);
  assert.strictEqual(loadPoints(file).users[String(ALICE)], undefined);
});

runTest("23. wrong group does not count", () => {
  const ctx = groupCtx({
    chatId: OTHER_CHAT,
    message: { text: "hello" },
  });
  assert.strictEqual(isEligibleCommunityActivityMessage(ctx), false);
});

runTest("24. multiple activity types same day → max +1", () => {
  const file = pointsFile();
  const text = processCommunityMessage(
    groupCtx({ message: { text: "hi" } }),
    { pointsFile: file }
  );
  const sticker = processCommunityMessage(
    groupCtx({ message: { sticker: { file_id: "s" } } }),
    { pointsFile: file }
  );
  const gif = processCommunityMessage(
    groupCtx({ message: { animation: { file_id: "g" } } }),
    { pointsFile: file }
  );
  assert.strictEqual(text.activityResult.awarded, true);
  assert.strictEqual(sticker.activityResult.awarded, false);
  assert.strictEqual(gif.activityResult.awarded, false);
  assert.strictEqual(loadPoints(file).users[String(ALICE)].points, 1);
  assert.strictEqual(readStreak(loadPoints(file).users[String(ALICE)]).current, 1);
});

runTest("25. first GMango of day: activity + trigger + streak once", () => {
  const file = pointsFile();
  const ctx = groupCtx({ message: { text: "GMango 🥭" } });
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult.awarded, true);
  assert.strictEqual(result.triggerResult.awarded, true);
  assert.strictEqual(result.triggerResult.pointsToAdd, 2);
  const user = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(user.points, 3);
  assert.strictEqual(readStreak(user).current, 1);
});

runTest("26. second GMango same day: no second activity/streak; trigger duplicate", () => {
  const file = pointsFile();
  processCommunityMessage(groupCtx({ message: { text: "GMango" } }), {
    pointsFile: file,
  });
  const second = processCommunityMessage(
    groupCtx({ message: { text: "GMango again" } }),
    { pointsFile: file }
  );
  assert.strictEqual(second.activityResult.awarded, false);
  assert.strictEqual(second.triggerResult.awarded, false);
  assert.strictEqual(loadPoints(file).users[String(ALICE)].points, 3);
  assert.strictEqual(readStreak(loadPoints(file).users[String(ALICE)]).current, 1);
});

runTest("27. max one rank-up reply", () => {
  const file = pointsFile();
  savePoints(
    {
      users: {
        [String(ALICE)]: {
          points: 24,
          weeklyPoints: 0,
          weekId: getTodayDate(),
          name: "Alice",
          triggerDate: null,
          triggersUsed: [],
          activityDate: null,
        },
      },
    },
    file
  );
  const result = processCommunityMessage(
    groupCtx({ message: { text: "GMango 🥭" } }),
    { pointsFile: file }
  );
  assert.strictEqual(result.activityResult.awarded, true);
  assert.strictEqual(result.triggerResult.awarded, true);
  const reply = getCombinedRankUpReply(
    result.activityResult,
    result.triggerResult,
    "Alice"
  );
  assert.strictEqual(reply, "🥭 Alice reached 🌿 Sprout!");
  assert.strictEqual(result.reply, reply);
});

runTest("28-31. owner filtered from lifetime/weekly/streak boards", () => {
  const file = pointsFile();
  savePoints(
    {
      users: {
        [OWNER_ID]: {
          points: 900,
          weeklyPoints: 90,
          weekId: getWeekIdForTest(),
          name: "Kevin",
          streak: { current: 40, longest: 40, lastActiveDate: getTodayDate() },
        },
        [String(ALICE)]: {
          points: 10,
          weeklyPoints: 5,
          weekId: getWeekIdForTest(),
          name: "Alice",
          streak: { current: 3, longest: 8, lastActiveDate: getTodayDate() },
        },
        [String(BOB)]: {
          points: 8,
          weeklyPoints: 4,
          weekId: getWeekIdForTest(),
          name: "Bob",
          streak: { current: 2, longest: 12, lastActiveDate: getTodayDate() },
        },
      },
    },
    file
  );
  const users = loadPoints(file).users;
  assert.deepStrictEqual(getLifetimeTop(users).map((u) => u.name), ["Alice", "Bob"]);
  assert.deepStrictEqual(
    getWeeklyTop(users, getEffectiveWeeklyPoints).map((u) => u.name),
    ["Alice", "Bob"]
  );
  assert.deepStrictEqual(getCurrentStreakTop(users).map((u) => u.name), ["Alice", "Bob"]);
  assert.deepStrictEqual(getLongestStreakTop(users).map((u) => u.name), ["Bob", "Alice"]);
  const ctx = {
    chat: { type: "group" },
    from: { id: ALICE, first_name: "Alice" },
    replies: [],
    reply(text) {
      this.replies.push({ text });
    },
  };
  handleStreak(ctx, { pointsFile: file });
  assert.ok(ctx.replies[0].text.includes("🥇 Alice — 3 days"));
  assert.ok(!ctx.replies[0].text.includes("Kevin"));
  const ctx2 = { ...ctx, replies: [] };
  ctx2.reply = function (text) {
    this.replies.push({ text });
  };
  handleStreakRecord(ctx2, { pointsFile: file });
  assert.ok(ctx2.replies[0].text.includes("🥇 Bob — 12 days"));
  assert.ok(!ctx2.replies[0].text.includes("Kevin"));
});

runTest("32-35. owner no new daily/GM/PvP/ChatFight XP", () => {
  const file = pointsFile();
  assert.strictEqual(awardDailyActivityPoint(OWNER_ID, "Kevin", file).awarded, false);
  assert.strictEqual(awardTriggerPoints(OWNER_ID, "Kevin", "gmango", file).awarded, false);
  assert.strictEqual(awardPvpWinXp(OWNER_ID, "Kevin", file).awarded, false);
  assert.strictEqual(awardChatFightXp(OWNER_ID, "Kevin", file).awarded, false);
  assert.strictEqual(loadPoints(file).users[OWNER_ID], undefined);
});

runTest("36-37. Snake and Bounch owner scores stay visible", () => {
  const snakeFile = path.join(tempDir, "snake.json");
  const bounchFile = path.join(tempDir, "bounch.json");
  writeScoresFile(snakeFile, {
    ...createEmptyScores(),
    leaderboard: [
      {
        name: "Kevin",
        score: 50,
        lastScore: 50,
        gamesPlayed: 1,
        updatedAt: "2026-08-14T00:00:00.000Z",
        lastPlayedAt: "2026-08-14T00:00:00.000Z",
        telegramUserId: OWNER_ID,
      },
    ],
  });
  bounchScores.writeScoresFile(bounchFile, {
    ...bounchScores.createEmptyScores(),
    leaderboard: [
      {
        name: "Kevin",
        bestLevel: 4,
        lastLevel: 4,
        gamesPlayed: 1,
        updatedAt: "2026-08-14T00:00:00.000Z",
        lastPlayedAt: "2026-08-14T00:00:00.000Z",
        telegramUserId: OWNER_ID,
      },
    ],
  });
  assert.strictEqual(shouldHideScoreLeaderboardEntry({ telegramUserId: OWNER_ID }), false);
  assert.strictEqual(getSnakeDisplay(snakeFile, 10)[0].name, "Kevin");
  assert.strictEqual(bounchScores.getDisplayLeaderboard(bounchFile, 10)[0].name, "Kevin");
  const xpFile = pointsFile();
  assert.strictEqual(awardSnakeGameXp(OWNER_ID, "Kevin", xpFile).awarded, true);
});

runTest("sticker does not GM-trigger without text", () => {
  const file = pointsFile();
  const result = processCommunityMessage(
    groupCtx({ message: { sticker: { file_id: "s" }, caption: undefined } }),
    { pointsFile: file }
  );
  assert.strictEqual(result.triggerResult, null);
});

runTest("photo caption GMango can trigger + activity", () => {
  const file = pointsFile();
  const result = processCommunityMessage(
    groupCtx({ message: { photo: [{ file_id: "p" }], caption: "GMango" } }),
    { pointsFile: file }
  );
  assert.strictEqual(result.activityResult.awarded, true);
  assert.strictEqual(result.triggerResult.awarded, true);
});

runTest("private /points shows streak fields", () => {
  const file = pointsFile();
  awardDailyActivityPoint(ALICE, "Alice", file, getTodayDate());
  const ctx = {
    chat: { type: "private" },
    from: { id: ALICE, first_name: "Alice" },
    replies: [],
    reply(text) {
      this.replies.push({ text });
    },
  };
  handlePoints(ctx, { pointsFile: file });
  assert.ok(ctx.replies[0].text.includes("Your ManGo Progress"));
  assert.ok(ctx.replies[0].text.includes("Current streak: 1 days"));
  assert.ok(ctx.replies[0].text.includes("✅ Daily activity"));
  const card = formatPointsCard(loadPoints(file).users[String(ALICE)]);
  assert.ok(card.includes("XP: 1"));
});

runTest("my streak private zero state", () => {
  const file = pointsFile();
  const ctx = {
    chat: { type: "private" },
    from: { id: ALICE, first_name: "Alice" },
    replies: [],
    reply(text) {
      this.replies.push({ text });
    },
  };
  handleMyStreak(ctx, { pointsFile: file });
  assert.ok(ctx.replies[0].text.includes("Current streak: 0 days"));
  assert.ok(ctx.replies[0].text.includes("Send a message in the ManGo community"));
  assert.strictEqual(
    formatPersonalStreakMessage({}),
    [
      "🔥 Your ManGo Streak",
      "",
      "Current streak: 0 days",
      "Longest streak: 0 days",
      "",
      "Send a message in the ManGo community to start one.",
    ].join("\n")
  );
});

runTest("streak sort: current desc then longest then XP; ranks renumbered", () => {
  const users = {
    [OWNER_ID]: {
      name: "Kevin",
      points: 999,
      streak: { current: 99, longest: 99, lastActiveDate: "2026-08-14" },
    },
    a: { name: "A", points: 1, streak: { current: 5, longest: 5, lastActiveDate: "2026-08-14" } },
    b: { name: "B", points: 50, streak: { current: 5, longest: 9, lastActiveDate: "2026-08-14" } },
    c: { name: "C", points: 80, streak: { current: 5, longest: 9, lastActiveDate: "2026-08-14" } },
  };
  assert.deepStrictEqual(
    getCurrentStreakTop(users).map((u) => u.name),
    ["C", "B", "A"]
  );
});

function seedLegacySameDayActivity(file, userId, name, extras = {}) {
  const today = extras.activityDate || getTodayDate();
  savePoints(
    {
      users: {
        [String(userId)]: {
          points: extras.points != null ? extras.points : 5,
          weeklyPoints: extras.weeklyPoints != null ? extras.weeklyPoints : 2,
          weekId: extras.weekId || getWeekIdForTest(),
          name,
          triggerDate: null,
          triggersUsed: [],
          activityDate: today,
        },
      },
    },
    file
  );
}

runTest("legacy same-day activityDate without streak needs repair", () => {
  const today = getTodayDate();
  const user = {
    points: 5,
    weeklyPoints: 2,
    activityDate: today,
  };
  assert.strictEqual(needsSameDayStreakRepair(user, today), true);
  assert.deepStrictEqual(readStreak(user), {
    current: 0,
    longest: 0,
    lastActiveDate: null,
  });
});

runTest("legacy: activityDate=today, streak missing → next group activity repairs without XP", () => {
  const file = pointsFile();
  seedLegacySameDayActivity(file, ALICE, "Alice", { points: 5, weeklyPoints: 2 });
  const before = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(needsSameDayStreakRepair(before, getTodayDate()), true);
  const result = processCommunityMessage(groupCtx({ message: { text: "hello again" } }), {
    pointsFile: file,
  });
  assert.strictEqual(result.activityResult.awarded, false);
  assert.strictEqual(result.activityResult.streakRepaired, true);
  const user = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(user.points, 5);
  assert.strictEqual(user.weeklyPoints, 2);
  assert.strictEqual(user.activityDate, getTodayDate());
  assert.deepStrictEqual(readStreak(user), {
    current: 1,
    longest: 1,
    lastActiveDate: getTodayDate(),
  });
});

runTest("legacy: streak 0/0/null repairs once", () => {
  const file = pointsFile();
  const today = getTodayDate();
  savePoints(
    {
      users: {
        [String(ALICE)]: {
          points: 8,
          weeklyPoints: 3,
          weekId: getWeekIdForTest(),
          name: "Alice",
          triggerDate: null,
          triggersUsed: [],
          activityDate: today,
          streak: { current: 0, longest: 0, lastActiveDate: null },
        },
      },
    },
    file
  );
  const first = awardDailyActivityPoint(ALICE, "Alice", file, today);
  assert.strictEqual(first.awarded, false);
  assert.strictEqual(first.streakRepaired, true);
  assert.strictEqual(first.streak.current, 1);
  const second = awardDailyActivityPoint(ALICE, "Alice", file, today);
  assert.strictEqual(second.awarded, false);
  assert.strictEqual(second.streakRepaired, false);
  assert.strictEqual(second.streak.current, 1);
  const user = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(user.points, 8);
  assert.strictEqual(user.weeklyPoints, 3);
  assert.strictEqual(readStreak(user).current, 1);
});

runTest("legacy: second message today keeps streak 1 and no extra XP", () => {
  const file = pointsFile();
  seedLegacySameDayActivity(file, ALICE, "Alice", { points: 5, weeklyPoints: 2 });
  processCommunityMessage(groupCtx({ message: { text: "first" } }), { pointsFile: file });
  const second = processCommunityMessage(groupCtx({ message: { text: "second" } }), {
    pointsFile: file,
  });
  assert.strictEqual(second.activityResult.awarded, false);
  assert.strictEqual(second.activityResult.streakRepaired, false);
  const user = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(user.points, 5);
  assert.strictEqual(readStreak(user).current, 1);
  assert.strictEqual(readStreak(user).longest, 1);
});

runTest("legacy: owner with activityDate today is never repaired", () => {
  const file = pointsFile();
  const today = getTodayDate();
  savePoints(
    {
      users: {
        [OWNER_ID]: {
          points: 20,
          weeklyPoints: 4,
          weekId: getWeekIdForTest(),
          name: "Kevin",
          triggerDate: null,
          triggersUsed: [],
          activityDate: today,
        },
      },
    },
    file
  );
  const result = processCommunityMessage(
    groupCtx({ userId: Number(OWNER_ID), firstName: "Kevin", message: { text: "hello" } }),
    { pointsFile: file }
  );
  assert.strictEqual(result.activityResult.awarded, false);
  assert.strictEqual(result.activityResult.reason, "excluded");
  const owner = loadPoints(file).users[OWNER_ID];
  assert.strictEqual(owner.points, 20);
  assert.strictEqual(owner.weeklyPoints, 4);
  assert.deepStrictEqual(readStreak(owner), {
    current: 0,
    longest: 0,
    lastActiveDate: null,
  });
});

runTest("legacy: private message does not repair", () => {
  const file = pointsFile();
  seedLegacySameDayActivity(file, ALICE, "Alice", { points: 5, weeklyPoints: 2 });
  const ctx = {
    from: { id: ALICE, first_name: "Alice", is_bot: false },
    chat: { id: ALICE, type: "private" },
    message: { text: "hello" },
  };
  const result = processCommunityMessage(ctx, { pointsFile: file });
  assert.strictEqual(result.activityResult, null);
  const user = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(needsSameDayStreakRepair(user, getTodayDate()), true);
  assert.deepStrictEqual(readStreak(user), {
    current: 0,
    longest: 0,
    lastActiveDate: null,
  });
  assert.strictEqual(user.points, 5);
});

runTest("legacy: wrong Telegram group does not repair", () => {
  const file = pointsFile();
  seedLegacySameDayActivity(file, ALICE, "Alice", { points: 5, weeklyPoints: 2 });
  const result = processCommunityMessage(
    groupCtx({ chatId: OTHER_CHAT, message: { text: "hello" } }),
    { pointsFile: file }
  );
  assert.strictEqual(result.activityResult, null);
  const user = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(needsSameDayStreakRepair(user, getTodayDate()), true);
  assert.strictEqual(readStreak(user).current, 0);
});

runTest("yesterday activityDate is not treated as today's streak", () => {
  const file = pointsFile();
  const yesterday = utcYesterday(getTodayDate());
  seedLegacySameDayActivity(file, ALICE, "Alice", {
    points: 5,
    weeklyPoints: 2,
    activityDate: yesterday,
  });
  const user = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(needsSameDayStreakRepair(user, getTodayDate()), false);
  handleStreak(
    {
      chat: { type: "group" },
      from: { id: ALICE, first_name: "Alice" },
      replies: [],
      reply(text) {
        this.replies.push({ text });
      },
    },
    { pointsFile: file }
  );
  const afterRead = loadPoints(file).users[String(ALICE)];
  assert.deepStrictEqual(readStreak(afterRead), {
    current: 0,
    longest: 0,
    lastActiveDate: null,
  });
  assert.strictEqual(afterRead.points, 5);
  assert.strictEqual(afterRead.activityDate, yesterday);
});

runTest("/streak and /streakrecord see repaired user; boards filter zeros", () => {
  const file = pointsFile();
  seedLegacySameDayActivity(file, ALICE, "Alice", { points: 5, weeklyPoints: 2 });
  savePoints(
    {
      users: {
        ...loadPoints(file).users,
        [String(BOB)]: {
          points: 3,
          weeklyPoints: 1,
          weekId: getWeekIdForTest(),
          name: "Bob",
          activityDate: getTodayDate(),
          streak: { current: 0, longest: 0, lastActiveDate: null },
        },
      },
    },
    file
  );
  processCommunityMessage(groupCtx({ message: { text: "hi" } }), { pointsFile: file });
  const users = loadPoints(file).users;
  assert.deepStrictEqual(getCurrentStreakTop(users).map((u) => u.name), ["Alice"]);
  assert.deepStrictEqual(getLongestStreakTop(users).map((u) => u.name), ["Alice"]);
  assert.ok(getCurrentStreakTop(users).every((u) => u.currentStreak > 0));
  assert.ok(getLongestStreakTop(users).every((u) => u.longestStreak > 0));

  const streakCtx = {
    chat: { type: "group" },
    from: { id: ALICE, first_name: "Alice" },
    replies: [],
    reply(text) {
      this.replies.push({ text });
    },
  };
  handleStreak(streakCtx, { pointsFile: file });
  assert.ok(streakCtx.replies[0].text.includes("Alice — 1 days"));
  assert.ok(!streakCtx.replies[0].text.includes("No active streaks yet"));

  const recordCtx = {
    ...streakCtx,
    replies: [],
  };
  recordCtx.reply = function (text) {
    this.replies.push({ text });
  };
  handleStreakRecord(recordCtx, { pointsFile: file });
  assert.ok(recordCtx.replies[0].text.includes("Alice — 1 days"));
  assert.ok(!recordCtx.replies[0].text.includes("No streak records yet"));
});

runTest("/streak read does not repair without activity", () => {
  const file = pointsFile();
  seedLegacySameDayActivity(file, ALICE, "Alice", { points: 5, weeklyPoints: 2 });
  const ctx = {
    chat: { type: "group" },
    from: { id: ALICE, first_name: "Alice" },
    replies: [],
    reply(text) {
      this.replies.push({ text });
    },
  };
  handleStreak(ctx, { pointsFile: file });
  assert.ok(ctx.replies[0].text.includes("No active streaks yet"));
  const user = loadPoints(file).users[String(ALICE)];
  assert.strictEqual(user.points, 5);
  assert.deepStrictEqual(readStreak(user), {
    current: 0,
    longest: 0,
    lastActiveDate: null,
  });
});

fs.rmSync(tempDir, { recursive: true, force: true });
restoreEnv();
console.log("\nAll streak/activity tests passed.");
