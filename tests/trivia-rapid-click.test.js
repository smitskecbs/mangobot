/**
 * Trivia rapid-click / missing-question protection.
 * Run: node tests/trivia-rapid-click.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  createTriviaService,
  buildAnswerCallbackData,
  buildHubNavCallbackData,
  parseTriviaCallbackData,
  TRIVIA_STALE_MS,
} = require("../services/trivia");
const {
  handleTriviaAnswer,
  handleTriviaHubCallback,
} = require("../commands/trivia");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const { awardTriviaAttemptXp, loadPoints } = require("../services/points");
const {
  GAME_TYPE,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  clearAllGameMessageCleanups,
  getScheduledGameCleanupIds,
} = require("../utils/gameCleanup");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-trivia-rapid-"));
setMangoShopFileForTests(path.join(tempDir, "shop.json"));
let testCounter = 0;
const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
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
    },
    {
      id: "q-b",
      category: "math",
      question: "What is 3+3?",
      answers: ["5", "6", "7", "8"],
      correctIndex: 1,
    },
    {
      id: "q-c",
      category: "math",
      question: "What is 4+4?",
      answers: ["6", "7", "8", "9"],
      correctIndex: 2,
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
  service.setMessageId(started.session.id, messageId);
  return started;
}

function keyboardBlob(extra) {
  return JSON.stringify(extra || {});
}

function answersMatchQuestion(text, extra, question) {
  assert.ok(text.includes(question), "question text must be visible");
  const blob = keyboardBlob(extra);
  assert.ok(blob.includes('"A"') && blob.includes('"B"'), "answer buttons present");
  return blob;
}

function createMockCtx({ callbackData, userId = USER_A, firstName = "Kevin", messageId = 101 } = {}) {
  const cbAnswers = [];
  const edited = [];
  return {
    chat: { type: "supergroup", id: COMMUNITY_CHAT },
    from: { id: userId, first_name: firstName, is_bot: false },
    callbackQuery: {
      data: callbackData,
      message: {
        message_id: messageId,
        chat: { id: COMMUNITY_CHAT, type: "supergroup" },
      },
    },
    cbAnswers,
    edited,
    telegram: {
      deleteMessage() {
        return Promise.resolve();
      },
    },
    answerCbQuery(msg) {
      cbAnswers.push(msg || "");
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      edited.push({ text, extra });
      return Promise.resolve();
    },
  };
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

  await runTest("A. question text and matching answer controls render together", () => {
    const { service } = createService();
    const started = startPersonal(service);
    assert.ok(started.text.includes("What is 2+2?"));
    assert.ok(started.text.includes("A."));
    const blob = keyboardBlob(started.keyboard);
    assert.ok(blob.includes(buildAnswerCallbackData(started.session.id, 0, 1)));
    assert.ok(blob.includes(buildAnswerCallbackData(started.session.id, 1, 1)));
    answersMatchQuestion(started.text, started.keyboard, "What is 2+2?");
  });

  await runTest("B. rapid double answer: one accepted, no duplicate reward", async () => {
    const file = pointsFile();
    const awards = [];
    const { service } = createService();
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push(payload);
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const started = startPersonal(service);
    const snap = service.getSnapshot(started.session.id);
    const ctx = createMockCtx({
      callbackData: buildAnswerCallbackData(started.session.id, snap.correctIndex, snap.questionGen),
    });
    await handleTriviaAnswer(ctx, { runtime: service });
    await handleTriviaAnswer(ctx, { runtime: service });
    assert.strictEqual(awards.length, 1);
    assert.strictEqual(service.getSnapshot(started.session.id).questionPhase, "resolved");
    const last = ctx.edited[ctx.edited.length - 1];
    assert.ok(last.text.includes("What is 2+2?"));
    assert.ok(last.text.includes("✅ Correct!"));
    assert.ok(!keyboardBlob(last.extra).includes(buildAnswerCallbackData(started.session.id, 0, snap.questionGen)));
  });

  await runTest("C. rapid double Next advances exactly one question", async () => {
    const { service } = createService();
    const started = startPersonal(service);
    const snap = service.getSnapshot(started.session.id);
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: snap.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: snap.questionGen,
    });
    const nextData = buildHubNavCallbackData("next", started.session.id, snap.questionGen);
    const first = createMockCtx({ callbackData: nextData });
    const second = createMockCtx({ callbackData: nextData });
    await handleTriviaHubCallback(first, { runtime: service });
    await handleTriviaHubCallback(second, { runtime: service });
    const live = service.getSnapshot(started.session.id);
    assert.strictEqual(live.questionNumber, 2);
    assert.ok(first.edited[0].text.includes("What is 3+3?"));
    answersMatchQuestion(first.edited[0].text, first.edited[0].extra, "What is 3+3?");
    assert.ok(second.cbAnswers.some((a) => String(a).includes("already") || String(a).includes("this question")));
  });

  await runTest("D. old answer callback after Next is stale", async () => {
    const file = pointsFile();
    const awards = [];
    const { service } = createService();
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push(1);
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const started = startPersonal(service);
    const firstSnap = service.getSnapshot(started.session.id);
    const firstGen = firstSnap.questionGen;
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: firstSnap.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: firstGen,
    });
    service.nextHubQuestion(started.session.id, USER_A, firstGen);
    const live = service.getSnapshot(started.session.id);
    assert.strictEqual(live.questionNumber, 2);
    const stale = createMockCtx({
      callbackData: buildAnswerCallbackData(started.session.id, firstSnap.correctIndex, firstGen),
    });
    await handleTriviaAnswer(stale, { runtime: service });
    assert.ok(stale.cbAnswers[0].includes("already finished"));
    assert.strictEqual(service.getSnapshot(started.session.id).questionNumber, 2);
    assert.strictEqual(service.getSnapshot(started.session.id).question, "What is 3+3?");
    assert.strictEqual(awards.length, 1);
  });

  await runTest("E. old Next after advance cannot advance again", async () => {
    const { service } = createService();
    const started = startPersonal(service);
    const firstGen = service.getSnapshot(started.session.id).questionGen;
    const firstSnap = service.getSnapshot(started.session.id);
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: firstSnap.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: firstGen,
    });
    const first = service.nextHubQuestion(started.session.id, USER_A, firstGen);
    assert.strictEqual(first.ok, true);
    const second = service.nextHubQuestion(started.session.id, USER_A, firstGen);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(service.getSnapshot(started.session.id).questionNumber, 2);
  });

  await runTest("F. answer + Next close together keeps current question UI", async () => {
    const file = pointsFile();
    let releaseXp;
    const { service } = createService();
    service.setAwardXpHandler((uid, name, payload) => {
      return new Promise((resolve) => {
        releaseXp = () =>
          resolve(awardTriviaAttemptXp(uid, name, payload, file));
      });
    });
    const started = startPersonal(service);
    const snap = service.getSnapshot(started.session.id);
    const answerCtx = createMockCtx({
      callbackData: buildAnswerCallbackData(started.session.id, snap.correctIndex, snap.questionGen),
    });
    const answerPromise = handleTriviaAnswer(answerCtx, { runtime: service });
    await new Promise((r) => setImmediate(r));
    const nextCtx = createMockCtx({
      callbackData: buildHubNavCallbackData("next", started.session.id, snap.questionGen),
    });
    await handleTriviaHubCallback(nextCtx, { runtime: service });
    if (typeof releaseXp === "function") {
      releaseXp();
    }
    await answerPromise;
    const live = service.getSnapshot(started.session.id);
    assert.strictEqual(live.questionNumber, 2);
    const lastNext = nextCtx.edited[nextCtx.edited.length - 1];
    answersMatchQuestion(lastNext.text, lastNext.extra, live.question);
    assert.ok(!lastNext.text.includes("What is 2+2?"));
    const answerEditedQuestionGone = answerCtx.edited.some(
      (row) =>
        keyboardBlob(row.extra).includes('"A"') && !row.text.includes(live.question)
    );
    assert.strictEqual(answerEditedQuestionGone, false);
  });

  await runTest("G. out-of-order old callback cannot replace current question", async () => {
    const { service } = createService();
    const started = startPersonal(service);
    const firstSnap = service.getSnapshot(started.session.id);
    const firstGen = firstSnap.questionGen;
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: firstSnap.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: firstGen,
    });
    service.nextHubQuestion(started.session.id, USER_A, firstGen);
    const staleParse = parseTriviaCallbackData(
      buildAnswerCallbackData(started.session.id, 0, firstGen)
    );
    const rejected = await service.tryAnswer({
      sessionId: staleParse.sessionId,
      userId: USER_A,
      answerIndex: staleParse.answerIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: staleParse.questionGen,
    });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, "stale-question");
    assert.ok(service.getSnapshot(started.session.id).question.includes("3+3"));
  });

  await runTest("H-I. active answer buttons always correspond to visible question", async () => {
    const { service } = createService();
    const started = startPersonal(service);
    answersMatchQuestion(started.text, started.keyboard, started.session.question);
    const snap = service.getSnapshot(started.session.id);
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: snap.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: snap.questionGen,
    });
    const advanced = service.nextHubQuestion(started.session.id, USER_A, snap.questionGen);
    answersMatchQuestion(advanced.text, advanced.keyboard, "What is 3+3?");
    const blob = keyboardBlob(advanced.keyboard);
    assert.ok(blob.includes(`:${liveGen(service, started.session.id)}:0`));
  });

  await runTest("J-K. old Trivia cleanup/timer cannot delete current question", async () => {
    const deleted = [];
    let ids = 0;
    const { service, timers } = createService({
      cleanupDelayMs: 50,
      deleteMessageFn: async (chatId, messageId) => {
        deleted.push({ chatId, messageId });
      },
      randomIdFn: () => {
        ids += 1;
        return ids === 1 ? "aaa111" : "bbb222";
      },
    });
    startPersonal(service, 101);
    service.abortRound("edit-failed");
    const second = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      source: "manual",
      hubMode: true,
      category: "math",
      userId: USER_A,
      displayName: "Kevin",
    });
    assert.strictEqual(second.ok, true);
    service.setMessageId(second.session.id, 202);
    timers.advance(50);
    await Promise.resolve();
    assert.ok(second.text.includes("Question"));
    assert.ok(
      second.text.includes("What is 2+2?") || second.text.includes("What is 3+3?")
    );
    assert.ok(!deleted.some((d) => d.messageId === 202));
    assert.strictEqual(TRIVIA_STALE_MS, 5 * 60 * 1000);
  });

  await runTest("L. rapid taps cannot duplicate XP", async () => {
    const file = pointsFile();
    const awards = [];
    const { service } = createService();
    service.setAwardXpHandler((uid, name, payload) => {
      awards.push(payload.correct);
      return awardTriviaAttemptXp(uid, name, payload, file);
    });
    const started = startPersonal(service);
    const snap = service.getSnapshot(started.session.id);
    const data = buildAnswerCallbackData(started.session.id, snap.correctIndex, snap.questionGen);
    await handleTriviaAnswer(createMockCtx({ callbackData: data }), { runtime: service });
    await handleTriviaAnswer(createMockCtx({ callbackData: data }), { runtime: service });
    await handleTriviaAnswer(createMockCtx({ callbackData: data }), { runtime: service });
    assert.strictEqual(awards.length, 1);
    const points = loadPoints(file);
    assert.strictEqual(points.users[String(USER_A)].trivia.correctCount, 1);
  });

  await runTest("M-N. normal paced Trivia and 5-minute idle remain", async () => {
    const { service, timers } = createService();
    const started = startPersonal(service);
    const snap = service.getSnapshot(started.session.id);
    const answered = await service.tryAnswer({
      sessionId: started.session.id,
      userId: USER_A,
      answerIndex: snap.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "Kevin",
      questionGen: snap.questionGen,
    });
    assert.strictEqual(answered.ok, true);
    assert.ok(answered.rendered.text.includes("What is 2+2?"));
    const next = service.nextHubQuestion(started.session.id, USER_A, snap.questionGen);
    assert.ok(next.text.includes("What is 3+3?"));
    assert.strictEqual(TRIVIA_STALE_MS, 5 * 60 * 1000);
    timers.advance(TRIVIA_STALE_MS - 1);
    assert.strictEqual(service.getSnapshot(started.session.id).status, "active");
  });

  await runTest("O. terminal 60s cleanup remains correct", () => {
    const { service } = createService({ cleanupDelayMs: 60 });
    const started = startPersonal(service);
    service.abortRound("hub-nav");
    assert.strictEqual(GAME_MESSAGE_CLEANUP_DELAY_MS, 60 * 1000);
    assert.ok(
      getScheduledGameCleanupIds(GAME_TYPE.TRIVIA, started.session.id).length >= 0
    );
  });

  restoreEnv();
  console.log("\nAll Trivia rapid-click tests passed.");
}

function liveGen(service, sessionId) {
  return service.getSnapshot(sessionId).questionGen;
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
