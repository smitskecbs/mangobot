/**
 * ManGo or Moon — Games topic, 50/50 RNG, streak, rewards, cleanup.
 * Run: node tests/mango-or-moon.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  createMangoOrMoonService,
  parseMomCallbackData,
  buildPlayCallbackData,
  STATUS,
  SIDE,
  defaultRandomInt,
  outcomeFromRoll,
} = require("../services/mangoOrMoon");
const { createPvpMatchReservation } = require("../services/pvpMatchReservation");
const {
  handleMangoOrMoon,
  handleMangoOrMoonCallback,
} = require("../commands/mangoormoon");
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
const {
  loadPoints,
  LIGHTWEIGHT_DAILY_XP_CAP,
} = require("../services/points");
const { GAME_SOURCES, noteDailyQuestGame, getDailyQuestSnapshot } = require("../services/dailyQuest");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const COMMUNITY_CHAT = -1001234567890;
const GAMES_TOPIC_ID = "999";
const USER_A = 111;
const USER_B = 222;

const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-mom-"));
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
  const reservation = overrides.reservation || createPvpMatchReservation();
  let idSeq = 0;
  const rolls = [];
  let rollSeq = 0;
  const defaultRolls = [0, 1, 0, 1];
  const randomIntFn =
    overrides.randomIntFn ||
    ((...args) => {
      rolls.push(args);
      const value = defaultRolls[Math.min(rollSeq, defaultRolls.length - 1)];
      rollSeq += 1;
      return value;
    });
  const service = createMangoOrMoonService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    randomIntFn,
    randomIdFn:
      overrides.randomIdFn ||
      (() => {
        idSeq += 1;
        return `bb${String(idSeq).padStart(6, "0")}`;
      }),
    idleMs: overrides.idleMs != null ? overrides.idleMs : 1_000,
    cleanupDelayMs:
      overrides.cleanupDelayMs != null ? overrides.cleanupDelayMs : 60,
    deleteMessageFn: async (chatId, messageId) => {
      deleted.push({ chatId, messageId });
    },
    reservation,
  });
  return { service, timers, deleted, reservation, rolls };
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
    const { service } = createService({ randomIntFn: seqRandom([0]) });
    let started = false;
    const ctx = createCtx({ threadId: Number(GAMES_TOPIC_ID), command: true });
    await handleMangoOrMoon(ctx, {
      isBusyFn: () => false,
      startChallengeFn: (p) => {
        started = true;
        return service.startGame(p);
      },
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
      runtime: service,
    });
    assert.strictEqual(started, true);
    assert.ok(ctx.replies[0].text.includes("ManGo or Moon"));
    assert.ok(ctx.replies[0].text.includes("🎯 Reward:"));
    assert.ok(ctx.replies[0].text.includes("🏆 Daily limit:"));
    assert.ok(ctx.replies[0].text.includes("Higher or Lower"));
  });

  await runTest("B. wrong topic is rejected", async () => {
    let started = false;
    const ctx = createCtx({ command: true });
    await handleMangoOrMoon(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return { ok: true, text: "x", session: { id: "z" } };
      },
    });
    assert.strictEqual(started, false);
    assert.ok(ctx.replies[0].text.includes(GAMES_TOPIC_REQUIRED_MESSAGE.split("\n")[0]));
  });

  await runTest("C-F. ManGo/Moon win and loss", () => {
    const mangoWin = createService({ randomIntFn: seqRandom([0]) }).service;
    const started = start(mangoWin);
    const win = mangoWin.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "m",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(win.ok, true);
    assert.strictEqual(win.correct, true);
    assert.strictEqual(win.session.streak, 1);
    assert.ok(win.rendered.text.includes("You chose: 🥭 ManGo"));
    assert.ok(win.rendered.text.includes("Result: 🥭 ManGo"));
    assert.ok(win.rendered.text.includes("✅ Correct!"));

    const mangoLoss = createService({ randomIntFn: seqRandom([1]) }).service;
    const s2 = start(mangoLoss);
    const loss = mangoLoss.guess({
      sessionId: s2.session.id,
      userId: USER_A,
      action: "m",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(loss.correct, false);
    assert.strictEqual(loss.session.streak, 0);
    assert.ok(loss.rendered.text.includes("Result: 🌙 Moon"));
    assert.ok(loss.rendered.text.includes("❌ Wrong!"));

    const moonWin = createService({ randomIntFn: seqRandom([1]) }).service;
    const s3 = start(moonWin);
    const mw = moonWin.guess({
      sessionId: s3.session.id,
      userId: USER_A,
      action: "n",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(mw.correct, true);
    assert.ok(mw.rendered.text.includes("You chose: 🌙 Moon"));

    const moonLoss = createService({ randomIntFn: seqRandom([0]) }).service;
    const s4 = start(moonLoss);
    const ml = moonLoss.guess({
      sessionId: s4.session.id,
      userId: USER_A,
      action: "n",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(ml.correct, false);
    assert.ok(ml.rendered.text.includes("Result: 🥭 ManGo"));
  });

  await runTest("G. RNG is 50/50 after choice and ignores prediction", () => {
    const seen = [];
    const { service } = createService({
      randomIntFn: (...args) => {
        seen.push(args.slice());
        return 0;
      },
    });
    const started = start(service);
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "n",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0], []);
    assert.strictEqual(outcomeFromRoll(0), SIDE.MANGO);
    assert.strictEqual(outcomeFromRoll(1), SIDE.MOON);
    assert.strictEqual(typeof defaultRandomInt, "function");
  });

  await runTest("H. streak increments; wrong ends run", () => {
    const { service } = createService({ randomIntFn: seqRandom([0, 0, 1]) });
    const started = start(service);
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "m",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "m",
      round: 2,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(service.getSession(started.session.id).streak, 2);
    const wrong = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "m",
      round: 3,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(wrong.correct, false);
    assert.strictEqual(wrong.session.status, STATUS.ENDED);
    assert.ok(wrong.rendered.text.includes("Final streak: 2"));
  });

  await runTest("I. Play Again and Finish", () => {
    const { service, reservation } = createService({ randomIntFn: seqRandom([1]) });
    const started = start(service);
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "m",
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
    assert.ok(!again.text.includes(GAME_CLEANUP_FOOTER));
    const finished = service.finish({
      sessionId: again.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(finished.ok, true);
    assert.ok(finished.rendered.text.includes(GAME_CLEANUP_FOOTER));
    assert.strictEqual(reservation.has(USER_A), false);
  });

  await runTest("J. idle expiry; old timeout cannot kill new session", () => {
    const { service, timers } = createService({
      randomIntFn: seqRandom([0]),
      idleMs: 100,
    });
    const first = start(service);
    timers.advance(100);
    assert.strictEqual(service.getSession(first.session.id).status, STATUS.EXPIRED);
    const second = start(service);
    timers.advance(50);
    assert.strictEqual(service.getSession(second.session.id).status, STATUS.ACTIVE);
    timers.advance(100);
    assert.strictEqual(service.getSession(second.session.id).status, STATUS.EXPIRED);
  });

  await runTest("K. stale callback and outsider protection", () => {
    const { service } = createService({ randomIntFn: seqRandom([0, 0]) });
    const started = start(service);
    const hijack = service.guess({
      sessionId: started.session.id,
      userId: USER_B,
      action: "m",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(hijack.reason, "outsider");
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "m",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const stale = service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "m",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-round");
  });

  await runTest("L. shared daily cap and fun play after cap", async () => {
    const { service } = createService({
      randomIntFn: seqRandom([0, 0, 0, 0, 0, 0]),
    });
    const started = start(service);
    const play = async (round) => {
      const ctx = createCtx({
        threadId: Number(GAMES_TOPIC_ID),
        callbackData: buildPlayCallbackData("m", started.session.id, round),
      });
      await handleMangoOrMoonCallback(ctx, {
        runtime: service,
        pointsFile,
        shopFile,
      });
      return ctx;
    };
    await play(1);
    await play(2);
    await play(3);
    assert.strictEqual(loadPoints(pointsFile).users[String(USER_A)].points, 1);
    await play(4);
    const fifth = await play(5);
    assert.strictEqual(
      loadPoints(pointsFile).users[String(USER_A)].points,
      LIGHTWEIGHT_DAILY_XP_CAP
    );
    const sixth = await play(6);
    assert.strictEqual(
      loadPoints(pointsFile).users[String(USER_A)].points,
      LIGHTWEIGHT_DAILY_XP_CAP
    );
    assert.ok(sixth.edits[0].text.includes("🎮 Daily XP earned — keep playing for fun."));
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
  });

  await runTest("M. Daily Quest notes resolved prediction only", () => {
    assert.ok(GAME_SOURCES.includes("mom"));
    assert.ok(GAME_SOURCES.includes("hol"));
    const cmd = fs.readFileSync(
      path.join(__dirname, "../commands/mangoormoon.js"),
      "utf8"
    );
    assert.ok(cmd.includes('noteDailyQuestGame(userId, "mom"'));
    const startFn = cmd.slice(cmd.indexOf("async function handleMangoOrMoon"), cmd.indexOf("async function handleMangoOrMoonCallback"));
    assert.ok(!startFn.includes("noteDailyQuestGame"));
    noteDailyQuestGame(USER_A, "mom", { shopFile, pointsFile });
    const snap = getDailyQuestSnapshot(USER_A, { shopFile, pointsFile });
    assert.ok(snap);
  });

  await runTest("N. cleanup footer/timer; replay not deleted", async () => {
    const { service, timers, deleted } = createService({
      randomIntFn: seqRandom([1]),
      cleanupDelayMs: 60,
    });
    const started = start(service);
    service.guess({
      sessionId: started.session.id,
      userId: USER_A,
      action: "m",
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const again = service.playAgain({
      sessionId: started.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    timers.advance(60);
    await Promise.resolve();
    assert.strictEqual(deleted.length, 0);
    service.finish({
      sessionId: again.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.ok(service.renderMessage(service.getSession(again.session.id)).text.includes(GAME_CLEANUP_FOOTER));
    timers.advance(59);
    await Promise.resolve();
    assert.strictEqual(deleted.length, 0);
    timers.advance(1);
    await Promise.resolve();
    assert.ok(deleted.some((d) => d.messageId === 7001));
  });

  await runTest("O. Games menu emoji and topic gate", async () => {
    assert.strictEqual(isGameMenuCallback(GROUP_MENU_CALLBACK.MOM), true);
    const extra = getGroupGamesMenuExtra({ botInfo: { username: "ManGoBot" } });
    const blob = JSON.stringify(extra);
    assert.ok(blob.includes(GROUP_MENU_CALLBACK.MOM));
    assert.ok(blob.includes("🥭 ManGo or Moon"));
    assert.ok(PRIVATE_GAMES_TEXT.includes("ManGo or Moon"));
    const ctx = createCtx({ callbackData: GROUP_MENU_CALLBACK.MOM });
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

  await runTest("P. stale toast is game ended", async () => {
    const { service } = createService();
    const ctx = createCtx({
      threadId: undefined,
      callbackData: buildPlayCallbackData("m", "dead01", 1),
    });
    await handleMangoOrMoonCallback(ctx, { runtime: service });
    assert.ok(ctx.answered.includes(GAME_ENDED_TOAST));
  });

  await runTest("Q. callback parse", () => {
    assert.strictEqual(parseMomCallbackData("hol:h:aa:1"), null);
    const parsed = parseMomCallbackData(buildPlayCallbackData("n", "aabbcc", 2));
    assert.strictEqual(parsed.action, "n");
    assert.strictEqual(parsed.round, 2);
    assert.strictEqual(GAME_MESSAGE_CLEANUP_DELAY_MS, 60 * 1000);
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
  });

  restoreEnv();
  console.log("\nAll ManGo or Moon tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
