/**
 * ChatFight v1 — challenges, XP, timeout, cooldown, daily activity interaction.
 * Run: node tests/chat-fight.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const {
  createChatFightService,
  FIGHT_TYPES,
  FIGHT_STATUS,
  TYPE_RUSH_WORDS,
  EMOJI_MAP,
  USAGE_TEXT,
  parseFightTypeArg,
  isAllowedChatFightChat,
  normalizeAnswer,
  buildWinnerReply,
  CHAT_FIGHT_XP,
  CHAT_FIGHT_COOLDOWN_MS,
  REVEAL_CALLBACK_DATA,
} = require("../services/chatFight");
const {
  awardChatFightXp,
  awardDailyActivityPoint,
  awardTriggerPoints,
  loadPoints,
  savePoints,
  getRank,
  getCombinedRankUpReply,
  mutatePoints,
  detectTrigger,
  isCommandText,
} = require("../services/points");
const {
  handleChatFight,
  handleChatFightReveal,
} = require("../commands/chatfight");
const { canManageGroup } = require("../utils/admin");
const { registerChatFightListener } = require("../events/chat-fight");
const { shouldSkipCommunityActivity } = require("../events/points-trigger");
const { MENU_LABELS } = require("../utils/botMenu");
const { HELP_MESSAGE } = require("../commands/help");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-chatfight-"));
let testCounter = 0;
const COMMUNITY_CHAT = -1001234567890;
const OTHER_CHAT = -1009999999999;
const ADMIN_ID = 424242;
const USER_A = 111;
const USER_B = 222;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
const pendingAsyncTests = [];

function pointsFile() {
  testCounter += 1;
  return path.join(tempDir, `points-${testCounter}.json`);
}

function resetEnv() {
  process.env.ADMIN_USER_ID = String(ADMIN_ID);
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
}

function restoreEnv() {
  if (originalAdmin === undefined) {
    delete process.env.ADMIN_USER_ID;
  } else {
    process.env.ADMIN_USER_ID = originalAdmin;
  }
  if (originalChatId === undefined) {
    delete process.env.TELEGRAM_CHAT_ID;
  } else {
    process.env.TELEGRAM_CHAT_ID = originalChatId;
  }
}

function runTest(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pendingAsyncTests.push(
        result
          .then(() => {
            console.log(`✓ ${name}`);
          })
          .catch((err) => {
            console.error(`✗ ${name}`);
            restoreEnv();
            throw err;
          })
      );
      return;
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    restoreEnv();
    throw err;
  }
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Kevin",
  username,
  text = "",
  isBot = false,
  memberStatus = "member",
  getChatMemberImpl,
} = {}) {
  const replies = [];
  const replyExtras = [];
  const telegramMessages = [];
  const cbAnswers = [];
  const edited = [];
  const getChatMemberCalls = [];
  const defaultGetChatMember = (id, uid) => {
    getChatMemberCalls.push({ chatId: id, userId: uid });
    return Promise.resolve({
      status: memberStatus,
      user: { id: uid },
    });
  };
  const ctx = {
    chat: { type: chatType, id: chatId },
    from: {
      id: userId,
      first_name: firstName,
      username,
      is_bot: isBot,
    },
    message: { text },
    state: {},
    replies,
    replyExtras,
    telegramMessages,
    cbAnswers,
    edited,
    getChatMemberCalls,
    telegram: {
      sendMessage(id, msg) {
        telegramMessages.push({ chatId: id, text: msg });
        return Promise.resolve();
      },
      getChatMember:
        typeof getChatMemberImpl === "function"
          ? getChatMemberImpl
          : defaultGetChatMember,
    },
    reply(msg, extra) {
      replies.push(msg);
      replyExtras.push(extra);
      return Promise.resolve({ message_id: 9001 });
    },
    answerCbQuery(text) {
      cbAnswers.push(text || "");
      return Promise.resolve();
    },
    editMessageText(text) {
      edited.push(text);
      return Promise.resolve();
    },
  };
  return ctx;
}

function createFakeTimers() {
  let nowMs = 1_700_000_000_000;
  const timers = [];
  let nextId = 1;

  return {
    now: () => nowMs,
    setNow(ms) {
      nowMs = ms;
    },
    advance(ms) {
      nowMs += ms;
      const due = timers
        .filter((t) => !t.cleared && t.fireAt <= nowMs)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const t of due) {
        if (t.cleared) continue;
        t.cleared = true;
        t.fn();
      }
    },
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.push({
        id,
        fn,
        fireAt: nowMs + delay,
        cleared: false,
      });
      return id;
    },
    clearTimeout(id) {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    pendingCount() {
      return timers.filter((t) => !t.cleared).length;
    },
  };
}

function seedUser(file, userId, points, extras = {}) {
  savePoints(
    {
      users: {
        [String(userId)]: {
          points,
          weeklyPoints: extras.weeklyPoints != null ? extras.weeklyPoints : 0,
          weekId: extras.weekId || null,
          name: extras.name || "Kevin",
          triggerDate: null,
          triggersUsed: [],
          activityDate: extras.activityDate || null,
        },
      },
    },
    file
  );
}

function createService(overrides = {}) {
  const clock = createFakeTimers();
  const sent = [];
  const service = createChatFightService({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: overrides.random || (() => 0),
    durationMs: overrides.durationMs || 60_000,
    revealWaitMs: overrides.revealWaitMs || 300_000,
    cooldownMs: overrides.cooldownMs || CHAT_FIGHT_COOLDOWN_MS,
    sendMessage: (chatId, text) => {
      sent.push({ chatId, text });
    },
    ...overrides,
  });
  return { service, clock, sent };
}

/** Start fight then reveal so answers are accepted (v2 flow). */
function startActiveFight(service, params) {
  const started = service.startFight(params);
  if (!started.ok) {
    return started;
  }
  const revealed = service.revealFight(params.chatId);
  if (!revealed.ok) {
    return { ok: false, reason: revealed.reason || "reveal-failed", started };
  }
  return {
    ok: true,
    fight: revealed.fight,
    prompt: revealed.prompt,
    teaser: started.teaser,
    started,
    revealed,
  };
}

