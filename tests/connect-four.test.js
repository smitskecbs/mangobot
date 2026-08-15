/**
 * Connect Four PvP + shared PvP cap/cooldown with Tic-Tac-Toe.
 * Run: node tests/connect-four.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

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
} = require("../services/connectFour");
const {
  createTicTacToeService,
  getTicTacToeRuntime,
} = require("../services/ticTacToe");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const {
  awardPvpWinXp,
  PVP_WIN_XP,
  PVP_DAILY_WIN_CAP,
  loadPoints,
} = require("../services/points");
const { handleConnectFour } = require("../commands/connect4");
const { handlePvpCallback } = require("../events/pvp-callbacks");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const { ACTION_REGISTRY } = require("../services/communityActivityEngine");

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
  const started = service.startChallenge({ chatId });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 5001);
  return started;
}

function joinBoth(service, sessionId) {
  const j1 = service.join({
    sessionId,
    userId: USER_A,
    displayName: "Kevin",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(j1.ok, true);
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

function playColumns(service, sessionId, columns) {
  let turn = USER_A;
  let last = null;
  for (const column of columns) {
    last = service.move({
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

  await runTest("38. create", () => {
    const { service } = createService();
    const started = startOpen(service);
    assert.strictEqual(started.session.game, "connect4");
    assert.strictEqual(started.session.status, STATUS.WAITING);
    assert.ok(started.text.includes("CONNECT FOUR"));
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
    assert.ok(member.replies[0].includes("CONNECT FOUR"));
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
    assert.ok(ok.replies[0].includes("CONNECT FOUR"));
  });

  await runTest("40. first player is red", () => {
    const { service } = createService();
    const started = startOpen(service);
    const j1 = service.join({
      sessionId: started.session.id,
      userId: USER_A,
      displayName: "Kevin",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(j1.role, "R");
    assert.strictEqual(j1.started, false);
  });

  await runTest("41. second player is yellow", () => {
    const { service } = createService();
    const started = startOpen(service);
    const j2 = joinBoth(service, started.session.id);
    assert.strictEqual(j2.role, "Y");
    assert.strictEqual(service.getSession(started.session.id).players.Y.userId, String(USER_B));
  });

  await runTest("42. same user cannot double join", () => {
    const { service } = createService();
    const started = startOpen(service);
    service.join({
      sessionId: started.session.id,
      userId: USER_A,
      displayName: "Kevin",
      chatId: COMMUNITY_CHAT,
    });
    const again = service.join({
      sessionId: started.session.id,
      userId: USER_A,
      displayName: "Kevin",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(again.reason, "already-joined");
  });

  await runTest("43. outsiders denied", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const outsider = service.move({
      sessionId: started.session.id,
      userId: USER_C,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(outsider.reason, "outsider");
  });

  await runTest("44. red starts", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.currentPlayer, "R");
    const yellowFirst = service.move({
      sessionId: started.session.id,
      userId: USER_B,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(yellowFirst.reason, "not-your-turn");
    const red = service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(red.ok, true);
  });

  await runTest("45. gravity", () => {
    const board = emptyBoard();
    const d1 = dropToken(board, 0, "R");
    assert.strictEqual(d1.row, 5);
    const d2 = dropToken(board, 0, "Y");
    assert.strictEqual(d2.row, 4);
    assert.strictEqual(board[5][0], "R");
    assert.strictEqual(board[4][0], "Y");
  });

  await runTest("46. turn switch", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const m1 = service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(m1.session.currentPlayer, "Y");
  });

  await runTest("47. full column denied", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    for (let i = 0; i < 6; i += 1) {
      const uid = i % 2 === 0 ? USER_A : USER_B;
      const r = service.move({
        sessionId: started.session.id,
        userId: uid,
        column: 0,
        chatId: COMMUNITY_CHAT,
      });
      assert.strictEqual(r.ok, true);
    }
    const full = service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(full.ok, false);
    assert.strictEqual(full.reason, "full");
  });

  await runTest("48. horizontal win", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const last = playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assert.strictEqual(last.session.status, STATUS.WON);
    assert.strictEqual(last.session.winnerSeat, "R");
    assert.strictEqual(last.needsXp, true);
  });

  await runTest("49. vertical win", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const last = playColumns(service, started.session.id, [0, 1, 0, 1, 0, 1, 0]);
    assert.strictEqual(last.session.status, STATUS.WON);
    assert.strictEqual(last.session.winnerSeat, "R");
  });

  await runTest("50. diagonal / win", () => {
    const board = emptyBoard();
    board[5][0] = "R";
    board[4][1] = "R";
    board[3][2] = "R";
    board[2][3] = "R";
    assert.strictEqual(checkConnectFourWinner(board), "R");
  });

  await runTest("51. diagonal \\ win", () => {
    const board = emptyBoard();
    board[2][0] = "Y";
    board[3][1] = "Y";
    board[4][2] = "Y";
    board[5][3] = "Y";
    assert.strictEqual(checkConnectFourWinner(board), "Y");
  });

  await runTest("52. edge diagonal", () => {
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

  await runTest("53. draw", () => {
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
    const last = service.move({
      sessionId: started.session.id,
      userId: USER_A,
      column: 6,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(last.session.status, STATUS.DRAW);
    assert.strictEqual(last.needsXp, false);
    assert.ok(last.rendered.text.includes("CONNECT FOUR DRAW"));
  });

  await runTest("54. only one winner", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const extra = service.move({
      sessionId: started.session.id,
      userId: USER_B,
      column: 0,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(extra.reason, "already-ended");
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.winnerUserId, String(USER_A));
  });

  await runTest("55. +3 XP", () => {
    const { service } = createService();
    const file = pointsFile();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const claim = service.claimXpAward(started.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const xp = awardPvpWinXp(claim.winnerUserId, "Kevin", file);
    assert.strictEqual(xp.awarded, true);
    assert.strictEqual(xp.pointsToAdd, PVP_WIN_XP);
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, 3);
  });

  await runTest("56. shared PvP daily cap with Tic-Tac-Toe", () => {
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

    function tttWin() {
      const s = ttt.startChallenge({ chatId: COMMUNITY_CHAT });
      ttt.join({ sessionId: s.session.id, userId: USER_A, displayName: "K", chatId: COMMUNITY_CHAT });
      ttt.join({ sessionId: s.session.id, userId: USER_B, displayName: "A", chatId: COMMUNITY_CHAT });
      ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
      ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
      ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
      ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
      ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });
      const claim = ttt.claimXpAward(s.session.id);
      if (claim.shouldAward) awardPvpWinXp(claim.winnerUserId, "Kevin", file);
    }

    tttWin();
    tttWin();
    const c4s = c4.startChallenge({ chatId: COMMUNITY_CHAT });
    c4.join({ sessionId: c4s.session.id, userId: USER_A, displayName: "K", chatId: COMMUNITY_CHAT });
    c4.join({ sessionId: c4s.session.id, userId: USER_B, displayName: "Alice", chatId: COMMUNITY_CHAT });
    playColumns(c4, c4s.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const claim = c4.claimXpAward(c4s.session.id);
    assert.strictEqual(claim.shouldAward, true);
    const xp = awardPvpWinXp(claim.winnerUserId, "Kevin", file);
    assert.strictEqual(xp.awarded, true);
    const cap = awardPvpWinXp(USER_A, "Kevin", file);
    assert.strictEqual(cap.awarded, false);
    assert.strictEqual(cap.reason, "daily-cap");
    assert.strictEqual(loadPoints(file).users[String(USER_A)].points, PVP_DAILY_WIN_CAP * PVP_WIN_XP);
  });

  await runTest("57. cross-game pair cooldown", () => {
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
    const s = ttt.startChallenge({ chatId: COMMUNITY_CHAT });
    ttt.join({ sessionId: s.session.id, userId: USER_A, displayName: "K", chatId: COMMUNITY_CHAT });
    ttt.join({ sessionId: s.session.id, userId: USER_B, displayName: "A", chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });

    const c4s = c4.startChallenge({ chatId: COMMUNITY_CHAT });
    c4.join({ sessionId: c4s.session.id, userId: USER_A, displayName: "K", chatId: COMMUNITY_CHAT });
    const j2 = c4.join({
      sessionId: c4s.session.id,
      userId: USER_B,
      displayName: "A",
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(j2.session.rewardEligible, false);
    playColumns(c4, c4s.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const claim = c4.claimXpAward(c4s.session.id);
    assert.strictEqual(claim.shouldAward, false);
    assert.strictEqual(claim.reason, "rematch-cooldown");

    const c4c = c4.startChallenge({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(c4c.ok, true);
    c4.join({
      sessionId: c4c.session.id,
      userId: USER_A,
      displayName: "K",
      chatId: COMMUNITY_CHAT,
    });
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
      last = c4.move({
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

  await runTest("58. join timeout", () => {
    const { service, timers } = createService({ joinTimeoutMs: 5000 });
    const started = startOpen(service);
    timers.advance(5000);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.EXPIRED);
    assert.strictEqual(timers.pendingCount(), 0);
  });

  await runTest("59. turn timeout opponent wins", () => {
    const { service, timers } = createService({ turnTimeoutMs: 1000 });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    timers.advance(1000);
    const session = service.getSession(started.session.id);
    assert.strictEqual(session.status, STATUS.WON);
    assert.strictEqual(session.winnerUserId, String(USER_B));
    assert.strictEqual(session.endReason, "timeout");
  });

  await runTest("60. no double award", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const c1 = service.claimXpAward(started.session.id);
    const c2 = service.claimXpAward(started.session.id);
    assert.strictEqual(c1.shouldAward, true);
    assert.strictEqual(c2.shouldAward, false);
    assert.strictEqual(c2.reason, "already-awarded");
  });

  await runTest("61. concurrent column clicks safe", () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    const nested = service.manager.withSessionLock(started.session.id, () =>
      service.move({
        sessionId: started.session.id,
        userId: USER_A,
        column: 0,
        chatId: COMMUNITY_CHAT,
      })
    );
    assert.strictEqual(nested.reason, "busy");
  });

  await runTest("62. no uid in callback", () => {
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

  await runTest("63. timers cleanup after win", () => {
    const { service, timers } = createService({ turnTimeoutMs: 1000 });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    assert.strictEqual(timers.pendingCount(), 0);
  });

  await runTest("64. wrong chat safe", () => {
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

  await runTest("one PvP per chat: TTT blocks Connect Four", () => {
    const timers = createFakeTimers();
    const manager = createPvpSessionManager({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    const ttt = createTicTacToeService({ manager, now: timers.now });
    const c4 = createConnectFourService({ manager, now: timers.now });
    assert.strictEqual(ttt.startChallenge({ chatId: COMMUNITY_CHAT }).ok, true);
    const blocked = c4.startChallenge({ chatId: COMMUNITY_CHAT });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, "already-active");
  });

  await runTest("full column callback answers without group spam", async () => {
    const { service } = createService();
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    for (let i = 0; i < 6; i += 1) {
      const uid = i % 2 === 0 ? USER_A : USER_B;
      service.move({
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

  await runTest("busy reason connect4", () => {
    assert.strictEqual(
      getCommunityBusyReason({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => true,
      }),
      "connect4"
    );
    assert.strictEqual(
      isCommunityChallengeBusy({
        isChatFightOpenFn: () => false,
        isTicTacToeOpenFn: () => false,
        isConnectFourOpenFn: () => true,
      }),
      true
    );
  });

  await runTest("activity engine connect4 not auto", () => {
    assert.strictEqual(ACTION_REGISTRY.connect4.enabledForAuto, false);
    assert.strictEqual(ACTION_REGISTRY.connect4.mode, "pvp");
  });

  await runTest("production TTT and Connect Four share one manager", () => {
    assert.strictEqual(
      getTicTacToeRuntime().manager,
      getConnectFourRuntime().manager
    );
  });

  await runTest("owner TTT and Connect Four wins award no XP", () => {
    process.env.ADMIN_USER_ID = String(USER_A);
    const file = pointsFile();
    const { service } = createService({ pairCooldownMs: 0 });
    const started = startOpen(service);
    joinBoth(service, started.session.id);
    playColumns(service, started.session.id, [0, 6, 1, 5, 2, 4, 3]);
    const c4Claim = service.claimXpAward(started.session.id);
    assert.strictEqual(c4Claim.shouldAward, true);
    const c4Xp = awardPvpWinXp(c4Claim.winnerUserId, "Kevin", file);
    assert.strictEqual(c4Xp.awarded, false);
    assert.strictEqual(c4Xp.reason, "excluded");

    const timers = createFakeTimers();
    const ttt = createTicTacToeService({
      now: timers.now,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      pairCooldownMs: 0,
    });
    const s = ttt.startChallenge({ chatId: COMMUNITY_CHAT });
    ttt.join({
      sessionId: s.session.id,
      userId: USER_A,
      displayName: "K",
      chatId: COMMUNITY_CHAT,
    });
    ttt.join({
      sessionId: s.session.id,
      userId: USER_B,
      displayName: "A",
      chatId: COMMUNITY_CHAT,
    });
    ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    ttt.move({ sessionId: s.session.id, userId: USER_A, cell: 2, chatId: COMMUNITY_CHAT });
    const tttClaim = ttt.claimXpAward(s.session.id);
    assert.strictEqual(tttClaim.shouldAward, true);
    const tttXp = awardPvpWinXp(tttClaim.winnerUserId, "Kevin", file);
    assert.strictEqual(tttXp.awarded, false);
    assert.strictEqual(tttXp.reason, "excluded");
    assert.strictEqual(loadPoints(file).users[String(USER_A)], undefined);
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
