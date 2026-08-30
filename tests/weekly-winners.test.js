/**
 * Weekly Top 3 winners — snapshot, boundary, announce, command.
 * Run: node tests/weekly-winners.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const {
  TOP_N,
  DEFAULT_WINNERS_FILE,
  emptyState,
  normalizeState,
  readWinnersState,
  writeWinnersState,
  getPreviousWeekId,
  getIsoWeekNumber,
  rankWeeklyStandings,
  formatWeeklyWinnersMessage,
  noteWeeklyStanding,
  syncAndFinalizeWeeklyWinners,
  markWeeklyWinnersAnnounced,
  processWeeklyWinnersBoundary,
  getLatestWeeklyWinners,
  setWeeklyWinnersFileForTests,
  resolveWinnersFile,
  isLikelyTestProcess,
  reconstructCurrentStandingsFromPoints,
} = require("../services/weeklyWinners");
const {
  getWeekId,
  getTodayDate,
  awardDailyActivityPoint,
  loadPoints,
  savePoints,
  getEffectiveWeeklyPoints,
} = require("../services/points");
const { getWeeklyTop } = require("../services/leaderboard");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const { handleWeeklyWinners } = require("../commands/weeklywinners");
const { handleWeekly } = require("../commands/weekly");
const { HELP_MESSAGE } = require("../commands/help");
const {
  GROUP_MENU_CALLBACK,
  getGroupMenuExtra,
  getGroupRankingsMenuExtra,
  isGroupMenuCallback,
} = require("../utils/botMenu");
const { handleGroupMenuCallback } = require("../commands/menu");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-weekly-winners-"));
const OWNER_ID = "1238384546";
const COMMUNITY_CHAT = -1003916996602;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;

process.env.ADMIN_USER_ID = OWNER_ID;
process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);

let n = 0;
function pointsFile() {
  n += 1;
  return path.join(tempDir, `points-${n}.json`);
}
function winnersFile() {
  n += 1;
  return path.join(tempDir, `winners-${n}.json`);
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function mondayOf(date) {
  return getWeekId(date);
}

function nextMondayAfter(weekId) {
  const d = new Date(`${weekId}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return getWeekId(d);
}

function seedUsers(file, rows, weekId) {
  const users = {};
  for (const row of rows) {
    users[String(row.id)] = {
      name: row.name,
      points: row.points != null ? row.points : row.weeklyPoints,
      weeklyPoints: row.weeklyPoints,
      weekId,
      activityDate: null,
      triggerDate: null,
      triggersUsed: [],
    };
  }
  savePoints({ users }, file);
}

function mockCtx({ chatType = "supergroup", chatId = COMMUNITY_CHAT } = {}) {
  const replies = [];
  return {
    replies,
    chat: { id: chatId, type: chatType },
    from: { id: 999, is_bot: false, first_name: "Viewer" },
    reply: async (text, extra) => {
      replies.push({ text, extra });
      return { message_id: replies.length };
    },
    answerCbQuery: async () => {},
    callbackQuery: null,
  };
}

async function main() {
  await runTest("week boundary is Monday 00:00 UTC (getWeekId)", () => {
    // Sunday 2026-08-09 23:00 UTC → still week starting 2026-08-03
    const sunday = new Date(Date.UTC(2026, 7, 9, 23, 0, 0));
    assert.strictEqual(getWeekId(sunday), "2026-08-03");
    // Monday 2026-08-10 00:00 UTC → new week
    const monday = new Date(Date.UTC(2026, 7, 10, 0, 0, 0));
    assert.strictEqual(getWeekId(monday), "2026-08-10");
    assert.strictEqual(getPreviousWeekId("2026-08-10"), "2026-08-03");
  });

  await runTest("Top 3 correct; owner excluded; max 3 stored", () => {
    const standings = {
      1: { name: "Alice", weeklyPoints: 40 },
      2: { name: "Bob", weeklyPoints: 30 },
      3: { name: "Charlie", weeklyPoints: 20 },
      4: { name: "Dave", weeklyPoints: 10 },
      [OWNER_ID]: { name: "Kevin", weeklyPoints: 999 },
    };
    assert.strictEqual(isCommunityCompetitionExcluded(OWNER_ID), true);
    const top = rankWeeklyStandings(standings, TOP_N);
    assert.strictEqual(top.length, 3);
    assert.deepStrictEqual(
      top.map((w) => w.name),
      ["Alice", "Bob", "Charlie"]
    );
    assert.ok(!top.some((w) => String(w.telegramUserId) === OWNER_ID));
  });

  await runTest("1 / 2 / 0 participants", () => {
    assert.strictEqual(
      rankWeeklyStandings({ 1: { name: "Solo", weeklyPoints: 5 } }).length,
      1
    );
    assert.strictEqual(
      rankWeeklyStandings({
        1: { name: "A", weeklyPoints: 5 },
        2: { name: "B", weeklyPoints: 3 },
      }).length,
      2
    );
    assert.strictEqual(rankWeeklyStandings({}).length, 0);
    const emptyMsg = formatWeeklyWinnersMessage({ winners: [] });
    assert.ok(emptyMsg.includes("No qualifying players"));
  });

  await runTest("tie sort matches /weekly (weeklyPoints desc only, stable)", () => {
    const standings = {
      20: { name: "Zed", weeklyPoints: 10 },
      10: { name: "Amy", weeklyPoints: 10 },
      15: { name: "Amy", weeklyPoints: 10 },
      99: { name: "Low", weeklyPoints: 1 },
    };
    const top = rankWeeklyStandings(standings);
    assert.strictEqual(top.length, 3);
    assert.ok(top.every((w, i) => i === 0 || top[i - 1].weeklyPoints >= w.weeklyPoints));
    assert.strictEqual(top[0].weeklyPoints, 10);
    assert.strictEqual(top[1].weeklyPoints, 10);
    assert.strictEqual(top[2].weeklyPoints, 10);
    // Integer-like keys: Object.entries order (asc), then stable sort by weeklyPoints (same as getWeeklyTop).
    assert.deepStrictEqual(
      top.map((w) => w.telegramUserId),
      ["10", "15", "20"]
    );
  });

  await runTest("old ranking captured before reset/loss on week boundary", () => {
    const pf = pointsFile();
    const wf = winnersFile();
    setWeeklyWinnersFileForTests(wf);
    const closedWeek = "2026-08-03";
    const newWeek = "2026-08-10";
    const newWeekDate = new Date(Date.UTC(2026, 7, 10, 1, 0, 0));

    seedUsers(
      pf,
      [
        { id: 1, name: "Alice", weeklyPoints: 40 },
        { id: 2, name: "Bob", weeklyPoints: 30 },
        { id: 3, name: "Charlie", weeklyPoints: 20 },
        { id: 4, name: "Dave", weeklyPoints: 10 },
        { id: OWNER_ID, name: "Kevin", weeklyPoints: 999 },
      ],
      closedWeek
    );

    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: null,
        latest: null,
        current: {
          week: closedWeek,
          standings: {
            1: { name: "Alice", weeklyPoints: 40 },
            2: { name: "Bob", weeklyPoints: 30 },
            3: { name: "Charlie", weeklyPoints: 20 },
            4: { name: "Dave", weeklyPoints: 10 },
          },
          updatedAt: 1,
        },
      },
      wf
    );

    // Simulate Monday wipe of live weeklyPoints (data would be lost without snapshot).
    const data = loadPoints(pf);
    for (const uid of Object.keys(data.users)) {
      data.users[uid].weekId = newWeek;
      data.users[uid].weeklyPoints = uid === "1" ? 1 : 0;
    }
    savePoints(data, pf);

    const result = syncAndFinalizeWeeklyWinners({
      winnersFile: wf,
      pointsFile: pf,
      now: newWeekDate,
    });
    assert.strictEqual(result.finalized, true);
    assert.strictEqual(result.week, closedWeek);
    assert.deepStrictEqual(
      result.winners.map((w) => [w.name, w.weeklyPoints]),
      [
        ["Alice", 40],
        ["Bob", 30],
        ["Charlie", 20],
      ]
    );
    assert.ok(!result.winners.some((w) => String(w.telegramUserId) === OWNER_ID));

    const state = readWinnersState(wf);
    assert.strictEqual(state.lastFinalizedWeek, closedWeek);
    assert.strictEqual(state.current.week, newWeek);
    assert.strictEqual(state.latest.winners.length, 3);
    setWeeklyWinnersFileForTests(null);
  });

  await runTest("same week not double finalized / announced", async () => {
    const pf = pointsFile();
    const wf = winnersFile();
    const closedWeek = "2026-08-03";
    const newWeekDate = new Date(Date.UTC(2026, 7, 10, 2, 0, 0));
    seedUsers(pf, [{ id: 1, name: "Alice", weeklyPoints: 5 }], closedWeek);
    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: null,
        latest: null,
        current: {
          week: closedWeek,
          standings: { 1: { name: "Alice", weeklyPoints: 5 } },
          updatedAt: 1,
        },
      },
      wf
    );

    const posts = [];
    const first = await processWeeklyWinnersBoundary({
      winnersFile: wf,
      pointsFile: pf,
      now: newWeekDate,
      chatId: COMMUNITY_CHAT,
      sendMessageFn: async (c, t) => {
        posts.push({ c, t });
      },
    });
    assert.strictEqual(first.finalized, true);
    assert.strictEqual(first.posted, true);
    assert.strictEqual(posts.length, 1);

    const second = await processWeeklyWinnersBoundary({
      winnersFile: wf,
      pointsFile: pf,
      now: newWeekDate,
      chatId: COMMUNITY_CHAT,
      sendMessageFn: async (c, t) => {
        posts.push({ c, t });
      },
    });
    assert.strictEqual(second.finalized, false);
    assert.strictEqual(second.posted, false);
    assert.strictEqual(posts.length, 1);

    // Restart after announced
    const third = await processWeeklyWinnersBoundary({
      winnersFile: wf,
      pointsFile: pf,
      now: newWeekDate,
      chatId: COMMUNITY_CHAT,
      sendMessageFn: async (c, t) => {
        posts.push({ c, t });
      },
    });
    assert.strictEqual(third.posted, false);
    assert.strictEqual(posts.length, 1);
  });

  await runTest("offline during boundary → recover from leftover points.json", async () => {
    const pf = pointsFile();
    const wf = winnersFile();
    const closedWeek = "2026-08-03";
    const newWeekDate = new Date(Date.UTC(2026, 7, 10, 8, 0, 0));
    // Bot was offline: no current standing file, but old week still on disk.
    seedUsers(
      pf,
      [
        { id: 1, name: "Alice", weeklyPoints: 40 },
        { id: 2, name: "Bob", weeklyPoints: 30 },
        { id: OWNER_ID, name: "Kevin", weeklyPoints: 999 },
      ],
      closedWeek
    );
    writeWinnersState(emptyState(), wf);

    const posts = [];
    const result = await processWeeklyWinnersBoundary({
      winnersFile: wf,
      pointsFile: pf,
      now: newWeekDate,
      chatId: COMMUNITY_CHAT,
      sendMessageFn: async (_c, t) => {
        posts.push(t);
      },
    });
    assert.strictEqual(result.finalized, true);
    assert.strictEqual(result.posted, true);
    assert.strictEqual(result.winners.length, 2);
    assert.strictEqual(result.winners[0].name, "Alice");
    assert.ok(posts[0].includes("Alice"));
    assert.ok(!posts[0].includes("Kevin"));
  });

  await runTest("noteWeeklyStanding before wipe preserves score", () => {
    const wf = winnersFile();
    const closedWeek = "2026-08-03";
    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: null,
        latest: null,
        current: { week: closedWeek, standings: {}, updatedAt: null },
      },
      wf
    );
    noteWeeklyStanding(1, "Alice", closedWeek, 40, wf);
    noteWeeklyStanding(OWNER_ID, "Kevin", closedWeek, 999, wf);
    const state = readWinnersState(wf);
    assert.strictEqual(state.current.standings["1"].weeklyPoints, 40);
    assert.strictEqual(state.current.standings[OWNER_ID], undefined);
  });

  await runTest("/weeklywinners public text; empty / filled", async () => {
    const wf = winnersFile();
    const ctx = mockCtx();
    await handleWeeklyWinners(ctx, { winnersFile: wf, pointsFile: pointsFile() });
    assert.ok(ctx.replies[0].text.includes("No qualifying players"));

    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: "2026-08-03",
        latest: {
          week: "2026-08-03",
          finalizedAt: 1,
          announced: true,
          winners: [
            { telegramUserId: "1", name: "Alice", weeklyPoints: 42 },
            { telegramUserId: "2", name: "Bob", weeklyPoints: 31 },
          ],
        },
        current: { week: "2026-08-10", standings: {}, updatedAt: 1 },
      },
      wf
    );
    const displayNow = new Date(Date.UTC(2026, 7, 12, 12, 0, 0));
    const ctx2 = mockCtx();
    await handleWeeklyWinners(ctx2, { winnersFile: wf, now: displayNow });
    assert.ok(ctx2.replies[0].text.includes("ManGo Weekly Winners"));
    assert.ok(ctx2.replies[0].text.includes("Alice — 42 XP"));
    assert.ok(ctx2.replies[0].text.includes("Bob — 31 XP"));
    assert.ok(ctx2.replies[0].text.includes("A new weekly race is underway"));
  });

  await runTest("/weekly still shows current week only", () => {
    const pf = pointsFile();
    const week = getWeekId();
    seedUsers(
      pf,
      [
        { id: 1, name: "Now", weeklyPoints: 7 },
        { id: 2, name: "Old", weeklyPoints: 99 },
      ],
      week
    );
    const data = loadPoints(pf);
    data.users["2"].weekId = getPreviousWeekId(week);
    savePoints(data, pf);
    const ctx = mockCtx();
    handleWeekly(ctx, { pointsFile: pf });
    assert.ok(ctx.replies[0].text.includes("Now"));
    assert.ok(!ctx.replies[0].text.includes("Old"));
  });

  await runTest("menu callback Weekly Winners + help lists command", async () => {
    assert.strictEqual(isGroupMenuCallback(GROUP_MENU_CALLBACK.WEEKLY_WINNERS), true);
    const main = getGroupMenuExtra({
      botInfo: { username: "mango_test_bot" },
    });
    assert.ok(JSON.stringify(main).includes(GROUP_MENU_CALLBACK.RANKINGS));
    const rankings = getGroupRankingsMenuExtra();
    const flat = JSON.stringify(rankings);
    assert.ok(flat.includes("Weekly Winners"));
    assert.ok(flat.includes(GROUP_MENU_CALLBACK.WEEKLY_WINNERS));
    assert.ok(HELP_MESSAGE.includes("/weeklywinners"));

    const wf = winnersFile();
    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: "2026-08-03",
        latest: {
          week: "2026-08-03",
          finalizedAt: 1,
          announced: true,
          winners: [{ telegramUserId: "1", name: "Alice", weeklyPoints: 9 }],
        },
        current: { week: getWeekId(), standings: {}, updatedAt: 1 },
      },
      wf
    );
    const ctx = mockCtx();
    ctx.callbackQuery = { data: GROUP_MENU_CALLBACK.WEEKLY_WINNERS };
    await handleGroupMenuCallback(ctx, { winnersFile: wf });
    assert.ok(ctx.replies.some((r) => r.text.includes("Alice — 9 XP")));
  });

  await runTest("legacy/missing/corrupt winners file safe", () => {
    const missing = path.join(tempDir, "no-such-winners.json");
    assert.doesNotThrow(() => readWinnersState(missing));
    const corrupt = winnersFile();
    fs.writeFileSync(corrupt, "{not-json", "utf8");
    const state = readWinnersState(corrupt);
    assert.strictEqual(state.lastFinalizedWeek, null);
    assert.deepStrictEqual(normalizeState(null).current.standings, {});
    assert.doesNotThrow(() =>
      formatWeeklyWinnersMessage(getLatestWeeklyWinners(missing))
    );
  });

  await runTest("no automatic rewards on finalize", async () => {
    const pf = pointsFile();
    const wf = winnersFile();
    const closedWeek = "2026-08-03";
    const newWeekDate = new Date(Date.UTC(2026, 7, 10, 3, 0, 0));
    seedUsers(pf, [{ id: 1, name: "Alice", weeklyPoints: 40, points: 40 }], closedWeek);
    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: null,
        latest: null,
        current: {
          week: closedWeek,
          standings: { 1: { name: "Alice", weeklyPoints: 40 } },
          updatedAt: 1,
        },
      },
      wf
    );
    await processWeeklyWinnersBoundary({
      winnersFile: wf,
      pointsFile: pf,
      now: newWeekDate,
      chatId: COMMUNITY_CHAT,
      sendMessageFn: async () => {},
    });
    const after = loadPoints(pf).users["1"];
    assert.strictEqual(after.points, 40);
  });

  await runTest("mark announced idempotent; announce retry if not marked", async () => {
    const wf = winnersFile();
    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: "2026-08-03",
        latest: {
          week: "2026-08-03",
          finalizedAt: 1,
          announced: false,
          winners: [{ telegramUserId: "1", name: "Alice", weeklyPoints: 3 }],
        },
        current: { week: "2026-08-10", standings: {}, updatedAt: 1 },
      },
      wf
    );
    const posts = [];
    const r1 = await processWeeklyWinnersBoundary({
      winnersFile: wf,
      pointsFile: pointsFile(),
      now: new Date(Date.UTC(2026, 7, 10, 4, 0, 0)),
      chatId: COMMUNITY_CHAT,
      sendMessageFn: async (_c, t) => {
        posts.push(t);
      },
    });
    assert.strictEqual(r1.posted, true);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(markWeeklyWinnersAnnounced("2026-08-03", wf), true);
    const r2 = await processWeeklyWinnersBoundary({
      winnersFile: wf,
      pointsFile: pointsFile(),
      now: new Date(Date.UTC(2026, 7, 10, 4, 0, 0)),
      chatId: COMMUNITY_CHAT,
      sendMessageFn: async (_c, t) => {
        posts.push(t);
      },
    });
    assert.strictEqual(r2.posted, false);
    assert.strictEqual(posts.length, 1);
  });

  await runTest("ISO week label in message", () => {
    // 2026-08-03 is Monday of ISO week 32
    assert.strictEqual(getIsoWeekNumber("2026-08-03"), 32);
    const msg = formatWeeklyWinnersMessage({
      week: "2026-08-03",
      winners: [{ telegramUserId: "1", name: "Alice", weeklyPoints: 1 }],
    });
    assert.ok(msg.includes("Week 32"));
  });

  await runTest("test process never resolves to production weekly-winners path", () => {
    assert.strictEqual(isLikelyTestProcess(), true);
    setWeeklyWinnersFileForTests(null);
    delete process.env.WEEKLY_WINNERS_FILE;
    const resolved = resolveWinnersFile();
    assert.notStrictEqual(
      path.resolve(resolved),
      path.resolve(DEFAULT_WINNERS_FILE)
    );
    assert.ok(resolved.includes("mango-ww-isolate-") || resolved.includes(os.tmpdir()));
  });

  await runTest("award path writes isolated weekly-winners, not the production path", () => {
    setWeeklyWinnersFileForTests(null);
    delete process.env.WEEKLY_WINNERS_FILE;
    const isolated = resolveWinnersFile();
    assert.notStrictEqual(path.resolve(isolated), path.resolve(DEFAULT_WINNERS_FILE));
    assert.ok(isolated.includes("mango-ww-isolate-") || isolated.includes(os.tmpdir()));

    // These fixture IDs previously polluted production standings when the
    // default path was used. Never open data/weekly-winners.json here — on
    // Hetzner that file is live runtime state.
    awardDailyActivityPoint(42, "Kevin", pointsFile());
    awardDailyActivityPoint(99, "Ada", pointsFile());
    awardDailyActivityPoint(111, "Player", pointsFile());
    awardDailyActivityPoint(222, "Alice", pointsFile());
    awardDailyActivityPoint(111111111, "Ada", pointsFile());
    noteWeeklyStanding(42, "Kevin", getWeekId(), 3);

    const state = readWinnersState(isolated);
    assert.ok(state.current && state.current.standings);
    assert.strictEqual(state.current.standings["42"].weeklyPoints, 3);
    assert.strictEqual(state.current.standings["42"].name, "Kevin");
  });

  await runTest("reconstruct current standings from points; preserve latest", () => {
    const pf = pointsFile();
    const wf = winnersFile();
    const week = getWeekId();
    seedUsers(
      pf,
      [
        { id: 1001, name: "KronicGrimm", weeklyPoints: 14, points: 14 },
        { id: 1002, name: "Pippi", weeklyPoints: 12, points: 12 },
        { id: 42, name: "KevinFixture", weeklyPoints: 99, points: 99 },
        { id: OWNER_ID, name: "Kevin", weeklyPoints: 999, points: 999 },
      ],
      week
    );
    // Fixture id 42 is a real points row here — reconstruction includes it
    // only because it is in points.json. Pollution IDs absent from points
    // must not appear.
    const data = loadPoints(pf);
    data.users["42"].weekId = getPreviousWeekId(week); // old week → excluded
    data.users["42"].weeklyPoints = 99;
    savePoints(data, pf);

    const latest = {
      week: "2026-08-03",
      finalizedAt: 123,
      announced: true,
      winners: [
        { telegramUserId: "9", name: "Ay", weeklyPoints: 2 },
        { telegramUserId: "8", name: "MK", weeklyPoints: 2 },
      ],
    };
    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: "2026-08-03",
        latest,
        current: {
          week: week,
          standings: {
            42: { name: "Kevin", weeklyPoints: 3 },
            99: { name: "Ada", weeklyPoints: 1 },
            111: { name: "Player", weeklyPoints: 3 },
            222: { name: "Alice", weeklyPoints: 1 },
            111111111: { name: "Ada", weeklyPoints: 1 },
            1001: { name: "stale", weeklyPoints: 1 },
          },
          updatedAt: 1,
        },
      },
      wf
    );

    const result = reconstructCurrentStandingsFromPoints({
      winnersFile: wf,
      pointsFile: pf,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.week, week);
    assert.strictEqual(result.preservedLatest, true);
    assert.strictEqual(result.preservedFinalized, true);

    const state = readWinnersState(wf);
    assert.strictEqual(state.lastFinalizedWeek, "2026-08-03");
    assert.strictEqual(state.latest.announced, true);
    assert.deepStrictEqual(
      state.latest.winners.map((w) => w.name),
      ["Ay", "MK"]
    );
    assert.strictEqual(state.current.week, week);
    assert.strictEqual(state.current.standings["1001"].weeklyPoints, 14);
    assert.strictEqual(state.current.standings["1002"].weeklyPoints, 12);
    assert.strictEqual(state.current.standings["42"], undefined);
    assert.strictEqual(state.current.standings["99"], undefined);
    assert.strictEqual(state.current.standings["111"], undefined);
    assert.strictEqual(state.current.standings[OWNER_ID], undefined);

    // Match /weekly semantics.
    const top = getWeeklyTop(loadPoints(pf).users, getEffectiveWeeklyPoints, 10);
    assert.deepStrictEqual(
      top.map((u) => u.name).sort(),
      ["KronicGrimm", "Pippi"].sort()
    );
    assert.strictEqual(isCommunityCompetitionExcluded(OWNER_ID), true);
  });

  await runTest(
    "reconstruct excludes production owner id (string + number); keeps peers",
    async () => {
      assert.strictEqual(process.env.ADMIN_USER_ID, OWNER_ID);
      assert.strictEqual(isCommunityCompetitionExcluded("1238384546"), true);
      assert.strictEqual(isCommunityCompetitionExcluded(1238384546), true);

      const pf = pointsFile();
      const wf = winnersFile();
      const week = getWeekId();
      seedUsers(
        pf,
        [
          { id: 1238384546, name: "Kevin", weeklyPoints: 21, points: 21 },
          { id: 6170961561, name: "KronicGrimm", weeklyPoints: 14, points: 14 },
          { id: 8388586967, name: "Pippi", weeklyPoints: 12, points: 12 },
        ],
        week
      );

      writeWinnersState(
        {
          version: 1,
          lastFinalizedWeek: "2026-08-03",
          latest: {
            week: "2026-08-03",
            finalizedAt: 1,
            announced: true,
            winners: [
              { telegramUserId: "9", name: "Ay", weeklyPoints: 2 },
              { telegramUserId: "8", name: "MK", weeklyPoints: 2 },
            ],
          },
          current: {
            week,
            standings: {
              "1238384546": { name: "Kevin", weeklyPoints: 21 },
              1238384546: { name: "Kevin", weeklyPoints: 21 },
              6170961561: { name: "stale", weeklyPoints: 1 },
              99: { name: "Ada", weeklyPoints: 1 },
            },
            updatedAt: 1,
          },
        },
        wf
      );

      const result = reconstructCurrentStandingsFromPoints({
        winnersFile: wf,
        pointsFile: pf,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.standingCount, 2);
      assert.strictEqual(result.preservedLatest, true);
      assert.strictEqual(result.preservedFinalized, true);

      const state = readWinnersState(wf);
      assert.strictEqual(state.lastFinalizedWeek, "2026-08-03");
      assert.strictEqual(state.latest.announced, true);
      assert.strictEqual(state.current.standings["1238384546"], undefined);
      assert.strictEqual(state.current.standings[1238384546], undefined);
      assert.strictEqual(state.current.standings["6170961561"].weeklyPoints, 14);
      assert.strictEqual(state.current.standings["8388586967"].weeklyPoints, 12);

      const weeklyCtx = mockCtx();
      await handleWeekly(weeklyCtx, { pointsFile: pf });
      assert.ok(weeklyCtx.replies[0].text.includes("KronicGrimm"));
      assert.ok(weeklyCtx.replies[0].text.includes("Pippi"));
      assert.ok(!weeklyCtx.replies[0].text.includes("Kevin"));

      const winnersCtx = mockCtx();
      await handleWeeklyWinners(winnersCtx, { winnersFile: wf, pointsFile: pf });
      assert.ok(!winnersCtx.replies[0].text.includes("Kevin"));
    }
  );

  await runTest("reconstruct without ADMIN_USER_ID includes owner (env gap)", () => {
    const pf = pointsFile();
    const wf = winnersFile();
    const week = getWeekId();
    seedUsers(
      pf,
      [{ id: 1238384546, name: "Kevin", weeklyPoints: 21, points: 21 }],
      week
    );
    writeWinnersState(emptyState(), wf);

    const savedAdmin = process.env.ADMIN_USER_ID;
    try {
      delete process.env.ADMIN_USER_ID;
      assert.strictEqual(isCommunityCompetitionExcluded("1238384546"), false);

      const result = reconstructCurrentStandingsFromPoints({
        winnersFile: wf,
        pointsFile: pf,
      });
      assert.strictEqual(result.ok, true);
      const state = readWinnersState(wf);
      assert.ok(state.current.standings["1238384546"]);
      assert.strictEqual(state.current.standings["1238384546"].weeklyPoints, 21);
      assert.strictEqual(state.current.standings["1238384546"].name, "Kevin");
    } finally {
      if (savedAdmin === undefined) delete process.env.ADMIN_USER_ID;
      else process.env.ADMIN_USER_ID = savedAdmin;
    }
  });

  await runTest("reconstruct 0 users + malformed state safe", () => {
    const pf = pointsFile();
    const wf = winnersFile();
    savePoints({ users: {} }, pf);
    fs.writeFileSync(wf, "{not-json", "utf8");
    const result = reconstructCurrentStandingsFromPoints({
      winnersFile: wf,
      pointsFile: pf,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(fs.readFileSync(wf, "utf8"), "{not-json");
    const state = readWinnersState(wf);
    assert.strictEqual(state.lastFinalizedWeek, null);
  });

  const sundayUtc = new Date(Date.UTC(2026, 7, 9, 23, 59, 0));
  const mondayMidnightUtc = new Date(Date.UTC(2026, 7, 10, 0, 0, 0));
  const mondayDayUtc = new Date(Date.UTC(2026, 7, 10, 15, 0, 0));

  function seedAliceLatest(wf, currentWeek) {
    writeWinnersState(
      {
        version: 1,
        lastFinalizedWeek: "2026-08-03",
        latest: {
          week: "2026-08-03",
          finalizedAt: 1,
          announced: true,
          winners: [
            { telegramUserId: "1", name: "Alice", weeklyPoints: 42 },
            { telegramUserId: "2", name: "Bob", weeklyPoints: 31 },
          ],
        },
        current: { week: currentWeek, standings: {}, updatedAt: 1 },
      },
      wf
    );
  }

  for (let i = 1; i <= 10; i += 1) {
    await runTest(`deterministic Sunday 23:59 UTC display ${i}/10`, async () => {
      const wf = winnersFile();
      seedAliceLatest(wf, "2026-08-03");
      const ctx = mockCtx();
      await handleWeeklyWinners(ctx, { winnersFile: wf, now: sundayUtc });
      assert.ok(ctx.replies[0].text.includes("Alice — 42 XP"));
      assert.strictEqual(readWinnersState(wf).latest.week, "2026-08-03");
    });
  }

  for (let i = 1; i <= 10; i += 1) {
    await runTest(`deterministic Monday 00:00 UTC boundary ${i}/10`, async () => {
      const wf = winnersFile();
      seedAliceLatest(wf, "2026-08-10");
      const result = syncAndFinalizeWeeklyWinners({
        winnersFile: wf,
        now: mondayMidnightUtc,
      });
      assert.strictEqual(getWeekId(mondayMidnightUtc), "2026-08-10");
      assert.strictEqual(result.finalized, false);
      const ctx = mockCtx();
      await handleWeeklyWinners(ctx, { winnersFile: wf, now: mondayMidnightUtc });
      assert.ok(ctx.replies[0].text.includes("Alice — 42 XP"));
    });
  }

  for (let i = 1; i <= 10; i += 1) {
    await runTest(`deterministic Monday daytime display ${i}/10`, async () => {
      const wf = winnersFile();
      seedAliceLatest(wf, "2026-08-10");
      const ctx = mockCtx();
      await handleWeeklyWinners(ctx, { winnersFile: wf, now: mondayDayUtc });
      assert.ok(ctx.replies[0].text.includes("Alice — 42 XP"));
      assert.ok(ctx.replies[0].text.includes("Bob — 31 XP"));
    });
  }

  await runTest("corrupt winners file is not overwritten by sync", () => {
    const wf = winnersFile();
    fs.writeFileSync(wf, "{not-json", "utf8");
    const result = syncAndFinalizeWeeklyWinners({
      winnersFile: wf,
      now: mondayDayUtc,
    });
    assert.strictEqual(result.finalized, false);
    assert.strictEqual(fs.readFileSync(wf, "utf8"), "{not-json");
  });

  console.log("\nAll weekly-winners tests passed.");
  restoreEnv();
}

main().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