function createTextBot(handlers) {
  return {
    on(event, fn) {
      if (event === "text") handlers.push(fn);
    },
  };
}

resetEnv();

// ---------------------------------------------------------------------------
// Type Rush
// ---------------------------------------------------------------------------

runTest("1. admin can start Type Rush in group", async () => {
  const { service } = createService({
    random: () => 0, // first word MANGO
  });
  const ctx = createMockCtx({
    userId: ADMIN_ID,
    text: "/chatfight type",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
    isAdminFn: (id) => String(id) === String(ADMIN_ID),
  });
  assert.strictEqual(ctx.replies.length, 1);
  assert.ok(ctx.replies[0].includes("A new challenge is ready"));
  assert.ok(!ctx.replies[0].includes("MANGO"));
  assert.ok(!ctx.replies[0].includes("Type this exactly:"));
  assert.ok(service.getFightSnapshot());
  assert.strictEqual(service.getFightSnapshot().status, FIGHT_STATUS.WAITING_FOR_REVEAL);
  assert.strictEqual(service.getFightSnapshot().type, FIGHT_TYPES.TYPE_RUSH);
  assert.strictEqual(service.getActiveFight(), null);
  const kb = ctx.replyExtras[0];
  assert.ok(kb && kb.reply_markup);
  const button = kb.reply_markup.inline_keyboard[0][0];
  assert.ok(button.text.includes("Reveal challenge"));
  assert.strictEqual(button.callback_data, REVEAL_CALLBACK_DATA);
  assert.ok(!String(button.callback_data).includes("MANGO"));
});

runTest("2. non-admin cannot start", async () => {
  const { service } = createService();
  const ctx = createMockCtx({
    userId: USER_A,
    text: "/chatfight",
    memberStatus: "member",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
    isAdminFn: (id) => String(id) === String(ADMIN_ID),
  });
  assert.strictEqual(ctx.replies.length, 1);
  assert.ok(ctx.replies[0].includes("only be started by an admin"));
  assert.strictEqual(service.getActiveFight(), null);
});

runTest("3. private cannot start", async () => {
  const { service } = createService();
  const ctx = createMockCtx({
    chatType: "private",
    chatId: USER_A,
    userId: ADMIN_ID,
    text: "/chatfight",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
    isAdminFn: () => true,
  });
  assert.ok(ctx.replies[0].includes("community group"));
  assert.strictEqual(service.getActiveFight(), null);
});

runTest("4. exact/case-insensitive correct answer wins", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "mango");
  assert.strictEqual(claim.claimed, true);
  const award = await awardChatFightXp(USER_A, "Kevin", file);
  assert.strictEqual(award.awarded, true);
  assert.strictEqual(award.pointsToAdd, 2);
});

runTest("5. wrong answer silent (no claim)", async () => {
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "WRONG");
  assert.strictEqual(claim.claimed, false);
  assert.strictEqual(claim.reason, "wrong-answer");
  assert.ok(service.getActiveFight());
});

runTest("6. substring answer fails", async () => {
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  // Word is MANGO — substring / extra punctuation must fail
  assert.strictEqual(
    service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANG").claimed,
    false
  );
  assert.strictEqual(
    service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO!!!").claimed,
    false
  );
  assert.strictEqual(
    service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "xx MANGO xx").claimed,
    false
  );
});

