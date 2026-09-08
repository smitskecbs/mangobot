/**
 * Rock Paper Scissors PvP — private choices, XP, quest, stale callbacks.
 * Run: node tests/rock-paper-scissors.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  createRockPaperScissorsService,
  parsePvpCallbackData,
  buildJoinCallbackData,
  buildChoiceCallbackData,
  buildReplayCallbackData,
  buildFinishCallbackData,
  publicTextHasSecret,
  JOIN_TIMEOUT_MS,
  CHOICE_TIMEOUT_MS,
  COUNTDOWN_MARKS_SEC,
  MOVE_LABEL,
  STATUS,
  PHASE,
  PLAYER_BUSY_TEXT,
  BOT_USER_ID,
  BOT_DISPLAY_NAME,
  pickBotMove,
  msUntilNextCountdownMark,
} = require("../services/rockPaperScissors");
const { createTicTacToeService } = require("../services/ticTacToe");
const {
  createPvpSessionManager,
} = require("../services/pvpSessionManager");
const { createPvpMatchReservation } = require("../services/pvpMatchReservation");
const {
  handlePvpCallback,
  finalizeWinXp,
} = require("../events/pvp-callbacks");
const { handleRps, PRIVATE_RPS_TEXT } = require("../commands/rps");
const { handleStart } = require("../commands/start");
const {
  handleGroupMenuCallback,
  handlePrivateHubCallback,
} = require("../commands/menu");
const {
  GROUP_MENU_CALLBACK,
  PRIVATE_HUB_CALLBACK,
  PRIVATE_GAMES_TEXT,
  getGroupGamesMenuExtra,
  isGameMenuCallback,
} = require("../utils/botMenu");
const { GAMES_TOPIC_REQUIRED_MESSAGE } = require("../utils/gameTopic");
const {
  bindGroupMenuOwnerFromCtx,
  resetGroupMenuOwnersForTests,
} = require("../utils/menuOwnership");
const {
  awardPvpWinXp,
  PVP_WIN_XP,
  PVP_DAILY_WIN_CAP,
  loadPoints,
} = require("../services/points");
const { GAME_SOURCES } = require("../services/dailyQuest");
const { PVP_MATCH_GAMES } = require("../services/pvpProgress");
const { ACTION_REGISTRY } = require("../services/communityActivityEngine");
const { GAME_TYPE } = require("../utils/gameCleanup");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-rps-"));
let testCounter = 0;
const COMMUNITY_CHAT = -1001234567890;
const OTHER_CHAT = -1009999999999;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;
const GAMES_TOPIC_ID = "999";

const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

function pointsFile() {
  testCounter += 1;
  return path.join(tempDir, `points-${testCounter}.json`);
}

function resetEnv() {
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  process.env.TELEGRAM_GAMES_TOPIC_ID = GAMES_TOPIC_ID;
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
  const manager =
    overrides.manager ||
    createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs:
        overrides.pairCooldownMs != null ? overrides.pairCooldownMs : 30 * 60 * 1000,
    });
  const reservation = overrides.reservation || createPvpMatchReservation();
  const questGames = [];
  const questPvp = [];
  const service = createRockPaperScissorsService({
    manager,
    reservation,
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    joinTimeoutMs: overrides.joinTimeoutMs != null ? overrides.joinTimeoutMs : JOIN_TIMEOUT_MS,
    choiceTimeoutMs:
      overrides.choiceTimeoutMs != null ? overrides.choiceTimeoutMs : CHOICE_TIMEOUT_MS,
    pairCooldownMs:
      overrides.pairCooldownMs != null ? overrides.pairCooldownMs : 30 * 60 * 1000,
    botUsername: "ManGoBot",
    randomMoveFn: overrides.randomMoveFn,
    noteDailyQuestGameFn: (uid, game) => {
      questGames.push({ uid: String(uid), game });
    },
    noteHumanPvpMatchFn: async (uid, payload) => {
      questPvp.push({ uid: String(uid), payload });
      return { ok: true };
    },
  });
  return { service, timers, manager, reservation, questGames, questPvp };
}

function startLobby(service) {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId: USER_A, displayName: "Kevin", isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  const lobby = service.chooseMode({
    sessionId: started.session.id,
    userId: USER_A,
    mode: "pvp",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(lobby.ok, true);
  assert.strictEqual(lobby.session.phase, PHASE.LOBBY);
  return lobby;
}

function startBot(service) {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId: USER_A, displayName: "Kevin", isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  const bot = service.chooseMode({
    sessionId: started.session.id,
    userId: USER_A,
    mode: "bot",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(bot.ok, true);
  assert.strictEqual(bot.session.opponentType, "bot");
  assert.strictEqual(bot.session.phase, PHASE.CHOOSING);
  return bot;
}

function joinP2(service, sessionId) {
  const joined = service.join({
    sessionId,
    userId: USER_B,
    displayName: "Alice",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(joined.ok, true);
  assert.strictEqual(joined.session.status, STATUS.ACTIVE);
  return joined;
}

async function lock(service, sessionId, userId, move, round = 1) {
  return service.choose({
    sessionId,
    userId,
    move,
    round,
    source: "private",
  });
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Kevin",
  text = "",
  callbackData,
  messageThreadId,
  startPayload,
} = {}) {
  const replies = [];
  const ctx = {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName, is_bot: false },
    message: { text },
    startPayload,
    botInfo: { username: "ManGoBot" },
    replies,
    cbAnswers: [],
    edited: [],
    dms: [],
    publicEdits: [],
    callbackQuery: callbackData
      ? {
          data: callbackData,
          from: { id: userId, is_bot: false },
          message: {
            message_id: 5001,
            chat: { id: chatId, type: chatType },
            ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
            reply_markup: {
              inline_keyboard: [[{ text: "x", callback_data: callbackData }]],
            },
          },
        }
      : undefined,
    reply(msg, extra) {
      replies.push({ text: msg, extra });
      return Promise.resolve({ message_id: 5001 });
    },
    answerCbQuery(text) {
      ctx.cbAnswers.push(text || "");
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      ctx.edited.push({ text, extra });
      return Promise.resolve();
    },
    telegram: {
      sendMessage(uid, text, extra) {
        ctx.dms.push({ uid, text, extra });
        return Promise.resolve({ message_id: 9000 });
      },
      editMessageText(chat, mid, _inline, text, extra) {
        ctx.publicEdits.push({ chat, mid, text, extra });
        return Promise.resolve();
      },
      deleteMessage() {
        return Promise.resolve();
      },
    },
  };
  if (messageThreadId != null) {
    ctx.message.message_thread_id = messageThreadId;
  }
  return ctx;
}

async function runTest(name, fn) {
  resetEnv();
  resetGroupMenuOwnersForTests();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    restoreEnv();
    throw err;
  }
}

async function main() {
  resetEnv();

  await runTest("A. start screen offers vs Bot / vs Player / Cancel", async () => {
    const { service } = createService();
    const started = service.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    assert.strictEqual(started.ok, true);
    assert.ok(started.text.includes("Rock Paper Scissors"));
    assert.ok(started.text.includes("How do you want to play?"));
    const blob = JSON.stringify(started.keyboard);
    assert.ok(blob.includes("Play vs ManGoBot"));
    assert.ok(blob.includes("Play vs Player"));
    assert.ok(blob.includes("Cancel"));
    assert.ok(!blob.includes("Wait for Opponent"));
    assert.ok(!blob.includes(String(USER_A)));
    service.setMessageId(started.session.id, 5001);
    const lobby = service.chooseMode({
      sessionId: started.session.id,
      userId: USER_A,
      mode: "pvp",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(lobby.ok, true);
    assert.ok(lobby.rendered.text.includes("Waiting for an opponent"));
    assert.ok(lobby.rendered.text.includes("⏱️"));
    assert.ok(lobby.rendered.text.includes("remaining"));
    assert.ok(JSON.stringify(lobby.rendered.extra).includes("JOIN GAME"));
  });

  await runTest("B. second player joins", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    const joined = joinP2(service, lobby.session.id);
    assert.strictEqual(joined.session.players.p2.userId, String(USER_B));
    assert.ok(joined.rendered.text.includes("Kevin vs Alice"));
    assert.ok(joined.rendered.text.includes("choose your move privately"));
    assert.strictEqual(joined.privatePrompts.length, 2);
  });

  await runTest("C. outsider cannot hijack match", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    const hijack = service.join({
      sessionId: lobby.session.id,
      userId: USER_C,
      displayName: "Eve",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(hijack.ok, false);
    assert.ok(["full", "not-waiting"].includes(hijack.reason));
    const choice = await lock(service, lobby.session.id, USER_C, "rock");
    assert.strictEqual(choice.ok, false);
    assert.strictEqual(choice.reason, "outsider");
  });

  await runTest("D. same player cannot join own match", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    const self = service.join({
      sessionId: lobby.session.id,
      userId: USER_A,
      displayName: "Kevin",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(self.ok, false);
    assert.strictEqual(self.reason, "already-joined");
  });

  await runTest("E-F. private choice screens for P1 and P2", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    const v1 = service.getPrivateView(USER_A, lobby.session.id);
    const v2 = service.getPrivateView(USER_B, lobby.session.id);
    assert.strictEqual(v1.ok, true);
    assert.strictEqual(v2.ok, true);
    assert.ok(v1.text.includes("Choose your move"));
    assert.ok(v2.text.includes("Choose your move"));
    const kb = JSON.stringify(v1.extra);
    assert.ok(kb.includes("✊ Rock"));
    assert.ok(kb.includes("✋ Paper"));
    assert.ok(kb.includes("✌️ Scissors"));
    const parsed = parsePvpCallbackData(buildChoiceCallbackData(lobby.session.id, 1, "rock"));
    assert.strictEqual(parsed.move, "rock");
    assert.ok(!buildChoiceCallbackData(lobby.session.id, 1, "rock").includes(String(USER_A)));
  });

  await runTest("G. choice remains secret before both choose", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    const locked = await lock(service, lobby.session.id, USER_A, "rock");
    assert.strictEqual(locked.ok, true);
    assert.strictEqual(locked.resolved, false);
    assert.ok(locked.privateEdit.text.includes("Choice locked: ✊ Rock"));
    assert.ok(locked.privateEdit.text.includes("Waiting for your opponent"));
    assert.strictEqual(publicTextHasSecret(locked.rendered.text, locked.session), false);
    assert.ok(locked.rendered.text.includes("Kevin: ✅ Ready"));
    assert.ok(locked.rendered.text.includes("Alice: ⏳ Choosing"));
    assert.ok(!locked.rendered.text.includes("Kevin: ✊ Rock"));
  });

  await runTest("H. Rock beats Scissors", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    const result = await lock(service, lobby.session.id, USER_B, "scissors");
    assert.strictEqual(result.session.status, STATUS.WON);
    assert.strictEqual(result.session.winnerUserId, String(USER_A));
    assert.ok(result.rendered.text.includes("Kevin: ✊ Rock"));
    assert.ok(result.rendered.text.includes("Alice: ✌️ Scissors"));
    assert.ok(result.rendered.text.includes("🏆 Kevin wins!"));
  });

  await runTest("I. Scissors beats Paper", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "scissors");
    const result = await lock(service, lobby.session.id, USER_B, "paper");
    assert.strictEqual(result.session.winnerUserId, String(USER_A));
  });

  await runTest("J. Paper beats Rock", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "paper");
    const result = await lock(service, lobby.session.id, USER_B, "rock");
    assert.strictEqual(result.session.winnerUserId, String(USER_A));
  });

  await runTest("K-L. draw detected and awards no win XP", async () => {
    const { service } = createService();
    const file = pointsFile();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    const result = await lock(service, lobby.session.id, USER_B, "rock");
    assert.strictEqual(result.session.status, STATUS.DRAW);
    assert.strictEqual(result.needsXp, false);
    assert.ok(result.rendered.text.includes("🤝 Draw!"));
    const fin = await finalizeWinXp(service, lobby.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.ok(!fin.claim.shouldAward);
    assert.strictEqual(fin.claim.reason, "not-won");
    assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
  });

  await runTest("M. winner receives existing PvP XP exactly once", async () => {
    const { service } = createService({ pairCooldownMs: 0 });
    const file = pointsFile();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    const result = await lock(service, lobby.session.id, USER_B, "scissors");
    assert.strictEqual(result.needsXp, true);
    const fin1 = await finalizeWinXp(service, lobby.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin1.xpResult.awarded, true);
    assert.strictEqual(fin1.xpResult.pointsToAdd, PVP_WIN_XP);
    const fin2 = await finalizeWinXp(service, lobby.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin2.claim.shouldAward, false);
    assert.strictEqual(fin2.claim.reason, "already-awarded");
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_WIN_XP);
    assert.strictEqual(loadPoints(file).users[String(USER_B)], undefined);
  });

  await runTest("N. daily PvP cap respected", async () => {
    const { service } = createService({ pairCooldownMs: 0 });
    const file = pointsFile();
    await awardPvpWinXp(USER_A, "Kevin", file);
    await awardPvpWinXp(USER_A, "Kevin", file);
    await awardPvpWinXp(USER_A, "Kevin", file);
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "paper");
    await lock(service, lobby.session.id, USER_B, "rock");
    const fin = await finalizeWinXp(service, lobby.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin.xpResult.awarded, false);
    assert.strictEqual(fin.xpResult.reason, "daily-cap");
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_WIN_XP * PVP_DAILY_WIN_CAP);
  });

  await runTest("O. duplicate choice cannot duplicate result", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    const first = await lock(service, lobby.session.id, USER_A, "rock");
    assert.strictEqual(first.ok, true);
    const again = await lock(service, lobby.session.id, USER_A, "paper");
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, "already-chosen");
    assert.strictEqual(service.getSession(lobby.session.id).choices.p1, "rock");
  });

  await runTest("P. duplicate result callback cannot duplicate XP", async () => {
    const { service } = createService({ pairCooldownMs: 0 });
    const file = pointsFile();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    const ctx = createMockCtx({
      chatType: "private",
      chatId: USER_B,
      userId: USER_B,
      firstName: "Alice",
      callbackData: buildChoiceCallbackData(lobby.session.id, 1, "scissors"),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
      awardPvpWinXpFn: (uid, name) => awardPvpWinXp(uid, name, file),
    });
    assert.strictEqual(service.getSession(lobby.session.id).status, STATUS.WON);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_WIN_XP);
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
      awardPvpWinXpFn: (uid, name) => awardPvpWinXp(uid, name, file),
    });
    assert.ok(ctx.cbAnswers.includes("This game is over.") || ctx.cbAnswers.includes("This round already ended."));
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_WIN_XP);
  });

  await runTest("Q. stale round choice rejected", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    await lock(service, lobby.session.id, USER_B, "paper");
    service.replay({
      sessionId: lobby.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    const stale = await service.choose({
      sessionId: lobby.session.id,
      userId: USER_A,
      move: "scissors",
      round: 1,
      source: "private",
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-round");
    assert.strictEqual(service.getSession(lobby.session.id).choices.p1, null);
  });

  await runTest("R. stale Join rejected", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    const stale = service.join({
      sessionId: lobby.session.id,
      userId: USER_C,
      displayName: "Eve",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(stale.ok, false);
    const ctx = createMockCtx({
      userId: USER_C,
      firstName: "Eve",
      callbackData: buildJoinCallbackData(lobby.session.id),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
      awardPvpWinXpFn: () => ({ awarded: false, pointsToAdd: 0 }),
    });
    assert.ok(ctx.cbAnswers.some((a) => a.includes("already") || a.includes("over") || a.includes("full") || a.includes("started")));
  });

  await runTest("S. lobby timeout cleanup", async () => {
    const { service, timers, reservation } = createService({ joinTimeoutMs: 60_000 });
    const lobby = startLobby(service);
    assert.strictEqual(JOIN_TIMEOUT_MS, 60_000);
    timers.advance(60_000);
    const session = service.getSession(lobby.session.id);
    assert.strictEqual(session.status, STATUS.EXPIRED);
    assert.strictEqual(session.endReason, "join-timeout");
    const rendered = service.renderMessage(service.manager.getSession(lobby.session.id));
    assert.ok(rendered.text.includes("No opponent joined"));
    assert.ok(JSON.stringify(rendered.extra).includes("Try Again"));
    assert.strictEqual(reservation.has(USER_A), false);
  });

  await runTest("T. choice timeout cleanup — no XP", async () => {
    const { service, timers } = createService();
    const file = pointsFile();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    assert.strictEqual(CHOICE_TIMEOUT_MS, 45_000);
    timers.advance(45_000);
    const session = service.getSession(lobby.session.id);
    assert.strictEqual(session.status, STATUS.EXPIRED);
    assert.strictEqual(session.endReason, "choice-timeout");
    const rendered = service.renderMessage(service.manager.getSession(lobby.session.id));
    assert.ok(rendered.text.includes("did not choose in time"));
    const fin = await finalizeWinXp(service, lobby.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.ok(!fin.claim.shouldAward);
    assert.strictEqual(fin.claim.reason, "not-won");
    assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
  });

  await runTest("U-V. replay creates clean round; old callbacks cannot affect it", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    await lock(service, lobby.session.id, USER_B, "rock");
    const replay = service.replay({
      sessionId: lobby.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(replay.ok, true);
    assert.strictEqual(replay.session.round, 2);
    assert.strictEqual(replay.session.status, STATUS.ACTIVE);
    assert.strictEqual(replay.session.choices.p1, null);
    assert.strictEqual(replay.session.choices.p2, null);
    const oldReplay = service.replay({
      sessionId: lobby.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(oldReplay.ok, false);
    assert.strictEqual(oldReplay.reason, "stale-round");
    const oldFinish = service.finish({
      sessionId: lobby.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(oldFinish.ok, false);
    assert.strictEqual(oldFinish.reason, "stale-round");
    assert.strictEqual(service.getSession(lobby.session.id).status, STATUS.ACTIVE);
  });

  await runTest("W. cancel before join works", async () => {
    const { service, reservation } = createService();
    const started = service.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    const cancelled = service.chooseMode({
      sessionId: started.session.id,
      userId: USER_A,
      mode: "cancel",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(cancelled.ok, true);
    assert.strictEqual(cancelled.session.status, STATUS.EXPIRED);
    assert.ok(cancelled.rendered.text.includes("cancelled"));
    assert.strictEqual(reservation.has(USER_A), false);
  });

  await runTest("X. user/session reservation released on finish", async () => {
    const { service, reservation } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    assert.strictEqual(reservation.has(USER_A), true);
    assert.strictEqual(reservation.has(USER_B), true);
    await lock(service, lobby.session.id, USER_A, "rock");
    await lock(service, lobby.session.id, USER_B, "scissors");
    assert.strictEqual(reservation.has(USER_A), false);
    assert.strictEqual(reservation.has(USER_B), false);
    const replay = service.replay({
      sessionId: lobby.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(replay.ok, true);
    assert.strictEqual(reservation.has(USER_A), true);
    await lock(service, lobby.session.id, USER_A, "paper", 2);
    await lock(service, lobby.session.id, USER_B, "paper", 2);
    assert.strictEqual(reservation.has(USER_A), false);
    service.finish({
      sessionId: lobby.session.id,
      userId: USER_A,
      round: 2,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(reservation.has(USER_A), false);
    assert.strictEqual(reservation.has(USER_B), false);
  });

  await runTest("Y. resetAll cleans RPS sessions", async () => {
    const { service, manager, reservation } = createService();
    const ttt = createTicTacToeService({
      manager,
      reservation,
      botThinkMinMs: 0,
      botThinkMaxMs: 0,
    });
    const lobby = startLobby(service);
    ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_C, displayName: "Eve", isBot: false },
    });
    service.reset();
    assert.strictEqual(service.isOpen(), false);
    assert.strictEqual(service.getSession(lobby.session.id), null);
    assert.strictEqual(reservation.has(USER_A), false);
    assert.strictEqual(ttt.isOpen(), false);
  });

  await runTest("Z. menu includes RPS", async () => {
    const extra = getGroupGamesMenuExtra({ botInfo: { username: "ManGoBot" } });
    const blob = JSON.stringify(extra);
    assert.ok(blob.includes(GROUP_MENU_CALLBACK.RPS));
    assert.ok(blob.includes("✊✋✌️ RPS") || blob.includes("Rock Paper Scissors"));
    assert.strictEqual(isGameMenuCallback(GROUP_MENU_CALLBACK.RPS), true);
    assert.ok(PRIVATE_GAMES_TEXT.includes("Rock Paper Scissors"));
    assert.ok(PRIVATE_GAMES_TEXT.includes("Games topic"));
  });

  await runTest("AA. game topic gate applies", async () => {
    let started = false;
    const ctx = createMockCtx({
      callbackData: GROUP_MENU_CALLBACK.RPS,
    });
    bindGroupMenuOwnerFromCtx(ctx);
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return { ok: true, text: "x", session: { id: "z" } };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, false);
    assert.ok(
      ctx.cbAnswers.some(
        (a) => typeof a === "string" && a.includes("Games")
      ) || JSON.stringify(ctx.cbAnswers).includes("Games")
    );
  });

  await runTest("AA2. Games topic starts RPS", async () => {
    let started = false;
    const ctx = createMockCtx({
      callbackData: GROUP_MENU_CALLBACK.RPS,
      messageThreadId: Number(GAMES_TOPIC_ID),
    });
    bindGroupMenuOwnerFromCtx(ctx);
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return { ok: true, text: "RPS", session: { id: "s1" } };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, true);
  });

  await runTest("AB. private menu does not launch group PvP", async () => {
    const { service } = createService();
    const ctx = createMockCtx({
      chatType: "private",
      chatId: USER_A,
      userId: USER_A,
    });
    await handleRps(ctx, {
      startChallengeFn: () => {
        throw new Error("must not start");
      },
    });
    assert.ok(ctx.replies[0].text.includes("Games topic"));
    assert.strictEqual(ctx.replies[0].text, PRIVATE_RPS_TEXT);
    const hub = createMockCtx({
      chatType: "private",
      chatId: USER_A,
      callbackData: PRIVATE_HUB_CALLBACK.GAMES,
    });
    hub.callbackQuery = {
      data: PRIVATE_HUB_CALLBACK.GAMES,
      message: { message_id: 1, chat: { id: USER_A, type: "private" } },
    };
    await handlePrivateHubCallback(hub);
    assert.ok(hub.replies[0].text.includes("Rock Paper Scissors"));
    assert.strictEqual(service.isOpen(), false);
  });

  await runTest("AC. Daily Quest / activity integration", async () => {
    assert.ok(GAME_SOURCES.includes("rps"));
    assert.ok(PVP_MATCH_GAMES.includes("rps"));
    assert.strictEqual(ACTION_REGISTRY.rps.mode, "pvp");
    assert.strictEqual(ACTION_REGISTRY.rps.enabledForAuto, false);
    assert.strictEqual(GAME_TYPE.RPS, "rps");
    const { service, questGames, questPvp } = createService({ pairCooldownMs: 0 });
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    await lock(service, lobby.session.id, USER_B, "scissors");
    assert.deepStrictEqual(questGames, []);
    assert.strictEqual(questPvp.length, 2);
    assert.ok(questPvp.every((q) => q.payload.game === "rps"));
    assert.ok(questPvp.every((q) => q.payload.opponentType === "human"));
  });

  await runTest("AC2. draw still notes PvP game played, not bot-game quest", async () => {
    const { service, questGames, questPvp } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "paper");
    await lock(service, lobby.session.id, USER_B, "paper");
    assert.strictEqual(questGames.length, 0);
    assert.strictEqual(questPvp.length, 2);
  });

  await runTest("AD. private join DMs + /rps command + /start deep-link", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    const ctx = createMockCtx({
      userId: USER_B,
      firstName: "Alice",
      callbackData: buildJoinCallbackData(lobby.session.id),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
      awardPvpWinXpFn: () => ({ awarded: false, pointsToAdd: 0 }),
    });
    assert.strictEqual(ctx.dms.length, 2);
    assert.ok(ctx.dms.every((d) => d.text.includes("Choose your move")));
    const cmd = createMockCtx({
      userId: USER_C,
      firstName: "Eve",
      messageThreadId: Number(GAMES_TOPIC_ID),
    });
    await handleRps(cmd, {
      startChallengeFn: (p) => service.startChallenge(p),
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
      isBusyFn: () => false,
      getBusyReasonFn: () => null,
    });
    assert.ok(cmd.replies[0].text.includes("Rock Paper Scissors"));

    const startCtx = createMockCtx({
      chatType: "private",
      chatId: USER_A,
      userId: USER_A,
      startPayload: `rps_${lobby.session.id}`,
    });
    await handleStart(startCtx, { runtime: service });
    assert.ok(
      startCtx.replies.some((r) =>
        String(r.text).includes("Choose your move") || String(r.text).includes("Choice locked")
      )
    );
  });

  await runTest("stale cancel cannot destroy newer round", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    const cancel = service.chooseMode({
      sessionId: lobby.session.id,
      userId: USER_A,
      mode: "cancel",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(cancel.ok, false);
    assert.strictEqual(service.getSession(lobby.session.id).status, STATUS.ACTIVE);
  });

  await runTest("wrong chat is rejected", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    const wrong = service.join({
      sessionId: lobby.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: OTHER_CHAT,
    });
    assert.strictEqual(wrong.reason, "wrong-chat");
  });

  await runTest("callback data stays under 64 bytes and has no uid", async () => {
    const id = "aabbccddeeff";
    const choice = buildChoiceCallbackData(id, 12, "scissors");
    const replay = buildReplayCallbackData(id, 12);
    const finish = buildFinishCallbackData(id, 12);
    assert.ok(Buffer.byteLength(choice, "utf8") <= 64);
    assert.ok(Buffer.byteLength(replay, "utf8") <= 64);
    assert.ok(Buffer.byteLength(finish, "utf8") <= 64);
    assert.ok(!choice.includes("111"));
    assert.strictEqual(parsePvpCallbackData("pvp:ttt:join:aabbccddeeff"), null);
  });

  await runTest("/rps in private explains Games topic", async () => {
    const ctx = createMockCtx({ chatType: "private", chatId: USER_A, userId: USER_A });
    await handleRps(ctx);
    assert.strictEqual(ctx.replies[0].text, PRIVATE_RPS_TEXT);
  });

  await runTest("bot A-C. vs ManGoBot starts without public lobby", async () => {
    const { service } = createService();
    const started = service.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    const bot = service.chooseMode({
      sessionId: started.session.id,
      userId: USER_A,
      mode: "bot",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(bot.ok, true);
    assert.strictEqual(bot.session.opponentType, "bot");
    assert.strictEqual(bot.session.players.p2.userId, BOT_USER_ID);
    assert.strictEqual(bot.session.players.p2.displayName, BOT_DISPLAY_NAME);
    assert.ok(!JSON.stringify(bot.rendered.extra).includes("JOIN GAME"));
    assert.ok(!bot.rendered.text.includes("Waiting for an opponent"));
    assert.ok(!bot.rendered.text.includes("⏱️"));
    assert.strictEqual(bot.privatePrompts.length, 1);
    assert.strictEqual(String(bot.privatePrompts[0].userId), String(USER_A));
    assert.ok(bot.privatePrompts[0].text.includes("Choose your move"));
    assert.ok(!bot.privatePrompts[0].text.includes("⏱️"));
  });

  await runTest("bot D-H. immediate fair resolve vs ManGoBot", async () => {
    async function play(userMove, botMove) {
      const { service } = createService({ randomMoveFn: () => botMove });
      const started = startBot(service);
      const before = Date.now();
      const result = await lock(service, started.session.id, USER_A, userMove);
      const elapsed = Date.now() - before;
      assert.ok(elapsed < 50, "bot must resolve immediately");
      assert.strictEqual(result.resolved, true);
      assert.strictEqual(result.session.choices.p2, botMove);
      return result;
    }
    const rockWin = await play("rock", "scissors");
    assert.strictEqual(rockWin.session.winnerUserId, String(USER_A));
    assert.ok(rockWin.rendered.text.includes("Kevin: ✊ Rock"));
    assert.ok(rockWin.rendered.text.includes("ManGoBot: ✌️ Scissors"));
    assert.ok(rockWin.rendered.text.includes("Kevin wins"));
    const sciWin = await play("scissors", "paper");
    assert.strictEqual(sciWin.session.winnerUserId, String(USER_A));
    const paperWin = await play("paper", "rock");
    assert.strictEqual(paperWin.session.winnerUserId, String(USER_A));
    const draw = await play("rock", "rock");
    assert.strictEqual(draw.session.status, STATUS.DRAW);
    assert.ok(draw.rendered.text.includes("Draw"));
  });

  await runTest("bot I-J. RNG injected and cannot see user choice", async () => {
    const calls = [];
    const { service } = createService({
      randomMoveFn: (...args) => {
        calls.push(args);
        return "paper";
      },
    });
    const started = startBot(service);
    const result = await lock(service, started.session.id, USER_A, "rock");
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], []);
    assert.strictEqual(result.session.choices.p1, "rock");
    assert.strictEqual(result.session.choices.p2, "paper");
    assert.strictEqual(result.session.winnerUserId, BOT_USER_ID);
    const independent = pickBotMove(() => "scissors");
    assert.strictEqual(independent, "scissors");
  });

  await runTest("bot K-L. Play Again vs bot is a clean round; stale choice rejected", async () => {
    const { service } = createService({ randomMoveFn: () => "scissors" });
    const started = startBot(service);
    await lock(service, started.session.id, USER_A, "rock");
    const replay = service.replay({
      sessionId: started.session.id,
      userId: USER_A,
      round: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(replay.ok, true);
    assert.strictEqual(replay.session.round, 2);
    assert.strictEqual(replay.session.opponentType, "bot");
    assert.strictEqual(replay.session.status, STATUS.ACTIVE);
    assert.strictEqual(replay.session.choices.p1, null);
    assert.strictEqual(replay.privatePrompts.length, 1);
    const stale = await lock(service, started.session.id, USER_A, "paper", 1);
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale-round");
    const fresh = await lock(service, started.session.id, USER_A, "paper", 2);
    assert.strictEqual(fresh.ok, true);
    assert.strictEqual(fresh.session.round, 2);
  });

  await runTest("bot M-N. bot mode notes BOT_GAME_1 only, not PVP_GAME_1 or PvP XP", async () => {
    const { service, questGames, questPvp } = createService({
      randomMoveFn: () => "scissors",
    });
    const file = pointsFile();
    const started = startBot(service);
    const result = await lock(service, started.session.id, USER_A, "rock");
    assert.strictEqual(result.needsXp, false);
    assert.deepStrictEqual(questGames, [{ uid: String(USER_A), game: "rps" }]);
    assert.strictEqual(questPvp.length, 0);
    const fin = await finalizeWinXp(service, started.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin.claim.shouldAward, false);
    assert.strictEqual(fin.claim.reason, "bot-match");
    assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
  });

  await runTest("bot O. human PvP still uses existing +3 XP rules", async () => {
    assert.strictEqual(PVP_WIN_XP, 3);
    const { service } = createService({ pairCooldownMs: 0 });
    const file = pointsFile();
    const lobby = startLobby(service);
    joinP2(service, lobby.session.id);
    await lock(service, lobby.session.id, USER_A, "rock");
    await lock(service, lobby.session.id, USER_B, "scissors");
    const fin = await finalizeWinXp(service, lobby.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin.xpResult.awarded, true);
    assert.strictEqual(fin.xpResult.pointsToAdd, 3);
  });

  await runTest("bot P-Q-T. PvP lobby countdown is coarse, not 1 edit/sec", async () => {
    const { service, timers } = createService();
    const lobby = startLobby(service);
    const ticks = [];
    service.setRenderHandler((r) => {
      if (r && r.ok && r.rendered && /⏱️/.test(r.rendered.text)) {
        ticks.push(r.rendered.text);
      }
    });
    assert.ok(lobby.rendered.text.includes("⏱️ 60s remaining"));
    assert.deepStrictEqual(COUNTDOWN_MARKS_SEC.slice(), [60, 45, 30, 15, 10, 5]);
    assert.strictEqual(msUntilNextCountdownMark(JOIN_TIMEOUT_MS, 0), 15_000);
    timers.advance(1000);
    assert.strictEqual(ticks.length, 0);
    const still = service.renderMessage(service.getSession(lobby.session.id));
    assert.ok(still.text.includes("⏱️ 59s remaining"));
    for (let i = 0; i < 58; i += 1) {
      timers.advance(1000);
    }
    assert.ok(ticks.length <= 5);
    assert.ok(ticks.length >= 4);
    assert.ok(ticks.some((t) => t.includes("45s remaining")));
    assert.ok(!ticks.some((t) => t.includes("44s remaining")));
  });

  await runTest("bot R. PvP choice timeout shows remaining time", async () => {
    const { service } = createService();
    const lobby = startLobby(service);
    const joined = joinP2(service, lobby.session.id);
    assert.ok(joined.rendered.text.includes("⏱️"));
    assert.ok(joined.rendered.text.includes("remaining"));
    assert.ok(joined.privatePrompts[0].text.includes("⏱️"));
    assert.ok(joined.rendered.text.includes("Kevin: ⏳ Choosing"));
  });

  await runTest("bot S. timeout cleanup unchanged", async () => {
    const { service, timers } = createService();
    const lobby = startLobby(service);
    timers.advance(JOIN_TIMEOUT_MS);
    const expired = service.getSession(lobby.session.id);
    assert.strictEqual(expired.status, STATUS.EXPIRED);
    assert.strictEqual(expired.endReason, "join-timeout");
    const pvp = startLobby(service);
    joinP2(service, pvp.session.id);
    timers.advance(CHOICE_TIMEOUT_MS);
    const choiceExpired = service.getSession(pvp.session.id);
    assert.strictEqual(choiceExpired.status, STATUS.EXPIRED);
    assert.strictEqual(choiceExpired.endReason, "choice-timeout");
  });

  restoreEnv();
  console.log("\nAll Rock Paper Scissors tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
