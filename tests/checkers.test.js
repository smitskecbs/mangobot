/**
 * Checkers PvP sessions, lobby, XP, and wiring.
 * Run: node tests/checkers.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const {
  createCheckersService,
  parsePvpCallbackData,
  buildJoinCallbackData,
  buildSelectCallbackData,
  buildMoveCallbackData,
  formatBoard,
  STATUS,
  getCheckersRuntime,
  BOT_USER_ID,
} = require("../services/checkers");
const {
  BLACK,
  WHITE,
  emptyBoard,
  countPieces,
} = require("../services/checkersRules");
const { createTicTacToeService, getTicTacToeRuntime } = require("../services/ticTacToe");
const { createConnectFourService, getConnectFourRuntime } = require("../services/connectFour");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const { createPvpMatchReservation } = require("../services/pvpMatchReservation");
const {
  awardPvpWinXp,
  PVP_WIN_XP,
  PVP_DAILY_WIN_CAP,
  loadPoints,
} = require("../services/points");
const { handleCheckers } = require("../commands/checkers");
const { handlePvpCallback, finalizeWinXp } = require("../events/pvp-callbacks");
const {
  isCommunityChallengeBusy,
  isPvpBusy,
} = require("../services/communityGameState");
const { ACTION_REGISTRY } = require("../services/communityActivityEngine");
const {
  getDailyQuestSnapshot,
  GAME_SOURCES,
} = require("../services/dailyQuest");
const { PVP_MATCH_GAMES, noteHumanPvpMatch } = require("../services/pvpProgress");
const { GAME_TYPE } = require("../utils/gameCleanup");
const { HELP_MESSAGE } = require("../commands/help");
const { registerManualWallet } = require("../services/walletLinks");
const {
  assertPvpFillsGameQuest,
  expectedPvpGameLoot,
} = require("./helpers/dailyQuestAssert");
const { getLootBalance } = require("../services/mangoLoot");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-chk-"));
let testCounter = 0;
const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;
const USER_D = 444;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

function pointsFile() {
  testCounter += 1;
  return path.join(tempDir, `points-${testCounter}.json`);
}

function walletAddress(seed) {
  return encodeBase58(crypto.createHash("sha256").update(String(seed)).digest());
}

function questFiles() {
  testCounter += 1;
  const shopFile = path.join(tempDir, `shop-${testCounter}.json`);
  const walletFile = path.join(tempDir, `wallet-${testCounter}.json`);
  const points = path.join(tempDir, `qpoints-${testCounter}.json`);
  fs.writeFileSync(points, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(
    walletFile,
    JSON.stringify({ users: {}, wallets: {} }, null, 2),
    "utf8"
  );
  return { shopFile, walletFile, pointsFile: points };
}

function linkQuestUser(files, userId) {
  registerManualWallet(
    userId,
    walletAddress(`w-${testCounter}-${userId}`),
    files.walletFile
  );
}

function resetEnv() {
  process.env.ADMIN_USER_ID = "424242";
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
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    restoreEnv();
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
  };
}

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const service = createCheckersService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    joinTimeoutMs:
      overrides.joinTimeoutMs != null ? overrides.joinTimeoutMs : 300_000,
    turnTimeoutMs:
      overrides.turnTimeoutMs != null ? overrides.turnTimeoutMs : 60_000,
    pairCooldownMs:
      overrides.pairCooldownMs != null ? overrides.pairCooldownMs : 1_800_000,
    botThinkMinMs: overrides.botThinkMinMs != null ? overrides.botThinkMinMs : 0,
    botThinkMaxMs: overrides.botThinkMaxMs != null ? overrides.botThinkMaxMs : 0,
    randomIdFn: overrides.randomIdFn,
    shopFile: overrides.shopFile,
    walletFile: overrides.walletFile,
    pointsFile: overrides.pointsFile,
    noteDailyQuestGameFn: overrides.noteDailyQuestGameFn,
    noteHumanPvpMatchFn: overrides.noteHumanPvpMatchFn,
    manager: overrides.manager,
    reservation: overrides.reservation,
  });
  return { service, timers };
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Kevin",
  isBot = false,
  memberStatus = "member",
  callbackData,
  messageThreadId,
} = {}) {
  const replies = [];
  const replyExtras = [];
  const cbAnswers = [];
  const edited = [];
  const message = {};
  if (messageThreadId != null) {
    message.message_thread_id = messageThreadId;
  }
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName, is_bot: isBot },
    message,
    callbackQuery: callbackData
      ? {
          data: callbackData,
          from: { id: userId, is_bot: isBot },
          message: {
            message_id: 5001,
            chat: { id: chatId, type: chatType },
          },
        }
      : undefined,
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
      return Promise.resolve({ message_id: 5001 });
    },
    answerCbQuery(text) {
      cbAnswers.push(text || "");
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      edited.push({ text, extra });
      return Promise.resolve();
    },
  };
}

function startOpen(service, starterId = USER_A, name = "Kevin") {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId: starterId, displayName: name, isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  return started;
}

function joinBoth(service, sessionId, joinerId = USER_B, name = "Alice") {
  const j2 = service.join({
    sessionId,
    userId: joinerId,
    displayName: name,
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(j2.ok, true);
  assert.strictEqual(j2.started, true);
  return j2;
}

function startVsBot(service) {
  const started = startOpen(service);
  const expired = service.expireJoin(started.session.id);
  assert.strictEqual(expired.session.opponentType, "bot");
  return started;
}

function setCaptureWinBoard(service, sessionId, current = BLACK) {
  const raw = service.manager.getSession(sessionId);
  raw.board = emptyBoard();
  raw.board[20] = BLACK;
  raw.board[16] = WHITE;
  raw.currentPlayer = current;
  raw.selectedSquare = null;
  raw.pendingFrom = null;
}

async function playCaptureWin(service, sessionId, userId = USER_A) {
  setCaptureWinBoard(service, sessionId);
  return service.move({
    sessionId,
    userId,
    from: 20,
    to: 13,
    chatId: COMMUNITY_CHAT,
  });
}

async function main() {
  resetEnv();

  await runTest("lobby creation", async () => {
    const { service } = createService();
    const r = startOpen(service);
    assert.strictEqual(r.session.status, STATUS.WAITING);
    assert.strictEqual(r.session.players.b.userId, String(USER_A));
    assert.strictEqual(r.session.currentPlayer, BLACK);
    assert.strictEqual(countPieces(r.session.board, BLACK), 12);
    assert.strictEqual(countPieces(r.session.board, WHITE), 12);
    assert.ok(r.text.includes("Checkers"));
    assert.ok(r.text.includes("looking for an opponent"));
  });

  await runTest("/checkers starts in the community group", async () => {
    const { service } = createService();
    const ctx = createMockCtx({ userId: USER_A });
    await handleCheckers(ctx, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(ctx.replies[0].includes("Checkers"));
  });

  await runTest("second human join starts immediately and cancels bot timeout", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 5000 });
    const started = startOpen(service);
    assert.ok(service.manager.getSession(started.session.id).timers.joinTimeoutId != null);
    const joined = joinBoth(service, started.session.id);
    assert.strictEqual(joined.session.status, STATUS.ACTIVE);
    assert.strictEqual(joined.session.opponentType, "human");
    const raw = service.manager.getSession(started.session.id);
    assert.strictEqual(raw.timers.joinTimeoutId, null);
    assert.strictEqual(raw.timers.countdownTimeoutId, null);
    const expired = service.expireJoin(started.session.id);
    assert.strictEqual(expired.reason, "not-waiting");
    timers.advance(5000);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.ACTIVE);
    assert.strictEqual(session.opponentType, "human");
    assert.strictEqual(session.players.w.isBot, false);
  });

  await runTest("no-human join timeout starts vs bot", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 5000 });
    const started = startOpen(service);
    timers.advance(5000);
    const s = service.getSession(started.session.id);
    assert.strictEqual(s.status, STATUS.ACTIVE);
    assert.strictEqual(s.opponentType, "bot");
    assert.strictEqual(s.players.w.isBot, true);
    assert.strictEqual(s.players.w.userId, BOT_USER_ID);
  });

  await runTest("duplicate join is safe", async () => {
    const { service } = createService();
    const started = startOpen(service);
    const first = joinBoth(service, started.session.id);
    const second = service.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    const third = service.join({
      sessionId: started.session.id,
      userId: USER_C,
      displayName: "Bob",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(third.ok, false);
    assert.strictEqual(
      service.getSession(started.session.id).players.w.userId,
      String(USER_B)
    );
  });

  await runTest("unauthorized user cannot move or select", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_C,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.reason, "outsider");
    const mv = await service.move({
      sessionId: started.session.id,
      userId: USER_C,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(mv.reason, "outsider");
    const ctx = createMockCtx({
      userId: USER_C,
      firstName: "Eve",
      callbackData: buildSelectCallbackData(started.session.id, 20),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
      awardPvpWinXpFn: () => ({ awarded: false }),
    });
    assert.ok(
      ctx.cbAnswers.some((a) => a.includes("This game belongs to two other players."))
    );
  });

  await runTest("stale callback rejected", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const win = await playCaptureWin(service, started.session.id);
    assert.strictEqual(win.session.status, STATUS.WON);
    const ctx = createMockCtx({
      callbackData: buildMoveCallbackData(started.session.id, 21, 17),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
      awardPvpWinXpFn: () => ({ awarded: false }),
    });
    assert.ok(ctx.cbAnswers.some((a) => a.includes("This game is over.")));
  });

  await runTest("turn enforcement and selection", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const whiteTurn = await service.move({
      sessionId: started.session.id,
      userId: USER_B,
      from: 8,
      to: 12,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(whiteTurn.reason, "not-your-turn");
    const sel = service.select({
      sessionId: started.session.id,
      userId: USER_A,
      square: 20,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(sel.ok, true);
    assert.strictEqual(sel.session.selectedSquare, 20);
    const rendered = sel.rendered;
    const keyboard = rendered.extra.reply_markup.inline_keyboard;
    assert.strictEqual(keyboard.length, 8);
    assert.strictEqual(keyboard[0].length, 8);
    const labels = keyboard.flat().map((b) => b.text);
    assert.ok(labels.includes("🟠"));
    assert.ok(labels.includes("✨"));
    assert.ok(!labels.includes("🟥"));
    assert.ok(!labels.includes("🟦"));
    const moved = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.session.currentPlayer, WHITE);
    assert.strictEqual(moved.session.board[16], BLACK);
  });

  await runTest("active message is header plus one 8x8 keyboard", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const session = service.getSession(started.session.id);
    const rendered = service.renderMessage(session);
    const board = formatBoard(session.board);
    assert.ok(!rendered.text.includes(board));
    assert.ok(rendered.text.includes("🏁 CHECKERS"));
    assert.ok(rendered.text.includes("Select your piece."));
    assert.ok(rendered.text.includes("🟠"));
    assert.ok(rendered.text.includes("🟢"));
    assert.ok(!rendered.text.includes("🟥"));
    assert.ok(!rendered.text.includes("🟦"));
    const rows = rendered.extra.reply_markup.inline_keyboard;
    assert.strictEqual(rows.length, 8);
    assert.ok(rows.every((row) => row.length === 8));
    assert.strictEqual(rows.flat().length, 64);
  });

  await runTest("callback data has no user id", async () => {
    const id = "abc123def456";
    const join = buildJoinCallbackData(id);
    const sel = buildSelectCallbackData(id, 20);
    const mv = buildMoveCallbackData(id, 20, 16);
    assert.strictEqual(join, `pvp:chk:join:${id}`);
    assert.strictEqual(sel, `pvp:chk:sel:${id}:20`);
    assert.strictEqual(mv, `pvp:chk:mv:${id}:20:16`);
    assert.ok(!join.includes(String(USER_A)));
    assert.deepStrictEqual(parsePvpCallbackData(mv), {
      action: "mv",
      sessionId: id,
      from: 20,
      to: 16,
      game: "checkers",
    });
  });

  await runTest("parallel Checkers matches", async () => {
    const { service } = createService();
    const a = startOpen(service, USER_A, "Kevin");
    const b = startOpen(service, USER_C, "Cara");
    joinBoth(service, a.session.id, USER_B, "Alice");
    joinBoth(service, b.session.id, USER_D, "Dan");
    await service.move({
      sessionId: a.session.id,
      userId: USER_A,
      from: 20,
      to: 16,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(service.getSession(a.session.id).board[16], BLACK);
    assert.strictEqual(service.getSession(b.session.id).board[16], null);
    assert.strictEqual(service.getSession(b.session.id).status, STATUS.ACTIVE);
  });

  await runTest("Checkers parallel with TTT/C4 on shared manager", async () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const reservation = createPvpMatchReservation();
    const shared = {
      manager,
      reservation,
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      joinTimeoutMs: 60_000,
      botThinkMinMs: 0,
      botThinkMaxMs: 0,
    };
    const chk = createCheckersService(shared);
    const ttt = createTicTacToeService(shared);
    const c4 = createConnectFourService(shared);
    const checkers = chk.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    const tic = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_C, displayName: "Cara", isBot: false },
    });
    const four = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_D, displayName: "Dan", isBot: false },
    });
    assert.strictEqual(checkers.ok, true);
    assert.strictEqual(tic.ok, true);
    assert.strictEqual(four.ok, true);
    const blocked = chk.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    assert.strictEqual(blocked.reason, "player-busy");
  });

  await runTest("session cleanup releases reservation and timers", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const win = await playCaptureWin(service, started.session.id);
    assert.strictEqual(win.session.status, STATUS.WON);
    assert.strictEqual(service.reservation.has(USER_A), false);
    assert.strictEqual(service.reservation.has(USER_B), false);
    assert.strictEqual(service.isOpen(), false);
    const rendered = service.renderMessage(win.session);
    assert.deepStrictEqual(rendered.extra.reply_markup.inline_keyboard, []);
  });

  await runTest("winner XP once, loser 0, async writer path", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const win = await playCaptureWin(service, started.session.id);
    assert.strictEqual(win.needsXp, true);
    const fin1 = await finalizeWinXp(service, started.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin1.claim.shouldAward, true);
    assert.strictEqual(fin1.xpResult.pointsToAdd, PVP_WIN_XP);
    const fin2 = await finalizeWinXp(service, started.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin2.claim.shouldAward, false);
    const data = loadPoints(file);
    assert.strictEqual(data.users[String(USER_A)].points, PVP_WIN_XP);
    assert.strictEqual(data.users[String(USER_B)], undefined);
  });

  await runTest("bot win awards human +3; bot winner awards none", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startVsBot(service);
    const win = await playCaptureWin(service, started.session.id);
    assert.strictEqual(win.session.winnerUserId, String(USER_A));
    const fin = await finalizeWinXp(service, started.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin.xpResult.pointsToAdd, PVP_WIN_XP);

    const { service: botWinService } = createService();
    const vsBot = startVsBot(botWinService);
    const raw = botWinService.manager.getSession(vsBot.session.id);
    raw.board = emptyBoard();
    raw.board[8] = WHITE;
    raw.board[13] = BLACK;
    raw.currentPlayer = WHITE;
    raw.selectedSquare = null;
    raw.pendingFrom = null;
    await botWinService.performBotMove(vsBot.session.id);
    const claim = botWinService.claimXpAward(vsBot.session.id);
    assert.strictEqual(claim.shouldAward, false);
    assert.strictEqual(claim.reason, "bot-winner");
  });

  await runTest("daily cap is shared with other PvP callers", async () => {
    const file = pointsFile();
    for (let i = 0; i < PVP_DAILY_WIN_CAP; i += 1) {
      const xp = await awardPvpWinXp(USER_A, "Kevin", file);
      assert.strictEqual(xp.awarded, true);
    }
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playCaptureWin(service, started.session.id);
    const fin = await finalizeWinXp(service, started.session.id, (uid, name) =>
      awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin.claim.shouldAward, true);
    assert.strictEqual(fin.xpResult.awarded, false);
    assert.strictEqual(fin.xpResult.reason, "daily-cap");
    assert.strictEqual(
      loadPoints(file).users[String(USER_A)].points,
      PVP_DAILY_WIN_CAP * PVP_WIN_XP
    );
  });

  await runTest("pair cooldown blocks XP", async () => {
    const file = pointsFile();
    const { service } = createService({ pairCooldownMs: 60_000 });
    const s1 = startOpen(service);
    joinBoth(service, s1.session.id);
    await playCaptureWin(service, s1.session.id);
    const claim1 = service.claimXpAward(s1.session.id);
    assert.strictEqual(claim1.shouldAward, true);
    await awardPvpWinXp(USER_A, "Kevin", file);
    const s2 = startOpen(service);
    joinBoth(service, s2.session.id);
    assert.strictEqual(service.getSession(s2.session.id).rewardEligible, false);
    await playCaptureWin(service, s2.session.id);
    const claim2 = service.claimXpAward(s2.session.id);
    assert.strictEqual(claim2.reason, "rematch-cooldown");
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_WIN_XP);
  });

  await runTest("wallet gate blocks Checkers XP", async () => {
    require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);
    try {
      const file = pointsFile();
      const walletFile = path.join(tempDir, `wallet-gate-${testCounter}.json`);
      fs.writeFileSync(
        walletFile,
        JSON.stringify({ users: {}, wallets: {} }, null, 2),
        "utf8"
      );
      const { service } = createService();
      const started = startOpen(service);
      joinBoth(service, started.session.id);
      await playCaptureWin(service, started.session.id);
      const fin = await finalizeWinXp(service, started.session.id, (uid, name) =>
        awardPvpWinXp(uid, name, file, walletFile)
      );
      assert.strictEqual(fin.xpResult.awarded, false);
      assert.strictEqual(fin.xpResult.reason, "wallet-required");
      assert.ok(fin.rendered.text.includes("wallet not linked"));
    } finally {
      require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
    }
  });

  await runTest("bot respects mandatory capture on a live session", async () => {
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board = emptyBoard();
    raw.board[8] = WHITE;
    raw.board[11] = WHITE;
    raw.board[13] = BLACK;
    raw.currentPlayer = WHITE;
    raw.selectedSquare = null;
    raw.pendingFrom = null;
    const moved = await service.performBotMove(started.session.id);
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.session.board[17], WHITE);
    assert.strictEqual(moved.session.board[13], null);
    assert.strictEqual(moved.session.board[11], WHITE);
  });

  await runTest("daily quest and PvP progression wiring", async () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playCaptureWin(service, started.session.id);
    const snapA = getDailyQuestSnapshot(USER_A, files);
    const snapB = getDailyQuestSnapshot(USER_B, files);
    assertPvpFillsGameQuest(snapA);
    assertPvpFillsGameQuest(snapB);
    assert.strictEqual(
      getLootBalance(USER_A, files.shopFile),
      expectedPvpGameLoot(snapA)
    );
    assert.ok(GAME_SOURCES.includes("checkers"));
    assert.ok(PVP_MATCH_GAMES.includes("checkers"));
    const noted = await noteHumanPvpMatch(
      USER_A,
      {
        game: "checkers",
        matchId: started.session.id,
        opponentType: "human",
        shopFile: files.shopFile,
        walletFile: files.walletFile,
      },
      files.pointsFile
    );
    assert.strictEqual(noted.already, true);
  });

  await runTest("community busy and menu/help wiring", async () => {
    assert.strictEqual(ACTION_REGISTRY.checkers.enabledForAuto, false);
    assert.strictEqual(GAME_TYPE.CHECKERS, "checkers");
    assert.ok(HELP_MESSAGE.includes("/checkers"));
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTriviaOpenFn: () => false,
        isMangoBombOpenFn: () => false,
      }),
      false
    );
    assert.strictEqual(
      isPvpBusy({
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => false,
        isCheckersOpenFn: () => true,
      }),
      true
    );
    assert.strictEqual(
      getCheckersRuntime().manager,
      getTicTacToeRuntime().manager
    );
    assert.strictEqual(
      getCheckersRuntime().reservation,
      getConnectFourRuntime().reservation
    );
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  console.log("\nAll checkers session tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