runTest("7. bot cannot win", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });

  const handlers = [];
  registerChatFightListener(createTextBot(handlers), {
    tryClaimWinnerFn: (uid, cid, text) => service.tryClaimWinner(uid, cid, text),
    awardChatFightXpFn: (uid, name) => awardChatFightXp(uid, name, file),
  });

  const ctx = createMockCtx({
    text: "MANGO",
    isBot: true,
  });
  await handlers[0](ctx);
  assert.strictEqual(ctx.replies.length, 0);
  assert.ok(service.getActiveFight());
  assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
});

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

runTest("8. generated math challenge has valid integer solution", async () => {
  for (let i = 0; i < 30; i += 1) {
    const { service } = createService({
      random: () => Math.random(),
    });
    const started = startActiveFight(service, {
      chatId: COMMUNITY_CHAT,
      type: FIGHT_TYPES.MATH_RUSH,
    });
    assert.ok(started.ok);
    const fight = service.getActiveFight();
    const answer = Number(fight.acceptedAnswers[0]);
    assert.ok(Number.isInteger(answer));
    assert.ok(answer >= 0);
    assert.strictEqual(String(answer), fight.acceptedAnswers[0]);
  }
});

runTest("9. correct math answer wins", async () => {
  const file = pointsFile();
  const { service } = createService({
    random: () => 0, // add, then 1, then 1 → 1+1=2 with our RNG shape
  });
  // Force deterministic math via generate with fixed random sequence
  let calls = 0;
  const seq = [0, 0, 0]; // kind add (index 0), a=1, b=1 → wait randomInt uses floor(r*(hi-lo+1))
  const { service: svc } = createService({
    random: () => {
      const v = seq[Math.min(calls, seq.length - 1)];
      calls += 1;
      return v;
    },
  });
  startActiveFight(svc, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.MATH_RUSH });
  const fight = svc.getActiveFight();
  const answer = fight.acceptedAnswers[0];
  const claim = svc.tryClaimWinner(USER_A, COMMUNITY_CHAT, answer);
  assert.strictEqual(claim.claimed, true);
  const award = await awardChatFightXp(USER_A, "Kevin", file);
  assert.strictEqual(award.points, 2);
});

runTest("10. wrong math answer no XP", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.MATH_RUSH });
  const wrong = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "99999");
  assert.strictEqual(wrong.claimed, false);
  assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
});

// ---------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------

runTest("11. accepted synonym wins", async () => {
  const { service } = createService({ random: () => 0 }); // first emoji 😂
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.EMOJI_GUESS });
  const fight = service.getActiveFight();
  assert.strictEqual(fight.meta.emoji, "😂");
  assert.strictEqual(
    service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "Laughing").claimed,
    true
  );
});

runTest("12. unknown emoji answer fails", async () => {
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.EMOJI_GUESS });
  assert.strictEqual(
    service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "happy").claimed,
    false
  );
});

// ---------------------------------------------------------------------------
// Winner / idempotency
// ---------------------------------------------------------------------------

runTest("13-16. first correct +2; second +0; lifetime+weekly", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });

  const first = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.strictEqual(first.claimed, true);
  const award1 = await awardChatFightXp(USER_A, "Kevin", file);
  assert.strictEqual(award1.pointsToAdd, 2);
  assert.strictEqual(award1.points, 2);

  const second = service.tryClaimWinner(USER_B, COMMUNITY_CHAT, "MANGO");
  assert.strictEqual(second.claimed, false);

  // Even if someone awards again incorrectly, fight won't claim — only one winner path.
  const user = loadPoints(file).users[String(USER_A)];
  assert.strictEqual(user.points, 2);
  assert.strictEqual(user.weeklyPoints, 2);
});

runTest("17. rank-up works", async () => {
  const file = pointsFile();
  seedUser(file, USER_A, 24);
  const award = await awardChatFightXp(USER_A, "Kevin", file);
  assert.strictEqual(award.rankUp, true);
  assert.strictEqual(award.rank.title, "Sprout");
  const reply = buildWinnerReply("Kevin", award);
  assert.ok(reply.includes("Rank up: Sprout"));
  assert.ok(reply.includes("🌿"));
});

runTest("18. two near-simultaneous correct messages → one winner", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });

  const handlers = [];
  registerChatFightListener(createTextBot(handlers), {
    tryClaimWinnerFn: (uid, cid, text) => service.tryClaimWinner(uid, cid, text),
    awardChatFightXpFn: (uid, name) => awardChatFightXp(uid, name, file),
  });

  const ctxA = createMockCtx({ userId: USER_A, firstName: "Ada", text: "MANGO" });
  const ctxB = createMockCtx({ userId: USER_B, firstName: "Bob", text: "MANGO" });
  const pA = handlers[0](ctxA);
  const pB = handlers[0](ctxB);
  await Promise.all([pA, pB]);

  assert.strictEqual(ctxA.replies.length, 1);
  assert.strictEqual(ctxB.replies.length, 0);
  assert.ok(ctxA.replies[0].includes("Ada wins"));
  const data = loadPoints(file);
  assert.strictEqual(data.users[String(USER_A)].points, 2);
  assert.strictEqual(data.users[String(USER_B)], undefined);
});

