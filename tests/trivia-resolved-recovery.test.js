/**
 * Trivia resolved-question UI, Finish lifecycle, and deleted-message recovery.
 * Run: node tests/trivia-resolved-recovery.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  createTriviaService,
  buildAnswerCallbackData,
  buildHubNavCallbackData,
  parseTriviaCallbackData,
  QUESTION_PHASE,
  TRIVIA_STALE_MS,
} = require("../services/trivia");
const {
  handleTrivia,
  handleTriviaAnswer,
  handleTriviaHubCallback,
} = require("../commands/trivia");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const {
  awardTriviaAttemptXp,
  getTriviaAttemptStatus,
  loadPoints,
  TRIVIA_DAILY_ATTEMPT_CAP,
  TRIVIA_ATTEMPT_XP,
} = require("../services/points");
const { getDailyQuestSnapshot } = require("../services/dailyQuest");
const {
  GAME_TYPE,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  GAME_CLEANUP_FOOTER,
  clearAllGameMessageCleanups,
  getScheduledGameCleanupIds,
  scheduleGameMessageCleanup,
} = require("../utils/gameCleanup");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-trivia-life-"));
setMangoShopFileForTests(path.join(tempDir, "shop.json"));
let testCounter = 0;
const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
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
  process.env.TELEGRAM_GAMES_TOPIC_ID = "999";
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalGamesTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalGamesTopic;
}

function makeBank() {
  return [
    {
      id: "q-a",
      category: "math",
      question: "What is 2+2?",
      answers: ["3", "4", "5", "6"],
      correctIndex: 1,
      difficulty: "easy",
    },
    {
      id: "q-b",
      category: "math",
      question: "What is 3+3?",
      answers: ["5", "6", "7", "8"],
      correctIndex: 1,
      difficulty: "medium",
    },
    {
      id: "q-c",
      category: "math",
      question: "What is 4+4?",
      answers: ["6", "7", "8", "9"],
      correctIndex: 2,
      difficulty: "hard",
    },
  ];
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
  };
}

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const service = createTriviaService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    questionTimeoutMs: overrides.questionTimeoutMs != null ? overrides.questionTimeoutMs : 60_000,
    staleAfterMs: overrides.staleAfterMs != null ? overrides.staleAfterMs : TRIVIA_STALE_MS,
    cleanupDelayMs: overrides.cleanupDelayMs,
    deleteMessageFn: overrides.deleteMessageFn,
    random: () => 0,
    randomIdFn: overrides.randomIdFn || (() => "abc123"),
    questions: overrides.questions || makeBank(),
  });
  return { service, timers };
}

function startPersonal(service, messageId = 101) {
  const started = service.startTrivia({
    chatId: COMMUNITY_CHAT,
    source: "manual",
    hubMode: true,
    category: "math",
    userId: USER_A,
    displayName: "Kevin",
  });
  assert.strictEqual(started.ok, true);
  if (messageId != null) {
    service.setMessageId(started.session.id, messageId);
  }
  return started;
}

function keyboardBlob(extra) {
  return JSON.stringify(extra || {});
}

function hasAnswerButtons(extra) {
  const blob = keyboardBlob(extra);
  return (
    blob.includes('"A"') &&
    blob.includes('"B"') &&
    blob.includes('"C"') &&
    blob.includes('"D"') &&
    /trivia:[a-f0-9]+:(?:\d+:)?[0-3]/i.test(blob)
  );
}

function hasNextAndFinish(extra, sessionId, questionGen) {
  const blob = keyboardBlob(extra);
  return (
    blob.includes("➡️ Next Question") &&
    blob.includes("❌ Finish") &&
    blob.includes(buildHubNavCallbackData("next", sessionId, questionGen)) &&
    blob.includes(buildHubNavCallbackData("finish", sessionId, questionGen))
  );
}

function goneError() {
  const err = new Error("Bad Request: message to edit not found");
  err.description = "Bad Request: message to edit not found";
  return err;
}

function createMockCtx({
  callbackData,
  userId = USER_A,
  firstName = "Kevin",
  messageId = 101,
  telegramGoneIds = [],
} = {}) {
  const cbAnswers = [];
  const edited = [];
  const replies = [];
  const telegramEdits = [];
  const deleted = [];
  return {
    chat: { type: "supergroup", id: COMMUNITY_CHAT },
    from: { id: userId, first_name: firstName, is_bot: false },
    callbackQuery: callbackData
      ? {
          data: callbackData,
          message: {
            message_id: messageId,
            message_thread_id: 999,
            chat: { id: COMMUNITY_CHAT, type: "supergroup" },
          },
        }
      : undefined,
    cbAnswers,
    edited,
    replies,
    telegramEdits,
    deleted,
    telegram: {
      editMessageText(chatId, mid, _inline, text, extra) {
        telegramEdits.push({ chatId, messageId: mid, text, extra });
        if (telegramGoneIds.map(String).includes(String(mid))) {
          return Promise.reject(goneError());
        }
        return Promise.resolve({ message_id: mid });
      },
      deleteMessage(chatId, mid) {
        deleted.push({ chatId, messageId: mid });
        return Promise.resolve();
      },
    },
    answerCbQuery(msg) {
      cbAnswers.push(msg || "");
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      edited.push({ text, extra, messageId });
      return Promise.resolve({ message_id: messageId, extra });
    },
    reply(text, extra) {
      const sent = { message_id: 707, text, extra };
      replies.push(sent);
      return Promise.resolve(sent);
    },
  };
}

function cmdOptions(service, file) {
  return {
    runtime: service,
    isBusyFn: () => false,
    assertCanStartFn: async () => ({ ok: true }),
    pointsFile: file,
  };
}

async function answerCurrent(service, ctxOptions = {}) {
  const snap = service.getSnapshot();
  const ctx = createMockCtx({
    callbackData: buildAnswerCallbackData(
      snap.id,
      snap.correctIndex,
      snap.questionGen
    ),
    messageId: snap.messageId != null ? snap.messageId : 101,
    ...ctxOptions,
  });
  await handleTriviaAnswer(ctx, { runtime: service, ...cmdOptions(service) });
  return ctx;
}

async function runTest(name, fn) {
  resetEnv();
  clearAllGameMessageCleanups();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  } finally {
    clearAllGameMessageCleanups();
  }
}

async function main() {
  resetEnv();

  await runTest("1. OPEN question has question + A/B/C/D", () => {
    const { service } = createService();
    const started = startPersonal(service);
    assert.ok(started.text.includes("What is 2+2?"));
    assert.ok(hasAnswerButtons(started.keyboard));
    const view = service.getAuthoritativeView(started.session.id);
    assert.strictEqual(view.phase, QUESTION_PHASE.OPEN);
    assert.ok(hasAnswerButtons(view.extra));
  });

  await runTest("2-5. answer resolves once with Next/Finish and no A/B/C/D", async () => {
    const file = pointsFile();
    const { service } = createService();
    service.setAwardXpHandler((uid, name, payload) =>
      awardTriviaAttemptXp(uid, name, payload, file)
    );
    const started = startPersonal(service);
    const gen = started.session.questionGen;
    const ctx = createMockCtx({
      callbackData: buildAnswerCallbackData(
        started.session.id,
        started.session.correctIndex,
        gen
      ),
    });
    await handleTriviaAnswer(ctx, cmdOptions(service, file));
    await handleTriviaAnswer(ctx, cmdOptions(service, file));
    const snap = service.getSnapshot(started.session.id);
    assert.strictEqual(snap.questionPhase, QUESTION_PHASE.RESOLVED);
    const last = ctx.edited[ctx.edited.length - 1];
    assert.ok(last.text.includes("What is 2+2?"));
    assert.ok(!hasAnswerButtons(last.extra));
    assert.ok(hasNextAndFinish(last.extra, started.session.id, gen));
    const points = loadPoints(file);
    assert.strictEqual(points.users[String(USER_A)].trivia.correctCount, 1);
  });

  await runTest("6-7. daily-cap fun-play resolved screen keeps Next/Finish", async () => {
    const file = pointsFile();
    const { service } = createService();
    service.setAwardXpHandler((uid, name, payload) =>
      awardTriviaAttemptXp(uid, name, payload, file)
    );
    for (let i = 0; i < TRIVIA_DAILY_ATTEMPT_CAP; i += 1) {
      await awardTriviaAttemptXp(USER_A, "Kevin", { correct: true }, file);
    }
    const started = startPersonal(service);
    const status = getTriviaAttemptStatus(USER_A, file);
    assert.ok(status.attemptsUsed >= TRIVIA_DAILY_ATTEMPT_CAP);
    const answered = await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: started.session.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: started.session.questionGen,
    });
    assert.ok(answered.rendered.text.includes("Playing for fun") || lastFun(answered.rendered.text));
    assert.ok(!hasAnswerButtons(answered.rendered.extra));
    assert.ok(
      hasNextAndFinish(
        answered.rendered.extra,
        started.session.id,
        started.session.questionGen
      )
    );
    const view = service.getAuthoritativeView(started.session.id, status);
    assert.strictEqual(view.phase, QUESTION_PHASE.RESOLVED);
    assert.ok(!hasAnswerButtons(view.extra));
    assert.ok(hasNextAndFinish(view.extra, started.session.id, started.session.questionGen));
  });

  await runTest("8-9. second and stale answers cannot reopen", async () => {
    const { service } = createService();
    const started = startPersonal(service);
    const gen = started.session.questionGen;
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: started.session.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: gen,
    });
    const second = await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: 0,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: gen,
    });
    assert.strictEqual(second.ok, false);
    const stale = await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: 0,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: gen - 1,
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-question");
    const view = service.getAuthoritativeView(started.session.id);
    assert.strictEqual(view.phase, QUESTION_PHASE.RESOLVED);
    assert.ok(!hasAnswerButtons(view.extra));
  });

  await runTest("10-14. Next validates resolved, advances once, new gen + answers", async () => {
    const { service } = createService();
    const started = startPersonal(service);
    const firstGen = started.session.questionGen;
    const openNext = service.nextHubQuestion(started.session.id, USER_A, firstGen);
    assert.strictEqual(openNext.ok, false);
    assert.strictEqual(openNext.reason, "question-open");
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: started.session.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: firstGen,
    });
    const nextData = buildHubNavCallbackData("next", started.session.id, firstGen);
    const first = createMockCtx({ callbackData: nextData });
    const second = createMockCtx({ callbackData: nextData });
    await handleTriviaHubCallback(first, cmdOptions(service));
    await handleTriviaHubCallback(second, cmdOptions(service));
    const live = service.getSnapshot(started.session.id);
    assert.strictEqual(live.questionNumber, 2);
    assert.strictEqual(live.questionGen, firstGen + 1);
    assert.ok(first.edited[0].text.includes("What is 3+3?"));
    assert.ok(hasAnswerButtons(first.edited[0].extra));
    assert.ok(first.edited[0].text.includes("What is 3+3?"));
    assert.ok(
      keyboardBlob(first.edited[0].extra).includes(
        buildAnswerCallbackData(started.session.id, 0, live.questionGen)
      )
    );
    assert.ok(second.cbAnswers.some((a) => String(a).includes("already") || String(a).includes("this question")));
  });

  await runTest("15-17. stale previous answer / races cannot answer the new question", async () => {
    const { service } = createService();
    const started = startPersonal(service);
    const firstGen = started.session.questionGen;
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: started.session.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: firstGen,
    });
    const nextCtx = createMockCtx({
      callbackData: buildHubNavCallbackData("next", started.session.id, firstGen),
    });
    const staleAnswer = createMockCtx({
      callbackData: buildAnswerCallbackData(started.session.id, 0, firstGen),
    });
    await handleTriviaHubCallback(nextCtx, cmdOptions(service));
    await handleTriviaAnswer(staleAnswer, cmdOptions(service));
    const live = service.getSnapshot(started.session.id);
    assert.strictEqual(live.questionPhase, QUESTION_PHASE.OPEN);
    assert.strictEqual(live.questionGen, firstGen + 1);
    assert.ok(live.question.includes("3+3"));
    const parsed = parseTriviaCallbackData(
      buildAnswerCallbackData(started.session.id, 0, firstGen)
    );
    const outOfOrder = await service.tryAnswer({
      sessionId: parsed.sessionId,
      userId: USER_A,
      answerIndex: parsed.answerIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: parsed.questionGen,
    });
    assert.strictEqual(outOfOrder.ok, false);
  });

  await runTest("18-23. Finish releases session immediately and schedules 60s cleanup", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startPersonal(service);
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: started.session.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: started.session.questionGen,
    });
    const ctx = createMockCtx({
      callbackData: buildHubNavCallbackData(
        "finish",
        started.session.id,
        started.session.questionGen
      ),
    });
    await handleTriviaHubCallback(ctx, cmdOptions(service, file));
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), false);
    assert.strictEqual(service.isTriviaOpen(), false);
    const last = ctx.edited[ctx.edited.length - 1];
    assert.ok(last.text.includes(GAME_CLEANUP_FOOTER));
    assert.deepStrictEqual(
      JSON.parse(keyboardBlob(last.extra)).reply_markup.inline_keyboard,
      []
    );
    assert.strictEqual(GAME_MESSAGE_CLEANUP_DELAY_MS, 60 * 1000);
    assert.deepStrictEqual(
      getScheduledGameCleanupIds(GAME_TYPE.TRIVIA, started.session.id),
      ["101"]
    );
    const again = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      source: "manual",
      hubMode: true,
      category: "math",
      userId: USER_A,
      displayName: "Kevin",
    });
    assert.strictEqual(again.ok, true);
  });

  await runTest("24-30. deleted Telegram message recovers OPEN/RESOLVED and rebinds", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startPersonal(service, 101);
    const openCtx = createMockCtx({
      callbackData: "trivia:hub",
      messageId: 555,
      telegramGoneIds: [101],
    });
    await handleTrivia(openCtx, cmdOptions(service, file));
    const afterOpen = service.getSnapshot(started.session.id);
    assert.strictEqual(afterOpen.messageId, 555);
    assert.strictEqual(afterOpen.questionGen, started.session.questionGen);
    assert.strictEqual(afterOpen.questionPhase, QUESTION_PHASE.OPEN);
    assert.ok(openCtx.edited[0].text.includes("What is 2+2?"));
    assert.ok(hasAnswerButtons(openCtx.edited[0].extra));

    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: afterOpen.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: afterOpen.questionGen,
    });
    const resolvedCtx = createMockCtx({
      callbackData: "trivia:hub",
      messageId: 556,
      telegramGoneIds: [555],
    });
    await handleTrivia(resolvedCtx, cmdOptions(service, file));
    const afterResolved = service.getSnapshot(started.session.id);
    assert.strictEqual(afterResolved.messageId, 556);
    assert.strictEqual(afterResolved.questionPhase, QUESTION_PHASE.RESOLVED);
    assert.strictEqual(afterResolved.questionGen, afterOpen.questionGen);
    assert.ok(resolvedCtx.edited[0].text.includes("What is 2+2?"));
    assert.ok(!hasAnswerButtons(resolvedCtx.edited[0].extra));
    assert.ok(
      hasNextAndFinish(
        resolvedCtx.edited[0].extra,
        started.session.id,
        afterResolved.questionGen
      )
    );
  });

  await runTest("31-36. recovery does not award/progress and old callbacks are inert", async () => {
    const file = pointsFile();
    const awards = [];
    const { service } = createService();
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push(payload);
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const started = startPersonal(service, 101);
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: started.session.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: started.session.questionGen,
    });
    const beforePoints = loadPoints(file);
    const beforeCorrect =
      (beforePoints.users[String(USER_A)] &&
        beforePoints.users[String(USER_A)].trivia &&
        beforePoints.users[String(USER_A)].trivia.correctCount) ||
      0;
    const beforeQuest = getDailyQuestSnapshot(USER_A, { shopFile: path.join(tempDir, "shop.json") });
    const gen = service.getSnapshot(started.session.id).questionGen;
    const recover = createMockCtx({
      callbackData: "trivia:hub",
      messageId: 202,
      telegramGoneIds: [101],
    });
    await handleTrivia(recover, cmdOptions(service, file));
    assert.strictEqual(service.getSnapshot(started.session.id).questionGen, gen);
    assert.strictEqual(service.getSnapshot(started.session.id).messageId, 202);
    const afterPoints = loadPoints(file);
    const afterCorrect =
      (afterPoints.users[String(USER_A)] &&
        afterPoints.users[String(USER_A)].trivia &&
        afterPoints.users[String(USER_A)].trivia.correctCount) ||
      0;
    assert.strictEqual(afterCorrect, beforeCorrect);
    assert.strictEqual(awards.length, 1);
    const afterQuest = getDailyQuestSnapshot(USER_A, { shopFile: path.join(tempDir, "shop.json") });
    assert.deepStrictEqual(afterQuest.completed, beforeQuest.completed);
    const stale = createMockCtx({
      callbackData: buildAnswerCallbackData(started.session.id, 0, gen),
      messageId: 101,
    });
    await handleTriviaAnswer(stale, cmdOptions(service, file));
    assert.ok(stale.cbAnswers.some((a) => String(a).includes("already ended")));
    assert.strictEqual(service.getSnapshot(started.session.id).questionPhase, QUESTION_PHASE.RESOLVED);
  });

  await runTest("37-38. outsider cannot recover; visible session is not duplicated", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startPersonal(service, 101);
    const outsider = createMockCtx({
      callbackData: "trivia:hub",
      userId: USER_B,
      firstName: "Piet",
      messageId: 555,
    });
    await handleTrivia(outsider, cmdOptions(service, file));
    assert.ok(String(outsider.edited[0].text).includes("Choose a category"));
    assert.strictEqual(service.getSnapshot(started.session.id).messageId, 101);
    const ownerReuse = createMockCtx({
      callbackData: "trivia:hub",
      messageId: 555,
    });
    await handleTrivia(ownerReuse, cmdOptions(service, file));
    assert.ok(ownerReuse.cbAnswers.some((a) => String(a).includes("still open")));
    assert.strictEqual(service.getSnapshot(started.session.id).messageId, 101);
    assert.strictEqual(service.getSnapshot(started.session.id).id, started.session.id);
  });

  await runTest("39-40. old cleanup/idle cannot kill rebound/newer session", async () => {
    const deleted = [];
    const { service, timers } = createService({
      deleteMessageFn: async (_chatId, messageId) => {
        deleted.push(messageId);
      },
    });
    const started = startPersonal(service, 101);
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.TRIVIA,
      sessionId: started.session.id,
      chatId: COMMUNITY_CHAT,
      messageIds: [101],
      delayMs: 50,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      deleteMessageFn: async (_c, messageId) => {
        deleted.push(messageId);
      },
    });
    service.rebindMessageId(started.session.id, 202);
    assert.deepStrictEqual(
      getScheduledGameCleanupIds(GAME_TYPE.TRIVIA, started.session.id),
      []
    );
    timers.advance(50);
    assert.ok(!deleted.includes(202));
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), true);
    assert.strictEqual(service.getSnapshot(started.session.id).messageId, 202);

    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: service.getSnapshot(started.session.id).correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: service.getSnapshot(started.session.id).questionGen,
    });
    service.finishHub({
      sessionId: started.session.id,
      userId: USER_A,
      questionGen: service.getSnapshot(started.session.id).questionGen,
      chatId: COMMUNITY_CHAT,
    });
    timers.advance(TRIVIA_STALE_MS);
    const second = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      source: "manual",
      hubMode: true,
      category: "math",
      userId: USER_A,
      displayName: "Kevin",
    });
    assert.strictEqual(second.ok, true);
    service.setMessageId(second.session.id, 303);
    timers.advance(TRIVIA_STALE_MS);
    assert.strictEqual(service.isPersonalTriviaOpen(COMMUNITY_CHAT, USER_A), true);
    assert.strictEqual(service.getSnapshot(second.session.id).messageId, 303);
    assert.strictEqual(TRIVIA_STALE_MS, 5 * 60 * 1000);
  });

  restoreEnv();
  console.log("\nAll trivia-resolved-recovery tests passed.");
}

function lastFun(text) {
  return (
    String(text).includes("keep playing for fun") ||
    String(text).includes("Playing for fun") ||
    String(text).includes("Daily Trivia XP limit reached")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
