/**
 * Community Builder First Welcome awards.
 * Run: node tests/community-builder-welcome.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  configureCommunityBuilderForTests,
  handleChatMemberUpdate,
  registerWelcomeOpportunity,
  tryClaimFirstWelcome,
  isValidWelcomeText,
  builderSummary,
  getBuilderLeaderboard,
  firstWelcomeEventId,
  FIRST_WELCOME_POINTS,
  FIRST_WELCOME_WINDOW_MS,
  FIRST_WELCOME_DAILY_CAP,
  BUILDER_EVENT_REASON,
  JOIN_BUILDER_POINTS,
} = require("../services/communityBuilder");
const { loadBuilderStore } = require("../services/communityBuilderStore");
const { loadPoints, mutatePoints } = require("../services/points");
const { setWalletFileForTests } = require("../services/walletLinks");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-builder-welcome-"));
const COMMUNITY_CHAT = "-1003916996602";
const WELCOMER = "1001";
const OTHER = "3003";
const NEW_A = "5001";
const NEW_B = "5002";
const NEW_C = "5003";
const NEW_D = "5004";
const NEW_E = "5005";

const originalChat = process.env.TELEGRAM_CHAT_ID;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.TELEGRAM_CHAT_ID = COMMUNITY_CHAT;
process.env.ADMIN_USER_ID = "9001";

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
  fs.writeFileSync(walletFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  configureCommunityBuilderForTests({
    storeFile,
    pointsFile,
    walletFile,
    chatId: COMMUNITY_CHAT,
    now,
    notify: () => Promise.resolve({ sent: true }),
  });
  setWalletFileForTests(walletFile);
  return {
    storeFile,
    pointsFile,
    walletFile,
    opts: { storeFile, pointsFile, walletFile, chatId: COMMUNITY_CHAT, now },
  };
}

function joinUpdate(userId, extra = {}) {
  const user = {
    id: Number(userId),
    is_bot: Boolean(extra.isBot),
    first_name: extra.name || "New",
    username: extra.username,
  };
  return {
    chat: { id: Number(COMMUNITY_CHAT) },
    old_chat_member: { status: extra.oldStatus || "left", user },
    new_chat_member: { status: extra.newStatus || "member", user },
  };
}

function claim(h, extra = {}) {
  return tryClaimFirstWelcome(
    {
      chatId: COMMUNITY_CHAT,
      from: {
        id: extra.fromId || Number(WELCOMER),
        is_bot: Boolean(extra.isBot),
        first_name: extra.fromName || "Alice",
        username: extra.fromUsername,
      },
      text: extra.text,
      entities: extra.entities,
      replyTo: extra.replyTo,
      sticker: extra.sticker,
      animation: extra.animation,
      editDate: extra.editDate,
    },
    { ...h.opts, now: extra.now != null ? extra.now : h.opts.now }
  );
}

function validReply(h, newMemberId, extra = {}) {
  const store = loadBuilderStore(h.storeFile);
  const opp = store.welcomeOpportunities[String(newMemberId)];
  const replyId = extra.replyId != null ? extra.replyId : opp && opp.joinMessageId;
  return claim(h, {
    text: extra.text || "Welcome to ManGo!",
    fromId: extra.fromId,
    isBot: extra.isBot,
    now: extra.now,
    fromName: extra.fromName,
    replyTo: {
      message_id: replyId != null ? replyId : 10,
      from: extra.replyFrom || { id: Number(newMemberId), is_bot: false },
    },
  });
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
  await runTest("1. new member join opens welcome opportunity", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    handleChatMemberUpdate(
      joinUpdate(NEW_A, { username: "newmango", name: "New" }),
      { ...h.opts, now }
    );
    const opp = loadBuilderStore(h.storeFile).welcomeOpportunities[NEW_A];
    assert.ok(opp);
    assert.strictEqual(opp.joinedAt, now);
    assert.strictEqual(opp.expiresAt, now + FIRST_WELCOME_WINDOW_MS);
    assert.strictEqual(opp.claimedAt, null);
    assert.strictEqual(opp.permanentClaimed, false);
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 0);
  });

  await runTest("2-5. valid targeted welcome awards +1 weekly/monthly/all-time", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      {
        chatId: COMMUNITY_CHAT,
        userId: NEW_A,
        username: "newmango",
        displayName: "New",
        joinMessageId: 10,
      },
      { ...h.opts, now }
    );
    const result = validReply(h, NEW_A);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.points, FIRST_WELCOME_POINTS);
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 1);
    const weekly = getBuilderLeaderboard({ ...h.opts, period: "weekly", now });
    const monthly = getBuilderLeaderboard({ ...h.opts, period: "monthly", now });
    const alltime = getBuilderLeaderboard({ ...h.opts, period: "alltime", now });
    assert.strictEqual(weekly[0].points, 1);
    assert.strictEqual(monthly[0].points, 1);
    assert.strictEqual(alltime[0].points, 1);
    assert.strictEqual(weekly[0].displayName, "Alice");
    const event = loadBuilderStore(h.storeFile).builderEvents[firstWelcomeEventId(NEW_A)];
    assert.strictEqual(event.reason, BUILDER_EVENT_REASON.FIRST_WELCOME);
    assert.strictEqual(event.points, 1);
    assert.strictEqual(event.subjectUserId, NEW_A);
    assert.ok(!event.referralUserId);
  });

  await runTest("6-7. second welcomer and concurrent claims → exactly one BP", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      {
        chatId: COMMUNITY_CHAT,
        userId: NEW_A,
        joinMessageId: 10,
      },
      { ...h.opts, now }
    );
    const first = validReply(h, NEW_A, { fromId: Number(WELCOMER) });
    const second = validReply(h, NEW_A, { fromId: Number(OTHER), fromName: "Lojay" });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 1);
    assert.strictEqual(builderSummary(OTHER, h.opts).builderPoints, 0);
    const events = Object.values(loadBuilderStore(h.storeFile).builderEvents || {}).filter(
      (row) => row.reason === BUILDER_EVENT_REASON.FIRST_WELCOME
    );
    assert.strictEqual(events.length, 1);
  });

  await runTest("8-13. bots, self, short, emoji, command, untargeted ignored", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      {
        chatId: COMMUNITY_CHAT,
        userId: NEW_A,
        username: "newmango",
        joinMessageId: 10,
      },
      { ...h.opts, now }
    );
    assert.strictEqual(isValidWelcomeText("hi"), false);
    assert.strictEqual(isValidWelcomeText("gm"), false);
    assert.strictEqual(isValidWelcomeText("welcome"), false);
    assert.strictEqual(isValidWelcomeText("👋"), false);
    assert.strictEqual(isValidWelcomeText("/menu"), false);
    assert.strictEqual(isValidWelcomeText("Welcome to ManGo!"), true);

    assert.strictEqual(validReply(h, NEW_A, { isBot: true }).ok, false);
    assert.strictEqual(validReply(h, NEW_A, { fromId: Number(NEW_A) }).ok, false);
    assert.strictEqual(claim(h, { text: "hi", replyTo: { message_id: 10 } }).ok, false);
    assert.strictEqual(claim(h, { text: "👋", replyTo: { message_id: 10 } }).ok, false);
    assert.strictEqual(claim(h, { text: "/menu", replyTo: { message_id: 10 } }).ok, false);
    assert.strictEqual(
      claim(h, { text: "Hello everyone, how is it going today?" }).ok,
      false
    );
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 0);
  });

  await runTest("14. valid @username welcome works", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      {
        chatId: COMMUNITY_CHAT,
        userId: NEW_A,
        username: "newmango",
      },
      { ...h.opts, now }
    );
    const result = claim(h, { text: "Hey @newmango, welcome in!" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 1);
  });

  await runTest("15. valid reply to new member message works", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      { chatId: COMMUNITY_CHAT, userId: NEW_A },
      { ...h.opts, now }
    );
    const result = claim(h, {
      text: "Welcome to ManGo!",
      replyTo: { message_id: 77, from: { id: Number(NEW_A), is_bot: false } },
    });
    assert.strictEqual(result.ok, true);
  });

  await runTest("16. after expiry no BP", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      { chatId: COMMUNITY_CHAT, userId: NEW_A, joinMessageId: 10 },
      { ...h.opts, now }
    );
    const result = validReply(h, NEW_A, { now: now + FIRST_WELCOME_WINDOW_MS + 1 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 0);
  });

  await runTest("17. leave/rejoin no second opportunity or reward", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    handleChatMemberUpdate(joinUpdate(NEW_A), { ...h.opts, now });
    const first = loadBuilderStore(h.storeFile).welcomeOpportunities[NEW_A];
    handleChatMemberUpdate(
      joinUpdate(NEW_A, { oldStatus: "left", newStatus: "member" }),
      { ...h.opts, now: now + FIRST_WELCOME_WINDOW_MS + 60_000 }
    );
    const again = loadBuilderStore(h.storeFile).welcomeOpportunities[NEW_A];
    assert.strictEqual(again.joinedAt, first.joinedAt);
    assert.strictEqual(again.expiresAt, first.expiresAt);
    const result = tryClaimFirstWelcome(
      {
        chatId: COMMUNITY_CHAT,
        from: { id: Number(WELCOMER), is_bot: false, first_name: "Alice" },
        text: "Welcome to ManGo!",
        replyTo: { message_id: 10, from: { id: Number(NEW_A) } },
      },
      { ...h.opts, now: now + FIRST_WELCOME_WINDOW_MS + 60_000 }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 0);
  });

  await runTest("18-20. daily cap 3, fourth 0, next UTC day allowed", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    const members = [NEW_A, NEW_B, NEW_C, NEW_D];
    members.forEach((id, index) => {
      registerWelcomeOpportunity(
        { chatId: COMMUNITY_CHAT, userId: id, joinMessageId: 20 + index },
        { ...h.opts, now }
      );
    });
    assert.strictEqual(validReply(h, NEW_A, { replyId: 20 }).ok, true);
    assert.strictEqual(validReply(h, NEW_B, { replyId: 21 }).ok, true);
    assert.strictEqual(validReply(h, NEW_C, { replyId: 22 }).ok, true);
    assert.strictEqual(FIRST_WELCOME_DAILY_CAP, 3);
    const fourth = validReply(h, NEW_D, { replyId: 23 });
    assert.strictEqual(fourth.ok, false);
    assert.strictEqual(fourth.reason, "daily-cap");
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 3);
    const nextDay = Date.UTC(2026, 7, 22, 0, 0, 0);
    registerWelcomeOpportunity(
      { chatId: COMMUNITY_CHAT, userId: NEW_E, joinMessageId: 30 },
      { ...h.opts, now: nextDay }
    );
    const next = validReply(h, NEW_E, { replyId: 30, now: nextDay });
    assert.strictEqual(next.ok, true);
    assert.strictEqual(builderSummary(WELCOMER, { ...h.opts, now: nextDay }).builderPoints, 4);
  });

  await runTest("21-22. restart preserves open opportunity and claimed state", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      { chatId: COMMUNITY_CHAT, userId: NEW_A, joinMessageId: 10 },
      { ...h.opts, now }
    );
    configureCommunityBuilderForTests({
      storeFile: h.storeFile,
      pointsFile: h.pointsFile,
      walletFile: h.walletFile,
      chatId: COMMUNITY_CHAT,
      now,
    });
    const afterRestart = validReply(h, NEW_A);
    assert.strictEqual(afterRestart.ok, true);
    configureCommunityBuilderForTests({
      storeFile: h.storeFile,
      pointsFile: h.pointsFile,
      walletFile: h.walletFile,
      chatId: COMMUNITY_CHAT,
      now,
    });
    handleChatMemberUpdate(joinUpdate(NEW_A), { ...h.opts, now: now + 1000 });
    const duplicate = validReply(h, NEW_A, { fromId: Number(OTHER) });
    assert.strictEqual(duplicate.ok, false);
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 1);
  });

  await runTest("23-24. no duplicate event or total BP; no XP/referral change", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      { chatId: COMMUNITY_CHAT, userId: NEW_A, joinMessageId: 10 },
      { ...h.opts, now }
    );
    const pointsBefore = JSON.stringify(loadPoints(h.pointsFile));
    const walletBefore = fs.readFileSync(h.walletFile, "utf8");
    validReply(h, NEW_A);
    validReply(h, NEW_A);
    validReply(h, NEW_A, { text: "Hey there, welcome in!" });
    const store = loadBuilderStore(h.storeFile);
    const welcomeEvents = Object.values(store.builderEvents).filter(
      (row) => row.reason === BUILDER_EVENT_REASON.FIRST_WELCOME
    );
    assert.strictEqual(welcomeEvents.length, 1);
    assert.strictEqual(store.builders[WELCOMER].points, 1);
    assert.strictEqual(JSON.stringify(loadPoints(h.pointsFile)), pointsBefore);
    assert.strictEqual(fs.readFileSync(h.walletFile, "utf8"), walletBefore);
    assert.strictEqual(JOIN_BUILDER_POINTS, 1);
  });

  await runTest("edited message cannot claim", () => {
    const now = Date.UTC(2026, 7, 21, 15, 0, 0);
    const h = harness(now);
    registerWelcomeOpportunity(
      { chatId: COMMUNITY_CHAT, userId: NEW_A, joinMessageId: 10 },
      { ...h.opts, now }
    );
    const edited = claim(h, {
      text: "Welcome to ManGo!",
      editDate: now,
      replyTo: { message_id: 10 },
    });
    assert.strictEqual(edited.ok, false);
    assert.strictEqual(builderSummary(WELCOMER, h.opts).builderPoints, 0);
  });

  for (const file of prodRoots) {
    if (!fs.existsSync(file)) continue;
    assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
  }
}

main()
  .then(() => {
    configureCommunityBuilderForTests({});
    setWalletFileForTests(null);
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll community-builder-welcome tests passed.");
  })
  .catch((err) => {
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    console.error(err);
    process.exit(1);
  });