// ---------------------------------------------------------------------------
// Daily Activity interaction
// ---------------------------------------------------------------------------

runTest("19-20. first daily message that wins → activity + ChatFight XP", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });

  // Simulate event order: chat-fight then points-trigger awards
  const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.ok(claim.claimed);
  const fightAward = await awardChatFightXp(USER_A, "Kevin", file);
  const activityAward = await awardDailyActivityPoint(USER_A, "Kevin", file);

  assert.strictEqual(fightAward.awarded, true);
  assert.strictEqual(activityAward.awarded, true);
  const user = loadPoints(file).users[String(USER_A)];
  assert.strictEqual(user.points, 3);
  assert.strictEqual(user.weeklyPoints, 3);
});

runTest("21. rank-up reply not duplicated if activity + fight cross threshold", async () => {
  const file = pointsFile();
  // 22 + 2 fight = 24 (no rank-up); +1 activity = 25 (rank-up) — only activity announces
  seedUser(file, USER_A, 22);

  const fightAward = await awardChatFightXp(USER_A, "Kevin", file);
  const activityAward = await awardDailyActivityPoint(USER_A, "Kevin", file);
  assert.strictEqual(fightAward.rankUp, false);
  assert.strictEqual(activityAward.rankUp, true);

  const winnerReply = buildWinnerReply("Kevin", fightAward);
  assert.ok(!winnerReply.includes("Rank up"));

  // points-trigger skips only when fightAward.rankUp; here activity announces once
  const combined = getCombinedRankUpReply(
    activityAward,
    null,
    "Kevin",
    fightAward
  );
  assert.ok(combined.includes("Sprout"));

  // 23 + 2 = 25 fight rank-up; activity no — fight reply only
  const file2 = pointsFile();
  seedUser(file2, USER_A, 23);
  const fight2 = await awardChatFightXp(USER_A, "Kevin", file2);
  const activity2 = await awardDailyActivityPoint(USER_A, "Kevin", file2);
  assert.strictEqual(fight2.rankUp, true);
  assert.strictEqual(activity2.rankUp, false);
  const winner2 = buildWinnerReply("Kevin", fight2);
  assert.ok(winner2.includes("Rank up: Sprout"));
  // points-trigger would return early when fightAward.rankUp
  assert.strictEqual(fight2.rankUp, true);
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

runTest("22-24. timeout ends fight; one message; no XP after", async () => {
  const file = pointsFile();
  const { service, clock, sent } = createService({
    random: () => 0,
    durationMs: 60_000,
  });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  assert.ok(service.getActiveFight());

  clock.advance(60_000);
  assert.strictEqual(service.getActiveFight(), null);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].text.includes("CHAT FIGHT EXPIRED"));
  assert.ok(sent[0].text.includes("Nobody solved it in time"));
  assert.ok(sent[0].text.includes("Answer:"));

  // Second timeout tick must not double-send
  clock.advance(1);
  assert.strictEqual(sent.length, 1);

  const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.strictEqual(claim.claimed, false);
  assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
});

runTest("25. timer cleared after winner", async () => {
  const { service, clock, sent } = createService({
    random: () => 0,
    durationMs: 60_000,
  });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  assert.strictEqual(clock.pendingCount(), 1);
  service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.strictEqual(clock.pendingCount(), 0);
  clock.advance(60_000);
  assert.strictEqual(sent.length, 0);
});

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

runTest("26. cannot start second fight before 60 min", async () => {
  const { service, clock } = createService({ random: () => 0 });
  const first = startActiveFight(service, {
    chatId: COMMUNITY_CHAT,
    type: FIGHT_TYPES.TYPE_RUSH,
  });
  assert.ok(first.ok);
  service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");

  clock.advance(5_000);
  const second = service.startFight({
    chatId: COMMUNITY_CHAT,
    type: FIGHT_TYPES.TYPE_RUSH,
  });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, "cooldown");
  assert.ok(second.remainingMinutes >= 59);
});

runTest("27. can start after cooldown", async () => {
  const { service, clock } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  clock.advance(CHAT_FIGHT_COOLDOWN_MS);
  const next = service.startFight({
    chatId: COMMUNITY_CHAT,
    type: FIGHT_TYPES.MATH_RUSH,
  });
  assert.ok(next.ok);
});

