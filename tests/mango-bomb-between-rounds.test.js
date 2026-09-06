/**
 * ManGo Bomb between-rounds waiting UI, leftover PASS, and wait callbacks.
 * Run: node tests/mango-bomb-between-rounds.test.js
 */

const assert = require("assert");

const {
  createMangoBombService,
  parseMangoBombCallbackData,
  passCallbackData,
  waitCallbackData,
  STATUS,
  STALE_CALLBACK,
  BETWEEN_ROUNDS_TOAST,
  ROUND_LIVE_TOAST,
  getMangoBombRuntime,
} = require("../services/mangoBomb");
const { handleMangoBombCallback } = require("../commands/mangobomb");

const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;
const USER_D = 444;

const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

function resetEnv() {
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
}

function restoreEnv() {
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalGamesTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalGamesTopic;
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
  const edits = [];
  const service = createMangoBombService({
    now: () => timers.now(),
    setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
    randomIntFn: () => 0,
    randomIdFn: () => "aabbccdd",
    lobbyMs: 60_000,
    bombMinMs: overrides.bombMinMs != null ? overrides.bombMinMs : 8_000,
    bombMaxMs: overrides.bombMaxMs != null ? overrides.bombMaxMs : 20_000,
    betweenRoundsMs:
      overrides.betweenRoundsMs != null ? overrides.betweenRoundsMs : 2_500,
    startCooldownMs: 0,
    watchdogMs: overrides.watchdogMs != null ? overrides.watchdogMs : 10_000,
  });
  service.setEditMessageHandler(async (chatId, messageId, text, extra) => {
    edits.push({ chatId, messageId, text, extra });
  });
  return { service, timers, edits };
}

function join(service, gameId, userId, name) {
  return service.tryJoin({
    gameId,
    userId,
    displayName: { first_name: name, id: userId },
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  });
}

function pass(service, gameId, userId) {
  return service.tryPass({
    gameId,
    userId,
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  });
}

async function startWithPlayers(service, names) {
  const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.gameId, 9001);
  const ids = [USER_A, USER_B, USER_C, USER_D];
  names.forEach((name, i) => {
    const result = join(service, started.gameId, ids[i], name);
    assert.strictEqual(result.ok, true, result.reason);
  });
  return started.gameId;
}

function createMockCtx({
  userId = USER_A,
  firstName = "Kevin",
  callbackData,
} = {}) {
  const cbAnswers = [];
  return {
    chat: { type: "supergroup", id: COMMUNITY_CHAT },
    from: { id: userId, first_name: firstName, is_bot: false },
    message: { message_thread_id: 123 },
    callbackQuery: {
      data: callbackData,
      from: { id: userId, is_bot: false },
      message: {
        message_id: 9001,
        chat: { id: COMMUNITY_CHAT, type: "supergroup" },
        message_thread_id: 123,
      },
    },
    cbAnswers,
    async answerCbQuery(text) {
      cbAnswers.push(text || "");
    },
    async editMessageText() {
      return true;
    },
  };
}

async function runTest(name, fn) {
  resetEnv();
  getMangoBombRuntime().reset();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  } finally {
    getMangoBombRuntime().reset();
  }
}

