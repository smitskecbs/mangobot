/**
 * Trivia 5-question rounds + auto engine + XP cap.
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
  TRIVIA_ROUND_QUESTIONS,
  TRIVIA_ROUND_WIN_XP,
  TRIVIA_TIE_XP,
  rankRoundScores,
} = require("../services/trivia");
const {
  TRIVIA_QUESTIONS,
  ANTI_REPEAT_WINDOW,
  pickTriviaQuestion,
  validateTriviaQuestionBank,
} = require("../services/triviaQuestions");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const {
  awardTriviaRoundXp,
  TRIVIA_DAILY_REWARD_CAP,
  loadPoints,
} = require("../services/points");
const { handleTrivia, handleTriviaAnswer } = require("../commands/trivia");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  ACTION_REGISTRY,
  ACTION_WEIGHTS,
  ACTION_IDS,
  chooseAction,
  processCommunityActivitySlot,
  isActionEligible,
} = require("../services/communityActivityEngine");
const { createChatFightService } = require("../services/chatFight");
const { HELP_MESSAGE } = require("../commands/help");
const {
  scheduleExpiredMessageCleanup,
  emptyInlineKeyboardExtra,
  EXPIRED_MESSAGE_CLEANUP_MS,
  clearAllExpiredMessageCleanups,
  getPendingExpiredCleanupCount,
} = require("../utils/expiredMessageCleanup");

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
const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

function pointsFile() {
  testCounter += 1;
  return path.join(tempDir, `points-${testCounter}.json`);
}

function resetEnv() {
  process.env.ADMIN_USER_ID = String(OWNER_ID);
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalGamesTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalGamesTopic;
}

async function runTest(name, fn) {
  resetEnv();
  clearAllExpiredMessageCleanups();
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

function makeBank(n = 20) {
  const bank = [];
  for (let i = 0; i < n; i += 1) {
    bank.push({
      id: `t-${i}`,
      category: "general knowledge",
      question: `Question number ${i}?`,
      answers: ["Alpha", "Beta", "Gamma", "Delta"],
      correctIndex: 1,
    });
  }
  return bank;
}

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const service = createTriviaService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    questionTimeoutMs:
      overrides.questionTimeoutMs != null ? overrides.questionTimeoutMs : 60_000,
    nextQuestionDelayMs:
      overrides.nextQuestionDelayMs != null ? overrides.nextQuestionDelayMs : 5_000,
    wrongAnswerNextDelayMs:
      overrides.wrongAnswerNextDelayMs != null
        ? overrides.wrongAnswerNextDelayMs
        : 2_500,
    totalQuestions:
      overrides.totalQuestions != null
        ? overrides.totalQuestions
        : TRIVIA_ROUND_QUESTIONS,
    random: overrides.random || (() => 0),
    randomIdFn: overrides.randomIdFn || (() => "abc123"),
    questions: overrides.questions || makeBank(30),
    antiRepeatWindow: overrides.antiRepeatWindow,
  });
  return { service, timers };
}

function startRound(service, chatId = COMMUNITY_CHAT) {
  const started = service.startTrivia({ chatId, source: "manual" });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 9001);
  return started;
}

function answerCorrect(service, sessionId, userId, name) {
  const snap = service.getSnapshot();
  assert.ok(snap);
  return service.tryAnswer({
    sessionId,
    userId,
    answerIndex: snap.correctIndex,
    chatId: COMMUNITY_CHAT,
    displayName: name,
  });
}

function answerWrong(service, sessionId, userId, name) {
  const snap = service.getSnapshot();
  const wrong = (snap.correctIndex + 1) % 4;
  return service.tryAnswer({
    sessionId,
    userId,
    answerIndex: wrong,
    chatId: COMMUNITY_CHAT,
    displayName: name,
  });
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
  messageThreadId,
} = {}) {
  const replies = [];
  const replyExtras = [];
  const cbAnswers = [];
  const edited = [];
  const message = { text };
  if (messageThreadId != null) {
    message.message_thread_id = messageThreadId;
  }
  const callbackQuery = callbackData
    ? {
        data: callbackData,
        from: { id: userId, is_bot: isBot },
        message: {
          message_id: 9001,
          chat: { id: chatId, type: chatType },
          ...(messageThreadId != null
            ? { message_thread_id: messageThreadId }
            : {}),
        },
      }
    : undefined;
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName, is_bot: isBot },
    message,
    callbackQuery,
    replies,
    replyExtras,
    cbAnswers,
    edited,
    telegram: {
      getChatMember() {
        return Promise.resolve({ status: memberStatus, user: { id: userId } });
      },
    },
    reply(msg, extra) {
      replies.push(msg);
      replyExtras.push(extra);
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

  await runTest("question bank validates", () => {
    const result = validateTriviaQuestionBank(TRIVIA_QUESTIONS);
    assert.strictEqual(result.ok, true, result.errors.join("; "));
    assert.ok(TRIVIA_QUESTIONS.length >= 50);
  });

  await runTest("round = 5 questions + numbering", () => {
    const { service } = createService();
    const started = startRound(service);
    assert.strictEqual(started.session.totalQuestions, 5);
    assert.strictEqual(started.session.questionNumber, 1);
    assert.ok(started.text.includes("Question 1 / 5"));
    assert.strictEqual(TRIVIA_ROUND_QUESTIONS, 5);
  });

  await runTest("one attempt per question; resets next question", () => {
    const { service, timers } = createService();
    const started = startRound(service);
    const wrong = answerWrong(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(wrong.correct, false);
    const again = answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(again.reason, "question-closed");

    const bob = answerCorrect(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(bob.reason, "question-closed");
    timers.advance(2_500);
    assert.strictEqual(service.getSnapshot().questionNumber, 2);
    const next = answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(next.questionWon, true);
    assert.strictEqual(service.getSnapshot().scores[String(USER_A)].score, 1);
  });

  await runTest("first correct earns 1 round point; wrong 0; no lifetime XP yet", () => {
    const file = pointsFile();
    const { service, timers } = createService();
    const started = startRound(service);
    service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: (service.getSnapshot().correctIndex + 1) % 4,
      chatId: COMMUNITY_CHAT,
      displayName: "Alice",
    });
    assert.strictEqual(service.getSnapshot().scores[String(USER_A)], undefined);
    const closed = answerCorrect(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(closed.reason, "question-closed");
    timers.advance(2_500);
    answerCorrect(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(service.getSnapshot().scores[String(USER_B)].score, 1);
    assert.strictEqual(service.getSnapshot().scores[String(USER_A)], undefined);
    assert.strictEqual(loadPoints(file).users[String(USER_B)], undefined);
  });

  await runTest("wrong answer shows ❌ and correct answer; next question in 2.5s", () => {
    const edits = [];
    const { service, timers } = createService();
    service.setEditMessageHandler((_c, _m, text, extra) => {
      edits.push({ text, extra });
    });
    const started = startRound(service);
    const snap = service.getSnapshot();
    const correctText = snap.answers[snap.correctIndex];
    const wrong = answerWrong(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(wrong.correct, false);
    assert.ok(wrong.rendered.text.includes("❌ Wrong answer!"));
    assert.ok(wrong.rendered.text.includes("Correct answer:"));
    assert.ok(wrong.rendered.text.includes(`✅ ${correctText}`));
    assert.ok(wrong.rendered.text.includes("Next question coming up"));
    assert.strictEqual(wrong.toast, "❌ Wrong answer!");
    assert.strictEqual(service.getPendingTimerCount(), 1);
    timers.advance(2_499);
    assert.strictEqual(service.getSnapshot().questionNumber, 1);
    timers.advance(1);
    assert.strictEqual(service.getSnapshot().questionNumber, 2);
  });

  await runTest("correct answer keeps 5s delay; wrong uses 2.5s", () => {
    const { service, timers } = createService();
    const started = startRound(service);
    answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.ok(service.buildQuestionWonText(service.getSnapshot(), "Alice").includes("5 seconds"));
    timers.advance(2_500);
    assert.strictEqual(service.getSnapshot().questionNumber, 1);
    timers.advance(2_500);
    assert.strictEqual(service.getSnapshot().questionNumber, 2);
  });

  await runTest("repeated wrong callback does not duplicate next-question timer", () => {
    const { service, timers } = createService();
    const started = startRound(service);
    const first = answerWrong(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(first.ok, true);
    assert.strictEqual(service.getPendingTimerCount(), 1);
    const second = answerWrong(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, "question-closed");
    const third = answerWrong(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(third.reason, "question-closed");
    assert.strictEqual(service.getPendingTimerCount(), 1);
    timers.advance(2_500);
    assert.strictEqual(service.getSnapshot().questionNumber, 2);
    assert.strictEqual(service.getPendingTimerCount(), 1);
  });

  await runTest("wrong answer awards no round XP; correct XP unchanged", () => {
    const file = pointsFile();
    const { service, timers } = createService({ nextQuestionDelayMs: 1, wrongAnswerNextDelayMs: 1 });
    service.setAwardXpHandler((uid, name, amount) =>
      awardTriviaRoundXp(uid, name, amount, file)
    );
    service.setEditMessageHandler(() => {});
    const started = startRound(service);
    answerWrong(service, started.session.id, USER_A, "Alice");
    timers.advance(1);
    for (let q = 2; q <= 5; q += 1) {
      answerCorrect(service, started.session.id, USER_B, "Bob");
      timers.advance(1);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
    assert.strictEqual(loadPoints(file).users[String(USER_B)].points, 3);
    assert.strictEqual(TRIVIA_ROUND_WIN_XP, 3);
    assert.strictEqual(TRIVIA_TIE_XP, 2);
  });

  await runTest("handleTriviaAnswer edits wrong-answer message once", async () => {
    const { service } = createService();
    const started = startRound(service);
    const snap = service.getSnapshot();
    const wrongIndex = (snap.correctIndex + 1) % 4;
    const ctx = createMockCtx({
      userId: USER_A,
      name: "Alice",
      callbackData: buildAnswerCallbackData(started.session.id, wrongIndex),
    });
    await handleTriviaAnswer(ctx, { runtime: service });
    assert.strictEqual(ctx.cbAnswers[0], "❌ Wrong answer!");
    assert.strictEqual(ctx.edited.length, 1);
    assert.ok(ctx.edited[0].text.includes("❌ Wrong answer!"));
    assert.ok(ctx.edited[0].text.includes("Correct answer:"));
    await handleTriviaAnswer(ctx, { runtime: service });
    assert.strictEqual(ctx.cbAnswers[1], "This question is over.");
    assert.strictEqual(ctx.edited.length, 1);
  });

  await runTest("question timeout continues round; 5th completes", () => {
    const edits = [];
    const { service, timers } = createService({
      questionTimeoutMs: 60_000,
      nextQuestionDelayMs: 5_000,
    });
    service.setEditMessageHandler((chatId, messageId, text, extra) => {
      edits.push({ text, extra });
    });
    const file = pointsFile();
    service.setAwardXpHandler((uid, name, amount) =>
      awardTriviaRoundXp(uid, name, amount, file)
    );
    startRound(service);
    assert.strictEqual(service.isTriviaOpen(), true);

    for (let q = 1; q <= 5; q += 1) {
      assert.strictEqual(service.getSnapshot().questionNumber, q);
      timers.advance(60_000);
      assert.ok(edits.some((e) => e.text.includes("TIME'S UP")));
      if (q < 5) {
        timers.advance(5_000);
      } else {
        timers.advance(5_000);
      }
    }
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, STATUS.COMPLETE);
    assert.ok(edits.some((e) => e.text.includes("TRIVIA COMPLETE")));
  });

  await runTest("sole winner +3 XP; tie +2 XP; owner +0; daily cap", () => {
    const file = pointsFile();
    assert.strictEqual(TRIVIA_ROUND_WIN_XP, 3);
    assert.strictEqual(TRIVIA_TIE_XP, 2);
    assert.strictEqual(TRIVIA_DAILY_REWARD_CAP, 2);

    const sole = awardTriviaRoundXp(USER_A, "Alice", TRIVIA_ROUND_WIN_XP, file);
    assert.strictEqual(sole.awarded, true);
    assert.strictEqual(sole.pointsToAdd, 3);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 3);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].weeklyPoints, 3);

    const tie = awardTriviaRoundXp(USER_B, "Bob", TRIVIA_TIE_XP, file);
    assert.strictEqual(tie.awarded, true);
    assert.strictEqual(tie.pointsToAdd, 2);

    const owner = awardTriviaRoundXp(OWNER_ID, "Kevin", TRIVIA_ROUND_WIN_XP, file);
    assert.strictEqual(owner.awarded, false);
    assert.strictEqual(owner.reason, "excluded");

    awardTriviaRoundXp(USER_A, "Alice", TRIVIA_ROUND_WIN_XP, file);
    const capped = awardTriviaRoundXp(USER_A, "Alice", TRIVIA_ROUND_WIN_XP, file);
    assert.strictEqual(capped.awarded, false);
    assert.strictEqual(capped.reason, "daily-cap");
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 6);
  });

  await runTest("full round sole winner awards once; concurrency one question winner", () => {
    const file = pointsFile();
    const { service, timers } = createService({ nextQuestionDelayMs: 1 });
    service.setAwardXpHandler((uid, name, amount) =>
      awardTriviaRoundXp(uid, name, amount, file)
    );
    const edits = [];
    service.setEditMessageHandler((c, m, text) => {
      edits.push(text);
    });
    const started = startRound(service);

    for (let q = 1; q <= 5; q += 1) {
      const a = answerCorrect(service, started.session.id, USER_A, "Alice");
      const b = answerCorrect(service, started.session.id, USER_B, "Bob");
      assert.strictEqual(a.questionWon, true);
      assert.strictEqual(b.ok, false);
      timers.advance(1);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 3);
    assert.strictEqual(loadPoints(file).users[String(USER_B)], undefined);
    const claim2 = service.claimRoundXp();
    assert.strictEqual(claim2.shouldAward, false);
  });

  await runTest("tie winners both get +2", () => {
    const file = pointsFile();
    const { service, timers } = createService({ nextQuestionDelayMs: 1 });
    service.setAwardXpHandler((uid, name, amount) =>
      awardTriviaRoundXp(uid, name, amount, file)
    );
    service.setEditMessageHandler(() => {});
    const started = startRound(service);
    // A wins Q1,Q2; B wins Q3,Q4; Q5 timeout → tie 2-2
    answerCorrect(service, started.session.id, USER_A, "Alice");
    timers.advance(1);
    answerCorrect(service, started.session.id, USER_A, "Alice");
    timers.advance(1);
    answerCorrect(service, started.session.id, USER_B, "Bob");
    timers.advance(1);
    answerCorrect(service, started.session.id, USER_B, "Bob");
    timers.advance(1);
    timers.advance(60_000);
    timers.advance(1);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 2);
    assert.strictEqual(loadPoints(file).users[String(USER_B)].points, 2);
  });

  await runTest("all scores 0 after five questions → no tie XP", () => {
    const file = pointsFile();
    const awards = [];
    const edits = [];
    const { service, timers } = createService({ nextQuestionDelayMs: 1 });
    service.setAwardXpHandler((uid, name, amount) => {
      awards.push({ uid, name, amount });
      return awardTriviaRoundXp(uid, name, amount, file);
    });
    service.setEditMessageHandler((_c, _m, text) => {
      edits.push(text);
    });
    startRound(service);
    for (let q = 1; q <= 5; q += 1) {
      timers.advance(60_000);
      timers.advance(1);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, STATUS.COMPLETE);
    assert.strictEqual(awards.length, 0);
    assert.strictEqual(Object.keys(loadPoints(file).users || {}).length, 0);
    const claim = service.claimRoundXp();
    assert.strictEqual(claim.shouldAward, false);
    assert.strictEqual(claim.ok, false);
    assert.strictEqual(claim.reason, "already-claimed");
    const final = edits.find((t) => t.includes("TRIVIA COMPLETE"));
    assert.ok(final);
    assert.ok(final.includes("No Trivia winner — nobody scored."));
    assert.ok(final.includes("No Trivia XP this round."));
    assert.ok(!final.includes("Trivia tie"));
    const ranked = rankRoundScores(service.getSnapshot().scores);
    assert.strictEqual(ranked.length, 0);
  });

  await runTest("busy remains between questions; released after round", () => {
    const { service, timers } = createService({ nextQuestionDelayMs: 5_000 });
    const started = startRound(service);
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isTriviaOpenFn: () => service.isTriviaOpen(),
      }),
      true
    );
    answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(service.isTriviaOpen(), true);
    timers.advance(5_000);
    assert.strictEqual(service.isTriviaOpen(), true);
    for (let q = 2; q <= 5; q += 1) {
      answerCorrect(service, started.session.id, USER_A, "Alice");
      timers.advance(5_000);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
  });

  await runTest("auto registry + weights total 100", () => {
    assert.strictEqual(ACTION_REGISTRY.trivia.enabledForAuto, true);
    assert.strictEqual(ACTION_REGISTRY.trivia.mode, "race");
    assert.strictEqual(ACTION_WEIGHTS[ACTION_IDS.TRIVIA], 15);
    assert.strictEqual(ACTION_WEIGHTS[ACTION_IDS.CHATFIGHT], 18);
    const total = Object.values(ACTION_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, 100);
  });

  await runTest("auto slot may select Trivia; busy blocks", async () => {
    const { service } = createService();
    const fight = createChatFightService({ cooldownMs: 0 });
    const config = {
      enabled: true,
      autoFightEnabled: true,
      autoFightMinGapMs: 0,
      skipRecentMs: 0,
      fightTypes: ["type_rush"],
      slots: [{ id: "s1", label: "00:00", hour: 0, minute: 0 }],
    };
    const state = { sent: {}, autoChatFight: {}, recentActivityTypes: [] };
    let announced = null;
    const result = await processCommunityActivitySlot({
      chatId: COMMUNITY_CHAT,
      slot: config.slots[0],
      dayKey: "2026-08-14",
      config,
      state,
      chatFight: fight,
      triviaRuntime: service,
      sendMessage: async () => true,
      announceTrivia: async (chatId, text, keyboard) => {
        announced = { chatId, text, keyboard };
        return { message_id: 42 };
      },
      nowMs: Date.now(),
      random: () => 0.2,
      wasActiveWithinFn: () => false,
    });
    // With random 0.2 and weights, may or may not pick trivia — force eligibility checks
    assert.strictEqual(
      isActionEligible(ACTION_IDS.TRIVIA, {
        config,
        chatFight: fight,
        autoState: {},
        nowMs: Date.now(),
      }),
      true
    );
    fight.startFight({ chatId: COMMUNITY_CHAT, type: "type_rush", source: "auto" });
    assert.strictEqual(
      isActionEligible(ACTION_IDS.TRIVIA, {
        config,
        chatFight: fight,
        autoState: {},
        nowMs: Date.now(),
      }),
      false
    );
    fight.reset();

    // isTriviaBusy() reads the production singleton
    const { getTriviaRuntime } = require("../services/trivia");
    const prod = getTriviaRuntime();
    prod.reset();
    assert.strictEqual(
      prod.startTrivia({ chatId: COMMUNITY_CHAT, source: "manual" }).ok,
      true
    );
    assert.strictEqual(
      isActionEligible(ACTION_IDS.TRIVIA, {
        config,
        chatFight: fight,
        autoState: {},
        nowMs: Date.now(),
      }),
      false
    );
    prod.reset();
    service.reset();
    void result;
    void announced;
  });

  await runTest("auto starts same 5-question runtime; members can start manual", async () => {
    const { service } = createService();
    const started = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      source: "auto",
      autoIntro: true,
    });
    assert.strictEqual(started.ok, true);
    assert.ok(started.text.includes("5-question community round"));
    assert.ok(started.text.includes("Question 1 / 5"));
    assert.strictEqual(started.session.totalQuestions, 5);
    service.reset();

    const member = createMockCtx({ userId: USER_A, memberStatus: "member" });
    await handleTrivia(member, {
      startTriviaFn: (p) => service.startTrivia(p),
      isBusyFn: () => false,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(member.replies[0].includes("Question 1 / 5"));
    assert.ok(!String(member.replies[0]).toLowerCase().includes("admin"));
  });

  await runTest("member start blocked outside Games topic when configured", async () => {
    process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
    const { service } = createService();
    const general = createMockCtx({ userId: USER_A, memberStatus: "member" });
    await handleTrivia(general, {
      startTriviaFn: (p) => service.startTrivia(p),
      isBusyFn: () => false,
      canManageGroupFn: async () => false,
    });
    assert.ok(general.replies[0].includes("Games topic"));
    assert.strictEqual(service.isTriviaOpen(), false);

    const wrong = createMockCtx({
      userId: USER_A,
      memberStatus: "member",
      messageThreadId: 999,
    });
    await handleTrivia(wrong, {
      startTriviaFn: (p) => service.startTrivia(p),
      isBusyFn: () => false,
      canManageGroupFn: async () => false,
    });
    assert.ok(wrong.replies[0].includes("Games topic"));

    const ok = createMockCtx({
      userId: USER_A,
      memberStatus: "member",
      messageThreadId: 123,
    });
    await handleTrivia(ok, {
      startTriviaFn: (p) => service.startTrivia(p),
      isBusyFn: () => false,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(ok.replies[0].includes("Question 1"));
    assert.strictEqual(ok.replyExtras[0].message_thread_id, 123);

    const adminBypass = createMockCtx({
      userId: OWNER_ID,
      memberStatus: "administrator",
    });
    service.reset();
    await handleTrivia(adminBypass, {
      startTriviaFn: (p) => service.startTrivia(p),
      isBusyFn: () => false,
      canManageGroupFn: async () => true,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(adminBypass.replies[0].includes("Question 1"));
  });

  await runTest("auto Trivia announce uses Games topic thread when configured", async () => {
    process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
    const { applyGamesTopicToExtra } = require("../utils/gameTopic");
    assert.strictEqual(applyGamesTopicToExtra({}).message_thread_id, 123);

    const { service } = createService();
    const announced = [];
    const fight = createChatFightService({ cooldownMs: 0 });
    const config = {
      enabled: true,
      autoFightEnabled: false,
      autoFightMinGapMs: 0,
      skipRecentMs: 0,
      fightTypes: ["type_rush"],
      slots: [{ id: "s1", label: "00:00", hour: 0, minute: 0 }],
    };
    const result = await processCommunityActivitySlot({
      chatId: COMMUNITY_CHAT,
      slot: config.slots[0],
      dayKey: "2026-08-15-topic",
      config,
      state: { sent: {}, autoChatFight: {}, recentActivityTypes: [] },
      chatFight: fight,
      triviaRuntime: service,
      sendMessage: async () => true,
      announceTrivia: async (chatId, text, keyboard) => {
        const extra = applyGamesTopicToExtra(
          keyboard && keyboard.reply_markup
            ? { reply_markup: keyboard.reply_markup }
            : {}
        );
        announced.push({ chatId, text, extra });
        return { message_id: 77 };
      },
      nowMs: Date.now(),
      random: () => 0,
      wasActiveWithinFn: () => true,
    });
    assert.strictEqual(result.action, ACTION_IDS.TRIVIA);
    assert.strictEqual(announced.length, 1);
    assert.strictEqual(announced[0].chatId, COMMUNITY_CHAT);
    assert.strictEqual(announced[0].extra.message_thread_id, 123);
    service.reset();
  });

  await runTest("cleanup helper schedules delete; failure safe", async () => {
    const timers = createFakeTimers();
    let deleted = null;
    let logged = false;
    const scheduled = scheduleExpiredMessageCleanup({
      chatId: COMMUNITY_CHAT,
      messageId: 55,
      delayMs: EXPIRED_MESSAGE_CLEANUP_MS,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async () => {
        deleted = 55;
        throw new Error("boom");
      },
      logErrorFn: () => {
        logged = true;
      },
    });
    assert.strictEqual(scheduled.scheduled, true);
    assert.strictEqual(getPendingExpiredCleanupCount(), 1);
    timers.advance(EXPIRED_MESSAGE_CLEANUP_MS);
    await Promise.resolve();
    assert.strictEqual(deleted, 55);
    assert.strictEqual(logged, true);
    assert.ok(emptyInlineKeyboardExtra().reply_markup.inline_keyboard);
  });

  await runTest("callbacks opaque; help lists 5-question", () => {
    const data = buildAnswerCallbackData("abc123", 1);
    assert.strictEqual(data, "trivia:abc123:1");
    assert.ok(!data.includes("Beta"));
    assert.deepStrictEqual(parseTriviaCallbackData(data), {
      sessionId: "abc123",
      answerIndex: 1,
    });
    assert.ok(HELP_MESSAGE.includes("Start a Trivia round"));
  });

  await runTest("anti-repeat window", () => {
    const bank = makeBank(3);
    let recent = [];
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      const picked = pickTriviaQuestion(bank, recent, () => 0, 10);
      recent = picked.recentIds;
      seen.push(picked.question.id);
    }
    assert.deepStrictEqual(seen.slice(0, 3), ["t-0", "t-1", "t-2"]);
    assert.ok(ANTI_REPEAT_WINDOW >= 10);
  });

  await runTest("fatal abort releases busy", () => {
    const { service } = createService();
    startRound(service);
    service.abortRound("edit-failed");
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, STATUS.ABORTED);
  });

  await runTest("configured group only + private rejected", async () => {
    const { service } = createService();
    const privateCtx = createMockCtx({ chatType: "private", chatId: USER_A });
    await handleTrivia(privateCtx, {
      startTriviaFn: (p) => service.startTrivia(p),
      canManageGroupFn: async () => true,
    });
    assert.ok(privateCtx.replies[0].includes("community group"));
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  clearAllExpiredMessageCleanups();
  console.log("\nAll trivia tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
