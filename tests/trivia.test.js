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
  buildHubNavCallbackData,
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
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const {
  awardTriviaRoundXp,
  awardTriviaAttemptXp,
  TRIVIA_DAILY_REWARD_CAP,
  TRIVIA_ATTEMPT_XP,
  TRIVIA_DAILY_ATTEMPT_CAP,
  loadPoints,
} = require("../services/points");
const {
  handleTrivia,
  handleTriviaAnswer,
  handleTriviaHubCallback,
} = require("../commands/trivia");
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
const {
  clearAllGameMessageCleanups,
} = require("../utils/gameCleanup");
const {
  getGroupMenuOwner,
  resetGroupMenuOwnersForTests,
} = require("../utils/menuOwnership");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-trivia-"));
setMangoShopFileForTests(path.join(tempDir, "shop.json"));
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
  clearAllGameMessageCleanups();
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
      category: "general",
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
    staleAfterMs: overrides.staleAfterMs,
    cleanupDelayMs: overrides.cleanupDelayMs,
    deleteMessageFn: overrides.deleteMessageFn,
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

async function answerCorrect(service, sessionId, userId, name) {
  const snap = service.getSnapshot();
  assert.ok(snap);
  return await service.tryAnswer({
    sessionId,
    userId,
    answerIndex: snap.correctIndex,
    chatId: COMMUNITY_CHAT,
    displayName: name,
  });
}

