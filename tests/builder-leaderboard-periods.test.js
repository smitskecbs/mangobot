/**
 * Community Builder weekly / monthly / all-time leaderboards and group share.
 * Run: node tests/builder-leaderboard-periods.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  configureCommunityBuilderForTests,
  getOrCreateInviteLink,
  handleChatMemberUpdate,
  tryWalletMilestone,
  tryActiveMilestone,
  builderSummary,
  getBuilderLeaderboard,
  getBuilderStats,
  startOfUtcWeekMs,
  startOfUtcMonthMs,
  builderEventId,
  BUILDER_EVENT_REASON,
  BUILDER_PERIOD,
  formatBuilderLeaderboard,
  shareBuilderLeaderboard,
} = require("../services/communityBuilder");
const { getWeekId } = require("../services/points");
const { loadBuilderStore, mutateBuilderStore } = require("../services/communityBuilderStore");
const {
  handleBuilderBoard,
  handleBuilderCallback,
  handleBuilderStats,
  BUILDER_CALLBACK,
  leaderboardText,
  periodChooserText,
} = require("../commands/communitybuilder");
const { registerManualWallet, setWalletFileForTests } = require("../services/walletLinks");
const { mutatePoints, loadPoints, awardMangoBombXp, canEarnXp } = require("../services/points");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-builder-periods-"));
const COMMUNITY_CHAT = "-1003916996602";
const INVITER = "1001";
const REFERRED = "2002";
const OTHER = "3003";
const ADMIN_ID = "9001";

const originalChat = process.env.TELEGRAM_CHAT_ID;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.TELEGRAM_CHAT_ID = COMMUNITY_CHAT;
process.env.ADMIN_USER_ID = ADMIN_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

let n = 0;
function harness(now) {
  n += 1;
  const storeFile = path.join(tempDir, `builder-${n}.json`);
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  configureCommunityBuilderForTests({
    storeFile,
    pointsFile,
    walletFile,
    chatId: COMMUNITY_CHAT,
    now,
    notify: () => Promise.resolve({ sent: true }),
    createChatInviteLink: async () => ({ invite_link: `https://t.me/+hash${n}abc` }),
    botId: 55,
  });
  setWalletFileForTests(walletFile);
  return {
    storeFile,
    pointsFile,
    walletFile,
    opts: {
      storeFile,
      pointsFile,
      walletFile,
      chatId: COMMUNITY_CHAT,
      now,
    },
  };
}

function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    address: encodeBase58(publicKeyRaw),
    sign(message) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      return signEd25519Detached(buf, privateKey);
    },
  };
}

function joinUpdate(userId, inviteLink, extra = {}) {
  return {
    chat: { id: Number(COMMUNITY_CHAT) },
    from: { id: Number(userId), is_bot: false, first_name: extra.name || "Bob" },
    old_chat_member: {
      status: "left",
      user: { id: Number(userId), is_bot: false, first_name: extra.name || "Bob" },
    },
    new_chat_member: {
      status: "member",
      user: { id: Number(userId), is_bot: false, first_name: extra.name || "Bob" },
    },
    invite_link: { invite_link: inviteLink },
  };
}

async function seedInvite(h, user = { id: INVITER, first_name: "Alice" }) {
  const created = await getOrCreateInviteLink(user, h.opts);
  assert.strictEqual(created.ok, true, created.message);
  return created;
}

function mockCtx(extra = {}) {
  const replies = [];
  const edits = [];
  const text = extra.text || "/builderboard";
  return {
    chat: { type: extra.chatType || "private", id: extra.chatId || 1 },
    from: {
      id: extra.userId || Number(INVITER),
      first_name: extra.name || "Alice",
      is_bot: false,
    },
    message: { text },
    botInfo: { username: "ManGoTestBot", id: 55 },
    telegram: extra.telegram || {},
    callbackQuery: extra.callbackData ? { data: extra.callbackData } : undefined,
    replies,
    edits,
    reply(msg, extraArg) {
      replies.push({ text: msg, extra: extraArg });
      return Promise.resolve();
    },
    editMessageText(msg, extraArg) {
      edits.push({ text: msg, extra: extraArg });
      return Promise.resolve();
    },
    answerCbQuery() {
      return Promise.resolve();
    },
  };
}

function putEvent(storeFile, event) {
  mutateBuilderStore((store) => {
    if (!store.builderEvents) {
      store.builderEvents = {};
    }
    store.builderEvents[event.eventId] = event;
    if (!store.builders[event.builderUserId]) {
      store.builders[event.builderUserId] = {
        points: 0,
        referralIds: [],
        displayName: event.displayName || "Member",
        createdAt: event.createdAt,
        activeInviteId: null,
      };
    }
  }, storeFile);
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

async function main() {
  await runTest("1-4. join/wallet/active events once, no duplicates", async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const h = harness(now);
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    handleChatMemberUpdate(joinUpdate(REFERRED, created.inviteUrl), h.opts);
    const afterJoin = loadBuilderStore(h.storeFile);
    const joinId = builderEventId(REFERRED, BUILDER_EVENT_REASON.JOIN);
    assert.ok(afterJoin.builderEvents[joinId]);
    assert.strictEqual(afterJoin.builderEvents[joinId].reason, BUILDER_EVENT_REASON.JOIN);
    assert.strictEqual(afterJoin.builderEvents[joinId].points, 1);
    assert.strictEqual(afterJoin.builderEvents[joinId].createdAt, now);
    handleChatMemberUpdate(joinUpdate(REFERRED, created.inviteUrl), h.opts);
    assert.strictEqual(
      Object.keys(loadBuilderStore(h.storeFile).builderEvents).length,
      1
    );

    registerManualWallet(REFERRED, generateSolanaWallet().address, h.walletFile);
    tryWalletMilestone(REFERRED, h.opts);
    tryWalletMilestone(REFERRED, h.opts);
    const afterWallet = loadBuilderStore(h.storeFile);
    const walletId = builderEventId(REFERRED, BUILDER_EVENT_REASON.WALLET);
    assert.ok(afterWallet.builderEvents[walletId]);
    assert.strictEqual(afterWallet.builderEvents[walletId].points, 1);

    mutatePoints((data) => {
      data.users[REFERRED] = { name: "Bob", points: 5, weeklyPoints: 0 };
    }, h.pointsFile);
    tryActiveMilestone(REFERRED, h.opts);
    tryActiveMilestone(REFERRED, h.opts);
    const afterActive = loadBuilderStore(h.storeFile);
    const activeId = builderEventId(REFERRED, BUILDER_EVENT_REASON.ACTIVE);
    assert.ok(afterActive.builderEvents[activeId]);
    assert.strictEqual(afterActive.builderEvents[activeId].points, 2);
    assert.strictEqual(Object.keys(afterActive.builderEvents).length, 3);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 4);
  });

  await runTest("5/15/17. existing all-time totals kept; weekly ignores legacy BP", async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const h = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 12,
        referralIds: [],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
    }, h.storeFile);
    const alltime = getBuilderLeaderboard({ ...h.opts, period: "alltime", now });
    assert.strictEqual(alltime[0].displayName, "Alice");
    assert.strictEqual(alltime[0].points, 12);
    const weekly = getBuilderLeaderboard({ ...h.opts, period: "weekly", now });
    assert.strictEqual(weekly.length, 0);
    const monthly = getBuilderLeaderboard({ ...h.opts, period: "monthly", now });
    assert.strictEqual(monthly.length, 0);
  });

  await runTest("6-10. weekly Monday/Sunday UTC boundaries and sorting", async () => {
    const sunday = Date.UTC(2026, 7, 9, 23, 59, 0);
    const monday = Date.UTC(2026, 7, 10, 0, 0, 0);
    assert.strictEqual(getWeekId(new Date(sunday)), "2026-08-03");
    assert.strictEqual(getWeekId(new Date(monday)), "2026-08-10");
    assert.strictEqual(startOfUtcWeekMs(sunday), Date.parse("2026-08-03T00:00:00.000Z"));
    assert.strictEqual(startOfUtcWeekMs(monday), Date.parse("2026-08-10T00:00:00.000Z"));

    const h = harness(sunday);
    putEvent(h.storeFile, {
      eventId: "r1:join",
      builderUserId: INVITER,
      points: 8,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "r1",
      createdAt: sunday,
      displayName: "Alice",
    });
    putEvent(h.storeFile, {
      eventId: "r2:join",
      builderUserId: OTHER,
      points: 4,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "r2",
      createdAt: sunday - 7 * 24 * 60 * 60 * 1000,
      displayName: "Lojay",
    });
    putEvent(h.storeFile, {
      eventId: "r3:join",
      builderUserId: ADMIN_ID,
      points: 6,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "r3",
      createdAt: sunday,
      displayName: "Kevin",
    });
    mutateBuilderStore((store) => {
      store.builders[INVITER].points = 8;
      store.builders[OTHER].points = 4;
      store.builders[ADMIN_ID].points = 6;
    }, h.storeFile);

    const weekly = getBuilderLeaderboard("weekly", { ...h.opts, now: sunday });
    assert.strictEqual(weekly.length, 2);
    assert.strictEqual(weekly[0].displayName, "Alice");
    assert.strictEqual(weekly[0].points, 8);
    assert.strictEqual(weekly[1].displayName, "Kevin");
    assert.strictEqual(weekly[1].points, 6);
    assert.ok(!weekly.some((row) => row.displayName === "Lojay"));

    const nextWeek = getBuilderLeaderboard("weekly", { ...h.opts, now: monday });
    assert.strictEqual(nextWeek.length, 0);
  });

  await runTest("11-14. monthly first-day and Dec→Jan year boundary", async () => {
    const dec31 = Date.UTC(2026, 11, 31, 23, 59, 0);
    const jan1 = Date.UTC(2027, 0, 1, 0, 0, 0);
    assert.strictEqual(startOfUtcMonthMs(dec31), Date.UTC(2026, 11, 1));
    assert.strictEqual(startOfUtcMonthMs(jan1), Date.UTC(2027, 0, 1));

    const h = harness(dec31);
    putEvent(h.storeFile, {
      eventId: "d1:join",
      builderUserId: INVITER,
      points: 24,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "d1",
      createdAt: dec31,
      displayName: "Alice",
    });
    putEvent(h.storeFile, {
      eventId: "d2:join",
      builderUserId: OTHER,
      points: 13,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "d2",
      createdAt: Date.UTC(2026, 10, 30, 12, 0, 0),
      displayName: "Lojay",
    });
    putEvent(h.storeFile, {
      eventId: "d3:wallet",
      builderUserId: ADMIN_ID,
      points: 18,
      reason: BUILDER_EVENT_REASON.WALLET,
      referralUserId: "d3",
      createdAt: Date.UTC(2026, 11, 1, 0, 0, 0),
      displayName: "Kevin",
    });
    mutateBuilderStore((store) => {
      store.builders[INVITER].points = 24;
      store.builders[OTHER].points = 13;
      store.builders[ADMIN_ID].points = 18;
    }, h.storeFile);

    const december = getBuilderLeaderboard("monthly", { ...h.opts, now: dec31 });
    assert.strictEqual(december[0].displayName, "Alice");
    assert.strictEqual(december[0].points, 24);
    assert.strictEqual(december[1].displayName, "Kevin");
    assert.strictEqual(december[1].points, 18);
    assert.ok(!december.some((row) => row.displayName === "Lojay"));

    const january = getBuilderLeaderboard("monthly", { ...h.opts, now: jan1 });
    assert.strictEqual(january.length, 0);
  });

  await runTest("16. new events reflected on all-time", async () => {
    const now = Date.UTC(2026, 7, 12, 15, 0, 0);
    const h = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 10,
        referralIds: [],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
    }, h.storeFile);
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    handleChatMemberUpdate(joinUpdate(REFERRED, created.inviteUrl), h.opts);
    const alltime = getBuilderLeaderboard({ ...h.opts, period: "alltime", now });
    assert.strictEqual(alltime[0].points, 11);
  });

  await runTest("18-23. period chooser, buttons, back, period preserved", async () => {
    const h = harness(Date.now());
    const chooser = mockCtx({ callbackData: BUILDER_CALLBACK.BOARD });
    await handleBuilderCallback(chooser, h.opts);
    const view = chooser.edits[0] || chooser.replies[0];
    assert.ok(view.text.includes(periodChooserText().split("\n")[0]));
    const labels = JSON.stringify(view.extra);
    assert.ok(labels.includes("Weekly"));
    assert.ok(labels.includes("Monthly"));
    assert.ok(labels.includes("All-time"));
    assert.ok(labels.includes(BUILDER_CALLBACK.WEEKLY));
    assert.ok(labels.includes(BUILDER_CALLBACK.MONTHLY));
    assert.ok(labels.includes(BUILDER_CALLBACK.ALLTIME));
    assert.ok(labels.includes(BUILDER_CALLBACK.HOME));

    const weeklyBtn = mockCtx({ callbackData: BUILDER_CALLBACK.WEEKLY });
    await handleBuilderCallback(weeklyBtn, h.opts);
    const weeklyView = weeklyBtn.edits[0] || weeklyBtn.replies[0];
    assert.ok(weeklyView.text.includes("Weekly Community Builders"));
    assert.ok(JSON.stringify(weeklyView.extra).includes(BUILDER_CALLBACK.SHARE_WEEKLY) === false);
    assert.ok(JSON.stringify(weeklyView.extra).includes(BUILDER_CALLBACK.PERIODS));

    const adminWeekly = mockCtx({
      callbackData: BUILDER_CALLBACK.WEEKLY,
      userId: Number(ADMIN_ID),
    });
    await handleBuilderCallback(adminWeekly, h.opts);
    const adminView = adminWeekly.edits[0] || adminWeekly.replies[0];
    assert.ok(JSON.stringify(adminView.extra).includes(BUILDER_CALLBACK.SHARE_WEEKLY));

    const back = mockCtx({ callbackData: BUILDER_CALLBACK.PERIODS });
    await handleBuilderCallback(back, h.opts);
    const backView = back.edits[0] || back.replies[0];
    assert.ok(backView.text.includes("Choose a period"));
  });

  await runTest("24-30. admin-only share, TELEGRAM_CHAT_ID, no topic/uid leak", async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const h = harness(now);
    putEvent(h.storeFile, {
      eventId: "s1:join",
      builderUserId: INVITER,
      points: 8,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "s1",
      createdAt: now,
      displayName: "Alice",
    });
    mutateBuilderStore((store) => {
      store.builders[INVITER].points = 8;
    }, h.storeFile);

    const denied = await shareBuilderLeaderboard("weekly", {
      ...h.opts,
      adminUserId: INVITER,
      shareToGroup: true,
      botToken: "TESTTOKEN",
    });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, "not-admin");

    const posts = [];
    const weeklyShare = await shareBuilderLeaderboard("weekly", {
      ...h.opts,
      adminUserId: ADMIN_ID,
      shareToGroup: true,
      botToken: "TESTTOKEN",
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(init.body));
        return { ok: true };
      },
    });
    assert.strictEqual(weeklyShare.ok, true);
    assert.strictEqual(String(posts[0].chat_id), COMMUNITY_CHAT);
    assert.strictEqual(posts[0].message_thread_id, undefined);
    assert.ok(posts[0].text.includes("Weekly Community Builders"));
    assert.ok(posts[0].text.includes("Alice — 8 BP"));
    assert.ok(posts[0].text.includes("Who will climb the board next week"));
    assert.ok(!posts[0].text.includes(INVITER));
    assert.ok(!JSON.stringify(posts[0]).includes("message_thread_id"));
    assert.ok(!/wallet/i.test(posts[0].text));

    posts.length = 0;
    await shareBuilderLeaderboard("monthly", {
      ...h.opts,
      adminUserId: ADMIN_ID,
      shareToGroup: true,
      botToken: "TESTTOKEN",
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(init.body));
        return { ok: true };
      },
    });
    assert.ok(posts[0].text.includes("Monthly Community Builders"));

    posts.length = 0;
    await shareBuilderLeaderboard("alltime", {
      ...h.opts,
      adminUserId: ADMIN_ID,
      shareToGroup: true,
      botToken: "TESTTOKEN",
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(init.body));
        return { ok: true };
      },
    });
    assert.ok(posts[0].text.includes("All-time Community Builders"));

    const nonAdminCb = mockCtx({
      callbackData: BUILDER_CALLBACK.SHARE_WEEKLY,
      userId: Number(INVITER),
    });
    await handleBuilderCallback(nonAdminCb, {
      ...h.opts,
      botToken: "TESTTOKEN",
      fetchImpl: async () => ({ ok: true }),
    });
    const rejected = (nonAdminCb.replies[0] || nonAdminCb.edits[0]).text;
    assert.ok(rejected.includes("Only admins"));
  });

  await runTest("31-34. /builderboard default alltime, weekly/monthly args, invalid safe", async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const h = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 52,
        referralIds: [],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
    }, h.storeFile);
    putEvent(h.storeFile, {
      eventId: "c1:join",
      builderUserId: INVITER,
      points: 3,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "c1",
      createdAt: now,
      displayName: "Alice",
    });

    const def = mockCtx({ text: "/builderboard", userId: Number(ADMIN_ID) });
    handleBuilderBoard(def, h.opts);
    assert.ok(def.replies[0].text.includes("All-time Community Builders"));
    assert.ok(def.replies[0].text.includes("Alice — 52 BP"));

    const weekly = mockCtx({ text: "/builderboard weekly", userId: Number(ADMIN_ID) });
    handleBuilderBoard(weekly, h.opts);
    assert.ok(weekly.replies[0].text.includes("Weekly Community Builders"));
    assert.ok(weekly.replies[0].text.includes("Alice — 3 BP"));

    const monthly = mockCtx({ text: "/builderboard monthly" });
    handleBuilderBoard(monthly, h.opts);
    assert.ok(monthly.replies[0].text.includes("Monthly Community Builders"));

    const bad = mockCtx({ text: "/builderboard potato" });
    handleBuilderBoard(bad, h.opts);
    assert.ok(bad.replies[0].text.includes("weekly, monthly, or alltime"));
  });

  await runTest("35-37. persistence, fail-closed, no production files", async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const h = harness(now);
    putEvent(h.storeFile, {
      eventId: "p1:join",
      builderUserId: INVITER,
      points: 5,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "p1",
      createdAt: now,
      displayName: "Alice",
    });
    mutateBuilderStore((store) => {
      store.builders[INVITER].points = 5;
    }, h.storeFile);
    configureCommunityBuilderForTests({ storeFile: h.storeFile, chatId: COMMUNITY_CHAT, now });
    const again = getBuilderLeaderboard("weekly", { storeFile: h.storeFile, now });
    assert.strictEqual(again[0].points, 5);

    const corrupt = path.join(tempDir, "corrupt-periods.json");
    fs.writeFileSync(corrupt, "{not-json", "utf8");
    assert.throws(() => {
      mutateBuilderStore((store) => {
        store.builders.x = { points: 1 };
      }, corrupt);
    });
    assert.strictEqual(fs.readFileSync(corrupt, "utf8"), "{not-json");

    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
    }
  });

  await runTest("38-42. referral/XP/alltime semantics unchanged", async () => {
    const h = harness(Date.now());
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    handleChatMemberUpdate(joinUpdate(REFERRED, created.inviteUrl, { name: "Bob" }), h.opts);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 1);
    registerManualWallet(REFERRED, generateSolanaWallet().address, h.walletFile);
    tryWalletMilestone(REFERRED, h.opts);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 2);
    mutatePoints((data) => {
      data.users[REFERRED] = { name: "Bob", points: 5, weeklyPoints: 0 };
    }, h.pointsFile);
    tryActiveMilestone(REFERRED, h.opts);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 4);
    assert.strictEqual(loadPoints(h.pointsFile).users[INVITER].points, 2);
    assert.strictEqual(canEarnXp(INVITER, h.walletFile), true);
    const bomb = awardMangoBombXp(INVITER, "Alice", 1, "round-p", h.pointsFile, h.walletFile);
    assert.strictEqual(bomb.awarded, true);
    const alltime = getBuilderLeaderboard(h.opts);
    assert.strictEqual(alltime[0].points, 4);
    assert.ok(leaderboardText(alltime).includes("All-time Community Builders"));
    assert.ok(!leaderboardText(alltime).includes(INVITER));
  });

  await runTest("builderstats includes period BP totals", async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const h = harness(now);
    putEvent(h.storeFile, {
      eventId: "st:join",
      builderUserId: INVITER,
      points: 1,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "st",
      createdAt: now,
      displayName: "Alice",
    });
    mutateBuilderStore((store) => {
      store.builders[INVITER].points = 9;
    }, h.storeFile);
    const stats = getBuilderStats({ ...h.opts, now });
    assert.strictEqual(stats.weekBp, 1);
    assert.strictEqual(stats.monthBp, 1);
    assert.strictEqual(stats.allTimeBp, 9);
    const admin = mockCtx({ userId: Number(ADMIN_ID) });
    handleBuilderStats(admin, { ...h.opts, now });
    assert.ok(admin.replies[0].text.includes("This week BP: 1"));
    assert.ok(admin.replies[0].text.includes("All-time BP: 9"));
  });

  await runTest("formatBuilderLeaderboard empty weekly copy", () => {
    const text = formatBuilderLeaderboard([], "weekly");
    assert.strictEqual(
      text,
      "🏆 Weekly Community Builders\n\nNo Builder Points earned this week yet."
    );
  });

  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;

  console.log("builder-leaderboard-periods tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
