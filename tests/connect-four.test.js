/**
 * Connect Four PvP + shared PvP cap/cooldown with Tic-Tac-Toe.
 * Run: node tests/connect-four.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const {
  createConnectFourService,
  parsePvpCallbackData,
  buildJoinCallbackData,
  buildMoveCallbackData,
  checkConnectFourWinner,
  dropToken,
  emptyBoard,
  isBoardFull,
  STATUS,
  getConnectFourRuntime,
  BOT_USER_ID,
} = require("../services/connectFour");
const {
  createTicTacToeService,
  getTicTacToeRuntime,
} = require("../services/ticTacToe");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const { createPvpMatchReservation } = require("../services/pvpMatchReservation");
const {
  awardPvpWinXp,
  PVP_WIN_XP,
  PVP_DAILY_WIN_CAP,
  loadPoints,
} = require("../services/points");
const { handleConnectFour } = require("../commands/connect4");
const { handlePvpCallback, finalizeWinXp } = require("../events/pvp-callbacks");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const { ACTION_REGISTRY } = require("../services/communityActivityEngine");
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-c4-"));
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

function makeC4DrawBoard() {
  const drawBoard = emptyBoard();
  const cols = [
    ["R", "R", "Y", "Y", "R", "R"],
    ["Y", "Y", "R", "R", "Y", "Y"],
    ["R", "R", "Y", "Y", "R", "R"],
    ["Y", "Y", "R", "R", "Y", "Y"],
    ["R", "R", "Y", "Y", "R", "R"],
    ["Y", "Y", "R", "R", "Y", "Y"],
    ["R", "R", "Y", "Y", "R", "R"],
  ];
  for (let col = 0; col < 7; col += 1) {
    for (let i = 0; i < 6; i += 1) {
      drawBoard[5 - i][col] = cols[col][i];
    }
  }
  return drawBoard;
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
  resetEnv();
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

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const manager =
    overrides.manager ||
    createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs:
        overrides.pairCooldownMs != null ? overrides.pairCooldownMs : 1_800_000,
      randomIdFn: overrides.randomIdFn,
    });
  const service = createConnectFourService({
    manager,
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
  return { service, timers, manager };
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Kevin",
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
      return Promise.resolve({ message_id: 5001, extra });
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

function startVsBot(service) {
  const started = startOpen(service);
  const expired = service.expireJoin(started.session.id);
  assert.strictEqual(expired.session.opponentType, "bot");
  assert.strictEqual(expired.session.status, STATUS.ACTIVE);
  return started;
}

async function playColumns(service, sessionId, columns) {
  let turn = USER_A;
  let last = null;
  for (const column of columns) {
    last = await service.move({
      sessionId,
      userId: turn,
      column,
      chatId: COMMUNITY_CHAT,
    });
    turn = turn === USER_A ? USER_B : USER_A;
  }
  return last;
}

async function main() {
  resetEnv();

  await runTest("38. create", async () => {
    const { service } = createService();
    const started = startOpen(service);
    assert.strictEqual(started.session.game, "connect4");
    assert.strictEqual(started.session.status, STATUS.WAITING);
    assert.ok(started.text.includes("Connect Four"));
    assert.ok(started.text.includes("Join game") || started.keyboard);
  });

  await runTest("39. members can start; topic gate when configured", async () => {
    const { service } = createService();
    const member = createMockCtx({
      userId: USER_A,
      memberStatus: "member",
      text: "/connect4",
    });
    await handleConnectFour(member, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(member.replies[0].includes("Connect Four"));
    assert.ok(!String(member.replies[0]).toLowerCase().includes("admin"));

    service.reset();
    process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
    const blocked = createMockCtx({
      userId: USER_A,
      memberStatus: "member",
    });
    await handleConnectFour(blocked, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
      canManageGroupFn: async () => false,
    });
    assert.ok(blocked.replies[0].includes("Games topic"));

    const ok = createMockCtx({
      userId: USER_A,
      memberStatus: "member",
      messageThreadId: 123,
    });
    await handleConnectFour(ok, {
      startChallengeFn: (p) => service.startChallenge(p),
      isBusyFn: () => false,
      setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
    });
    assert.ok(ok.replies[0].includes("Connect Four"));
  });

  await runTest("40. first player is red", async () => {
    const { service } = createService();
    const started = startOpen(service);
    assert.strictEqual(started.session.players.R.userId, String(USER_A));
    assert.strictEqual(started.session.status, STATUS.WAITING);
  });

  await runTest("41. second player is yellow", async () => {
    const { service } = createService();
    const started = startOpen(service);
    const j2 = joinBoth(service, started.session.id);
    assert.strictEqual(j2.role, "Y");
    assert.strictEqual(service.getSession(started.session.id).players.Y.userId, String(USER_B));
  });

  await runTest("42. same user cannot double join", async () => {
    const { service } = createService();
    const started = startOpen(service);
    const again = service.join({
      sessionId: started.session.id,
      userId: USER_A,
      displayName: "Kevin",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(again.reason, "already-joined");
  });

  await runTest("43. outsiders denied", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const outsider = await service.move({
      sessionId: started.session.id,
      userId: USER_C,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(outsider.reason, "outsider");
  });

  await runTest("44. red starts", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.currentPlayer, "R");
    const yellowFirst = await service.move({
      sessionId: started.session.id,
      userId: USER_B,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(yellowFirst.reason, "not-your-turn");
    const red = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(red.ok, true);
  });

  await runTest("45. gravity", async () => {
    const board = emptyBoard();
    const d1 = dropToken(board, 0, "R");
    assert.strictEqual(d1.row, 5);
    const d2 = dropToken(board, 0, "Y");
    assert.strictEqual(d2.row, 4);
    assert.strictEqual(board[5][0], "R");
    assert.strictEqual(board[4][0], "Y");
  });

  await runTest("46. turn switch", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const m1 = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(m1.session.currentPlayer, "Y");
  });

  await runTest("47. full column denied", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    for (let i = 0; i < 6; i += 1) {
      const uid = i % 2 === 0 ? USER_A : USER_B;
      const r = await service.move({
        sessionId: started.session.id,
        userId: uid,
        column: 0,
        chatId: COMMUNITY_CHAT,
      });
      assert.strictEqual(r.ok, true);
    }
    const full = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(full.ok, false);
    assert.strictEqual(full.reason, "full");
  });

  await runTest("48. horizontal win", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const last = await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assert.strictEqual(last.session.status, STATUS.WON);
    assert.strictEqual(last.session.winnerSeat, "R");
    assert.strictEqual(last.needsXp, true);
  });

  await runTest("49. vertical win", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const last = await playColumns(service, started.session.id, [0, 1, 0, 1, 0, 1, 0]);
    assert.strictEqual(last.session.status, STATUS.WON);
    assert.strictEqual(last.session.winnerSeat, "R");
  });

  await runTest("50. diagonal / win", async () => {
    const board = emptyBoard();
    board[5][0] = "R";
    board[4][1] = "R";
    board[3][2] = "R";
    board[2][3] = "R";
    assert.strictEqual(checkConnectFourWinner(board), "R");
  });

  await runTest("51. diagonal \\ win", async () => {
    const board = emptyBoard();
    board[2][0] = "Y";
    board[3][1] = "Y";
    board[4][2] = "Y";
    board[5][3] = "Y";
    assert.strictEqual(checkConnectFourWinner(board), "Y");
  });

  await runTest("52. edge diagonal", async () => {
    const board = emptyBoard();
    board[5][3] = "R";
    board[4][4] = "R";
    board[3][5] = "R";
    board[2][6] = "R";
    assert.strictEqual(checkConnectFourWinner(board), "R");
    const left = emptyBoard();
    left[5][0] = "Y";
    left[4][1] = "Y";
    left[3][2] = "Y";
    left[2][3] = "Y";
    assert.strictEqual(checkConnectFourWinner(left), "Y");
  });

  await runTest("53. draw", async () => {
    const board = emptyBoard();
    const pattern = ["R", "Y", "R", "Y", "R", "Y", "R"];
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 7; col += 1) {
        const base = pattern[col];
        board[row][col] = row % 2 === 0 ? base : base === "R" ? "Y" : "R";
      }
    }
    // Avoid accidental 4: use a known no-win fill via columns of RYYRRY / YRRYYR
    const drawBoard = emptyBoard();
    const cols = [
      ["R", "R", "Y", "Y", "R", "R"],
      ["Y", "Y", "R", "R", "Y", "Y"],
      ["R", "R", "Y", "Y", "R", "R"],
      ["Y", "Y", "R", "R", "Y", "Y"],
      ["R", "R", "Y", "Y", "R", "R"],
      ["Y", "Y", "R", "R", "Y", "Y"],
      ["R", "R", "Y", "Y", "R", "R"],
    ];
    for (let col = 0; col < 7; col += 1) {
      for (let i = 0; i < 6; i += 1) {
        drawBoard[5 - i][col] = cols[col][i];
      }
    }
    assert.strictEqual(isBoardFull(drawBoard), true);
    assert.strictEqual(checkConnectFourWinner(drawBoard), null);

    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const raw = service.manager.getSession(started.session.id);
    raw.board = drawBoard.map((row) => row.slice());
    raw.board[0][6] = null;
    raw.currentPlayer = "R";
    const last = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 6,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(last.session.status, STATUS.DRAW);
    assert.strictEqual(last.needsXp, false);
    assert.ok(last.rendered.text.includes("CONNECT FOUR DRAW"));
  });

  await runTest("54. only one winner", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const extra = await service.move({
      sessionId: started.session.id,
      userId: USER_B,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(extra.reason, "already-ended");
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.winnerUserId, String(USER_A));
  });

  await runTest("55. +3 XP", async () => {
    const { service } = createService();
    const file = pointsFile();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const xp = await awardPvpWinXp(claim.winnerUserId, "Kevin", file);
    assert.strictEqual(xp.awarded, true);
    assert.strictEqual(xp.pointsToAdd, PVP_WIN_XP);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 3);
  });

  await runTest("56. shared PvP daily cap with Tic-Tac-Toe", async () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs: 0,
    });
    const ttt = createTicTacToeService({
      manager,
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs: 0,
    });
    const c4 = createConnectFourService({
      manager,
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs: 0,
    });
    const file = pointsFile();

    async function tttWin() {
      const s = ttt.startChallenge({
        chatId: COMMUNITY_CHAT,
        starter: { userId: USER_A, displayName: "K", isBot: false },
      });
      ttt.join({ sessionId: s.session.id, userId: USER_B, displayName: "A", chatId: COMMUNITY_CHAT });
      await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
      await ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
      await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
      await ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
      await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });
      const claim = ttt.claimXpAward(s.session.id);
      if (claim.shouldAward) await awardPvpWinXp(claim.winnerUserId, "Kevin", file);
    }

    await tttWin();
    await tttWin();
    const c4s = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "K", isBot: false },
    });
    c4.join({ sessionId: c4s.session.id, userId: USER_B, displayName: "Alice", chatId: COMMUNITY_CHAT });
    await playColumns(c4, c4s.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const claim = c4.claimXpAward(c4s.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const xp = await awardPvpWinXp(claim.winnerUserId, "Kevin", file);
    assert.strictEqual(xp.awarded, true);
    const cap = await awardPvpWinXp(USER_A, "Kevin", file);
    assert.strictEqual(cap.awarded, false);
    assert.strictEqual(cap.reason, "daily-cap");
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_DAILY_WIN_CAP * PVP_WIN_XP);
  });

  await runTest("57. cross-game pair cooldown", async () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs: 60_000,
    });
    const ttt = createTicTacToeService({
      manager,
      pairCooldownMs: 60_000,
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const c4 = createConnectFourService({
      manager,
      pairCooldownMs: 60_000,
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const s = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "K", isBot: false },
    });
    ttt.join({ sessionId: s.session.id, userId: USER_B, displayName: "A", chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });

    const c4s = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "K", isBot: false },
    });
    const j2 = c4.join({
      sessionId: c4s.session.id,
      userId: USER_B,
      displayName: "A",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(j2.session.rewardEligible, false);
    await playColumns(c4, c4s.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const claim = c4.claimXpAward(c4s.session.id);
    assert.strictEqual(claim.shouldAward, false);
    assert.strictEqual(claim.reason, "rematch-cooldown");

    const c4c = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "K", isBot: false },
    });
    assert.strictEqual(c4c.ok, true);
    const vsC = c4.join({
      sessionId: c4c.session.id,
      userId: USER_C,
      displayName: "Bob",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(vsC.session.rewardEligible, true);
    let turn = USER_A;
    let last = null;
    for (const column of [0, 6, 1, 5, 2, 4, 3]) {
      last = await c4.move({
        sessionId: c4c.session.id,
        userId: turn,
        column,
        chatId: COMMUNITY_CHAT,
      });
      turn = turn === USER_A ? USER_C : USER_A;
    }
    assert.strictEqual(last.session.status, STATUS.WON);
    const claimC = c4.claimXpAward(c4c.session.id);
    assert.strictEqual(claimC.shouldAward, true);
  });

  await runTest("58. join timeout", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 5000 });
    const started = startOpen(service);
    timers.advance(5000);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.ACTIVE);
    assert.strictEqual(session.opponentType, "bot");
    assert.strictEqual(session.players.Y.isBot, true);
  });

  await runTest("lobby. player 2 join starts immediately", async () => {
    const { service } = createService({ joinTimeoutMs: 5000 });
    const started = startOpen(service);
    const before = service.manager.getSession(started.session.id);
    assert.ok(before.timers.joinTimeoutId != null);
    const joined = service.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(joined.started, true);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.ACTIVE);
    assert.strictEqual(session.opponentType, "human");
    assert.ok(session.startedAt);
    const raw = service.manager.getSession(started.session.id);
    assert.strictEqual(raw.timers.joinTimeoutId, null);
    assert.strictEqual(raw.timers.countdownTimeoutId, null);
    assert.ok(raw.timers.turnTimeoutId != null);
  });

  await runTest("lobby. join timeout is cleared and stale expire is a no-op", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 5000 });
    const started = startOpen(service);
    service.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
    const expired = service.expireJoin(started.session.id);
    assert.strictEqual(expired.ok, false);
    assert.strictEqual(expired.reason, "not-waiting");
    timers.advance(5000);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.ACTIVE);
    assert.strictEqual(session.opponentType, "human");
    assert.ok(!session.players.Y.isBot);
    assert.strictEqual(session.players.Y.userId, String(USER_B));
  });

  await runTest("lobby. without player 2 existing timeout remains", async () => {
    const { service, timers } = createService({ joinTimeoutMs: 5000 });
    const started = startOpen(service);
    assert.ok(service.manager.getSession(started.session.id).timers.joinTimeoutId != null);
    timers.advance(4000);
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.WAITING);
    timers.advance(1000);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.ACTIVE);
    assert.strictEqual(session.opponentType, "bot");
  });

  await runTest("lobby. duplicate join starts the game exactly once", async () => {
    const { service } = createService();
    const started = startOpen(service);
    const first = service.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Alice",
      chatId: COMMUNITY_CHAT,
    });
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
    assert.strictEqual(first.started, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(third.ok, false);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.ACTIVE);
    assert.strictEqual(session.opponentType, "human");
    assert.strictEqual(session.players.Y.userId, String(USER_B));
    assert.strictEqual(session.players.R.userId, String(USER_A));
  });

  await runTest("59. turn timeout opponent wins", async () => {
    const { service, timers } = createService({ turnTimeoutMs: 1000 });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    timers.advance(1000);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.WON);
    assert.strictEqual(session.winnerUserId, String(USER_B));
    assert.strictEqual(session.endReason, "timeout");
  });

  await runTest("60. no double award", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const c1 = service.claimXpAward(started.session.id);
    const c2 = service.claimXpAward(started.session.id);
    assert.strictEqual(c1.shouldAward, true);
    assert.strictEqual(c2.shouldAward, false);
    assert.strictEqual(c2.reason, "already-awarded");
  });

  await runTest("61. concurrent column clicks safe", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const nested = await service.manager.withSessionLock(started.session.id, () =>
      service.move({
        sessionId: started.session.id,
        userId: USER_A,
        column: 0,
        chatId: COMMUNITY_CHAT,
      })
    );
    assert.strictEqual(nested.reason, "busy");
  });

  await runTest("62. no uid in callback", async () => {
    const id = "abc123def456";
    const join = buildJoinCallbackData(id);
    const move = buildMoveCallbackData(id, 3);
    assert.strictEqual(join, `pvp:c4:join:${id}`);
    assert.strictEqual(move, `pvp:c4:move:${id}:3`);
    assert.ok(!join.includes(String(USER_A)));
    assert.ok(!move.includes(String(USER_B)));
    assert.deepStrictEqual(parsePvpCallbackData(move), {
      action: "move",
      sessionId: id,
      column: 3,
      game: "connect4",
    });
  });

  await runTest("63. timers cleanup after win", async () => {
    const { service, timers } = createService({ turnTimeoutMs: 1000 });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assert.strictEqual(timers.pendingCount(), 0);
  });

  await runTest("64. wrong chat safe", async () => {
    const { service } = createService();
    const started = startOpen(service);
    const wrong = service.join({
      sessionId: started.session.id,
      userId: USER_A,
      displayName: "K",
      chatId: OTHER_CHAT,
    });
    assert.strictEqual(wrong.reason, "wrong-chat");
    const badStart = service.startChallenge({ chatId: OTHER_CHAT });
    assert.strictEqual(badStart.reason, "wrong-chat");
  });

  await runTest("parallel PvP: TTT and Connect Four can run together", async () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const reservation = createPvpMatchReservation();
    const ttt = createTicTacToeService({ manager, reservation, now: timers.now });
    const c4 = createConnectFourService({ manager, reservation, now: timers.now });
    assert.strictEqual(
      ttt.startChallenge({
        chatId: COMMUNITY_CHAT,
        starter: { userId: USER_A, displayName: "Kevin", isBot: false },
      }).ok,
      true
    );
    const parallel = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_C, displayName: "Bob", isBot: false },
    });
    assert.strictEqual(parallel.ok, true);
    const blocked = c4.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Kevin", isBot: false },
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, "player-busy");
  });

  await runTest("full column callback answers without group spam", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    for (let i = 0; i < 6; i += 1) {
      const uid = i % 2 === 0 ? USER_A : USER_B;
      await service.move({
        sessionId: started.session.id,
        userId: uid,
        column: 0,
        chatId: COMMUNITY_CHAT,
      });
    }
    const ctx = createMockCtx({
      userId: USER_A,
      callbackData: buildMoveCallbackData(started.session.id, 0),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.ok(ctx.cbAnswers.some((a) => a.includes("That column is full.")));
    assert.strictEqual(ctx.edited.length, 0);
  });

  await runTest("busy reason connect4 does not occupy community exclusive slot", async () => {
    assert.strictEqual(
      getCommunityBusyReason({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => true,
      }),
      null
    );
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => true,
      }),
      false
    );
  });

  await runTest("activity engine connect4 not auto", async () => {
    assert.strictEqual(ACTION_REGISTRY.connect4.enabledForAuto, false);
    assert.strictEqual(ACTION_REGISTRY.connect4.mode, "pvp");
  });

  await runTest("production TTT and Connect Four share one manager and reservation", async () => {
    assert.strictEqual(
      getTicTacToeRuntime().manager,
      getConnectFourRuntime().manager
    );
    assert.strictEqual(
      getTicTacToeRuntime().reservation,
      getConnectFourRuntime().reservation
    );
  });

  await runTest("owner TTT and Connect Four wins award XP", async () => {
    process.env.ADMIN_USER_ID = String(USER_A);
    const file = pointsFile();
    const { service } = createService({ pairCooldownMs: 0 });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const c4Claim = service.claimXpAward(started.session.id);
    assert.strictEqual(c4Claim.shouldAward, true);
    const c4Xp = await awardPvpWinXp(c4Claim.winnerUserId, "Kevin", file);
    assert.strictEqual(c4Xp.awarded, true);
    assert.strictEqual(c4Xp.pointsToAdd, PVP_WIN_XP);

    const timers = createFakeTimers();
    const ttt = createTicTacToeService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs: 0,
    });
    const s = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "K", isBot: false },
    });
    ttt.join({
      sessionId: s.session.id,
      userId: USER_B,
      displayName: "A",
      chatId: COMMUNITY_CHAT,
    });
    await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });
    const tttClaim = ttt.claimXpAward(s.session.id);
    assert.strictEqual(tttClaim.shouldAward, true);
    const tttXp = await awardPvpWinXp(tttClaim.winnerUserId, "Kevin", file);
    assert.strictEqual(tttXp.awarded, true);
    assert.strictEqual(tttXp.pointsToAdd, PVP_WIN_XP);
    assert.ok(loadPoints(file).users[String(USER_A)].points >= PVP_WIN_XP);
  });

  await runTest("daily quest: GAME_SOURCES includes connect4 and pvp", async () => {
    assert.ok(GAME_SOURCES.includes("connect4"));
    assert.ok(GAME_SOURCES.includes("pvp"));
  });

  await runTest("daily quest: C4 win counts", async () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const win = await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assert.strictEqual(win.session.status, STATUS.WON);
    assert.strictEqual(win.session.winnerUserId, String(USER_A));
    assertHumanGameQuest(files, USER_A);
  });

  await runTest("daily quest: C4 loss counts", async () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assertHumanGameQuest(files, USER_B);
  });

  await runTest("daily quest: C4 draw counts", async () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const raw = service.manager.getSession(started.session.id);
    raw.board = makeC4DrawBoard();
    raw.board[0][6] = null;
    raw.currentPlayer = "R";
    const last = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 6,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(last.session.status, STATUS.DRAW);
    assertHumanGameQuest(files, USER_A);
    assertHumanGameQuest(files, USER_B);
  });

  await runTest("daily quest: C4 lobby only does not count", async () => {
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

  await runTest("daily quest: C4 expired lobby without gameplay does not count", async () => {
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

  await runTest("daily quest: C4 bot win and bot loss both count", async () => {
    const winFiles = questFiles();
    linkQuestUser(winFiles, USER_A);
    const { service: winService } = createService(winFiles);
    const winStart = startOpen(winService);
    winService.expireJoin(winStart.session.id);
    await winService.move({
      sessionId: winStart.session.id,
      userId: USER_A,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    const humanWin = await winService.resolveTurnTimeout(winStart.session.id);
    assert.strictEqual(humanWin.session.status, STATUS.WON);
    assert.strictEqual(humanWin.session.winnerUserId, String(USER_A));
    assertHumanGameQuest(winFiles, USER_A, { vsBot: true });
    assert.strictEqual(questSnap(winFiles, BOT_USER_ID).game.completed, false);

    const lossFiles = questFiles();
    linkQuestUser(lossFiles, USER_A);
    const { service: lossService } = createService(lossFiles);
    const lossStart = startOpen(lossService);
    lossService.expireJoin(lossStart.session.id);
    const botWin = await lossService.resolveTurnTimeout(lossStart.session.id);
    assert.strictEqual(botWin.session.status, STATUS.WON);
    assert.strictEqual(botWin.session.winnerUserId, BOT_USER_ID);
    assertHumanGameQuest(lossFiles, USER_A, { vsBot: true });
  });

  await runTest("daily quest: C4 bot draw counts", async () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    const { service } = createService(files);
    const started = startOpen(service);
    service.expireJoin(started.session.id);
    const raw = service.manager.getSession(started.session.id);
    raw.board = makeC4DrawBoard();
    raw.board[0][6] = null;
    raw.currentPlayer = "R";
    const last = await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 6,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(last.session.status, STATUS.DRAW);
    assertHumanGameQuest(files, USER_A, { vsBot: true });
    assert.strictEqual(questSnap(files, BOT_USER_ID).game.completed, false);
  });

  await runTest("daily quest: C4 duplicate resolution does not double-award", async () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    const { service } = createService({ ...files, pairCooldownMs: 0 });
    const first = startOpen(service);
    joinBoth(service, first.session.id);
    await playColumns(service, first.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assertHumanGameQuest(files, USER_A);
    assertHumanGameQuest(files, USER_B);

    const retry = await service.move({
      sessionId: first.session.id,
      userId: USER_B,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(retry.reason, "already-ended");
    await service.resolveTurnTimeout(first.session.id);
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
    await playColumns(service, second.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assertHumanGameQuest(files, USER_A);
    assertHumanGameQuest(files, USER_B);
  });

  await runTest("daily quest: C4 unlinked wallet completes slot without Loot", async () => {
    const files = questFiles();
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assertHumanGameQuest(files, USER_A, { linked: false });
    assertHumanGameQuest(files, USER_B, { linked: false });
  });

  await runTest("daily quest: C4 XP cap does not block gameplay detection", async () => {
    const files = questFiles();
    linkQuestUser(files, USER_A);
    linkQuestUser(files, USER_B);
    for (let i = 0; i < PVP_DAILY_WIN_CAP; i += 1) {
      const xp = await awardPvpWinXp(USER_A, "Kevin", files.pointsFile);
      assert.strictEqual(xp.awarded, true);
      assert.strictEqual(xp.pointsToAdd, PVP_WIN_XP);
    }
    const capped = await awardPvpWinXp(USER_A, "Kevin", files.pointsFile);
    assert.strictEqual(capped.awarded, false);
    assert.strictEqual(loadPoints(files.pointsFile).users[String(USER_A)].points, PVP_DAILY_WIN_CAP * PVP_WIN_XP);

    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assertHumanGameQuest(files, USER_A);
    assertHumanGameQuest(files, USER_B);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const extra = await awardPvpWinXp(claim.winnerUserId, "Kevin", files.pointsFile);
    assert.strictEqual(extra.awarded, false);
    assert.strictEqual(loadPoints(files.pointsFile).users[String(USER_A)].points, PVP_DAILY_WIN_CAP * PVP_WIN_XP);
    assert.strictEqual(loadPoints(files.pointsFile).users[String(USER_B)].points, 0);
  });

  await runTest("daily quest: C4 XP amount unchanged after resolved win", async () => {
    const files = questFiles();
    const { service } = createService(files);
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const xp = await awardPvpWinXp(claim.winnerUserId, "Kevin", files.pointsFile);
    assert.strictEqual(xp.awarded, true);
    assert.strictEqual(xp.pointsToAdd, PVP_WIN_XP);
    assert.strictEqual(PVP_WIN_XP, 3);
    assert.strictEqual(loadPoints(files.pointsFile).users[String(USER_A)].points, 3);
  });

  await runTest("daily quest: C4 failure does not break resolution", async () => {
    const { service } = createService({
      noteDailyQuestGameFn() {
        throw new Error("quest-boom");
      },
    });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const win = await playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assert.strictEqual(win.session.status, STATUS.WON);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
  });

  await runTest("bot XP: human win vs bot awards PVP_WIN_XP once", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board[5][0] = "R";
    raw.board[4][0] = "R";
    raw.board[3][0] = "R";
    raw.currentPlayer = "R";
    const ctx = createMockCtx({
      userId: USER_A,
      callbackData: buildMoveCallbackData(started.session.id, 0),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
      awardPvpWinXpFn: (uid, name) => awardPvpWinXp(uid, name, file),
    });
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.WON);
    assert.strictEqual(service.getSession(started.session.id).winnerUserId, String(USER_A));
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_WIN_XP);
    const again = await finalizeWinXp(service, started.session.id, (uid, name) => awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(again.claim.shouldAward, false);
    assert.strictEqual(again.claim.reason, "already-awarded");
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_WIN_XP);
  });

  await runTest("bot XP: loss vs bot does not award win XP", async () => {
    const file = pointsFile();
    const { service } = createService();
    const started = startVsBot(service);
    const loss = await service.resolveTurnTimeout(started.session.id);
    assert.strictEqual(loss.session.winnerUserId, BOT_USER_ID);
    const fin = await finalizeWinXp(service, started.session.id, (uid, name) => awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin.claim.shouldAward, false);
    assert.strictEqual(fin.claim.reason, "bot-winner");
    assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
  });

  await runTest("bot XP: daily PvP cap also applies to bot wins", async () => {
    const file = pointsFile();
    for (let i = 0; i < PVP_DAILY_WIN_CAP; i += 1) {
      const xp = await awardPvpWinXp(USER_A, "Kevin", file);
      assert.strictEqual(xp.awarded, true);
    }
    const { service } = createService();
    const started = startVsBot(service);
    const raw = service.manager.getSession(started.session.id);
    raw.board[5][0] = "R";
    raw.board[4][0] = "R";
    raw.board[3][0] = "R";
    raw.currentPlayer = "R";
    await service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    const fin = await finalizeWinXp(service, started.session.id, (uid, name) => awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin.claim.shouldAward, true);
    assert.strictEqual(fin.xpResult.awarded, false);
    assert.strictEqual(fin.xpResult.reason, "daily-cap");
    assert.strictEqual(
      loadPoints(file).users[String(USER_A)].points,
      PVP_DAILY_WIN_CAP * PVP_WIN_XP
    );
  });

  await runTest("bot XP: human vs human still awards after a bot match", async () => {
    const file = pointsFile();
    const { service } = createService({ pairCooldownMs: 0 });
    const botMatch = startVsBot(service);
    await service.resolveTurnTimeout(botMatch.session.id);
    await finalizeWinXp(service, botMatch.session.id, (uid, name) => awardPvpWinXp(uid, name, file)
    );
    const pvp = startOpen(service);
    joinBoth(service, pvp.session.id);
    await playColumns(service, pvp.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const fin = await finalizeWinXp(service, pvp.session.id, (uid, name) => awardPvpWinXp(uid, name, file)
    );
    assert.strictEqual(fin.claim.shouldAward, true);
    assert.strictEqual(fin.xpResult.pointsToAdd, PVP_WIN_XP);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_WIN_XP);
    assert.strictEqual(loadPoints(file).users[String(USER_B)], undefined);
  });

  await runTest("bot XP: owner can earn XP for bot wins", async () => {
    const file = pointsFile();
    const prevAdmin = process.env.ADMIN_USER_ID;
    process.env.ADMIN_USER_ID = String(USER_A);
    try {
      const { service } = createService();
      const started = startVsBot(service);
      const raw = service.manager.getSession(started.session.id);
      raw.board[5][0] = "R";
      raw.board[4][0] = "R";
      raw.board[3][0] = "R";
      raw.currentPlayer = "R";
      await service.move({
        sessionId: started.session.id,
        userId: USER_A,
        column: 0,
        chatId: COMMUNITY_CHAT,
      });
      const fin = await finalizeWinXp(service, started.session.id, (uid, name) => awardPvpWinXp(uid, name, file)
      );
      assert.strictEqual(fin.claim.shouldAward, true);
      assert.strictEqual(fin.xpResult.awarded, true);
      const user = loadPoints(file).users[String(USER_A)];
      assert.strictEqual(user.points, PVP_WIN_XP);
    } finally {
      process.env.ADMIN_USER_ID = prevAdmin;
    }
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  console.log("\nAll connect-four tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
