/**
 * Trivia daily attempt cap, XP, wallet, UX, and integrations.
 * Run: node tests/trivia-daily-limit.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  createTriviaService,
  buildAnswerCallbackData,
  QUESTION_PHASE,
  buildHubNavCallbackData,
} = require("../services/trivia");
const { TRIVIA_QUESTIONS } = require("../services/triviaQuestions");
const {
  awardTriviaAttemptXp,
  getTriviaAttemptStatus,
  loadPoints,
  mutatePoints,
  utcYesterday,
  awardDailyActivityPoint,
  TRIVIA_DAILY_ATTEMPT_CAP,
  TRIVIA_ATTEMPT_XP,
} = require("../services/points");
const {
  handleTrivia,
  handleTriviaAnswer,
  handleTriviaHubCallback,
} = require("../commands/trivia");
const { ACTION_IDS } = require("../services/communityActivityEngine");
const {
  isCommunityChallengeBusy,
} = require("../services/communityGameState");
const { getDailyQuestSnapshot } = require("../services/dailyQuest");
const { assertEligibleBotGameProgress } = require("./helpers/dailyQuestAssert");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const {
  setWalletFileForTests,
  registerManualWallet,
} = require("../services/walletLinks");
const { encodeBase58 } = require("../utils/base58");
const { setXpWalletAutoLinkForTests } = require("../services/xpWalletGate");
const { GAME_TYPE, FINAL_STATE } = require("../utils/gameCleanup");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-trivia-limit-"));
let n = 0;
const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const OWNER_ID = 999001;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function resetEnv() {
  process.env.ADMIN_USER_ID = String(OWNER_ID);
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  setXpWalletAutoLinkForTests(true);
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalGamesTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalGamesTopic;
}

function files() {
  n += 1;
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  const shopFile = path.join(tempDir, `shop-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(walletFile, JSON.stringify({ users: {}, wallets: {} }, null, 2), "utf8");
  setWalletFileForTests(walletFile);
  setMangoShopFileForTests(shopFile);
  return { pointsFile, walletFile, shopFile };
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

function createService(store = {}, overrides = {}) {
  const files = store && typeof store === "object" ? store : {};
  const timers = createFakeTimers();
  const service = createTriviaService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    random: overrides.random || (() => 0),
    randomIdFn: overrides.randomIdFn || (() => "abc123"),
    questions: overrides.questions || TRIVIA_QUESTIONS,
  });
  if (files.pointsFile) {
    service.setAwardXpHandler((uid, name, payload) =>
      awardTriviaAttemptXp(
        uid,
        name,
        { ...payload, shopFile: files.shopFile },
        files.pointsFile,
        files.walletFile || overrides.walletFile
      )
    );
  }
  service.setEditMessageHandler(() => {});
  return { service, timers };
}

function startHub(service, category = "geography") {
  const started = service.startTrivia({
    chatId: COMMUNITY_CHAT,
    source: "manual",
    hubMode: true,
    category,
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 9001);
  return started;
}

function answerCorrect(service, sessionId, userId, name) {
  const snap = service.getSnapshot();
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
  return service.tryAnswer({
    sessionId,
    userId,
    answerIndex: (snap.correctIndex + 1) % 4,
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
  callbackData,
  memberStatus = "member",
} = {}) {
  const replies = [];
  const replyExtras = [];
  const cbAnswers = [];
  const edited = [];
  const callbackQuery = callbackData
    ? {
        data: callbackData,
        from: { id: userId, is_bot: false },
        message: {
          message_id: 9001,
          chat: { id: chatId, type: chatType },
          reply_markup: {
            inline_keyboard: [[{ text: "A", callback_data: "x" }]],
          },
        },
      }
    : undefined;
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName, is_bot: false },
    message: { text },
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
      return Promise.resolve({ message_id: 9001, extra });
    },
  };
}

function resultButtons(extra) {
  const rows =
    extra && extra.reply_markup && extra.reply_markup.inline_keyboard
      ? extra.reply_markup.inline_keyboard
      : [];
  return rows.flat();
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

async function main() {
  resetEnv();

  await runTest("20. first valid answer consumes attempt 1", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    const started = startHub(service);
    const result = answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.xpResult.attemptsUsed, 1);
    assert.strictEqual(getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed, 1);
  });

  await runTest("21. incorrect also consumes attempt", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    const started = startHub(service);
    const result = answerWrong(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(result.correct, false);
    assert.strictEqual(result.xpResult.attemptsUsed, 1);
    assert.strictEqual(result.xpResult.pointsToAdd, 0);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 0);
  });

  await runTest("22. open-but-no-answer does not consume", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    startHub(service);
    assert.strictEqual(getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed, 0);
    assert.ok(service.isTriviaOpen());
  });

  await runTest("23. duplicate callback no second attempt", async () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    const started = startHub(service);
    const ctx = createMockCtx({
      callbackData: buildAnswerCallbackData(
        started.session.id,
        service.getSnapshot().correctIndex
      ),
    });
    await handleTriviaAnswer(ctx, { runtime: service });
    await handleTriviaAnswer(ctx, { runtime: service });
    assert.strictEqual(ctx.cbAnswers[1], "This question is already finished.");
    assert.strictEqual(getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed, 1);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 1);
  });

  await runTest("24-26. 5 XP-eligible max; 6th playable with 0 XP", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    let started = startHub(service, "math");
    for (let i = 0; i < 5; i += 1) {
      const result = answerCorrect(service, started.session.id, USER_A, "Alice");
      assert.strictEqual(result.xpResult.awarded, true);
      assert.strictEqual(result.xpResult.pointsToAdd, TRIVIA_ATTEMPT_XP);
      const next = service.nextHubQuestion();
      assert.strictEqual(next.ok, true);
      started = { session: next.session };
    }
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 5);
    const sixth = answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(sixth.ok, true);
    assert.strictEqual(sixth.correct, true);
    assert.strictEqual(sixth.xpResult.awarded, false);
    assert.strictEqual(sixth.xpResult.pointsToAdd, 0);
    assert.ok(sixth.rendered.text.includes("Daily Trivia XP limit reached"));
    assert.ok(sixth.rendered.text.includes("Playing for fun"));
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 5);
    assert.strictEqual(
      getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed,
      6
    );
  });

  await runTest("27. categories share same total limit", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    const geo = startHub(service, "geography");
    answerCorrect(service, geo.session.id, USER_A, "Alice");
    service.nextHubQuestion();
    answerCorrect(service, service.getSnapshot().id, USER_A, "Alice");
    service.releaseHubSession("change");
    const math = startHub(service, "math");
    answerCorrect(service, math.session.id, USER_A, "Alice");
    service.nextHubQuestion();
    answerWrong(service, service.getSnapshot().id, USER_A, "Alice");
    service.releaseHubSession("change");
    const hist = startHub(service, "history");
    answerCorrect(service, hist.session.id, USER_A, "Alice");
    assert.strictEqual(getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed, 5);
    const sixth = service.nextHubQuestion();
    assert.strictEqual(sixth.ok, true);
    const fun = answerCorrect(service, sixth.session.id, USER_A, "Alice");
    assert.strictEqual(fun.xpResult.awarded, false);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 4);
  });

  await runTest("28. UTC next day resets", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    for (let i = 0; i < 5; i += 1) {
      awardTriviaAttemptXp(USER_A, "Alice", { correct: true, shopFile }, pointsFile);
    }
    assert.strictEqual(getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed, 5);
    mutatePoints((data) => {
      data.users[String(USER_A)].trivia.rewardDate = utcYesterday();
    }, pointsFile);
    const next = awardTriviaAttemptXp(USER_A, "Alice", { correct: true, shopFile }, pointsFile);
    assert.strictEqual(next.awarded, true);
    assert.strictEqual(next.attemptsUsed, 1);
    assert.strictEqual(getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed, 1);
  });

  await runTest("29. restart preserves attempts", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    awardTriviaAttemptXp(USER_A, "Alice", { correct: true, shopFile }, pointsFile);
    awardTriviaAttemptXp(USER_A, "Alice", { correct: false, shopFile }, pointsFile);
    const { service } = createService(store);
    const started = startHub(service);
    answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.strictEqual(getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed, 3);
    const again = getTriviaAttemptStatus(USER_A, pointsFile);
    assert.strictEqual(again.attemptsUsed, 3);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].trivia.attemptsUsed, 3);
  });

  await runTest("30. concurrent answer exactly once", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    const started = startHub(service);
    const a = answerCorrect(service, started.session.id, USER_A, "Alice");
    const b = answerCorrect(service, started.session.id, USER_B, "Bob");
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.reason, "question-closed");
    assert.strictEqual(getTriviaAttemptStatus(USER_A, pointsFile).attemptsUsed, 1);
    assert.strictEqual(getTriviaAttemptStatus(USER_B, pointsFile).attemptsUsed, 0);
  });

  await runTest("31-33. correct +1, incorrect +0, max Trivia XP 5/day", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const good = awardTriviaAttemptXp(USER_A, "Alice", { correct: true, shopFile }, pointsFile);
    assert.strictEqual(good.pointsToAdd, 1);
    const bad = awardTriviaAttemptXp(USER_B, "Bob", { correct: false, shopFile }, pointsFile);
    assert.strictEqual(bad.pointsToAdd, 0);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_B)].points, 0);
    for (let i = 0; i < 4; i += 1) {
      const next = awardTriviaAttemptXp(USER_A, "Alice", { correct: true, shopFile }, pointsFile);
      assert.strictEqual(next.awarded, true);
    }
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 5);
    const sixth = awardTriviaAttemptXp(USER_A, "Alice", { correct: true, shopFile }, pointsFile);
    assert.strictEqual(sixth.awarded, false);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 5);
    assert.strictEqual(TRIVIA_DAILY_ATTEMPT_CAP, 5);
  });

  await runTest("34. wallet-linked works", () => {
    const { pointsFile, walletFile, shopFile } = files();
    registerManualWallet(
      USER_A,
      encodeBase58(crypto.createHash("sha256").update("link-a").digest()),
      walletFile,
      1
    );
    const result = awardTriviaAttemptXp(
      USER_A,
      "Alice",
      { correct: true, shopFile },
      pointsFile,
      walletFile
    );
    assert.strictEqual(result.awarded, true);
    assert.strictEqual(result.pointsToAdd, 1);
  });

  await runTest("35-37. unlinked 0 XP, attempt consumed, no retroactive XP", () => {
    setXpWalletAutoLinkForTests(false);
    const { pointsFile, walletFile, shopFile } = files();
    const blocked = awardTriviaAttemptXp(
      USER_A,
      "Alice",
      { correct: true, shopFile },
      pointsFile,
      walletFile
    );
    assert.strictEqual(blocked.awarded, false);
    assert.strictEqual(blocked.attemptsUsed, 1);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 0);
    registerManualWallet(
      USER_A,
      encodeBase58(crypto.createHash("sha256").update("link-later").digest()),
      walletFile,
      1
    );
    const later = awardTriviaAttemptXp(
      USER_A,
      "Alice",
      { correct: true, shopFile },
      pointsFile,
      walletFile
    );
    assert.strictEqual(later.awarded, true);
    assert.strictEqual(later.points, 1);
    assert.strictEqual(later.attemptsUsed, 2);
  });

  await runTest("38. rank-up integration still works", () => {
    const { pointsFile, shopFile } = files();
    mutatePoints((data) => {
      data.users[String(USER_A)] = {
        points: 24,
        weeklyPoints: 0,
        weekId: "2026-01-05",
        name: "Alice",
      };
    }, pointsFile);
    const result = awardTriviaAttemptXp(
      USER_A,
      "Alice",
      { correct: true, shopFile },
      pointsFile
    );
    assert.strictEqual(result.awarded, true);
    assert.strictEqual(result.rankUp, true);
    assert.strictEqual(result.rank.title, "Sprout");
  });

  await runTest("39. daily XP totals unchanged outside Trivia", () => {
    const { pointsFile, shopFile } = files();
    awardTriviaAttemptXp(USER_A, "Alice", { correct: true, shopFile }, pointsFile);
    const before = loadPoints(pointsFile).users[String(USER_A)].points;
    awardDailyActivityPoint(USER_B, "Bob", pointsFile);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, before);
    assert.strictEqual(getTriviaAttemptStatus(USER_B, pointsFile).attemptsUsed, 0);
    assert.ok(loadPoints(pointsFile).users[String(USER_B)].points >= 1);
  });

  await runTest("40-43. status 0/5, updates, limit copy, fun play continues", async () => {
    const store = files();
    const { pointsFile } = store;
    const ctx = createMockCtx({ text: "/trivia" });
    await handleTrivia(ctx, { isBusyFn: () => false, pointsFile });
    assert.ok(ctx.replies[0].includes("🎯 XP-eligible plays: 0 / 5"));
    const { service } = createService(store);
    const started = startHub(service);
    const first = answerCorrect(service, started.session.id, USER_A, "Alice");
    assert.ok(first.rendered.text.includes("🎯 XP-eligible plays: 1 / 5"));
    for (let i = 0; i < 4; i += 1) {
      service.nextHubQuestion();
      answerCorrect(service, service.getSnapshot().id, USER_A, "Alice");
    }
    service.nextHubQuestion();
    const fun = answerCorrect(service, service.getSnapshot().id, USER_A, "Alice");
    assert.ok(fun.rendered.text.includes("Daily Trivia XP limit reached"));
    assert.ok(fun.ok);
    const more = service.nextHubQuestion();
    assert.strictEqual(more.ok, true);
  });

  await runTest("44. Next Question keeps category", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    const started = startHub(service, "science");
    assert.strictEqual(started.session.category, "science");
    answerCorrect(service, started.session.id, USER_A, "Alice");
    const next = service.nextHubQuestion();
    assert.strictEqual(next.session.category, "science");
    assert.strictEqual(next.session.questionCategory, "science");
    assert.ok(next.text.includes("Science"));
  });

  await runTest("45. Change Category works", async () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    startHub(service, "history");
    const ctx = createMockCtx({
      callbackData: buildHubNavCallbackData("change", service.getSnapshot().id),
    });
    await handleTriviaHubCallback(ctx, {
      runtime: service,
      isBusyFn: () => false,
      pointsFile,
    });
    assert.strictEqual(service.isTriviaOpen(), false);
    const text = ctx.edited.length ? ctx.edited[0].text : ctx.replies[0];
    assert.ok(String(text).includes("Choose a category"));
  });

  await runTest("46. stale callback safe", async () => {
    const { service } = createService();
    const started = startHub(service);
    service.abortRound("edit-failed");
    const ctx = createMockCtx({
      callbackData: buildAnswerCallbackData(started.session.id, 0),
    });
    await handleTriviaAnswer(ctx, { runtime: service });
    assert.ok(ctx.cbAnswers[0]);
    assert.strictEqual(service.isTriviaOpen(), false);
  });

  await runTest("47. finished question has no live answer buttons", () => {
    const store = files();
    const { pointsFile, shopFile } = store;
    const { service } = createService(store);
    const started = startHub(service);
    const result = answerCorrect(service, started.session.id, USER_A, "Alice");
    const buttons = resultButtons(result.rendered.extra);
    assert.ok(!buttons.some((b) => /^trivia:[a-f0-9]+:[0-3]$/i.test(b.callback_data)));
    assert.ok(
      buttons.some(
        (b) =>
          b.callback_data ===
          buildHubNavCallbackData("next", started.session.id)
      )
    );
    assert.ok(
      buttons.some(
        (b) =>
          b.callback_data ===
          buildHubNavCallbackData("change", started.session.id)
      )
    );
    assert.ok(
      buttons.some(
        (b) =>
          b.callback_data ===
          buildHubNavCallbackData("games", started.session.id)
      )
    );
    assert.strictEqual(service.getSnapshot().questionPhase, QUESTION_PHASE.RESOLVED);
  });

  await runTest("48-49. Daily Quest after real answer, not chooser", async () => {
    const { pointsFile, walletFile, shopFile } = files();
    const ctx = createMockCtx({ text: "/trivia" });
    await handleTrivia(ctx, { isBusyFn: () => false, pointsFile, shopFile });
    const before = getDailyQuestSnapshot(USER_A, { shopFile });
    assert.strictEqual(before.game.completed, false);

    const { service } = createService(null);
    service.setAwardXpHandler((uid, name, payload) =>
      awardTriviaAttemptXp(
        uid,
        name,
        { ...payload, shopFile },
        pointsFile,
        walletFile
      )
    );
    const started = startHub(service);
    answerCorrect(service, started.session.id, USER_A, "Alice");
    const after = getDailyQuestSnapshot(USER_A, { shopFile });
    assertEligibleBotGameProgress(after, { trivia: true });
    service.nextHubQuestion();
    answerCorrect(service, service.getSnapshot().id, USER_A, "Alice");
    const again = getDailyQuestSnapshot(USER_A, { shopFile });
    assertEligibleBotGameProgress(again, { trivia: true });
  });

  await runTest("50. auto activity-engine Trivia uses Random", () => {
    const { service } = createService();
    const started = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      source: "auto",
      autoIntro: true,
      category: "random",
      hubMode: false,
    });
    assert.strictEqual(started.ok, true);
    assert.strictEqual(started.session.category, "random");
    assert.strictEqual(started.session.hubMode, false);
    assert.ok(started.text.includes("5-question community round"));
    assert.strictEqual(ACTION_IDS.TRIVIA, "trivia");
  });

  await runTest("51. Games topic routing preserved", async () => {
    process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
    const ctx = createMockCtx({});
    await handleTrivia(ctx, {
      isBusyFn: () => false,
      canManageGroupFn: async () => false,
    });
    assert.ok(String(ctx.replies[0]).includes("Games topic"));
  });

  await runTest("52-53. cleanup and busy-state release preserved", () => {
    const { service } = createService();
    startHub(service);
    assert.strictEqual(service.isTriviaOpen(), true);
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
    service.abortRound("edit-failed");
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.strictEqual(service.getSnapshot().status, "aborted");
    startHub(service);
    service.releaseHubSession("back-games");
    assert.strictEqual(service.isTriviaOpen(), false);
    void GAME_TYPE.TRIVIA;
    void FINAL_STATE;
  });

  for (const [file, mtime] of Object.entries(prodMtimes)) {
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime, `mutated ${file}`);
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  console.log("\nAll trivia-daily-limit tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