async function main() {
  await runTest("wait callback parsing stays server-owned", async () => {
    assert.strictEqual(parseMangoBombCallbackData("mb:wait:aabbccdd").action, "wait");
    assert.strictEqual(parseMangoBombCallbackData("mb:wait:aabbccdd:111"), null);
    assert.ok(!waitCallbackData("aabbccdd").includes(String(USER_A)));
    assert.ok(!passCallbackData("aabbccdd").includes(String(USER_A)));
  });

  await runTest("valid pass still advances a running round", async () => {
    const { service } = createService();
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    const holder = service.getGame(gameId).currentHolder;
    const moved = pass(service, gameId, Number(holder));
    assert.strictEqual(moved.ok, true);
    assert.notStrictEqual(service.getGame(gameId).currentHolder, holder);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);
  });

  await runTest("boom text shows waiting and pause timer has a deterministic exit", async () => {
    const { service, timers, edits } = createService({ betweenRoundsMs: 80 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.BETWEEN_ROUNDS);
    assert.strictEqual(service.hasActivePauseTimer(gameId), true);
    const boom = edits.filter((row) => row.text.includes("BOOM")).pop();
    assert.ok(boom);
    assert.ok(boom.text.includes("Next round starting"));
    const waitBtn = boom.extra.reply_markup.inline_keyboard[0][0];
    assert.strictEqual(waitBtn.callback_data, waitCallbackData(gameId));
    timers.advance(80);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);
    assert.ok(service.getGame(gameId).currentHolder);
  });

  await runTest("leftover PASS during pause does not claim the game is over", async () => {
    const { service, edits } = createService({ betweenRoundsMs: 250 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    const boom = await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(boom.status, STATUS.BETWEEN_ROUNDS);
    const beforeEliminated = service.getGame(gameId).eliminatedCount;
    const holderBefore = service.getGame(gameId).currentHolder;
    const passed = pass(service, gameId, USER_A);
    assert.strictEqual(passed.ok, false);
    assert.strictEqual(passed.reason, "between-rounds");
    assert.strictEqual(passed.toast, BETWEEN_ROUNDS_TOAST);
    assert.notStrictEqual(passed.toast, STALE_CALLBACK);
    assert.ok(passed.text.includes("Next round starting"));
    const queued = await service.enqueuePass({
      gameId,
      userId: USER_A,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(queued.ok, false);
    assert.strictEqual(queued.toast, BETWEEN_ROUNDS_TOAST);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.BETWEEN_ROUNDS);
    assert.strictEqual(service.getGame(gameId).eliminatedCount, beforeEliminated);
    assert.strictEqual(service.getGame(gameId).currentHolder, holderBefore);
    assert.ok(edits.some((row) => row.text.includes("Next round starting")));
  });

  await runTest("wait callback refreshes UI and never passes", async () => {
    const { service, timers } = createService({ betweenRoundsMs: 60 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    await service.forceExplode(gameId);
    const waitCtx = createMockCtx({
      callbackData: waitCallbackData(gameId),
    });
    await handleMangoBombCallback(waitCtx, { runtime: service });
    assert.strictEqual(waitCtx.cbAnswers[0], BETWEEN_ROUNDS_TOAST);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.BETWEEN_ROUNDS);
    timers.advance(60);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);
    const liveWait = createMockCtx({
      callbackData: waitCallbackData(gameId),
    });
    const holder = service.getGame(gameId).currentHolder;
    await handleMangoBombCallback(liveWait, { runtime: service });
    assert.strictEqual(liveWait.cbAnswers[0], ROUND_LIVE_TOAST);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);
    assert.strictEqual(service.getGame(gameId).currentHolder, holder);
  });

  await runTest("duplicate callbacks cannot create a second winner", async () => {
    const { service, timers, edits } = createService({ betweenRoundsMs: 40 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay"]);
    await service.forceLobbyEnd(gameId);
    const first = await service.forceExplode(gameId);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(first.status, STATUS.FINISHED);
    const againPass = await service.enqueuePass({
      gameId,
      userId: USER_A,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    const againWait = await service.enqueueWait({
      gameId,
      userId: USER_A,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    const againBoom = await service.forceExplode(gameId);
    assert.strictEqual(againPass.ok, false);
    assert.strictEqual(againWait.ok, false);
    assert.strictEqual(againBoom.ok, false);
    assert.strictEqual(edits.filter((row) => row.text.includes("WINNER")).length, 1);
    timers.advance(40);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
  });

  await runTest("wait-queue error does not permanently lock the chat", async () => {
    const { service, timers } = createService({ betweenRoundsMs: 50 });
    const gameId = await startWithPlayers(service, ["Kevin", "Lojay", "Ada"]);
    await service.forceLobbyEnd(gameId);
    await service.forceExplode(gameId);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.BETWEEN_ROUNDS);
    service.injectQueueThrow("wait");
    const failed = await service.enqueueWait({
      gameId,
      userId: USER_A,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.BETWEEN_ROUNDS);
    assert.strictEqual(service.hasActivePauseTimer(gameId), true);
    timers.advance(50);
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);
  });

  restoreEnv();
  console.log("\nAll mango-bomb between-rounds tests passed.");
}

main().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