runTest("28. cooldown survives fight completion in memory", async () => {
  const { service, clock } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.ok(service.isOnCooldown());
  clock.advance(30 * 60 * 1000);
  assert.ok(service.isOnCooldown());
});

runTest("29. displayed remaining minutes sensible", async () => {
  const { service, clock } = createService({ random: () => 0 });
  const ctx = createMockCtx({ userId: ADMIN_ID, text: "/chatfight" });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
    isAdminFn: () => true,
  });
  service.forceTimeout();
  clock.advance(10 * 60 * 1000);
  const ctx2 = createMockCtx({ userId: ADMIN_ID, text: "/chatfight" });
  await handleChatFight(ctx2, {
    startFightFn: (p) => service.startFight(p),
    isAdminFn: () => true,
  });
  assert.ok(ctx2.replies[0].includes("cooldown"));
  assert.ok(ctx2.replies[0].includes("about 50 minutes"));
});

// ---------------------------------------------------------------------------
// Chat restriction
// ---------------------------------------------------------------------------

runTest("30. wrong group cannot participate", async () => {
  resetEnv();
  assert.strictEqual(isAllowedChatFightChat(OTHER_CHAT), false);
  const { service } = createService({ random: () => 0 });
  const started = service.startFight({
    chatId: OTHER_CHAT,
    type: FIGHT_TYPES.TYPE_RUSH,
  });
  assert.strictEqual(started.ok, false);
  assert.strictEqual(started.reason, "wrong-chat");

  // Even if fight somehow in community, wrong chat cannot claim
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  const claim = service.tryClaimWinner(USER_A, OTHER_CHAT, "MANGO");
  assert.strictEqual(claim.claimed, false);
});

runTest("31. configured community group works", async () => {
  resetEnv();
  assert.strictEqual(isAllowedChatFightChat(COMMUNITY_CHAT), true);
  const { service } = createService({ random: () => 0 });
  const started = service.startFight({
    chatId: COMMUNITY_CHAT,
    type: FIGHT_TYPES.TYPE_RUSH,
  });
  assert.ok(started.ok);
});

// ---------------------------------------------------------------------------
// Regression / security
// ---------------------------------------------------------------------------

runTest("32. commands don't count as answer", async () => {
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, { chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });

  const handlers = [];
  registerChatFightListener(createTextBot(handlers), {
    tryClaimWinnerFn: (uid, cid, text) => service.tryClaimWinner(uid, cid, text),
    awardChatFightXpFn: () => {
      throw new Error("should not award");
    },
  });

  const ctx = createMockCtx({ text: "/mango" });
  await handlers[0](ctx);
  assert.strictEqual(ctx.replies.length, 0);
  assert.ok(service.getActiveFight());
  assert.ok(isCommandText("/chatfight"));
});

runTest("33. gm/gmango triggers still work normally", async () => {
  const file = pointsFile();
  assert.strictEqual(detectTrigger("gmango everyone"), "gmango");
  assert.strictEqual(detectTrigger("gm friends"), "gm");
  const result = await awardTriggerPoints(USER_A, "Kevin", "gmango", file);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.pointsToAdd, 2);
});

runTest("34. menu labels unaffected", async () => {
  assert.ok(MENU_LABELS.POINTS);
  assert.ok(HELP_MESSAGE.includes("/chatfight"));
  const ctx = createMockCtx({
    chatType: "private",
    text: MENU_LABELS.POINTS,
  });
  assert.strictEqual(shouldSkipCommunityActivity(ctx, MENU_LABELS.POINTS), true);
});

runTest("35. points locking remains safe via awardChatFightXp", async () => {
  const file = pointsFile();
  mutatePoints((data) => {
    data.users["1"] = {
      points: 0,
      weeklyPoints: 0,
      weekId: null,
      name: "A",
      triggerDate: null,
      triggersUsed: [],
      activityDate: null,
    };
  }, file);
  const a = await awardChatFightXp(1, "A", file);
  const b = await awardChatFightXp(1, "A", file);
  assert.strictEqual(a.points, 2);
  assert.strictEqual(b.points, 4);
  assert.strictEqual(loadPoints(file).users["1"].points, 4);
});

// Extra sanity
runTest("parseFightTypeArg + usage on unknown", async () => {
  assert.strictEqual(parseFightTypeArg("").random, true);
  assert.strictEqual(parseFightTypeArg("type").type, FIGHT_TYPES.TYPE_RUSH);
  assert.strictEqual(parseFightTypeArg("math").type, FIGHT_TYPES.MATH_RUSH);
  assert.strictEqual(parseFightTypeArg("emoji").type, FIGHT_TYPES.EMOJI_GUESS);
  assert.strictEqual(parseFightTypeArg("nope").ok, false);

  const { service } = createService();
  const ctx = createMockCtx({ userId: ADMIN_ID, text: "/chatfight banana" });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
    isAdminFn: () => true,
  });
  assert.strictEqual(ctx.replies[0], USAGE_TEXT);
});

