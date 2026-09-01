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
  reconcileBuilderEventHistory,
  persistReconcileBuilderEvents,
} = require("../services/communityBuilder");
const { getWeekId } = require("../services/points");
const { loadBuilderStore, mutateBuilderStore } = require("../services/communityBuilderStore");
const {
  handleBuilderBoard,
  handleBuilderCallback,
  handleBuilderStats,
  BUILDER_CALLBACK,
  GROUP_BOARD_CALLBACK,
  leaderboardText,
  periodChooserText,
  handleGroupLeaderboardCallback,
  handleCommunityBuilder,
  resetOpenBoardCooldownForTests,
  OPEN_BOARD_COOLDOWN_MS,
  OPEN_BOARD_COOLDOWN_TEXT,
  OPEN_BOARD_OPENED_TEXT,
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

async function waitUntil(predicate) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if (predicate()) {
        return;
      }
    } catch (_err) {
      /* File may be mid-rename; retry. */
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "timed out waiting for async builder XP");
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
      is_bot: Boolean(extra.isBot),
    },
    message: { text },
    botInfo: { username: "ManGoTestBot", id: 55 },
    telegram: extra.telegram || {},
    callbackQuery: extra.callbackData ? { data: extra.callbackData } : undefined,
    replies,
    edits,
    cbAnswers: [],
    reply(msg, extraArg) {
      replies.push({ text: msg, extra: extraArg });
      return Promise.resolve();
    },
    editMessageText(msg, extraArg) {
      if (typeof extra.editImpl === "function") {
        return extra.editImpl(msg, extraArg);
      }
      edits.push({ text: msg, extra: extraArg });
      return Promise.resolve();
    },
    answerCbQuery(msg) {
      this.cbAnswers.push(msg || "");
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
    await handleChatMemberUpdate(joinUpdate(REFERRED, created.inviteUrl), h.opts);
    const afterJoin = loadBuilderStore(h.storeFile);
    const joinId = builderEventId(REFERRED, BUILDER_EVENT_REASON.JOIN);
    assert.ok(afterJoin.builderEvents[joinId]);
    assert.strictEqual(afterJoin.builderEvents[joinId].reason, BUILDER_EVENT_REASON.JOIN);
    assert.strictEqual(afterJoin.builderEvents[joinId].points, 1);
    assert.strictEqual(afterJoin.builderEvents[joinId].createdAt, now);
    await handleChatMemberUpdate(joinUpdate(REFERRED, created.inviteUrl), h.opts);
    assert.strictEqual(
      Object.keys(loadBuilderStore(h.storeFile).builderEvents).length,
      1
    );

    registerManualWallet(REFERRED, generateSolanaWallet().address, h.walletFile);
    await tryWalletMilestone(REFERRED, h.opts);
    await tryWalletMilestone(REFERRED, h.opts);
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
    await handleChatMemberUpdate(joinUpdate(REFERRED, created.inviteUrl), h.opts);
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
    await handleChatMemberUpdate(joinUpdate(REFERRED, created.inviteUrl, { name: "Bob" }), h.opts);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 1);
    registerManualWallet(REFERRED, generateSolanaWallet().address, h.walletFile);
    await waitUntil(
      () =>
        builderSummary(INVITER, h.opts).builderPoints === 2 &&
        loadPoints(h.pointsFile).users[INVITER] &&
        loadPoints(h.pointsFile).users[INVITER].points === 2
    );
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 2);
    mutatePoints((data) => {
      data.users[REFERRED] = { name: "Bob", points: 5, weeklyPoints: 0 };
    }, h.pointsFile);
    tryActiveMilestone(REFERRED, h.opts);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 4);
    assert.strictEqual(loadPoints(h.pointsFile).users[INVITER].points, 2);
    assert.strictEqual(canEarnXp(INVITER, h.walletFile), true);
    const bomb = await awardMangoBombXp(INVITER, "Alice", 1, "round-p", h.pointsFile, h.walletFile);
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

  await runTest("1-15. reconstruct events from referral timestamps, no double BP", async () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const lastWeek = Date.UTC(2026, 7, 10, 12, 0, 0);
    const h = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 4,
        referralIds: [REFERRED],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
      store.referrals[REFERRED] = {
        inviterUserId: INVITER,
        joinedAt: now,
        inviteId: "hash",
        displayName: "Bob",
        walletMilestoneAt: now,
        activeMilestoneAt: now,
      };
    }, h.storeFile);
    assert.strictEqual(Object.keys(loadBuilderStore(h.storeFile).builderEvents || {}).length, 0);
    const first = persistReconcileBuilderEvents(h.storeFile);
    assert.strictEqual(first.added, 3);
    const store = loadBuilderStore(h.storeFile);
    assert.strictEqual(store.builders[INVITER].points, 4);
    assert.strictEqual(store.builderEvents[`${REFERRED}:join`].createdAt, now);
    assert.strictEqual(store.builderEvents[`${REFERRED}:wallet`].points, 1);
    assert.strictEqual(store.builderEvents[`${REFERRED}:active`].points, 2);
    const weekly = getBuilderLeaderboard("weekly", { ...h.opts, now });
    assert.strictEqual(weekly[0].points, 4);
    const monthly = getBuilderLeaderboard("monthly", { ...h.opts, now });
    assert.strictEqual(monthly[0].points, 4);
    const alltime = getBuilderLeaderboard("alltime", { ...h.opts, now });
    assert.strictEqual(alltime[0].points, 4);
    const second = persistReconcileBuilderEvents(h.storeFile);
    assert.strictEqual(second.added, 0);
    assert.strictEqual(loadBuilderStore(h.storeFile).builders[INVITER].points, 4);

    const h2 = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 3,
        referralIds: ["5005", "5006"],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
      store.referrals["5005"] = {
        inviterUserId: INVITER,
        joinedAt: lastWeek,
        inviteId: "o",
        displayName: "Old",
        walletMilestoneAt: lastWeek,
        activeMilestoneAt: null,
      };
      store.referrals["5006"] = {
        inviterUserId: INVITER,
        joinedAt: now,
        inviteId: "n",
        displayName: "New",
        walletMilestoneAt: null,
        activeMilestoneAt: null,
      };
    }, h2.storeFile);
    persistReconcileBuilderEvents(h2.storeFile);
    const week2 = getBuilderLeaderboard("weekly", { ...h2.opts, now });
    assert.strictEqual(week2[0].points, 1);
    const month2 = getBuilderLeaderboard("monthly", { ...h2.opts, now });
    assert.strictEqual(month2[0].points, 3);

    const h3 = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 8,
        referralIds: ["5007"],
        displayName: "Alice",
        createdAt: now,
        activeInviteId: null,
      };
      store.referrals["5007"] = {
        inviterUserId: INVITER,
        joinedAt: null,
        inviteId: "x",
        displayName: "NoStamp",
        walletMilestoneAt: null,
        activeMilestoneAt: null,
      };
    }, h3.storeFile);
    const none = persistReconcileBuilderEvents(h3.storeFile);
    assert.strictEqual(none.added, 0);
    assert.strictEqual(getBuilderLeaderboard("weekly", { ...h3.opts, now }).length, 0);
    assert.strictEqual(getBuilderLeaderboard("alltime", { ...h3.opts, now })[0].points, 8);

    const h4 = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 2,
        referralIds: [REFERRED],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
      store.referrals[REFERRED] = {
        inviterUserId: INVITER,
        joinedAt: now,
        inviteId: "p",
        displayName: "Bob",
        walletMilestoneAt: now,
        activeMilestoneAt: null,
      };
      store.builderEvents[`${REFERRED}:join`] = {
        eventId: `${REFERRED}:join`,
        builderUserId: INVITER,
        points: 1,
        reason: BUILDER_EVENT_REASON.JOIN,
        referralUserId: REFERRED,
        createdAt: now,
      };
    }, h4.storeFile);
    const partial = persistReconcileBuilderEvents(h4.storeFile);
    assert.strictEqual(partial.added, 1);
    assert.ok(loadBuilderStore(h4.storeFile).builderEvents[`${REFERRED}:wallet`]);
    assert.strictEqual(loadBuilderStore(h4.storeFile).builders[INVITER].points, 2);

    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    await handleChatMemberUpdate(joinUpdate(OTHER, created.inviteUrl), { ...h.opts, now });
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 5);
    assert.ok(loadBuilderStore(h.storeFile).builderEvents[`${OTHER}:join`]);
  });

  await runTest("16-32. group /builderboard board + period edits, no leak", async () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 8,
        referralIds: [],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
    }, h.storeFile);
    putEvent(h.storeFile, {
      eventId: "g1:join",
      builderUserId: INVITER,
      points: 8,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "g1",
      createdAt: now,
      displayName: "Alice",
    });

    const group = mockCtx({
      chatType: "supergroup",
      chatId: Number(COMMUNITY_CHAT),
      text: "/builderboard",
    });
    handleBuilderBoard(group, { ...h.opts, now });
    assert.ok(group.replies[0].text.includes("All-time Community Builders"));
    const extra = JSON.stringify(group.replies[0].extra);
    assert.ok(extra.includes("Weekly"));
    assert.ok(extra.includes("Monthly"));
    assert.ok(extra.includes("All-time"));
    assert.ok(extra.includes(GROUP_BOARD_CALLBACK.WEEKLY));
    assert.ok(extra.includes(GROUP_BOARD_CALLBACK.MONTHLY));
    assert.ok(extra.includes(GROUP_BOARD_CALLBACK.ALLTIME));
    assert.ok(!extra.includes("message_thread_id"));
    assert.ok(!group.replies[0].text.includes(INVITER));
    assert.ok(!/wallet/i.test(group.replies[0].text));

    const weeklyCb = mockCtx({
      chatType: "supergroup",
      chatId: Number(COMMUNITY_CHAT),
      callbackData: GROUP_BOARD_CALLBACK.WEEKLY,
    });
    await handleGroupLeaderboardCallback(weeklyCb, { ...h.opts, now });
    assert.strictEqual(weeklyCb.cbAnswers.length, 1);
    assert.ok(weeklyCb.edits[0].text.includes("Weekly Community Builders"));
    assert.ok(weeklyCb.edits[0].text.includes("This week"));
    assert.ok(JSON.stringify(weeklyCb.edits[0].extra).includes(GROUP_BOARD_CALLBACK.MONTHLY));

    const monthlyCb = mockCtx({
      chatType: "supergroup",
      chatId: Number(COMMUNITY_CHAT),
      callbackData: GROUP_BOARD_CALLBACK.MONTHLY,
    });
    await handleGroupLeaderboardCallback(monthlyCb, { ...h.opts, now });
    assert.ok(monthlyCb.edits[0].text.includes("Monthly Community Builders"));
    assert.ok(monthlyCb.edits[0].text.includes("August 2026"));

    const allCb = mockCtx({
      chatType: "supergroup",
      chatId: Number(COMMUNITY_CHAT),
      callbackData: GROUP_BOARD_CALLBACK.ALLTIME,
    });
    await handleGroupLeaderboardCallback(allCb, { ...h.opts, now });
    assert.ok(allCb.edits[0].text.includes("All-time Community Builders"));

    const unmodified = mockCtx({
      chatType: "supergroup",
      chatId: Number(COMMUNITY_CHAT),
      callbackData: GROUP_BOARD_CALLBACK.WEEKLY,
      editImpl: () => {
        const err = new Error("Bad Request: message is not modified");
        err.description = "Bad Request: message is not modified";
        throw err;
      },
    });
    await handleGroupLeaderboardCallback(unmodified, { ...h.opts, now });
    assert.strictEqual(unmodified.cbAnswers.length, 1);

    const wrong = mockCtx({
      chatType: "supergroup",
      chatId: -1000000000001,
      callbackData: GROUP_BOARD_CALLBACK.WEEKLY,
    });
    await handleGroupLeaderboardCallback(wrong, { ...h.opts, now, chatId: COMMUNITY_CHAT });
    assert.strictEqual(wrong.edits.length, 0);

    const botCtx = mockCtx({
      chatType: "supergroup",
      chatId: Number(COMMUNITY_CHAT),
      callbackData: GROUP_BOARD_CALLBACK.WEEKLY,
      isBot: true,
    });
    await handleGroupLeaderboardCallback(botCtx, { ...h.opts, now });
    assert.strictEqual(botCtx.edits.length, 0);

    const privateBoard = mockCtx({ callbackData: BUILDER_CALLBACK.BOARD });
    await handleBuilderCallback(privateBoard, h.opts);
    const privateView = privateBoard.edits[0] || privateBoard.replies[0];
    assert.ok(privateView.text.includes("Choose a period"));

    const adminShare = mockCtx({
      callbackData: BUILDER_CALLBACK.WEEKLY,
      userId: Number(ADMIN_ID),
    });
    await handleBuilderCallback(adminShare, h.opts);
    const shareExtra = JSON.stringify((adminShare.edits[0] || adminShare.replies[0]).extra);
    assert.ok(shareExtra.includes(BUILDER_CALLBACK.SHARE_WEEKLY));

    const weeklyCmd = mockCtx({
      chatType: "supergroup",
      chatId: Number(COMMUNITY_CHAT),
      text: "/builderboard weekly",
    });
    handleBuilderBoard(weeklyCmd, { ...h.opts, now });
    assert.ok(weeklyCmd.replies[0].text.includes("Weekly Community Builders"));

    const pointsBefore = builderSummary(INVITER, h.opts).builderPoints;
    await handleGroupLeaderboardCallback(
      mockCtx({
        chatType: "supergroup",
        chatId: Number(COMMUNITY_CHAT),
        callbackData: GROUP_BOARD_CALLBACK.MONTHLY,
      }),
      { ...h.opts, now }
    );
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, pointsBefore);

    const src = fs.readFileSync(
      path.join(__dirname, "..", "commands", "communitybuilder.js"),
      "utf8"
    );
    assert.ok(!src.includes("TELEGRAM_GAMES_TOPIC_ID"));
    assert.ok(!src.includes("gameTopic"));
  });

  await runTest("open builder board from private menu", async () => {
    resetOpenBoardCooldownForTests();
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now);
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 8,
        referralIds: [],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
    }, h.storeFile);
    putEvent(h.storeFile, {
      eventId: "ob1:join",
      builderUserId: INVITER,
      points: 8,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: "4004",
      createdAt: now,
      displayName: "Alice",
    });

    const home = mockCtx({ chatType: "private", userId: Number(INVITER) });
    handleCommunityBuilder(home, h.opts);
    const homeExtra = JSON.stringify(home.replies[0].extra);
    assert.ok(homeExtra.includes("🏆 Open Builder Board"));
    assert.ok(homeExtra.includes(BUILDER_CALLBACK.OPEN_BOARD));
    assert.ok(homeExtra.includes("🏆 Builder Leaderboard"));
    assert.ok(homeExtra.includes(BUILDER_CALLBACK.BOARD));

    const posts = [];
    const telegram = {
      async sendMessage(chatId, text, extra) {
        posts.push({ chat_id: chatId, text, extra });
        return { message_id: posts.length };
      },
    };
    const storeBefore = JSON.stringify(loadBuilderStore(h.storeFile));
    const pointsBefore = JSON.stringify(loadPoints(h.pointsFile));
    const bpBefore = builderSummary(INVITER, h.opts).builderPoints;

    const member = mockCtx({
      callbackData: BUILDER_CALLBACK.OPEN_BOARD,
      userId: Number(INVITER),
      telegram,
    });
    await handleBuilderCallback(member, { ...h.opts, now });
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(String(posts[0].chat_id), COMMUNITY_CHAT);
    assert.ok(posts[0].text.includes("All-time Community Builders"));
    assert.ok(posts[0].text.includes("Alice — 8 BP"));
    assert.ok(!posts[0].text.includes(INVITER));
    assert.ok(!/wallet/i.test(posts[0].text));
    const posted = JSON.stringify(posts[0]);
    assert.ok(!posted.includes("message_thread_id"));
    const postedExtra = JSON.stringify(posts[0].extra);
    assert.ok(postedExtra.includes(GROUP_BOARD_CALLBACK.WEEKLY));
    assert.ok(postedExtra.includes(GROUP_BOARD_CALLBACK.MONTHLY));
    assert.ok(postedExtra.includes(GROUP_BOARD_CALLBACK.ALLTIME));
    assert.ok(postedExtra.includes("📅 Weekly"));
    assert.ok(postedExtra.includes("🗓 Monthly"));
    assert.ok(postedExtra.includes("🌍 All-time"));
    assert.strictEqual(member.replies[0].text, OPEN_BOARD_OPENED_TEXT);

    const groupWeekly = mockCtx({
      chatType: "supergroup",
      chatId: Number(COMMUNITY_CHAT),
      callbackData: GROUP_BOARD_CALLBACK.WEEKLY,
      userId: Number(OTHER),
    });
    await handleGroupLeaderboardCallback(groupWeekly, { ...h.opts, now });
    assert.strictEqual(groupWeekly.cbAnswers.length, 1);
    assert.ok(groupWeekly.edits[0].text.includes("Weekly Community Builders"));

    const spam = mockCtx({
      callbackData: BUILDER_CALLBACK.OPEN_BOARD,
      userId: Number(INVITER),
      telegram,
    });
    await handleBuilderCallback(spam, { ...h.opts, now: now + 1_000 });
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(spam.replies[0].text, OPEN_BOARD_COOLDOWN_TEXT);

    const stillCool = mockCtx({
      callbackData: BUILDER_CALLBACK.OPEN_BOARD,
      userId: Number(INVITER),
      telegram,
    });
    await handleBuilderCallback(stillCool, {
      ...h.opts,
      now: now + OPEN_BOARD_COOLDOWN_MS - 1,
    });
    assert.strictEqual(posts.length, 1);

    const admin = mockCtx({
      callbackData: BUILDER_CALLBACK.OPEN_BOARD,
      userId: Number(ADMIN_ID),
      telegram,
    });
    await handleBuilderCallback(admin, { ...h.opts, now });
    assert.strictEqual(posts.length, 2);
    assert.strictEqual(String(posts[1].chat_id), COMMUNITY_CHAT);
    assert.ok(posts[1].text.includes("All-time Community Builders"));
    assert.strictEqual(admin.replies[0].text, OPEN_BOARD_OPENED_TEXT);

    const botCtx = mockCtx({
      callbackData: BUILDER_CALLBACK.OPEN_BOARD,
      userId: 777,
      isBot: true,
      telegram,
    });
    await handleBuilderCallback(botCtx, { ...h.opts, now });
    assert.strictEqual(posts.length, 2);
    assert.strictEqual(botCtx.replies.length, 0);

    const afterCooldown = mockCtx({
      callbackData: BUILDER_CALLBACK.OPEN_BOARD,
      userId: Number(INVITER),
      telegram,
    });
    await handleBuilderCallback(afterCooldown, {
      ...h.opts,
      now: now + OPEN_BOARD_COOLDOWN_MS,
    });
    assert.strictEqual(posts.length, 3);

    const chooser = mockCtx({ callbackData: BUILDER_CALLBACK.BOARD });
    await handleBuilderCallback(chooser, h.opts);
    const chooserView = chooser.edits[0] || chooser.replies[0];
    assert.ok(chooserView.text.includes("Choose a period"));
    const chooserExtra = JSON.stringify(chooserView.extra);
    assert.ok(chooserExtra.includes(BUILDER_CALLBACK.WEEKLY));
    assert.ok(chooserExtra.includes(BUILDER_CALLBACK.HOME));

    const adminWeekly = mockCtx({
      callbackData: BUILDER_CALLBACK.WEEKLY,
      userId: Number(ADMIN_ID),
    });
    await handleBuilderCallback(adminWeekly, h.opts);
    const adminView = adminWeekly.edits[0] || adminWeekly.replies[0];
    assert.ok(adminView.text.includes("Weekly Community Builders"));
    const shareExtra = JSON.stringify(adminView.extra);
    assert.ok(shareExtra.includes(BUILDER_CALLBACK.SHARE_WEEKLY));
    assert.ok(shareExtra.includes(BUILDER_CALLBACK.PERIODS));

    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, bpBefore);
    assert.strictEqual(JSON.stringify(loadBuilderStore(h.storeFile)), storeBefore);
    assert.strictEqual(JSON.stringify(loadPoints(h.pointsFile)), pointsBefore);

    const src = fs.readFileSync(
      path.join(__dirname, "..", "commands", "communitybuilder.js"),
      "utf8"
    );
    assert.ok(!src.includes("TELEGRAM_GAMES_TOPIC_ID"));
    assert.ok(!src.includes("gameTopic"));
    resetOpenBoardCooldownForTests();
  });

  await runTest("formatBuilderLeaderboard empty weekly copy", () => {
    const text = formatBuilderLeaderboard([], "weekly", "private", Date.UTC(2026, 7, 21));
    assert.ok(text.includes("🏆 Weekly Community Builders"));
    assert.ok(text.includes("Period:"));
    assert.ok(text.includes("This week"));
    assert.ok(text.includes("No Builder Points earned this week yet."));
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