async function answerWrong(service, sessionId, userId, name) {
  const snap = service.getSnapshot();
  const wrong = (snap.correctIndex + 1) % 4;
  return await service.tryAnswer({
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
  messageId = 9001,
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
          message_id: messageId,
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

  await runTest("question bank validates", async () => {
    const result = validateTriviaQuestionBank(TRIVIA_QUESTIONS);
    assert.strictEqual(result.ok, true, result.errors.join("; "));
    assert.ok(TRIVIA_QUESTIONS.length >= 50);
  });

  await runTest("round = 5 questions + numbering", async () => {
    const { service } = createService();
    const started = startRound(service);
    assert.strictEqual(started.session.totalQuestions, 5);
    assert.strictEqual(started.session.questionNumber, 1);
    assert.ok(started.text.includes("Question 1 / 5"));
    assert.strictEqual(TRIVIA_ROUND_QUESTIONS, 5);
  });

  await runTest("one attempt per question; resets next question", async () => {
    const { service, timers } = createService();
    const started = startRound(service);
    const wrong = await answerWrong(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(wrong.correct, false);
    const again = await answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(again.reason, "question-closed");

    const bob = await answerCorrect(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(bob.reason, "question-closed");
    timers.advance(2_500);
    assert.strictEqual(service.getSnapshot().questionNumber, 2);
    const next = await answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(next.questionWon, true);
    assert.strictEqual(service.getSnapshot().scores[String(USER_A)].score, 1);
  });

  await runTest("first correct earns 1 round point; wrong 0; no lifetime XP yet", async () => {
    const file = pointsFile();
    const { service, timers } = createService();
    const started = startRound(service);
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: (service.getSnapshot().correctIndex + 1) % 4,
      chatId: COMMUNITY_CHAT,
      displayName: "Alice",
    });
    assert.strictEqual(service.getSnapshot().scores[String(USER_A)], undefined);
    const closed = await answerCorrect(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(closed.reason, "question-closed");
    timers.advance(2_500);
    await answerCorrect(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(service.getSnapshot().scores[String(USER_B)].score, 1);
    assert.strictEqual(service.getSnapshot().scores[String(USER_A)], undefined);
    assert.strictEqual(loadPoints(file).users[String(USER_B)], undefined);
  });

  await runTest("wrong answer shows ❌ and correct answer; next question in 2.5s", async () => {
    const edits = [];
    const { service, timers } = createService();
    service.setEditMessageHandler((_c, _m, text, extra) => {
      edits.push({ text, extra });
    });
    const started = startRound(service);
    const snap = service.getSnapshot();
    const correctText = snap.answers[snap.correctIndex];
    const wrong = await answerWrong(service, started.session.id, USER_A, "Alice");
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

  await runTest("correct answer keeps 5s delay; wrong uses 2.5s", async () => {
    const { service, timers } = createService();
    const started = startRound(service);
    await answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.ok(service.buildQuestionWonText(service.getSnapshot(), "Alice").includes("5 seconds"));
    timers.advance(2_500);
    assert.strictEqual(service.getSnapshot().questionNumber, 1);
    timers.advance(2_500);
    assert.strictEqual(service.getSnapshot().questionNumber, 2);
  });

  await runTest("repeated wrong callback does not duplicate next-question timer", async () => {
    const { service, timers } = createService();
    const started = startRound(service);
    const first = await answerWrong(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(first.ok, true);
    assert.strictEqual(service.getPendingTimerCount(), 1);
    const second = await answerWrong(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, "question-closed");
    const third = await answerWrong(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(third.reason, "question-closed");
    assert.strictEqual(service.getPendingTimerCount(), 1);
    timers.advance(2_500);
    assert.strictEqual(service.getSnapshot().questionNumber, 2);
    assert.strictEqual(service.getPendingTimerCount(), 1);
  });

  await runTest("wrong answer awards no round XP; correct XP unchanged", async () => {
    const file = pointsFile();
    const { service, timers } = createService({ nextQuestionDelayMs: 1, wrongAnswerNextDelayMs: 1 });
    service.setAwardXpHandler((uid, name, payload) => awardTriviaAttemptXp(uid, name, payload, file)
    );
    service.setEditMessageHandler(() => {});
    const started = startRound(service);
    await answerWrong(service, started.session.id, USER_A, "Alice");
    timers.advance(1);
    for (let q = 2; q <= 5; q += 1) {
      await answerCorrect(service, started.session.id, USER_B, "Bob");
      timers.advance(1);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 0);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].trivia.attemptsUsed, 1);
    assert.strictEqual(loadPoints(file).users[String(USER_B)].points, 4);
    assert.strictEqual(TRIVIA_ATTEMPT_XP, 1);
    assert.strictEqual(TRIVIA_DAILY_ATTEMPT_CAP, 5);
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
    assert.strictEqual(ctx.cbAnswers[1], "This question is already finished.");
    assert.strictEqual(ctx.edited.length, 1);
  });

  await runTest("question timeout continues round; 5th completes", async () => {
    const edits = [];
    const { service, timers } = createService({
      questionTimeoutMs: 60_000,
      nextQuestionDelayMs: 5_000,
    });
    service.setEditMessageHandler((chatId, messageId, text, extra) => {
      edits.push({ text, extra });
    });
    const file = pointsFile();
    service.setAwardXpHandler((uid, name, payload) => awardTriviaAttemptXp(uid, name, payload, file)
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

  await runTest("sole winner +3 XP; tie +2 XP; owner earns; daily cap", async () => {
    const file = pointsFile();
    assert.strictEqual(TRIVIA_ROUND_WIN_XP, 3);
    assert.strictEqual(TRIVIA_TIE_XP, 2);
    assert.strictEqual(TRIVIA_DAILY_REWARD_CAP, 2);

    const sole = await awardTriviaRoundXp(USER_A, "Alice", TRIVIA_ROUND_WIN_XP, file);
    assert.strictEqual(sole.awarded, true);
    assert.strictEqual(sole.pointsToAdd, 3);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 3);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].weeklyPoints, 3);

    const tie = await awardTriviaRoundXp(USER_B, "Bob", TRIVIA_TIE_XP, file);
    assert.strictEqual(tie.awarded, true);
    assert.strictEqual(tie.pointsToAdd, 2);

    const owner = await awardTriviaRoundXp(OWNER_ID, "Kevin", TRIVIA_ROUND_WIN_XP, file);
    assert.strictEqual(owner.awarded, true);
    assert.strictEqual(owner.pointsToAdd, 3);

    await awardTriviaRoundXp(USER_A, "Alice", TRIVIA_ROUND_WIN_XP, file);
    const capped = await awardTriviaRoundXp(USER_A, "Alice", TRIVIA_ROUND_WIN_XP, file);
    assert.strictEqual(capped.awarded, false);
    assert.strictEqual(capped.reason, "daily-cap");
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 6);
  });

  await runTest("full round sole winner awards once; concurrency one question winner", async () => {
    const file = pointsFile();
    const { service, timers } = createService({ nextQuestionDelayMs: 1 });
    service.setAwardXpHandler((uid, name, payload) => awardTriviaAttemptXp(uid, name, payload, file)
    );
    const edits = [];
    service.setEditMessageHandler((c, m, text) => {
      edits.push(text);
    });
    const started = startRound(service);

    for (let q = 1; q <= 5; q += 1) {
      const a = await answerCorrect(service, started.session.id, USER_A, "Alice");
      const b = await answerCorrect(service, started.session.id, USER_B, "Bob");
      assert.strictEqual(a.questionWon, true);
      assert.strictEqual(b.ok, false);
      timers.advance(1);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 5);
    assert.strictEqual(loadPoints(file).users[String(USER_B)], undefined);
    const claim2 = service.claimRoundXp();
    assert.strictEqual(claim2.shouldAward, false);
  });

  await runTest("tie winners both get +2", async () => {
    const file = pointsFile();
    const { service, timers } = createService({ nextQuestionDelayMs: 1 });
    service.setAwardXpHandler((uid, name, payload) => awardTriviaAttemptXp(uid, name, payload, file)
    );
    service.setEditMessageHandler(() => {});
    const started = startRound(service);
    // A wins Q1,Q2; B wins Q3,Q4; Q5 timeout → tie 2-2
    await answerCorrect(service, started.session.id, USER_A, "Alice");
    timers.advance(1);
    await answerCorrect(service, started.session.id, USER_A, "Alice");
    timers.advance(1);
    await answerCorrect(service, started.session.id, USER_B, "Bob");
    timers.advance(1);
    await answerCorrect(service, started.session.id, USER_B, "Bob");
    timers.advance(1);
    timers.advance(60_000);
    timers.advance(1);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 2);
    assert.strictEqual(loadPoints(file).users[String(USER_B)].points, 2);
  });

  await runTest("all scores 0 after five questions → no tie XP", async () => {
    const file = pointsFile();
    const awards = [];
    const edits = [];
    const { service, timers } = createService({ nextQuestionDelayMs: 1 });
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push({ uid, name, payload });
      return awardTriviaAttemptXp(uid, name, payload, file);
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

  await runTest("busy remains between questions; released after round", async () => {
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
    await answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(service.isTriviaOpen(), true);
    timers.advance(5_000);
    assert.strictEqual(service.isTriviaOpen(), true);
    for (let q = 2; q <= 5; q += 1) {
      await answerCorrect(service, started.session.id, USER_A, "Alice");
      timers.advance(5_000);
    }
    assert.strictEqual(service.isTriviaOpen(), false);
  });

  await runTest("auto registry + weights total 100", async () => {
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
    assert.ok(member.replies[0].includes("Choose a category"));
    assert.ok(member.replies[0].includes("ManGo Trivia"));
    assert.ok(!String(member.replies[0]).toLowerCase().includes("admin"));
    assert.strictEqual(service.isTriviaOpen(), false);
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
    assert.ok(ok.replies[0].includes("Choose a category"));
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
    assert.ok(adminBypass.replies[0].includes("Choose a category"));
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

  await runTest("callbacks opaque; help lists 5-question", async () => {
    const data = buildAnswerCallbackData("abc123", 1);
    assert.strictEqual(data, "trivia:abc123:1");
    assert.ok(!data.includes("Beta"));
    assert.deepStrictEqual(parseTriviaCallbackData(data), {
      sessionId: "abc123",
      answerIndex: 1,
    });
    assert.ok(HELP_MESSAGE.includes("Open Trivia categories"));
  });

  await runTest("anti-repeat window", async () => {
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

  await runTest("fatal abort releases busy", async () => {
    const { service } = createService();
    startRound(service);
    service.abortRound("edit-failed");
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, STATUS.ABORTED);
  });

  await runTest("stale hub session does not permanently block a new game", async () => {
    const { service, timers } = createService({ staleAfterMs: 1_000 });
    const first = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      hubMode: true,
      category: "general",
    });
    assert.strictEqual(first.ok, true);
    service.setMessageId(first.session.id, 9001);
    await answerCorrect(service, first.session.id, USER_A, "Alice");
    assert.strictEqual(service.isTriviaOpen(), true);
    timers.advance(1_000);
    assert.strictEqual(service.isTriviaOpen(), false);
    const second = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      hubMode: true,
      category: "general",
    });
    assert.strictEqual(second.ok, true);
  });

  await runTest("timerless leftover after restart-like crash is recovered", async () => {
    const { service, timers } = createService();
    startRound(service);
    assert.strictEqual(service.isTriviaOpen(), true);
    service.clearAllTimers();
    assert.strictEqual(service.getPendingTimerCount(), 0);
    assert.strictEqual(service.isTriviaOpen(), false);
    const again = startRound(service);
    assert.strictEqual(again.ok, true);
    void timers;
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

  function createPersonalService(overrides = {}) {
    return createService({ questions: TRIVIA_QUESTIONS, ...overrides });
  }

  function startPersonal(
    service,
    {
      userId,
      category,
      messageId,
      displayName,
      randomId,
    } = {}
  ) {
    const started = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      source: "manual",
      hubMode: true,
      category,
      userId,
      displayName,
    });
    assert.strictEqual(started.ok, true, randomId || "personal start");
    if (messageId != null) {
      service.setMessageId(started.session.id, messageId);
    }
    return started;
  }

  async function answerSession(service, sessionId, userId, name, correct = true) {
    const snap = service.getSnapshot(sessionId);
    assert.ok(snap);
    return await service.tryAnswer({
      sessionId,
      userId,
      answerIndex: correct ? snap.correctIndex : (snap.correctIndex + 1) % 4,
      chatId: COMMUNITY_CHAT,
      displayName: name,
    });
  }

  await runTest("A-C. parallel personal Trivia stays isolated by owner", async () => {
    const { service } = createPersonalService();
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const piet = startPersonal(service, {
      userId: USER_B,
      category: "geography",
      messageId: 202,
      displayName: "Piet",
    });
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), true);
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_B), true);
    assert.strictEqual(kevin.session.category, "math");
    assert.strictEqual(piet.session.category, "geography");
    assert.notStrictEqual(kevin.session.id, piet.session.id);

    const aAnswer = await answerSession(service, kevin.session.id, USER_A, "Kevin");
    assert.strictEqual(aAnswer.ok, true);
    assert.strictEqual(
      service.getSnapshot(piet.session.id).questionPhase,
      "open"
    );
    assert.strictEqual(
      service.getSnapshot(piet.session.id).category,
      "geography"
    );

    const bAnswer = await answerSession(service, piet.session.id, USER_B, "Piet");
    assert.strictEqual(bAnswer.ok, true);
    assert.strictEqual(
      service.getSnapshot(kevin.session.id).questionPhase,
      "resolved"
    );
    assert.strictEqual(service.getSnapshot(kevin.session.id).category, "math");
  });

  await runTest("D. outsider personal answer is denied without XP or state change", async () => {
    const file = pointsFile();
    const awards = [];
    const { service } = createPersonalService();
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push({ uid, name, payload });
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const before = service.getSnapshot(kevin.session.id);
    const denied = await service.tryAnswer({
      sessionId: kevin.session.id,
      userId: USER_B,
      answerIndex: before.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Piet",
    });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, "not-owner");
    assert.strictEqual(awards.length, 0);
    const after = service.getSnapshot(kevin.session.id);
    assert.strictEqual(after.questionPhase, before.questionPhase);
    assert.deepStrictEqual(after.answeredUsers, before.answeredUsers);
    assert.strictEqual(Object.keys(loadPoints(file).users || {}).length, 0);
  });

  await runTest("D-handler. outsider callback does not edit or reward", async () => {
    const file = pointsFile();
    const { service } = createPersonalService();
    service.setAwardXpHandler((uid, name, payload) => awardTriviaAttemptXp(uid, name, payload, file)
    );
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const snap = service.getSnapshot(kevin.session.id);
    const piet = createMockCtx({
      userId: USER_B,
      firstName: "Piet",
      callbackData: buildAnswerCallbackData(kevin.session.id, snap.correctIndex),
      messageId: 101,
    });
    await handleTriviaAnswer(piet, { runtime: service });
    assert.ok(
      String(piet.cbAnswers[0]).includes("belongs to Kevin")
    );
    assert.strictEqual(piet.edited.length, 0);
    assert.strictEqual(
      service.getSnapshot(kevin.session.id).questionPhase,
      "open"
    );
    assert.strictEqual(Object.keys(loadPoints(file).users || {}).length, 0);
  });

  await runTest("E. Next only advances the owning personal session", async () => {
    const { service } = createPersonalService();
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const piet = startPersonal(service, {
      userId: USER_B,
      category: "geography",
      messageId: 202,
      displayName: "Piet",
    });
    await answerSession(service, kevin.session.id, USER_A, "Kevin");
    const pietBefore = service.getSnapshot(piet.session.id);
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      callbackData: buildHubNavCallbackData("next", kevin.session.id),
      messageId: 101,
    });
    await handleTriviaHubCallback(ctx, { runtime: service, isBusyFn: () => false });
    const kevinAfter = service.getSnapshot(kevin.session.id);
    const pietAfter = service.getSnapshot(piet.session.id);
    assert.strictEqual(kevinAfter.questionNumber, 2);
    assert.strictEqual(kevinAfter.questionPhase, "open");
    assert.strictEqual(pietAfter.questionId, pietBefore.questionId);
    assert.strictEqual(pietAfter.questionNumber, pietBefore.questionNumber);
    assert.strictEqual(pietAfter.category, "geography");
  });

  await runTest("F. Change Category only ends the owning personal session", async () => {
    const { service } = createPersonalService();
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const piet = startPersonal(service, {
      userId: USER_B,
      category: "geography",
      messageId: 202,
      displayName: "Piet",
    });
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      callbackData: buildHubNavCallbackData("change", kevin.session.id),
      messageId: 101,
    });
    await handleTriviaHubCallback(ctx, { runtime: service, isBusyFn: () => false });
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), false);
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_B), true);
    assert.strictEqual(service.getSnapshot(piet.session.id).category, "geography");
  });

  await runTest("G. personal timeout does not end the other session", async () => {
    const { service, timers } = createPersonalService({ questionTimeoutMs: 1_000 });
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    timers.advance(500);
    const piet = startPersonal(service, {
      userId: USER_B,
      category: "geography",
      messageId: 202,
      displayName: "Piet",
    });
    timers.advance(500);
    assert.strictEqual(
      service.getSnapshot(kevin.session.id).questionPhase,
      "resolved"
    );
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_B), true);
    assert.strictEqual(
      service.getSnapshot(piet.session.id).questionPhase,
      "open"
    );
  });

  await runTest("H. ending one personal session leaves the other active", async () => {
    const { service } = createPersonalService();
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const piet = startPersonal(service, {
      userId: USER_B,
      category: "geography",
      messageId: 202,
      displayName: "Piet",
    });
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      callbackData: buildHubNavCallbackData("games", kevin.session.id),
      messageId: 101,
    });
    await handleTriviaHubCallback(ctx, { runtime: service, isBusyFn: () => false });
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), false);
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_B), true);
    assert.strictEqual(service.getSession(piet.session.id).status, STATUS.ACTIVE);
  });

  await runTest("I. personal Trivia does not set community busy", async () => {
    const { service } = createPersonalService();
    startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    assert.strictEqual(service.isCommunityTriviaOpen(), false);
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isTriviaOpenFn: () => service.isCommunityTriviaOpen(),
        isMangoBombOpenFn: () => false,
      }),
      false
    );
    const piet = createMockCtx({ userId: USER_B, firstName: "Piet" });
    await handleTrivia(piet, {
      runtime: service,
      startTriviaFn: (p) => service.startTrivia(p),
      isBusyFn: () =>
        isCommunityChallengeBusy({
          isChatFightOpenFn: () => false,
          isTriviaOpenFn: () => service.isCommunityTriviaOpen(),
          isMangoBombOpenFn: () => false,
        }),
    });
    assert.ok(String(piet.replies[0]).includes("Choose a category"));
    const started = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      hubMode: true,
      category: "history",
      userId: USER_B,
      displayName: "Piet",
    });
    assert.strictEqual(started.ok, true);
  });

  await runTest("J-K. personal and community Trivia coexist; community race stays open", async () => {
    const { service } = createPersonalService();
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const community = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      source: "auto",
      autoIntro: true,
      category: "random",
      hubMode: false,
    });
    assert.strictEqual(community.ok, true);
    service.setMessageId(community.session.id, 303);
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), true);
    assert.strictEqual(service.isCommunityTriviaOpen(COMMUNITY_CHAT), true);
    assert.strictEqual(kevin.session.hubMode, true);
    assert.strictEqual(community.session.hubMode, false);

    const snap = service.getSnapshot(community.session.id);
    const first = await service.tryAnswer({
      sessionId: community.session.id,
      userId: USER_B,
      answerIndex: snap.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Piet",
    });
    assert.strictEqual(first.ok, true);
    const second = await service.tryAnswer({
      sessionId: community.session.id,
      userId: USER_A,
      answerIndex: snap.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
    });
    assert.strictEqual(second.ok, false);
    assert.ok(
      second.reason === "question-closed" || second.reason === "already-answered"
    );
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), true);
    assert.strictEqual(
      service.getSnapshot(kevin.session.id).questionPhase,
      "open"
    );
  });

  await runTest("L. owner earns personal Trivia XP but cannot drive another player's game", async () => {
    const file = pointsFile();
    const awards = [];
    const { service } = createPersonalService();
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push({ uid, payload });
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const ownerGame = startPersonal(service, {
      userId: OWNER_ID,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const piet = startPersonal(service, {
      userId: USER_B,
      category: "geography",
      messageId: 202,
      displayName: "Piet",
    });
    const own = await answerSession(service, ownerGame.session.id, OWNER_ID, "Kevin");
    assert.strictEqual(own.ok, true);
    assert.ok(awards.some((row) => String(row.uid) === String(OWNER_ID)));
    assert.ok(loadPoints(file).users[String(OWNER_ID)]);

    const beforePiet = service.getSnapshot(piet.session.id);
    const hijack = await service.tryAnswer({
      sessionId: piet.session.id,
      userId: OWNER_ID,
      answerIndex: beforePiet.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
    });
    assert.strictEqual(hijack.ok, false);
    assert.strictEqual(hijack.reason, "not-owner");
    assert.strictEqual(
      service.getSnapshot(piet.session.id).questionPhase,
      "open"
    );
    assert.strictEqual(awards.filter((row) => String(row.uid) === String(OWNER_ID)).length, 1);
  });

  await runTest("M. parallel personal Trivia edits only the owning message", async () => {
    const edits = [];
    const { service } = createPersonalService();
    service.setEditMessageHandler((chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
    });
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const piet = startPersonal(service, {
      userId: USER_B,
      category: "geography",
      messageId: 202,
      displayName: "Piet",
    });
    assert.strictEqual(service.getSession(kevin.session.id).messageId, 101);
    assert.strictEqual(service.getSession(piet.session.id).messageId, 202);
    assert.notStrictEqual(kevin.session.id, piet.session.id);

    await answerSession(service, kevin.session.id, USER_A, "Kevin");
    const next = service.nextHubQuestion(kevin.session.id, USER_A);
    assert.strictEqual(next.ok, true);
    await Promise.resolve();
    assert.ok(edits.some((row) => row.messageId === 101));
    assert.ok(!edits.some((row) => row.messageId === 202));

    const timed = service.forceQuestionTimeout(piet.session.id);
    assert.strictEqual(timed.timedOut, true);
    await Promise.resolve();
    assert.ok(edits.some((row) => row.messageId === 202));
    assert.ok(
      edits.every((row) => row.messageId === 101 || row.messageId === 202)
    );
    assert.strictEqual(service.getSnapshot(kevin.session.id).questionPhase, "open");
    assert.strictEqual(
      service.getSnapshot(piet.session.id).questionPhase,
      "resolved"
    );
  });

  await runTest("ended sessions and choosers leave no leftover maps or timers", async () => {
    const { service } = createPersonalService();
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const piet = startPersonal(service, {
      userId: USER_B,
      category: "geography",
      messageId: 202,
      displayName: "Piet",
    });
    assert.ok(service.getPendingTimerCount() >= 2);
    service.abortRound("hub-nav", {
      silent: true,
      session: service.getSession(kevin.session.id),
    });
    assert.strictEqual(service.getSession(kevin.session.id), null);
    assert.ok(service.getSession(piet.session.id));
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), false);
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_B), true);
    assert.ok(service.getPendingTimerCount() >= 1);
    service.releaseHubSession("back-games", {
      session: service.getSession(piet.session.id),
    });
    assert.strictEqual(service.getSession(piet.session.id), null);
    assert.strictEqual(service.getPendingTimerCount(), 0);

    const community = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      source: "manual",
      hubMode: false,
    });
    assert.strictEqual(community.ok, true);
    service.setMessageId(community.session.id, 303);
    service.forceCompleteRound(community.session.id);
    assert.strictEqual(service.getSession(community.session.id), null);
    assert.strictEqual(service.isCommunityTriviaOpen(COMMUNITY_CHAT), false);
    assert.strictEqual(service.getPendingTimerCount(), 0);

    service.rememberChooserOwner(COMMUNITY_CHAT, 9001, USER_A, "Kevin");
    assert.ok(service.getChooserOwner(COMMUNITY_CHAT, 9001));
    resetGroupMenuOwnersForTests();
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      callbackData: "trivia:games",
      messageId: 9001,
    });
    await handleTriviaHubCallback(ctx, {
      runtime: service,
      isBusyFn: () => false,
    });
    assert.strictEqual(service.getChooserOwner(COMMUNITY_CHAT, 9001), null);
    const menuOwner = getGroupMenuOwner(COMMUNITY_CHAT, 9001);
    assert.ok(menuOwner);
    assert.strictEqual(menuOwner.ownerUserId, String(USER_A));
  });

  await runTest("callback ACK happens before Trivia XP persistence", async () => {
    const file = pointsFile();
    const order = [];
    const { service } = createPersonalService();
    service.setAwardXpHandler((uid, name, payload) => {
      order.push("xp");
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const snap = service.getSnapshot(kevin.session.id);
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      callbackData: buildAnswerCallbackData(
        kevin.session.id,
        snap.correctIndex
      ),
      messageId: 101,
    });
    const inner = ctx.answerCbQuery.bind(ctx);
    ctx.answerCbQuery = (msg) => {
      order.push("ack");
      return inner(msg);
    };
    await handleTriviaAnswer(ctx, { runtime: service });
    assert.ok(order.indexOf("ack") >= 0);
    assert.ok(order.indexOf("xp") >= 0);
    assert.ok(order.indexOf("ack") < order.indexOf("xp"));
    assert.ok(ctx.cbAnswers[0].includes("Correct"));
    assert.ok(loadPoints(file).users[String(USER_A)]);
  });

  await runTest("unauthorized Trivia callback is still denied without XP", async () => {
    const file = pointsFile();
    const awards = [];
    const { service } = createPersonalService();
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push(uid);
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const snap = service.getSnapshot(kevin.session.id);
    const piet = createMockCtx({
      userId: USER_B,
      firstName: "Piet",
      callbackData: buildAnswerCallbackData(
        kevin.session.id,
        snap.correctIndex
      ),
      messageId: 101,
    });
    await handleTriviaAnswer(piet, { runtime: service });
    assert.ok(String(piet.cbAnswers[0]).includes("belongs to Kevin"));
    assert.strictEqual(awards.length, 0);
    assert.strictEqual(piet.edited.length, 0);
    assert.strictEqual(
      service.getSnapshot(kevin.session.id).questionPhase,
      "open"
    );
  });

  await runTest("duplicate Trivia answer callback does not double XP", async () => {
    const file = pointsFile();
    const awards = [];
    const { service } = createPersonalService();
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push(uid);
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const kevin = startPersonal(service, {
      userId: USER_A,
      category: "math",
      messageId: 101,
      displayName: "Kevin",
    });
    const snap = service.getSnapshot(kevin.session.id);
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      callbackData: buildAnswerCallbackData(
        kevin.session.id,
        snap.correctIndex
      ),
      messageId: 101,
    });
    await handleTriviaAnswer(ctx, { runtime: service });
    await handleTriviaAnswer(ctx, { runtime: service });
    assert.strictEqual(awards.length, 1);
    assert.strictEqual(
      loadPoints(file).users[String(USER_A)].trivia.attemptsUsed,
      1
    );
    assert.strictEqual(ctx.cbAnswers[1], "This question is already finished.");
  });

  await runTest("two sequential XP mutations both persist", async () => {
    const file = pointsFile();
    const a = await awardTriviaAttemptXp(USER_A, "Kevin", { correct: true }, file);
    const b = await awardTriviaAttemptXp(USER_B, "Piet", { correct: true }, file);
    assert.strictEqual(a.awarded, true);
    assert.strictEqual(b.awarded, true);
    const data = loadPoints(file);
    assert.ok(data.users[String(USER_A)].points >= 1);
    assert.ok(data.users[String(USER_B)].points >= 1);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  clearAllExpiredMessageCleanups();
  clearAllGameMessageCleanups();
  console.log("\nAll trivia tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