runTest("normalizeAnswer policy: no punctuation strip", async () => {
  assert.strictEqual(normalizeAnswer(FIGHT_TYPES.TYPE_RUSH, "  MaNgO  "), "mango");
  assert.strictEqual(normalizeAnswer(FIGHT_TYPES.TYPE_RUSH, "MANGO!!!"), "mango!!!");
  assert.strictEqual(normalizeAnswer(FIGHT_TYPES.MATH_RUSH, " 42 "), "42");
});

runTest("TYPE_RUSH_WORDS and EMOJI_MAP are stable", async () => {
  assert.ok(TYPE_RUSH_WORDS.includes("MANGO"));
  assert.ok(TYPE_RUSH_WORDS.includes("GMANGO"));
  assert.deepStrictEqual(EMOJI_MAP["😂"], ["laugh", "laughing", "funny"]);
  assert.strictEqual(CHAT_FIGHT_XP, 2);
  assert.strictEqual(getRank(26).title, "Sprout");
});

runTest("dev mode without TELEGRAM_CHAT_ID allows any group", async () => {
  delete process.env.TELEGRAM_CHAT_ID;
  assert.strictEqual(isAllowedChatFightChat(OTHER_CHAT), true);
  resetEnv();
});

// ---------------------------------------------------------------------------
// Group admin authorization (Telegram creator/administrator + ADMIN_USER_ID)
// ---------------------------------------------------------------------------

