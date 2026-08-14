/**
 * Trivia race + question bank validation.
 * Run: node tests/trivia.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  createTriviaService,
  parseTriviaCallbackData,
  buildAnswerCallbackData,
  STATUS,
  TRIVIA_TIMEOUT_MS,
} = require("../services/trivia");
const {
  TRIVIA_QUESTIONS,
  ANTI_REPEAT_WINDOW,
  pickTriviaQuestion,
  validateTriviaQuestionBank,
} = require("../services/triviaQuestions");
const {
  awardTriviaWinXp,
  TRIVIA_WIN_XP,
  loadPoints,
} = require("../services/points");
const { handleTrivia, handleTriviaAnswer } = require("../commands/trivia");
const { handleChatFight } = require("../commands/chatfight");
const { handleTicTacToe } = require("../commands/tictactoe");
const { handleConnectFour } = require("../commands/connect4");
const { createChatFightService } = require("../services/chatFight");
const { createTicTacToeService } = require("../services/ticTacToe");
const { createConnectFourService } = require("../services/connectFour");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const { ACTION_REGISTRY } = require("../services/communityActivityEngine");
const { HELP_MESSAGE } = require("../commands/help");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-trivia-"));
let testCounter = 0;
const COMMUNITY_CHAT = -1001234567890;
const OTHER_CHAT = -1009999999999;
const ADMIN_ID = 424242;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;
const OWNER_ID = 999001;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;

function pointsFile() {
  testCounter += 1;
  return path.join(tempDir, `points-${testCounter}.json`);
}

function resetEnv() {
  process.env.ADMIN_USER_ID = String(OWNER_ID);
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
}

async function runTest(name, fn) {
  resetEnv();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function createFakeTimers() {
  let nowMs = 1_700_000_000_000;
  const timers = [];
  let nextId = 1;
  return {
    now: () => nowMs,
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
      timers.push({ id, fn, fireAt: nowMs + delay, cleared: false });
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

const SAMPLE_QUESTION = Object.freeze({
  id: "test-mars",
  category: "space",
  question: "Which planet is known as the Red Planet?",
  answers: Object.freeze(["Venus", "Mars", "Jupiter", "Mercury"]),
  correctIndex: 1,
});

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const service = createTriviaService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    timeoutMs:
      overrides.timeoutMs != null ? overrides.timeoutMs : TRIVIA_TIMEOUT_MS,
    random: overrides.random || (() => 0),
    randomIdFn: overrides.randomIdFn || (() => "abc123"),
    questions: overrides.questions || TRIVIA_QUESTIONS,
    antiRepeatWindow: overrides.antiRepeatWindow,
  });
  return { service, timers };
}

function startSample(service, chatId = COMMUNITY_CHAT) {
  const started = service.startTrivia({
    chatId,
    question: SAMPLE_QUESTION,
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 9001);
  return started;
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Alice",
  text = "/trivia",
  isBot = false,
  memberStatus = "member",
  callbackData,
} = {}) {
  const replies = [];
  const cbAnswers = [];
  const edited = [];
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName, is_bot: isBot },
    message: { text },
    callbackQuery: callbackData
      ? { data: callbackData, from: { id: userId, is_bot: isBot } }
      : undefined,
    replies,
    cbAnswers,
    edited,
    telegram: {
      getChatMember() {
        return Promise.resolve({ status: memberStatus, user: { id: userId } });
      },
    },
    reply(msg, extra) {
      replies.push(msg);
      return Promise.resolve({ message_id: 9001, extra });
    },
    answerCbQuery(msg) {
      cbAnswers.push(msg || "");
      return Promise.resolve();
    },
    editMessageText(msg, extra) {
      edited.push({ text: msg, extra });
      return Promise.resolve();
    },
  };
}

async function main() {
  resetEnv();

  await runTest("question bank validates (>=50, unique, 4 answers)", () => {
    const result = validateTriviaQuestionBank(TRIVIA_QUESTIONS);
    assert.strictEqual(result.ok, true, result.errors.join("; "));
    assert.ok(TRIVIA_QUESTIONS.length >= 50);
    const categories = new Set(TRIVIA_QUESTIONS.map((q) => q.category));
    assert.ok(categories.has("geography"));
    assert.ok(categories.has("science"));
    assert.ok(categories.has("history"));
    assert.ok(categories.has("animals/nature"));
    assert.ok(categories.has("technology"));
    assert.ok(categories.has("space"));
    assert.ok(categories.has("sports"));
    assert.ok(categories.has("food/culture"));
    assert.ok(categories.has("simple math/logic"));
    assert.ok(categories.has("general knowledge"));
  });

  await runTest("configured group only + private rejected", async () => {
    const { service } = createService();
    const privateCtx = createMockCtx({ chatType: "private", chatId: USER_A });
    await handleTrivia(privateCtx, {
      startTriviaFn: (p) => service.startTrivia(p),
      canManageGroupFn: async () => true,
    });
    assert.ok(privateCtx.replies[0].includes("community group"));

    const wrong = service.startTrivia({ chatId: OTHER_CHAT });
    assert.strictEqual(wrong.ok, false);
    assert.strictEqual(wrong.reason, "wrong-chat");
  });

  await runTest("admin start + non-admin rejected", async () => {
    const { service } = createService();
    const member = createMockCtx({ userId: USER_A, memberStatus: "member" });
    await handleTrivia(member, {
      startTriviaFn: (p) => service.startTrivia(p),
      canManageGroupFn: async () => false,
    });
    assert.ok(member.replies[0].includes("admin"));

    const admin = createMockCtx({
      userId: ADMIN_ID,
      memberStatus: "administrator",
    });
    await handleTrivia(admin, {
      startTriviaFn: (p) => service.startTrivia(p),
      canManageGroupFn: async () => true,
      isBusyFn: () => false,
    });
    assert.ok(admin.replies[0].includes("MANGO TRIVIA"));
    assert.strictEqual(service.isTriviaOpen(), true);
  });

  await runTest("exactly 4 answers + correct answer server-side", () => {
    const { service } = createService();
    const started = startSample(service);
    assert.strictEqual(started.session.answers.length, 4);
    assert.strictEqual(started.session.correctIndex, 1);
    assert.strictEqual(started.session.answers[1], "Mars");
    assert.ok(!started.text.includes("correctIndex"));
    assert.ok(started.text.includes("[B] Mars"));
  });

  await runTest("callbacks contain no answer text or user id", () => {
    const data = buildAnswerCallbackData("abc123", 1);
    assert.strictEqual(data, "trivia:abc123:1");
    assert.ok(!data.includes("Mars"));
    assert.ok(!data.includes(String(USER_A)));
    assert.deepStrictEqual(parseTriviaCallbackData(data), {
      sessionId: "abc123",
      answerIndex: 1,
    });
    assert.strictEqual(parseTriviaCallbackData("trivia:abc123:9"), null);
    assert.strictEqual(parseTriviaCallbackData("trivia:abc123:1:extra"), null);
    assert.strictEqual(parseTriviaCallbackData("pvp:c4:join:abc"), null);
  });

  await runTest("first correct wins + wrong no XP + one attempt", () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startSample(service);

    const wrong = service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: 0,
      chatId: COMMUNITY_CHAT,
      displayName: "Alice",
    });
    assert.strictEqual(wrong.ok, true);
    assert.strictEqual(wrong.correct, false);
    assert.strictEqual(wrong.toast, "Wrong answer ❌");
    assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);

    const again = service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: 1,
      chatId: COMMUNITY_CHAT,
      displayName: "Alice",
    });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, "already-answered");

    const win = service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_B,
      answerIndex: 1,
      chatId: COMMUNITY_CHAT,
      displayName: "Bob",
    });
    assert.strictEqual(win.ok, true);
    assert.strictEqual(win.correct, true);
    assert.strictEqual(win.won, true);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const xp = awardTriviaWinXp(claim.winnerUserId, "Bob", file);
    assert.strictEqual(xp.awarded, true);
    assert.strictEqual(xp.pointsToAdd, TRIVIA_WIN_XP);
    assert.strictEqual(TRIVIA_WIN_XP, 2);
    const user = loadPoints(file).users[String(USER_B)];
    assert.strictEqual(user.points, 2);
    assert.strictEqual(user.weeklyPoints, 2);
  });

  await runTest("second user can still answer after first wrong", () => {
    const { service } = createService();
    const started = startSample(service);
    service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: 0,
      chatId: COMMUNITY_CHAT,
      displayName: "Alice",
    });
    const win = service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_B,
      answerIndex: 1,
      chatId: COMMUNITY_CHAT,
      displayName: "Bob",
    });
    assert.strictEqual(win.won, true);
    assert.strictEqual(win.session.winnerId, String(USER_B));
  });

  await runTest("owner answers for +0 XP", () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startSample(service);
    const win = service.tryAnswer({
      sessionId: started.session.id,
      userId: OWNER_ID,
      answerIndex: 1,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
    });
    assert.strictEqual(win.won, true);
    const claim = service.claimXpAward(started.session.id);
    const xp = awardTriviaWinXp(claim.winnerUserId, "Kevin", file);
    assert.strictEqual(xp.awarded, false);
    assert.strictEqual(xp.reason, "excluded");
    assert.strictEqual(loadPoints(file).users[String(OWNER_ID)], undefined);
    const rendered = service.applyXpResultToRender(started.session.id, xp);
    assert.ok(rendered.text.includes("Winner:"));
    assert.ok(!rendered.text.includes("Reward: +2"));
  });

  await runTest("timeout + no answer after timeout + timer cleanup", () => {
    const edits = [];
    const { service, timers } = createService({ timeoutMs: 60_000 });
    service.setEditMessageHandler((chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
    });
    const started = startSample(service);
    assert.strictEqual(timers.pendingCount(), 1);
    assert.strictEqual(service.isTriviaOpen(), true);
    timers.advance(60_000);
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(timers.pendingCount(), 0);
    assert.ok(edits[0].text.includes("TRIVIA OVER"));
    assert.ok(edits[0].text.includes("Mars"));

    const late = service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: 1,
      chatId: COMMUNITY_CHAT,
      displayName: "Alice",
    });
    assert.strictEqual(late.ok, false);
    assert.strictEqual(late.reason, "finished");
  });

  await runTest("concurrent correct → one winner", () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startSample(service);
    const a = service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: 1,
      chatId: COMMUNITY_CHAT,
      displayName: "Alice",
    });
    const b = service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_B,
      answerIndex: 1,
      chatId: COMMUNITY_CHAT,
      displayName: "Bob",
    });
    assert.strictEqual(a.won, true);
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.reason, "finished");
    const claim1 = service.claimXpAward(started.session.id);
    const claim2 = service.claimXpAward(started.session.id);
    assert.strictEqual(claim1.shouldAward, true);
    assert.strictEqual(claim2.shouldAward, false);
    awardTriviaWinXp(claim1.winnerUserId, "Alice", file);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 2);
    assert.strictEqual(loadPoints(file).users[String(USER_B)], undefined);
  });

  await runTest("busy state ChatFight / TTT / Connect Four / Trivia", async () => {
    const { service } = createService();
    startSample(service);

    assert.strictEqual(
      getCommunityBusyReason({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isTriviaOpenFn: () => service.isTriviaOpen(),
      }),
      "trivia"
    );
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isTriviaOpenFn: () => true,
      }),
      true
    );

    const fight = createChatFightService({
      cooldownMs: 0,
      durationMs: 60_000,
      revealWaitMs: 300_000,
    });
    fight.startFight({ chatId: COMMUNITY_CHAT, type: null });
    const triviaBlockedByFight = createMockCtx({ userId: ADMIN_ID });
    await handleTrivia(triviaBlockedByFight, {
      startTriviaFn: (p) => service.startTrivia(p),
      canManageGroupFn: async () => true,
      isBusyFn: isCommunityChallengeBusy,
      getBusyReasonFn: getCommunityBusyReason,
      isChatFightOpenFn: () => fight.isFightOpen(),
      isTicTacToeOpenFn: () => false,
      isConnectFourOpenFn: () => false,
      isTriviaOpenFn: () => false,
    });
    assert.ok(triviaBlockedByFight.replies[0].includes("ChatFight"));
    fight.reset();

    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs: 0,
    });
    const ttt = createTicTacToeService({ manager, now: timers.now });
    const c4 = createConnectFourService({ manager, now: timers.now });
    assert.strictEqual(ttt.startChallenge({ chatId: COMMUNITY_CHAT }).ok, true);

    const triviaBlockedByTtt = createMockCtx({ userId: ADMIN_ID });
    await handleTrivia(triviaBlockedByTtt, {
      startTriviaFn: (p) => createService().service.startTrivia(p),
      canManageGroupFn: async () => true,
      isBusyFn: isCommunityChallengeBusy,
      getBusyReasonFn: getCommunityBusyReason,
      isChatFightOpenFn: () => false,
      isTicTacToeOpenFn: () => ttt.isOpen(),
      isConnectFourOpenFn: () => false,
      isTriviaOpenFn: () => false,
    });
    assert.ok(triviaBlockedByTtt.replies[0].includes("Tic-Tac-Toe"));
    manager.resetAll();

    assert.strictEqual(c4.startChallenge({ chatId: COMMUNITY_CHAT }).ok, true);
    const triviaBlockedByC4 = createMockCtx({ userId: ADMIN_ID });
    await handleTrivia(triviaBlockedByC4, {
      startTriviaFn: (p) => createService().service.startTrivia(p),
      canManageGroupFn: async () => true,
      isBusyFn: isCommunityChallengeBusy,
      getBusyReasonFn: getCommunityBusyReason,
      isChatFightOpenFn: () => false,
      isTicTacToeOpenFn: () => false,
      isConnectFourOpenFn: () => c4.isOpen(),
      isTriviaOpenFn: () => false,
    });
    assert.ok(triviaBlockedByC4.replies[0].includes("Connect Four"));
    manager.resetAll();

    const openTrivia = createService().service;
    startSample(openTrivia);
    const chatFightCtx = createMockCtx({
      userId: ADMIN_ID,
      text: "/chatfight",
    });
    await handleChatFight(chatFightCtx, {
      startFightFn: () => ({ ok: false, reason: "should-not-run" }),
      canManageGroupFn: async () => true,
      isBusyFn: isCommunityChallengeBusy,
      getBusyReasonFn: getCommunityBusyReason,
      isChatFightOpenFn: () => false,
      isTicTacToeOpenFn: () => false,
      isConnectFourOpenFn: () => false,
      isTriviaOpenFn: () => openTrivia.isTriviaOpen(),
    });
    assert.ok(chatFightCtx.replies[0].includes("Trivia"));

    const tttCtx = createMockCtx({ userId: ADMIN_ID, text: "/tictactoe" });
    await handleTicTacToe(tttCtx, {
      startChallengeFn: () => ({ ok: false }),
      canManageGroupFn: async () => true,
      isBusyFn: isCommunityChallengeBusy,
      getBusyReasonFn: getCommunityBusyReason,
      isChatFightOpenFn: () => false,
      isTicTacToeOpenFn: () => false,
      isConnectFourOpenFn: () => false,
      isTriviaOpenFn: () => openTrivia.isTriviaOpen(),
    });
    assert.ok(tttCtx.replies[0].includes("Trivia"));

    const c4Ctx = createMockCtx({ userId: ADMIN_ID, text: "/connect4" });
    await handleConnectFour(c4Ctx, {
      startChallengeFn: () => ({ ok: false }),
      canManageGroupFn: async () => true,
      isBusyFn: isCommunityChallengeBusy,
      getBusyReasonFn: getCommunityBusyReason,
      isChatFightOpenFn: () => false,
      isTicTacToeOpenFn: () => false,
      isConnectFourOpenFn: () => false,
      isTriviaOpenFn: () => openTrivia.isTriviaOpen(),
    });
    assert.ok(c4Ctx.replies[0].includes("Trivia"));
  });

  await runTest("busy released after completion", () => {
    const { service } = createService();
    const started = startSample(service);
    assert.strictEqual(service.isTriviaOpen(), true);
    service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: 1,
      chatId: COMMUNITY_CHAT,
      displayName: "Alice",
    });
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isTriviaOpenFn: () => service.isTriviaOpen(),
      }),
      false
    );
  });

  await runTest("question anti-repeat window + fallback", () => {
    const bank = [
      { id: "a", category: "x", question: "A?", answers: ["1", "2", "3", "4"], correctIndex: 0 },
      { id: "b", category: "x", question: "B?", answers: ["1", "2", "3", "4"], correctIndex: 0 },
      { id: "c", category: "x", question: "C?", answers: ["1", "2", "3", "4"], correctIndex: 0 },
    ];
    let recent = [];
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      const picked = pickTriviaQuestion(bank, recent, () => 0, 10);
      recent = picked.recentIds;
      seen.push(picked.question.id);
    }
    assert.deepStrictEqual(seen.slice(0, 3), ["a", "b", "c"]);
    assert.strictEqual(seen[3], "a");
    assert.ok(ANTI_REPEAT_WINDOW >= 10);
  });

  await runTest("malformed callback / wrong chat / bot safe", async () => {
    const { service } = createService();
    const started = startSample(service);

    const malformed = createMockCtx({
      callbackData: "trivia:not-hex:1",
    });
    await handleTriviaAnswer(malformed, { runtime: service });
    assert.strictEqual(malformed.cbAnswers.length, 0);
    assert.strictEqual(service.isTriviaOpen(), true);

    const botCtx = createMockCtx({
      isBot: true,
      callbackData: buildAnswerCallbackData(started.session.id, 1),
    });
    await handleTriviaAnswer(botCtx, { runtime: service });
    assert.ok(botCtx.cbAnswers[0].includes("Bots"));
    assert.strictEqual(service.isTriviaOpen(), true);

    const wrongChat = createMockCtx({
      chatId: OTHER_CHAT,
      callbackData: buildAnswerCallbackData(started.session.id, 1),
    });
    await handleTriviaAnswer(wrongChat, { runtime: service });
    assert.ok(wrongChat.cbAnswers[0].includes("Wrong chat"));
    assert.strictEqual(service.isTriviaOpen(), true);
  });

  await runTest("callback handler awards + edits complete message", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startSample(service);
    const ctx = createMockCtx({
      userId: USER_C,
      firstName: "Carol",
      callbackData: buildAnswerCallbackData(started.session.id, 1),
    });
    await handleTriviaAnswer(ctx, {
      runtime: service,
      awardTriviaWinXpFn: (uid, name) => awardTriviaWinXp(uid, name, file),
    });
    assert.ok(ctx.cbAnswers.some((a) => a.includes("Correct")));
    assert.ok(ctx.edited[0].text.includes("TRIVIA COMPLETE"));
    assert.ok(ctx.edited[0].text.includes("Carol"));
    assert.ok(ctx.edited[0].text.includes("Reward: +2 XP"));
    assert.strictEqual(loadPoints(file).users[String(USER_C)].points, 2);
    assert.strictEqual(service.isTriviaOpen(), false);
  });

  await runTest("help lists /trivia; auto registry disabled", () => {
    assert.ok(HELP_MESSAGE.includes("/trivia"));
    assert.strictEqual(ACTION_REGISTRY.trivia.enabledForAuto, false);
    assert.strictEqual(ACTION_REGISTRY.trivia.mode, "race");
  });

  await runTest("trivia does not claim daily activity via callback", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startSample(service);
    const ctx = createMockCtx({
      userId: USER_A,
      callbackData: buildAnswerCallbackData(started.session.id, 1),
    });
    await handleTriviaAnswer(ctx, {
      runtime: service,
      awardTriviaWinXpFn: (uid, name) => awardTriviaWinXp(uid, name, file),
    });
    const user = loadPoints(file).users[String(USER_A)];
    assert.strictEqual(user.points, 2);
    assert.strictEqual(user.activityDate, null);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  console.log("\nAll trivia tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
