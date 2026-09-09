/**
 * Higher or Lower — Games topic, streak, RNG, session safety, cleanup.
 * Run: node tests/higher-or-lower.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  createHigherOrLowerService,
  parseHolCallbackData,
  buildPlayCallbackData,
  MIN_NUMBER,
  MAX_NUMBER,
  nextDistinctNumber,
  STATUS,
  PLAYER_BUSY_TEXT,
} = require("../services/higherOrLower");
const { createPvpMatchReservation } = require("../services/pvpMatchReservation");
const {
  handleHigherOrLower,
  handleHigherOrLowerCallback,
} = require("../commands/higherorlower");
const { handleGroupMenuCallback } = require("../commands/menu");
const {
  GROUP_MENU_CALLBACK,
  getGroupGamesMenuExtra,
  isGameMenuCallback,
  PRIVATE_GAMES_TEXT,
} = require("../utils/botMenu");
const { GAMES_TOPIC_REQUIRED_MESSAGE } = require("../utils/gameTopic");
const {
  GAME_TYPE,
  GAME_CLEANUP_FOOTER,
  GAME_ENDED_TOAST,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  clearAllGameMessageCleanups,
  getPendingGameMessageCleanupCount,
} = require("../utils/gameCleanup");
const {
  bindGroupMenuOwnerFromCtx,
  resetGroupMenuOwnersForTests,
} = require("../utils/menuOwnership");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const { loadPoints, LIGHTWEIGHT_DAILY_XP_CAP } = require("../services/points");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const COMMUNITY_CHAT = -1001234567890;
const GAMES_TOPIC_ID = "999";
const USER_A = 111;
const USER_B = 222;

const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-hol-"));
const pointsFile = path.join(tempDir, "points.json");
const shopFile = path.join(tempDir, "shop.json");
fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }));
setMangoShopFileForTests(shopFile);

function resetEnv() {
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  process.env.TELEGRAM_GAMES_TOPIC_ID = GAMES_TOPIC_ID;
}

function restoreEnv() {
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalTopic;
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

function seqRandom(values) {
  let i = 0;
  return () => {
    const value = values[Math.min(i, values.length - 1)];
    i += 1;
    return value;
  };
}

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const deleted = [];
  const reservation =
    overrides.reservation || createPvpMatchReservation();
  let idSeq = 0;
  const service = createHigherOrLowerService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    randomIntFn: overrides.randomIntFn || seqRandom([42, 67, 10, 80]),
    randomIdFn:
      overrides.randomIdFn ||
      (() => {
        idSeq += 1;
        return `aa${String(idSeq).padStart(6, "0")}`;
      }),
    idleMs: overrides.idleMs != null ? overrides.idleMs : 1_000,
    cleanupDelayMs:
      overrides.cleanupDelayMs != null ? overrides.cleanupDelayMs : 60,
    deleteMessageFn: async (chatId, messageId) => {
      deleted.push({ chatId, messageId });
    },
    reservation,
  });
  return { service, timers, deleted, reservation };
}

function start(service, userId = USER_A, name = "Kevin") {
  const started = service.startGame({
    chatId: COMMUNITY_CHAT,
    threadId: Number(GAMES_TOPIC_ID),
    starter: { userId, displayName: name, isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 7001);
  return started;
}

function createCtx({
  chatType = "supergroup",
  threadId,
  callbackData,
  userId = USER_A,
  command = false,
} = {}) {
  const replies = [];
  const msg = { message_id: 8001, chat: { id: COMMUNITY_CHAT, type: chatType } };
  if (threadId != null) {
    msg.message_thread_id = threadId;
  }
  const ctx = {
    chat: { id: COMMUNITY_CHAT, type: chatType },
    from: { id: userId, first_name: "Kevin", is_bot: false },
    replies,
    answered: [],
    edits: [],
    callbackQuery: callbackData
      ? {
          data: callbackData,
          message: {
            ...msg,
            reply_markup: {
              inline_keyboard: [[{ text: "x", callback_data: callbackData }]],
            },
          },
        }
      : undefined,
    message: command ? { ...msg } : undefined,
    reply(text, extra) {
      const payload = { text, extra, message_id: 8002 };
      replies.push(payload);
      return Promise.resolve(payload);
    },
    answerCbQuery(text) {
      ctx.answered.push(text || "");
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      ctx.edits.push({ text, extra });
      return Promise.resolve();
    },
  };
  return ctx;
}

async function runTest(name, fn) {
  resetEnv();
  clearAllGameMessageCleanups();
  resetGroupMenuOwnersForTests();
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
  await runTest("A. game starts in Games topic", async () => {
    const { service } = createService();
    let started = false;
    const ctx = createCtx({ threadId: Number(GAMES_TOPIC_ID), command: true });
    await handleHigherOrLower(ctx, {
      isBusyFn: () => false,
      startChallengeFn: (p) => {
        started = true;
        return service.startGame(p);
      },
      setMessageIdFn: (id, mid) => service.setMessageId(id, messageIdOr(mid)),
    });
    assert.strictEqual(started, true);
    assert.ok(ctx.replies[0].text.includes("Current number:"));
    assert.ok(ctx.replies[0].text.includes(`Numbers: ${MIN_NUMBER}–${MAX_NUMBER}`));
    assert.ok(ctx.replies[0].text.includes("🎯 Reward:"));
    assert.ok(ctx.replies[0].text.includes("🏆 Daily limit:"));
    assert.ok(ctx.replies[0].text.includes("ManGo or Moon"));
  });

  await runTest("B. wrong topic is rejected correctly", async () => {
    let started = false;
    const ctx = createCtx({ command: true });
    await handleHigherOrLower(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return { ok: true, text: "x", session: { id: "z" } };
      },
    });
    assert.strictEqual(started, false);
    assert.ok(ctx.replies[0].text.includes("Games topic"));
    assert.ok(ctx.replies[0].text.includes(GAMES_TOPIC_REQUIRED_MESSAGE.split("\n")[0]));
  });

  await runTest("C. first number is valid 1–100", () => {
    const { service } = createService({ randomIntFn: seqRandom([42]) });
    const started = start(service);
    assert.ok(started.session.current >= MIN_NUMBER);
    assert.ok(started.session.current <= MAX_NUMBER);
    assert.strictEqual(started.session.current, 42);
    assert.ok(started.text.includes(`Numbers: ${MIN_NUMBER}–${MAX_NUMBER}`));
  });

  await runTest("D. Higher correct", () => {
    const { service } = createService({ randomIntFn: seqRandom([42, 67]) });
    const started = start(service);
    const result = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.correct, true);
    assert.ok(result.rendered.text.includes("✅ Correct!"));
    assert.ok(result.rendered.text.includes(`Numbers: ${MIN_NUMBER}–${MAX_NUMBER}`));
    assert.ok(result.rendered.text.includes("Previous: 42"));
    assert.ok(result.rendered.text.includes("Next: 67"));
  });

  await runTest("E. Higher wrong", () => {
    const { service } = createService({ randomIntFn: seqRandom([42, 10]) });
    const started = start(service);
    const result = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.correct, false);
    assert.ok(result.rendered.text.includes("❌ Wrong!"));
    assert.ok(JSON.stringify(result.rendered.extra).includes("Play Again"));
  });

  await runTest("F. Lower correct", () => {
    const { service } = createService({ randomIntFn: seqRandom([42, 10]) });
    const started = start(service);
    const result = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "l",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.correct, true);
  });

  await runTest("G. Lower wrong", () => {
    const { service } = createService({ randomIntFn: seqRandom([42, 80]) });
    const started = start(service);
    const result = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "l",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.correct, false);
  });

  await runTest("H. equal RNG value safely rerolls", () => {
    let calls = 0;
    const next = nextDistinctNumber(42, () => {
      calls += 1;
      return 42;
    });
    assert.notStrictEqual(next, 42);
    assert.ok(calls >= 32);
    assert.ok(next >= MIN_NUMBER && next <= MAX_NUMBER);
  });

  await runTest("I. correct answer increments streak", () => {
    const { service } = createService({ randomIntFn: seqRandom([42, 67]) });
    const started = start(service);
    const result = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(result.session.streak, 1);
    assert.ok(result.rendered.text.includes("🔥 Streak: 1"));
  });

  await runTest("J. repeated correct answers continue session", () => {
    const { service } = createService({
      randomIntFn: seqRandom([20, 40, 70, 90]),
    });
    const started = start(service);
    const first = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(first.session.status, STATUS.ACTIVE);
    const second = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 2,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.session.streak, 2);
    assert.strictEqual(second.session.status, STATUS.ACTIVE);
  });

  await runTest("K. wrong answer ends gameplay state", () => {
    const { service, reservation } = createService({
      randomIntFn: seqRandom([42, 10]),
    });
    const started = start(service);
    assert.strictEqual(reservation.has(USER_A), true);
    const result = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(result.session.status, STATUS.ENDED);
    assert.strictEqual(reservation.has(USER_A), false);
  });

  await runTest("L. Finish ends immediately", () => {
    const { service, reservation } = createService();
    const started = start(service);
    const finished = service.finish({
      sessionId: started.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(finished.ok, true);
    assert.strictEqual(finished.session.status, STATUS.FINISHED);
    assert.strictEqual(reservation.has(USER_A), false);
    assert.ok(finished.rendered.text.includes(GAME_CLEANUP_FOOTER));
    assert.deepStrictEqual(finished.rendered.extra.reply_markup.inline_keyboard, []);
  });

  await runTest("M. Play Again starts clean session", () => {
    const { service } = createService({
      randomIntFn: seqRandom([42, 10, 55]),
    });
    const started = start(service);
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const again = service.playAgain({
      sessionId: started.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.session.streak, 0);
    assert.strictEqual(again.session.round, 1);
    assert.strictEqual(again.session.status, STATUS.ACTIVE);
    assert.notStrictEqual(again.session.id, started.session.id);
  });

  await runTest("N. stale previous-round button cannot mutate new round", () => {
    const { service } = createService({
      randomIntFn: seqRandom([20, 40, 10]),
    });
    const started = start(service);
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const stale = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-round");
    assert.strictEqual(service.getSession(started.session.id).streak, 1);
  });

  await runTest("O. abandoned session expires", () => {
    const { service, timers, reservation } = createService({ idleMs: 100 });
    const started = start(service);
    timers.advance(100);
    const live = service.getSession(started.session.id);
    assert.strictEqual(live.status, STATUS.EXPIRED);
    assert.strictEqual(reservation.has(USER_A), false);
  });

  await runTest("P. old timeout cannot kill new session", () => {
    const { service, timers, reservation } = createService({ idleMs: 100 });
    const started = start(service);
    const oldGen = service.getSession(started.session.id).idleGeneration;
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const stale = service.expireSession(started.session.id, oldGen);
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-timer");
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
    assert.strictEqual(reservation.has(USER_A), true);
    timers.advance(0);
  });

  await runTest("Q. outsider cannot control another user's session", () => {
    const { service } = createService();
    const started = start(service);
    const hijack = service.guess({
      sessionId: started.session.id,
      userId: USER_B,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(hijack.ok, false);
    assert.strictEqual(hijack.reason, "outsider");
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
  });

  await runTest("R. service guess does not mint XP/Loot/BP itself", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../services/higherOrLower.js"),
      "utf8"
    );
    assert.ok(!src.includes("awardPvpWinXp"));
    assert.ok(!src.includes("awardTrivia"));
    assert.ok(!src.includes("mangoLoot"));
    assert.ok(!src.includes("battlePass"));
    const before = loadPoints(pointsFile);
    const { service } = createService({ randomIntFn: seqRandom([42, 10]) });
    const started = start(service);
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "h",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const after = loadPoints(pointsFile);
    assert.deepStrictEqual(after, before);
  });

  await runTest("S. cleanup footer and cleanup timer work", async () => {
    const { service, timers, deleted } = createService({
      cleanupDelayMs: 60,
    });
    const started = start(service);
    service.finish({
      sessionId: started.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const rendered = service.renderMessage(service.getSession(started.session.id));
    assert.ok(rendered.text.includes(GAME_CLEANUP_FOOTER));
    assert.strictEqual(deleted.length, 0);
    timers.advance(59);
    await Promise.resolve();
    assert.strictEqual(deleted.length, 0);
    timers.advance(1);
    await Promise.resolve();
    assert.ok(deleted.some((d) => d.messageId === 7001));
  });

  await runTest("T. user can immediately start a new game after Finish/end", () => {
    const { service, reservation } = createService({
      randomIntFn: seqRandom([42, 10, 33]),
    });
    const started = start(service);
    service.finish({
      sessionId: started.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(reservation.has(USER_A), false);
    const next = service.startGame({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    assert.strictEqual(next.ok, true);
    assert.strictEqual(reservation.has(USER_A), true);
  });

  await runTest("menu includes Higher or Lower and topic-gates it", async () => {
    assert.strictEqual(isGameMenuCallback(GROUP_MENU_CALLBACK.HOL), true);
    const extra = getGroupGamesMenuExtra({ botInfo: { username: "ManGoBot" } });
    const blob = JSON.stringify(extra);
    assert.ok(blob.includes(GROUP_MENU_CALLBACK.HOL));
    assert.ok(blob.includes("📈 Higher or Lower"));
    assert.ok(blob.includes("🥭 ManGo or Moon"));
    assert.ok(blob.includes(GROUP_MENU_CALLBACK.MOM));
    assert.ok(blob.includes("🐍 Snake"));
    assert.ok(blob.includes("🟠 Bounch"));
    assert.ok(blob.includes("⭕ Tic-Tac-Toe"));
    assert.ok(blob.includes("🔴 Connect Four"));
    assert.ok(blob.includes("♟️ Checkers"));
    assert.ok(blob.includes("✊ Rock Paper Scissors"));
    assert.ok(blob.includes("💣 ManGo Bomb"));
    assert.ok(blob.includes("🃏 Blackjack"));
    assert.ok(blob.includes("🧠 Trivia"));
    assert.ok(PRIVATE_GAMES_TEXT.includes("Higher or Lower"));
    const ctx = createCtx({ callbackData: GROUP_MENU_CALLBACK.HOL });
    bindGroupMenuOwnerFromCtx(ctx);
    let started = false;
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return { ok: true, text: "x", session: { id: "z" } };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, false);
    assert.ok(JSON.stringify(ctx.answered).includes("Games"));
  });

  await runTest("stale callback toast is game ended, not Games topic", async () => {
    const { service } = createService();
    const ctx = createCtx({
      threadId: undefined,
      callbackData: buildPlayCallbackData("h", "dead01", 1),
    });
    await handleHigherOrLowerCallback(ctx, { runtime: service });
    const blob = JSON.stringify(ctx.answered) + JSON.stringify(ctx.edits);
    assert.ok(!blob.includes("Games are played in the Games topic"));
    assert.ok(ctx.answered.includes(GAME_ENDED_TOAST));
  });

  await runTest("U. streak milestones award XP up to shared daily cap", async () => {
    const { service } = createService({
      randomIntFn: seqRandom([10, 20, 30, 40, 50, 60, 70]),
    });
    const started = start(service);
    const ctxFor = (action, round) =>
      createCtx({
        threadId: Number(GAMES_TOPIC_ID),
        callbackData: buildPlayCallbackData(action, started.session.id, round),
      });
    await handleHigherOrLowerCallback(ctxFor("h", 1), {
      runtime: service,
      pointsFile,
      shopFile,
    });
    await handleHigherOrLowerCallback(ctxFor("h", 2), {
      runtime: service,
      pointsFile,
      shopFile,
    });
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 0);
    await handleHigherOrLowerCallback(ctxFor("h", 3), {
      runtime: service,
      pointsFile,
      shopFile,
    });
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 1);
    await handleHigherOrLowerCallback(ctxFor("h", 4), {
      runtime: service,
      pointsFile,
      shopFile,
    });
    await handleHigherOrLowerCallback(ctxFor("h", 5), {
      runtime: service,
      pointsFile,
      shopFile,
    });
    assert.strictEqual(
      loadPoints(pointsFile).users[String(USER_A)].points,
      LIGHTWEIGHT_DAILY_XP_CAP
    );
    const capped = ctxFor("h", 6);
    await handleHigherOrLowerCallback(capped, {
      runtime: service,
      pointsFile,
      shopFile,
    });
    assert.strictEqual(
      loadPoints(pointsFile).users[String(USER_A)].points,
      LIGHTWEIGHT_DAILY_XP_CAP
    );
    const last = capped.edits[capped.edits.length - 1];
    assert.ok(last.text.includes("🎮 Daily XP earned — keep playing for fun."));
    assert.ok(last.text.includes("Current number:"));
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
  });

  await runTest("V. stale guess cannot reward after Finish", async () => {
    const before = loadPoints(pointsFile);
    const { service } = createService({ randomIntFn: seqRandom([10, 20, 30]) });
    const started = start(service);
    service.finish({
      sessionId: started.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const ctx = createCtx({
      threadId: Number(GAMES_TOPIC_ID),
      callbackData: buildPlayCallbackData("h", started.session.id, 1),
    });
    await handleHigherOrLowerCallback(ctx, { runtime: service, pointsFile, shopFile });
    assert.deepStrictEqual(loadPoints(pointsFile), before);
  });

  await runTest("callback parse rejects junk", () => {
    assert.strictEqual(parseHolCallbackData("pvp:ttt:join:x"), null);
    assert.strictEqual(parseHolCallbackData("hol:h:zz:1"), null);
    const parsed = parseHolCallbackData(buildPlayCallbackData("h", "aabbcc", 2));
    assert.strictEqual(parsed.action, "h");
    assert.strictEqual(parsed.round, 2);
  });

  await runTest("cleanup delay default is 60s", () => {
    assert.strictEqual(GAME_MESSAGE_CLEANUP_DELAY_MS, 60 * 1000);
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
  });

  restoreEnv();
  console.log("\nAll Higher or Lower tests passed.");
}

function messageIdOr(mid) {
  return mid;
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