runTest("auth1. ADMIN_USER_ID mag starten", async () => {
  resetEnv();
  const { service } = createService({ random: () => 0 });
  const ctx = createMockCtx({
    userId: ADMIN_ID,
    text: "/chatfight type",
    memberStatus: "member",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("A new challenge is ready"));
  assert.ok(service.getFightSnapshot());
  assert.strictEqual(service.getActiveFight(), null);
});

runTest("auth2. creator mag starten", async () => {
  resetEnv();
  delete process.env.ADMIN_USER_ID;
  const { service } = createService({ random: () => 0 });
  const ctx = createMockCtx({
    userId: USER_A,
    text: "/chatfight type",
    memberStatus: "creator",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("A new challenge is ready"));
  assert.ok(service.getFightSnapshot());
  assert.strictEqual(service.getActiveFight(), null);
  resetEnv();
});

runTest("auth3. administrator mag starten", async () => {
  resetEnv();
  delete process.env.ADMIN_USER_ID;
  const { service } = createService({ random: () => 0 });
  const ctx = createMockCtx({
    userId: USER_A,
    text: "/chatfight math",
    memberStatus: "administrator",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("A new challenge is ready"));
  assert.strictEqual(service.getFightSnapshot().type, FIGHT_TYPES.MATH_RUSH);
  assert.strictEqual(service.getActiveFight(), null);
  resetEnv();
});

runTest("auth4. member mag niet starten", async () => {
  resetEnv();
  delete process.env.ADMIN_USER_ID;
  const { service } = createService();
  const ctx = createMockCtx({
    userId: USER_A,
    text: "/chatfight",
    memberStatus: "member",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("only be started by an admin"));
  assert.strictEqual(service.getActiveFight(), null);
  resetEnv();
});

runTest("auth5. restricted mag niet starten", async () => {
  resetEnv();
  delete process.env.ADMIN_USER_ID;
  const { service } = createService();
  const ctx = createMockCtx({
    userId: USER_A,
    text: "/chatfight",
    memberStatus: "restricted",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("only be started by an admin"));
  assert.strictEqual(service.getActiveFight(), null);
  resetEnv();
});

runTest("auth6. left mag niet starten", async () => {
  const allowed = await canManageGroup(
    createMockCtx({ userId: USER_A, memberStatus: "left" }),
    { isAdminFn: () => false }
  );
  assert.strictEqual(allowed, false);
});

runTest("auth7. kicked mag niet starten", async () => {
  const allowed = await canManageGroup(
    createMockCtx({ userId: USER_A, memberStatus: "kicked" }),
    { isAdminFn: () => false }
  );
  assert.strictEqual(allowed, false);
});

runTest("auth8. getChatMember error + ADMIN_USER_ID match → toegestaan", async () => {
  resetEnv();
  const { service } = createService({ random: () => 0 });
  const ctx = createMockCtx({
    userId: ADMIN_ID,
    text: "/chatfight type",
    getChatMemberImpl: async () => {
      throw new Error("telegram down");
    },
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("A new challenge is ready"));
  assert.ok(service.getFightSnapshot());
  assert.strictEqual(service.getActiveFight(), null);
});

runTest("auth9. getChatMember error zonder ADMIN_USER_ID → geweigerd", async () => {
  resetEnv();
  delete process.env.ADMIN_USER_ID;
  const { service } = createService();
  const ctx = createMockCtx({
    userId: USER_A,
    text: "/chatfight",
    getChatMemberImpl: async () => {
      throw new Error("telegram down");
    },
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("only be started by an admin"));
  assert.strictEqual(service.getActiveFight(), null);
  resetEnv();
});

runTest("auth10. private chat blijft geweigerd", async () => {
  resetEnv();
  const { service } = createService();
  const ctx = createMockCtx({
    chatType: "private",
    chatId: ADMIN_ID,
    userId: ADMIN_ID,
    text: "/chatfight",
    memberStatus: "creator",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("community group"));
  assert.strictEqual(service.getActiveFight(), null);
});

runTest("auth11. verkeerde configured community group blijft geweigerd", async () => {
  resetEnv();
  const { service } = createService();
  const ctx = createMockCtx({
    chatId: OTHER_CHAT,
    userId: ADMIN_ID,
    text: "/chatfight",
    memberStatus: "creator",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.ok(ctx.replies[0].includes("not available in this group"));
  assert.strictEqual(service.getActiveFight(), null);
});

runTest("auth12. Telegram-admin start ChatFight core correct", async () => {
  resetEnv();
  delete process.env.ADMIN_USER_ID;
  const { service } = createService({ random: () => 0 });
  const ctx = createMockCtx({
    userId: USER_A,
    firstName: "Owner",
    text: "/chatfight type",
    memberStatus: "creator",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  const fight = service.getFightSnapshot();
  assert.ok(fight);
  assert.strictEqual(fight.status, FIGHT_STATUS.WAITING_FOR_REVEAL);
  assert.strictEqual(fight.type, FIGHT_TYPES.TYPE_RUSH);
  assert.deepStrictEqual(fight.acceptedAnswers, ["mango"]);
  resetEnv();
});

runTest("auth13. non-admin /chatfight awards geen XP", async () => {
  resetEnv();
  delete process.env.ADMIN_USER_ID;
  const file = pointsFile();
  const { service } = createService();
  const ctx = createMockCtx({
    userId: USER_A,
    text: "/chatfight",
    memberStatus: "member",
  });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
  });
  assert.strictEqual(service.getActiveFight(), null);
  assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
  resetEnv();
});


// ---------------------------------------------------------------------------
// Reveal flow
// ---------------------------------------------------------------------------

runTest("reveal11. fight starts hidden (waiting_for_reveal)", async () => {
  const { service } = createService({ random: () => 0 });
  const started = service.startFight({
    chatId: COMMUNITY_CHAT,
    type: FIGHT_TYPES.TYPE_RUSH,
  });
  assert.ok(started.ok);
  assert.ok(started.teaser.includes("A new challenge is ready"));
  assert.ok(!started.teaser.includes("MANGO"));
  assert.strictEqual(service.getActiveFight(), null);
  assert.strictEqual(
    service.getFightSnapshot().status,
    FIGHT_STATUS.WAITING_FOR_REVEAL
  );
});

runTest("reveal12-14. teaser has opaque reveal button, no answer in callback", async () => {
  const { service } = createService({ random: () => 0 });
  const ctx = createMockCtx({ userId: ADMIN_ID, text: "/chatfight type" });
  await handleChatFight(ctx, {
    startFightFn: (p) => service.startFight(p),
    isAdminFn: () => true,
  });
  assert.ok(!ctx.replies[0].includes("Type this exactly:"));
  assert.ok(!ctx.replies[0].includes("MANGO"));
  const button = ctx.replyExtras[0].reply_markup.inline_keyboard[0][0];
  assert.strictEqual(button.callback_data, "cfight:reveal");
  assert.ok(!button.callback_data.includes("mango"));
  assert.ok(!JSON.stringify(button).toLowerCase().includes("mango"));
});

runTest("reveal15. answer before reveal does nothing", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  service.startFight({ chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.strictEqual(claim.claimed, false);
  assert.strictEqual(claim.reason, "inactive");
  assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
});

runTest("reveal16-17. first reveal shows challenge; second does not duplicate", async () => {
  const { service, clock } = createService({
    random: () => 0,
    revealWaitMs: 300_000,
    durationMs: 60_000,
  });
  service.startFight({ chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  assert.strictEqual(clock.pendingCount(), 1);

  const ctx1 = createMockCtx({ userId: USER_A });
  await handleChatFightReveal(ctx1, {
    revealFightFn: (cid) => service.revealFight(cid),
  });
  assert.ok(ctx1.edited[0].includes("TYPE RUSH"));
  assert.ok(ctx1.edited[0].includes("MANGO"));
  assert.ok(service.getActiveFight());
  assert.strictEqual(clock.pendingCount(), 1);

  const ctx2 = createMockCtx({ userId: USER_B });
  await handleChatFightReveal(ctx2, {
    revealFightFn: (cid) => service.revealFight(cid),
  });
  assert.strictEqual(ctx2.edited.length, 0);
  assert.ok(ctx2.cbAnswers[0].includes("already revealed"));
  assert.strictEqual(clock.pendingCount(), 1);
});

runTest("reveal18. answer after reveal can win", async () => {
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, {
    chatId: COMMUNITY_CHAT,
    type: FIGHT_TYPES.TYPE_RUSH,
  });
  const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "mango");
  assert.strictEqual(claim.claimed, true);
  assert.strictEqual(claim.pointsToAdd, CHAT_FIGHT_XP);
});

runTest("reveal19. reveal click awards no XP", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  service.startFight({ chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  const ctx = createMockCtx({ userId: USER_A });
  await handleChatFightReveal(ctx, {
    revealFightFn: (cid) => service.revealFight(cid),
  });
  assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
});

runTest("reveal20. answer can give activity + fight XP", async () => {
  const file = pointsFile();
  const { service } = createService({ random: () => 0 });
  startActiveFight(service, {
    chatId: COMMUNITY_CHAT,
    type: FIGHT_TYPES.TYPE_RUSH,
  });
  const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.ok(claim.claimed);
  const fightAward = await awardChatFightXp(USER_A, "Kevin", file);
  const activityAward = await awardDailyActivityPoint(USER_A, "Kevin", file);
  assert.strictEqual(fightAward.awarded, true);
  assert.strictEqual(activityAward.awarded, true);
  assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 3);
});

runTest("reveal21. reveal timeout without click", async () => {
  const { service, clock, sent } = createService({
    random: () => 0,
    revealWaitMs: 5 * 60 * 1000,
    durationMs: 60_000,
  });
  service.startFight({ chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  clock.advance(5 * 60 * 1000);
  assert.strictEqual(service.getActiveFight(), null);
  assert.strictEqual(service.getFightSnapshot().status, FIGHT_STATUS.EXPIRED);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].text.includes("Nobody revealed the challenge"));
  const claim = service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.strictEqual(claim.claimed, false);
});

runTest("reveal22-23. answer timeout after reveal; timer cleanup", async () => {
  const { service, clock, sent } = createService({
    random: () => 0,
    revealWaitMs: 300_000,
    durationMs: 60_000,
  });
  startActiveFight(service, {
    chatId: COMMUNITY_CHAT,
    type: FIGHT_TYPES.TYPE_RUSH,
  });
  assert.strictEqual(clock.pendingCount(), 1);
  clock.advance(60_000);
  assert.strictEqual(service.getActiveFight(), null);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].text.includes("CHAT FIGHT EXPIRED"));
  assert.ok(sent[0].text.includes("Nobody solved it in time"));
  assert.strictEqual(clock.pendingCount(), 0);
});

runTest("reveal24. cooldown from fight START not reveal", async () => {
  const { service, clock } = createService({
    random: () => 0,
    revealWaitMs: 300_000,
    durationMs: 60_000,
  });
  const t0 = clock.now();
  service.startFight({ chatId: COMMUNITY_CHAT, type: FIGHT_TYPES.TYPE_RUSH });
  clock.advance(2 * 60 * 1000);
  service.revealFight(COMMUNITY_CHAT);
  service.tryClaimWinner(USER_A, COMMUNITY_CHAT, "MANGO");
  assert.ok(service.isOnCooldown());
  const rem = service.getCooldownRemainingMs();
  assert.ok(rem > 57 * 60 * 1000 && rem <= 58 * 60 * 1000);
  clock.setNow(t0 + CHAT_FIGHT_COOLDOWN_MS);
  assert.strictEqual(service.isOnCooldown(), false);
});

runTest("canManageGroup: env-admin skips getChatMember", async () => {
  let called = false;
  const allowed = await canManageGroup(
    createMockCtx({ userId: ADMIN_ID }),
    {
      isAdminFn: (id) => String(id) === String(ADMIN_ID),
      getChatMember: async () => {
        called = true;
        throw new Error("should not be called");
      },
    }
  );
  assert.strictEqual(allowed, true);
  assert.strictEqual(called, false);
});

Promise.all(pendingAsyncTests)
  .then(() => {
    restoreEnv();
    console.log("\nAll ChatFight tests passed.");
  })
  .catch((err) => {
    console.error(err);
    restoreEnv();
    process.exit(1);
  });
