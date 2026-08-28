/**
 * Tic-Tac-Toe PvP + awardPvpWinXp + coexistence.
 * Run: node tests/tic-tac-toe.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const {
  createTicTacToeService,
  parsePvpCallbackData,
  buildJoinCallbackData,
  buildMoveCallbackData,
  checkWinner,
  emptyBoard,
  STATUS,
  BOT_USER_ID,
  formatBoard,
} = require("../services/ticTacToe");
const {
  sanitizePvpDisplayName,
} = require("../services/pvpSessionManager");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const {
  awardPvpWinXp,
  PVP_WIN_XP,
  PVP_DAILY_WIN_CAP,
  getPvpRewardedWinsToday,
  loadPoints,
  savePoints,
  formatClaimedTodayLines,
  mutatePoints,
} = require("../services/points");
const { handleTicTacToe } = require("../commands/tictactoe");
const { handleChatFight } = require("../commands/chatfight");
const {
  handlePvpCallback,
  finalizeWinXp,
} = require("../events/pvp-callbacks");
const {
  createChatFightService,
} = require("../services/chatFight");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const { HELP_MESSAGE } = require("../commands/help");
const {
  ACTION_REGISTRY,
} = require("../services/communityActivityEngine");
const {
  getDailyQuestSnapshot,
  ACTIVITY_LOOT,
  GAME_SOURCES,
} = require("../services/dailyQuest");
const { getLootBalance } = require("../services/mangoLoot");
const { registerManualWallet } = require("../services/walletLinks");
const {
  assertPvpFillsGameQuest,
  expectedPvpGameLoot,
} = require("./helpers/dailyQuestAssert");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-ttt-"));
let testCounter = 0;
const COMMUNITY_CHAT = -1001234567890;
const OTHER_CHAT = -1009999999999;
const ADMIN_ID = 424242;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;

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
  fs.writeFileSync(walletFile, JSON.stringify({ users: {}, wallets: {} }, null, 2), "utf8");
  return { shopFile, walletFile, pointsFile: points };
}

function linkQuestUser(files, userId) {
  registerManualWallet(userId, walletAddress(`w-${testCounter}-${userId}`), files.walletFile);
}

function questSnap(files, userId) {
  return getDailyQuestSnapshot(userId, {
    shopFile: files.shopFile,
    walletFile: files.walletFile,
  });
}

function assertHumanGameQuest(files, userId, extra = {}) {
  const snap = questSnap(files, userId);
  const g = assertPvpFillsGameQuest(snap, extra);
  assert.strictEqual(
    getLootBalance(userId, files.shopFile),
    expectedPvpGameLoot(snap, { ...extra, linked: extra.linked !== false })
  );
  if (extra.linked === false && g.completed) {
    assert.strictEqual(g.lootSkipped, true);
  }
  return snap;
}

function playTttWinLine(service, sessionId) {
  service.move({ sessionId, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
  service.move({ sessionId, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
  service.move({ sessionId, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
  service.move({ sessionId, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
  return service.move({
    sessionId,
    userId: USER_A,
    cell: 2,
    chatId: COMMUNITY_CHAT,
  });
}

function playTttDrawLine(service, sessionId) {
  const moves = [
    [USER_A, 0],
    [USER_B, 1],
    [USER_A, 2],
    [USER_B, 5],
    [USER_A, 3],
    [USER_B, 6],
    [USER_A, 4],
    [USER_B, 8],
    [USER_A, 7],
  ];
  let last;
  for (const [uid, cell] of moves) {
    last = service.move({
      sessionId,
      userId: uid,
      cell,
      chatId: COMMUNITY_CHAT,
    });
  }
  return last;
}

function resetEnv() {
  process.env.ADMIN_USER_ID = String(ADMIN_ID);
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
    setNow(ms) {
      nowMs = ms;
    },
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

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const service = createTicTacToeService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    joinTimeoutMs: overrides.joinTimeoutMs != null ? overrides.joinTimeoutMs : 300_000,
    turnTimeoutMs: overrides.turnTimeoutMs != null ? overrides.turnTimeoutMs : 60_000,
    pairCooldownMs: overrides.pairCooldownMs != null ? overrides.pairCooldownMs : 1_800_000,
    randomIdFn: overrides.randomIdFn,
    shopFile: overrides.shopFile,
    walletFile: overrides.walletFile,
    pointsFile: overrides.pointsFile,
    noteDailyQuestGameFn: overrides.noteDailyQuestGameFn,
  });
  return { service, timers };
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Kevin",
  username,
  text = "",
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
  const ctx = {
    chat: { type: chatType, id: chatId },
    from: {
      id: userId,
      first_name: firstName,
      username,
      is_bot: isBot,
    },
    message,
    callbackQuery: callbackData
      ? {
          data: callbackData,
          from: { id: userId, is_bot: isBot },
          message: {
            message_id: 5001,
            chat: { id: chatId, type: chatType },
            ...(messageThreadId != null
              ? { message_thread_id: messageThreadId }
              : {}),
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
  return ctx;
}

function startOpen(service, chatId = COMMUNITY_CHAT) {
  const started = service.startChallenge({
    chatId,
    starter: { userId: USER_A, displayName: "Kevin", isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  return started;
}

function joinBoth(service, sessionId) {
  const j2 = service.join({
    sessionId,
    userId: USER_B,
    displayName: "Alice",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(j2.ok, true);
  assert.strictEqual(j2.started, true);
  return j2;
}

async function main() {
  resetEnv();

  await runTest("1. create session", () => {
    const { service } = createService();
    const r = service.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.session.status, STATUS.WAITING);
    assert.ok(r.session.id);
    assert.ok(r.text.includes("Tic-Tac-Toe"));
    assert.ok(r.text.includes("looking for an opponent"));
    assert.ok(r.keyboard);
  });

  await runTest("2-4. group + member start; bots/private rejected", async () => {
    const { service } = createService();
    const priv = createMockCtx({ chatType: "private", userId: ADMIN_ID });
    await handleTicTacToe(priv, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
    });
    assert.ok(priv.replies[0].includes("community group"));

    const member = createMockCtx({
      userId: USER_A,
      memberStatus: "member",
      text: "/tictactoe",
    });
    await handleTicTacToe(member, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(member.replies[0].includes("Tic-Tac-Toe"));
    assert.ok(!String(member.replies[0]).toLowerCase().includes("admin"));

    service.reset();
    const botCtx = createMockCtx({
      userId: USER_A,
      isBot: true,
      memberStatus: "member",
    });
    await handleTicTacToe(botCtx, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
    });
    assert.ok(botCtx.replies[0].includes("Bots cannot"));
  });

  await runTest("Games topic required for members when configured", async () => {
    process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
    const { service } = createService();
    const general = createMockCtx({ userId: USER_A, memberStatus: "member" });
    await handleTicTacToe(general, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
      canManageGroupFn: async () => false,
    });
    assert.ok(general.replies[0].includes("Games topic"));

    const inTopic = createMockCtx({
      userId: USER_A,
      memberStatus: "member",
      messageThreadId: "123",
    });
    await handleTicTacToe(inTopic, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(inTopic.replies[0].includes("Tic-Tac-Toe"));
    assert.strictEqual(String(inTopic.replyExtras[0].message_thread_id), "123");
  });

  await runTest("wrong configured TELEGRAM_CHAT_ID denied", async () => {
    const { service } = createService();
    const ctx = createMockCtx({
      chatId: OTHER_CHAT,
      userId: ADMIN_ID,
      memberStatus: "administrator",
    });
    await handleTicTacToe(ctx, {
      startChallengeFn: (p) => service.startChallenge(p),
      canManageGroupFn: async () => true,
      isBusyFn: () => false,
    });
    assert.ok(ctx.replies[0].includes("not available"));
  });

  await runTest("5-9. join flow: starter is X, O joins, same user, bot, third", () => {
    const { service } = createService();
    const started = startOpen(service);
    const id = started.session.id;
    assert.strictEqual(started.session.players.X.userId, String(USER_A));

    const same = service.join({
      sessionId: id,
      userId: USER_A,
      displayName: "Kevin",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(same.reason, "already-joined");

    const bot = service.join({
      sessionId: id,
      userId: 999,
      displayName: "Bot",
      chatId: COMMUNITY_CHAT,
      isBot: true,
    });
    assert.strictEqual(bot.reason, "bot");

    const j2 = service.join({
      sessionId: id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(j2.role, "O");
    assert.strictEqual(j2.started, true);
    assert.strictEqual(j2.session.status, STATUS.ACTIVE);

    const third = service.join({
      sessionId: id,
      userId: USER_C,
      displayName: "Bob",
      chatId: COMMUNITY_CHAT,
    });
    assert.ok(["full", "not-waiting"].includes(third.reason));
  });

  await runTest("10-16. board, turns, occupied, outsider", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const id = started.session.id;
    let s = service.getSession(id);
    assert.deepStrictEqual(s.board, emptyBoard());
    assert.strictEqual(s.currentPlayer, "X");

    const oEarly = service.move({
      sessionId: id,
      userId: USER_B,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(oEarly.reason, "not-your-turn");

    const m1 = service.move({
      sessionId: id,
      userId: USER_A,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(m1.ok, true);
    assert.strictEqual(m1.session.board[0], "X");
    assert.strictEqual(m1.session.currentPlayer, "O");

    const occ = service.move({
      sessionId: id,
      userId: USER_B,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(occ.reason, "occupied");

    const out = service.move({
      sessionId: id,
      userId: USER_C,
      cell: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(out.reason, "outsider");

    const m2 = service.move({
      sessionId: id,
      userId: USER_B,
      cell: 1,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(m2.ok, true);
    assert.strictEqual(m2.session.currentPlayer, "X");
  });

  await runTest("17. row win", () => {
    const { service } = createService();
    const started = startOpen(service);
    const id = started.session.id;
    joinBoth(service, id);
    // X0 O3 X1 O4 X2
    service.move({ sessionId: id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    const win = service.move({
      sessionId: id,
      userId: USER_A,
      cell: 2,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(win.session.status, STATUS.WON);
    assert.strictEqual(win.session.winnerUserId, String(USER_A));
    assert.strictEqual(checkWinner(win.session.board), "X");
  });

  await runTest("18. column win", () => {
    const { service } = createService();
    const started = startOpen(service);
    const id = started.session.id;
    joinBoth(service, id);
    service.move({ sessionId: id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 1, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_A, cell: 3, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 2, chatId: COMMUNITY_CHAT });
    const win = service.move({
      sessionId: id,
      userId: USER_A,
      cell: 6,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(win.session.status, STATUS.WON);
    assert.strictEqual(win.session.winnerSeat, "X");
  });

  await runTest("19. diagonal win", () => {
    const { service } = createService();
    const started = startOpen(service);
    const id = started.session.id;
    joinBoth(service, id);
    service.move({ sessionId: id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 1, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_A, cell: 4, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 2, chatId: COMMUNITY_CHAT });
    const win = service.move({
      sessionId: id,
      userId: USER_A,
      cell: 8,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(win.session.status, STATUS.WON);
  });

  await runTest("20-21. draw + only one winner", () => {
    const { service } = createService();
    const started = startOpen(service);
    const id = started.session.id;
    joinBoth(service, id);
    // X O X
    // X X O
    // O X O  → draw
    const moves = [
      [USER_A, 0],
      [USER_B, 1],
      [USER_A, 2],
      [USER_B, 5],
      [USER_A, 3],
      [USER_B, 6],
      [USER_A, 4],
      [USER_B, 8],
      [USER_A, 7],
    ];
    let last;
    for (const [uid, cell] of moves) {
      last = service.move({
        sessionId: id,
        userId: uid,
        cell,
        chatId: COMMUNITY_CHAT,
      });
    }
    assert.strictEqual(last.session.status, STATUS.DRAW);
    assert.strictEqual(last.session.winnerUserId, null);
    assert.strictEqual(last.needsXp, false);

    const again = service.move({
      sessionId: id,
      userId: USER_A,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(again.reason, "already-ended");
  });

  await runTest("22-26. awardPvpWinXp + daily cap + legacy + next day", () => {
    const file = pointsFile();
    const r1 = awardPvpWinXp(USER_A, "Kevin", file);
    assert.strictEqual(r1.awarded, true);
    assert.strictEqual(r1.pointsToAdd, PVP_WIN_XP);
    assert.strictEqual(r1.points, 3);

    const r2 = awardPvpWinXp(USER_A, "Kevin", file);
    assert.strictEqual(r2.awarded, true);
    assert.strictEqual(r2.points, 6);

    const r3 = awardPvpWinXp(USER_A, "Kevin", file);
    assert.strictEqual(r3.awarded, true);
    assert.strictEqual(r3.points, 9);
    assert.strictEqual(r3.rewardedWinsToday, 3);

    const r4 = awardPvpWinXp(USER_A, "Kevin", file);
    assert.strictEqual(r4.awarded, false);
    assert.strictEqual(r4.reason, "daily-cap");
    assert.strictEqual(r4.pointsToAdd, 0);
    assert.strictEqual(r4.points, 9);

    const data = loadPoints(file);
    assert.strictEqual(data.users[String(USER_A)].weeklyPoints, 9);
    assert.strictEqual(getPvpRewardedWinsToday(data.users[String(USER_A)]), 3);

    // legacy user without pvp
    savePoints(
      {
        users: {
          [String(USER_B)]: {
            points: 5,
            weeklyPoints: 1,
            weekId: data.users[String(USER_A)].weekId,
            name: "Alice",
            triggerDate: null,
            triggersUsed: [],
            activityDate: null,
          },
        },
      },
      file
    );
    const legacy = awardPvpWinXp(USER_B, "Alice", file);
    assert.strictEqual(legacy.awarded, true);
    assert.strictEqual(legacy.points, 8);

    // next UTC day reset — mutate date on USER_B after award
    mutatePoints((d) => {
      d.users[String(USER_B)].pvp.date = "2000-01-01";
      d.users[String(USER_B)].pvp.rewardedWins = 3;
    }, file);
    const next = awardPvpWinXp(USER_B, "Alice", file);
    assert.strictEqual(next.awarded, true);
    assert.strictEqual(next.rewardedWinsToday, 1);
  });

  await runTest("27. pair cooldown → play ok, no XP", () => {
    const { service } = createService({ pairCooldownMs: 60_000 });
    const file = pointsFile();
    const s1 = startOpen(service);
    joinBoth(service, s1.session.id);
    // quick win
    service.move({ sessionId: s1.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: s1.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: s1.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: s1.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    const win1 = service.move({
      sessionId: s1.session.id,
      userId: USER_A,
      cell: 2,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(win1.needsXp, true);
    const claim1 = service.claimXpAward(s1.session.id);
    assert.strictEqual(claim1.shouldAward, true);
    awardPvpWinXp(USER_A, "Kevin", file);

    const s2 = startOpen(service);
    joinBoth(service, s2.session.id);
    assert.strictEqual(service.getSession(s2.session.id).rewardEligible, false);
    service.move({ sessionId: s2.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: s2.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: s2.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: s2.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    service.move({
      sessionId: s2.session.id,
      userId: USER_A,
      cell: 2,
      chatId: COMMUNITY_CHAT,
    });
    const claim2 = service.claimXpAward(s2.session.id);
    assert.strictEqual(claim2.shouldAward, false);
    assert.strictEqual(claim2.reason, "rematch-cooldown");
    const data = loadPoints(file);
    assert.strictEqual(data.users[String(USER_A)].points, PVP_WIN_XP);
  });

  await runTest("28. timeout winner", () => {
    const { service, timers } = createService({ turnTimeoutMs: 1000 });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    timers.advance(1000);
    const s = service.getSession(started.session.id);
    assert.strictEqual(s.status, STATUS.WON);
    assert.strictEqual(s.winnerUserId, String(USER_B));
    assert.strictEqual(s.endReason, "timeout");
    const rendered = service.renderMessage(s);
    assert.ok(rendered.text.includes("ran out of time"));
    assert.ok(rendered.text.includes(formatBoard(s.board)));
    assert.deepStrictEqual(rendered.extra.reply_markup.inline_keyboard, []);
    assert.strictEqual(service.reservation.has(USER_A), false);
    assert.strictEqual(service.reservation.has(USER_B), false);
  });

  await runTest("29. join timeout", () => {
    const { service, timers } = createService({ joinTimeoutMs: 5000 });
    const started = startOpen(service);
    timers.advance(5000);
    const s = service.getSession(started.session.id);
    assert.strictEqual(s.status, STATUS.ACTIVE);
    assert.strictEqual(s.opponentType, "bot");
    assert.strictEqual(s.players.O.isBot, true);
    assert.strictEqual(service.isOpen(), true);
    const rendered = service.renderMessage(s);
    assert.ok(rendered.text.includes(formatBoard(s.board)));
    assert.ok(rendered.text.includes("⬜"));
    assert.ok(rendered.extra.reply_markup.inline_keyboard.length > 0);
  });

  await runTest("UX. active board remains visible in message text", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const moved = service.move({
      sessionId: started.session.id,
      userId: USER_A,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    const session = service.getSession(started.session.id);
    const rendered = moved.rendered;
    assert.strictEqual(session.status, STATUS.ACTIVE);
    assert.ok(rendered.text.includes(formatBoard(session.board)));
    assert.ok(rendered.text.includes("❌"));
    assert.ok(rendered.extra.reply_markup.inline_keyboard.length === 3);
    assert.strictEqual(session.board[0], "X");
  });

  await runTest("UX. win leaves final board and strips buttons", () => {
    const { service } = createService();
    const started = startOpen(service);
    const id = started.session.id;
    joinBoth(service, id);
    service.move({ sessionId: id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    const win = service.move({
      sessionId: id,
      userId: USER_A,
      cell: 2,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(win.session.status, STATUS.WON);
    assert.ok(win.rendered.text.includes("WINNER"));
    assert.ok(win.rendered.text.includes(formatBoard(win.session.board)));
    assert.ok(win.rendered.text.includes("❌"));
    assert.deepStrictEqual(win.rendered.extra.reply_markup.inline_keyboard, []);
    const claim = service.claimXpAward(id);
    assert.strictEqual(claim.shouldAward, true);
    const again = service.claimXpAward(id);
    assert.strictEqual(again.shouldAward, false);
  });

  await runTest("UX. draw leaves final board and strips buttons", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const last = playTttDrawLine(service, started.session.id);
    assert.strictEqual(last.session.status, STATUS.DRAW);
    assert.ok(last.rendered.text.includes("DRAW"));
    assert.ok(last.rendered.text.includes(formatBoard(last.session.board)));
    assert.deepStrictEqual(last.rendered.extra.reply_markup.inline_keyboard, []);
  });

  await runTest("30. timer reset after move", () => {
    const { service, timers } = createService({ turnTimeoutMs: 1000 });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    timers.advance(900);
    service.move({
      sessionId: started.session.id,
      userId: USER_A,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    timers.advance(900);
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
    timers.advance(200);
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.WON);
    assert.strictEqual(
      service.getSession(started.session.id).winnerUserId,
      String(USER_A)
    );
  });

  await runTest("31. no XP double award on callback retry", async () => {
    const { service } = createService();
    const file = pointsFile();
    const started = startOpen(service);
    const id = started.session.id;
    joinBoth(service, id);
    service.move({ sessionId: id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });

    const awardFn = (uid, name) => awardPvpWinXp(uid, name, file);
    const fin1 = await finalizeWinXp(service, id, awardFn);
    assert.strictEqual(fin1.claim.shouldAward, true);
    const fin2 = await finalizeWinXp(service, id, awardFn);
    assert.strictEqual(fin2.claim.shouldAward, false);
    const data = loadPoints(file);
    assert.strictEqual(data.users[String(USER_A)].points, PVP_WIN_XP);
  });

  await runTest("32. concurrent two moves same cell safe", () => {
    const { service } = createService();
    const started = startOpen(service);
    const id = started.session.id;
    joinBoth(service, id);
    const a = service.move({
      sessionId: id,
      userId: USER_A,
      cell: 4,
      chatId: COMMUNITY_CHAT,
    });
    const b = service.move({
      sessionId: id,
      userId: USER_A,
      cell: 4,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(a.ok, true);
    assert.ok(!b.ok);
    assert.ok(["not-your-turn", "occupied", "busy"].includes(b.reason));
  });

  await runTest("33. callback contains no uid", () => {
    const id = "abc123def456";
    const join = buildJoinCallbackData(id);
    const move = buildMoveCallbackData(id, 4);
    assert.strictEqual(join, `pvp:ttt:join:${id}`);
    assert.strictEqual(move, `pvp:ttt:move:${id}:4`);
    assert.ok(!join.includes(String(USER_A)));
    assert.ok(!move.includes(String(USER_B)));
    const parsed = parsePvpCallbackData(move);
    assert.deepStrictEqual(parsed, {
      action: "move",
      sessionId: id,
      cell: 4,
      game: "tictactoe",
    });
  });

  await runTest("34-35. invalid session + wrong chat safe", () => {
    const { service } = createService();
    const started = startOpen(service);
    const bad = service.join({
      sessionId: "deadbeef00",
      userId: USER_A,
      displayName: "K",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(bad.reason, "invalid-session");

    const wrong = service.join({
      sessionId: started.session.id,
      userId: USER_A,
      displayName: "K",
      chatId: OTHER_CHAT,
    });
    assert.strictEqual(wrong.reason, "wrong-chat");
  });

  await runTest("display name sanitize", () => {
    assert.strictEqual(
      sanitizePvpDisplayName({ first_name: "<b>Hi</b>" }),
      "bHib"
    );
    assert.strictEqual(
      sanitizePvpDisplayName({ username: "longname_".repeat(10) }).length,
      24
    );
    assert.strictEqual(sanitizePvpDisplayName({}), "Player");
  });

  await runTest("callback handler answers Not your turn", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const ctx = createMockCtx({
      userId: USER_B,
      firstName: "Alice",
      callbackData: buildMoveCallbackData(started.session.id, 0),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      awardPvpWinXpFn: () => ({ awarded: true, pointsToAdd: 3 }),
    });
    assert.ok(ctx.cbAnswers.some((a) => a.includes("Not your turn")));
  });

  await runTest("coexistence: ChatFight blocks /tictactoe", async () => {
    const { service } = createService();
    const fight = createChatFightService({
      now: () => Date.now(),
      cooldownMs: 0,
    });
    fight.startFight({
      chatId: COMMUNITY_CHAT,
      type: "type_rush",
      sendMessage: async () => true,
    });
    const ctx = createMockCtx({
      userId: ADMIN_ID,
      memberStatus: "administrator",
      text: "/tictactoe",
    });
    await handleTicTacToe(ctx, {
      startChallengeFn: (p) => service.startChallenge(p),
      canManageGroupFn: async () => true,
      isBusyFn: () =>
        isCommunityChallengeBusy({
          isChatFightOpenFn: () => fight.isFightOpen(),
          isTicTacToeOpenFn: () => service.isOpen(),
        }),
      getBusyReasonFn: () =>
        getCommunityBusyReason({
          isChatFightOpenFn: () => fight.isFightOpen(),
          isTicTacToeOpenFn: () => service.isOpen(),
        }),
    });
    assert.ok(ctx.replies[0].includes("ChatFight"));
    fight.reset();
  });

  await runTest("coexistence: Tic-Tac-Toe does not block /chatfight", async () => {
    const { service } = createService();
    startOpen(service);
    const fight = createChatFightService({
      now: () => Date.now(),
      cooldownMs: 0,
    });
    const ctx = createMockCtx({
      userId: ADMIN_ID,
      memberStatus: "administrator",
      text: "/chatfight type",
    });
    await handleChatFight(ctx, {
      startFightFn: (p) => fight.startFight(p),
      canManageGroupFn: async () => true,
      isBusyFn: () =>
        isCommunityChallengeBusy({
          isChatFightOpenFn: () => fight.isFightOpen(),
          isTicTacToeOpenFn: () => service.isOpen(),
        }),
      getBusyReasonFn: () =>
        getCommunityBusyReason({
          isChatFightOpenFn: () => fight.isFightOpen(),
          isTicTacToeOpenFn: () => service.isOpen(),
        }),
    });
    assert.ok(fight.isFightOpen());
    assert.ok(!String(ctx.replies[0] || "").includes("Tic-Tac-Toe challenge"));
    fight.reset();
  });

  await runTest("after PvP ends ChatFight may start", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    service.move({ sessionId: started.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: started.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: started.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: started.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    service.move({ sessionId: started.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });
    assert.strictEqual(service.isOpen(), false);

    const fight = createChatFightService({
      now: () => Date.now(),
      cooldownMs: 0,
    });
    const ctx = createMockCtx({
      userId: ADMIN_ID,
      memberStatus: "administrator",
      text: "/chatfight type",
    });
    await handleChatFight(ctx, {
      startFightFn: (p) => fight.startFight(p),
      canManageGroupFn: async () => true,
      isBusyFn: () =>
        isCommunityChallengeBusy({
          isChatFightOpenFn: () => fight.isFightOpen(),
          isTicTacToeOpenFn: () => service.isOpen(),
        }),
      getBusyReasonFn: () =>
        getCommunityBusyReason({
          isChatFightOpenFn: () => fight.isFightOpen(),
          isTicTacToeOpenFn: () => service.isOpen(),
        }),
    });
    assert.ok(ctx.replies[0].includes("ChatFight") || ctx.replies.length === 1);
    assert.ok(fight.isFightOpen());
    fight.reset();
  });

  await runTest("/points shows PvP wins line", () => {
    const lines = formatClaimedTodayLines({});
    assert.ok(lines.includes(`PvP wins today: 0 / ${PVP_DAILY_WIN_CAP}`));
  });

  await runTest("/help lists /tictactoe and /connect4", () => {
    assert.ok(HELP_MESSAGE.includes("/tictactoe"));
    assert.ok(HELP_MESSAGE.includes("/connect4"));
    assert.ok(HELP_MESSAGE.includes("/streak"));
    assert.ok(HELP_MESSAGE.includes("/streakrecord"));
  });

  await runTest("activity engine metadata enabledForAuto", () => {
    assert.strictEqual(ACTION_REGISTRY.tictactoe.enabledForAuto, false);
    assert.strictEqual(ACTION_REGISTRY.tictactoe.mode, "pvp");
    assert.strictEqual(ACTION_REGISTRY.connect4.enabledForAuto, false);
    assert.strictEqual(ACTION_REGISTRY.connect4.mode, "pvp");
    assert.strictEqual(ACTION_REGISTRY.trivia.enabledForAuto, true);
    assert.strictEqual(ACTION_REGISTRY.trivia.mode, "race");
  });

  await runTest("locking: concurrent awardPvpWinXp safe", () => {
    const file = pointsFile();
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(awardPvpWinXp(USER_C, "Bob", file));
    }
    const awarded = results.filter((r) => r.awarded).length;
    assert.strictEqual(awarded, PVP_DAILY_WIN_CAP);
    const data = loadPoints(file);
    assert.strictEqual(data.users[String(USER_C)].points, PVP_DAILY_WIN_CAP * PVP_WIN_XP);
  });

  await runTest("daily quest: GAME_SOURCES includes tictactoe and pvp", () => {
    assert.ok(GAME_SOURCES.includes("tictactoe"));
    assert.ok(GAME_SOURCES.includes("pvp"));
  });

  await runTest("daily quest: TTT win counts", () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const win = playTttWinLine(service, started.session.id);
    assert.strictEqual(win.session.status, STATUS.WON);
    assert.strictEqual(win.session.winnerUserId, String(USER_A));
    assertHumanGameQuest(files, USER_A);
  });

  await runTest("daily quest: TTT loss counts", () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playTttWinLine(service, started.session.id);
    assertHumanGameQuest(files, USER_B);
  });

  await runTest("daily quest: TTT draw counts", () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const last = playTttDrawLine(service, started.session.id);
    assert.strictEqual(last.session.status, STATUS.DRAW);
    assertHumanGameQuest(files, USER_A);
    assertHumanGameQuest(files, USER_B);
  });

  await runTest("daily quest: TTT lobby only does not count", () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService(files);
    const started = startOpen(service);
    assert.strictEqual(questSnap(files, USER_A).game.completed, false);
    joinBoth(service, started.session.id);
    assert.strictEqual(questSnap(files, USER_A).game.completed, false);
    assert.strictEqual(questSnap(files, USER_B).game.completed, false);
    assert.strictEqual(getLootBalance(USER_A, files.shopFile), 0);
  });

  await runTest("daily quest: TTT expired lobby without gameplay does not count", () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    const { service } = createService(files);
    const started = startOpen(service);
    const expired = service.expireJoin(started.session.id);
    assert.strictEqual(expired.session.status, STATUS.ACTIVE);
    assert.strictEqual(expired.session.opponentType, "bot");
    assert.strictEqual(questSnap(files, USER_A).game.completed, false);
    assert.strictEqual(getLootBalance(USER_A, files.shopFile), 0);
  });

  await runTest("daily quest: TTT bot win and bot loss both count", () => {
    const winFiles = questFiles();
    linkQuestUser(winFiles, USER_A);
    const { service: winService } = createService(winFiles);
    const winStart = startOpen(winService);
    winService.expireJoin(winStart.session.id);
    winService.move({
      sessionId: winStart.session.id,
      userId: USER_A,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    const humanWin = winService.resolveTurnTimeout(winStart.session.id);
    assert.strictEqual(humanWin.session.status, STATUS.WON);
    assert.strictEqual(humanWin.session.winnerUserId, String(USER_A));
    assertHumanGameQuest(winFiles, USER_A, { vsBot: true });
    assert.strictEqual(questSnap(winFiles, BOT_USER_ID).game.completed, false);

    const lossFiles = questFiles();
    linkQuestUser(lossFiles, USER_A);
    const { service: lossService } = createService(lossFiles);
    const lossStart = startOpen(lossService);
    lossService.expireJoin(lossStart.session.id);
    const botWin = lossService.resolveTurnTimeout(lossStart.session.id);
    assert.strictEqual(botWin.session.status, STATUS.WON);
    assert.strictEqual(botWin.session.winnerUserId, BOT_USER_ID);
    assertHumanGameQuest(lossFiles, USER_A, { vsBot: true });
  });

  await runTest("daily quest: TTT bot draw counts", () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    const { service } = createService(files);
    const started = startOpen(service);
    service.expireJoin(started.session.id);
    const raw = service.manager.getSession(started.session.id);
    raw.board = ["X", "O", "X", "X", "X", "O", "O", null, "O"];
    raw.currentPlayer = "X";
    const last = service.move({
      sessionId: started.session.id,
      userId: USER_A,
      cell: 7,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(last.session.status, STATUS.DRAW);
    assertHumanGameQuest(files, USER_A, { vsBot: true });
    assert.strictEqual(questSnap(files, BOT_USER_ID).game.completed, false);
  });

  await runTest("daily quest: TTT duplicate resolution does not double-award", () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService({ ...files, pairCooldownMs: 0 });
    const first = startOpen(service);
    joinBoth(service, first.session.id);
    playTttWinLine(service, first.session.id);
    assertHumanGameQuest(files, USER_A);
    assertHumanGameQuest(files, USER_B);

    const retry = service.move({
      sessionId: first.session.id,
      userId: USER_A,
      cell: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(retry.reason, "already-ended");
    service.resolveTurnTimeout(first.session.id);
    service.claimXpAward(first.session.id);
    service.claimXpAward(first.session.id);

    const second = service.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    service.setMessageId(second.session.id, 5002);
    service.join({
      sessionId: second.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    playTttWinLine(service, second.session.id);
    assertHumanGameQuest(files, USER_A);
    assertHumanGameQuest(files, USER_B);
  });

  await runTest("daily quest: TTT unlinked wallet completes slot without Loot", () => {
    const files = questFiles();
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playTttWinLine(service, started.session.id);
    assertHumanGameQuest(files, USER_A, { linked: false });
    assertHumanGameQuest(files, USER_B, { linked: false });
  });

  await runTest("daily quest: TTT XP cap does not block gameplay detection", () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    for (let i = 0; i < PVP_DAILY_WIN_CAP; i += 1) {
      const xp = awardPvpWinXp(USER_A, "Kevin", files.pointsFile);
      assert.strictEqual(xp.awarded, true);
      assert.strictEqual(xp.pointsToAdd, PVP_WIN_XP);
    }
    const capped = awardPvpWinXp(USER_A, "Kevin", files.pointsFile);
    assert.strictEqual(capped.awarded, false);
    assert.strictEqual(loadPoints(files.pointsFile).users[String(USER_A)].points, PVP_DAILY_WIN_CAP * PVP_WIN_XP);

    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playTttWinLine(service, started.session.id);
    assertHumanGameQuest(files, USER_A);
    assertHumanGameQuest(files, USER_B);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const extra = awardPvpWinXp(claim.winnerUserId, "Kevin", files.pointsFile);
    assert.strictEqual(extra.awarded, false);
    assert.strictEqual(loadPoints(files.pointsFile).users[String(USER_A)].points, PVP_DAILY_WIN_CAP * PVP_WIN_XP);
    assert.strictEqual(loadPoints(files.pointsFile).users[String(USER_B)].points, 0);
  });

  await runTest("daily quest: TTT XP amount unchanged after resolved win", () => {
    const files = questFiles();
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playTttWinLine(service, started.session.id);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const xp = awardPvpWinXp(claim.winnerUserId, "Kevin", files.pointsFile);
    assert.strictEqual(xp.awarded, true);
    assert.strictEqual(xp.pointsToAdd, PVP_WIN_XP);
    assert.strictEqual(PVP_WIN_XP, 3);
    assert.strictEqual(loadPoints(files.pointsFile).users[String(USER_A)].points, 3);
  });

  await runTest("daily quest: TTT failure does not break resolution", () => {
    const { service } = createService({
      noteDailyQuestGameFn() {
        throw new Error("quest-boom");
      },
    });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const win = playTttWinLine(service, started.session.id);
    assert.strictEqual(win.session.status, STATUS.WON);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  console.log("\nAll tic-tac-toe / PvP tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
