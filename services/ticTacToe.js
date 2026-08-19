/**
 * Tic-Tac-Toe PvP — in-memory sessions via generic PvP manager.
 * Not auto-started by Activity Engine in v1 (enabledForAuto: false).
 */

const { Markup } = require("telegraf");
const { logError } = require("../utils/logger");
const {
  createPvpSessionManager,
  getSharedPvpSessionManager,
  sanitizePvpDisplayName,
  DEFAULT_PAIR_COOLDOWN_MS,
} = require("./pvpSessionManager");
const { isAllowedChatFightChat } = require("./chatFight");

const GAME_ID = "tictactoe";

const JOIN_TIMEOUT_MS = 5 * 60 * 1000;
const TURN_TIMEOUT_MS = 60 * 1000;
const PAIR_COOLDOWN_MS = DEFAULT_PAIR_COOLDOWN_MS;

const STATUS = Object.freeze({
  WAITING: "waiting",
  ACTIVE: "active",
  WON: "won",
  DRAW: "draw",
  EXPIRED: "expired",
});

const WIN_LINES = Object.freeze([
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]);

const EMPTY_CELL = "⬜";
const MARK_X = "❌";
const MARK_O = "⭕";

function emptyBoard() {
  return [null, null, null, null, null, null, null, null, null];
}

function checkWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) {
      return v;
    }
  }
  return null;
}

function isBoardFull(board) {
  return board.every((cell) => cell === "X" || cell === "O");
}

function cellLabel(value) {
  if (value === "X") return MARK_X;
  if (value === "O") return MARK_O;
  return EMPTY_CELL;
}

function buildJoinCallbackData(sessionId) {
  return `pvp:ttt:join:${sessionId}`;
}

function buildMoveCallbackData(sessionId, cell) {
  return `pvp:ttt:move:${sessionId}:${cell}`;
}

function parsePvpCallbackData(data) {
  if (typeof data !== "string" || !data.startsWith("pvp:ttt:")) {
    return null;
  }
  const parts = data.split(":");
  // pvp : ttt : join|move : sessionId [ : cell ]
  if (parts.length < 4 || parts[0] !== "pvp" || parts[1] !== "ttt") {
    return null;
  }
  const action = parts[2];
  const sessionId = parts[3];
  if (!sessionId || !/^[a-f0-9]+$/i.test(sessionId)) {
    return null;
  }
  if (action === "join") {
    if (parts.length !== 4) return null;
    return { action: "join", sessionId, game: GAME_ID };
  }
  if (action === "move") {
    if (parts.length !== 5) return null;
    const cell = Number(parts[4]);
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) return null;
    return { action: "move", sessionId, cell, game: GAME_ID };
  }
  return null;
}

function buildJoinKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    Markup.button.callback("Join game", buildJoinCallbackData(sessionId)),
  ]);
}

function buildBoardKeyboard(session, clickable) {
  const rows = [];
  for (let r = 0; r < 3; r += 1) {
    const row = [];
    for (let c = 0; c < 3; c += 1) {
      const i = r * 3 + c;
      const label = cellLabel(session.board[i]);
      if (clickable && session.board[i] == null) {
        row.push(
          Markup.button.callback(label, buildMoveCallbackData(session.id, i))
        );
      } else {
        // Non-clickable look: still a button but dead session handlers reject.
        row.push(
          Markup.button.callback(label, buildMoveCallbackData(session.id, i))
        );
      }
    }
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

function buildWaitingText(session) {
  const x = session.players.X;
  if (!x) {
    return `🎮 TIC-TAC-TOE

A new PvP challenge is open.

First two players can join.`;
  }
  return `🎮 TIC-TAC-TOE

${MARK_X} ${x.displayName} joined.

Waiting for an opponent...`;
}

function buildActiveText(session) {
  const x = session.players.X;
  const o = session.players.O;
  const turnMark = session.currentPlayer === "X" ? MARK_X : MARK_O;
  const turnName =
    session.currentPlayer === "X" ? x.displayName : o.displayName;
  return `🎮 TIC-TAC-TOE

${MARK_X} ${x.displayName}
${MARK_O} ${o.displayName}

Turn: ${turnMark} ${turnName}

Klik hieronder om je move te doen.`;
}

function formatXpLine(xpResult, rewardEligible) {
  if (!rewardEligible) {
    return "PvP XP: rematch cooldown — no XP";
  }
  if (xpResult && xpResult.awarded) {
    return `PvP XP: +${xpResult.pointsToAdd}`;
  }
  if (xpResult && xpResult.reason === "daily-cap") {
    return "PvP XP: daily cap reached";
  }
  if (xpResult && xpResult.reason === "wallet-required") {
    return "PvP XP: 🔒 0 XP — wallet not linked — /wallet";
  }
  return "PvP XP: none";
}

function buildWonText(session, xpResult) {
  const winnerSeat = session.winnerSeat;
  const loserSeat = winnerSeat === "X" ? "O" : "X";
  const winner = session.players[winnerSeat];
  const loser = session.players[loserSeat];
  const wMark = winnerSeat === "X" ? MARK_X : MARK_O;
  const lMark = loserSeat === "X" ? MARK_X : MARK_O;
  const byTimeout = session.endReason === "timeout";
  const xpLine = formatXpLine(xpResult, session.rewardEligible);

  if (byTimeout) {
    return `⏱ TIC-TAC-TOE

${loser.displayName} ran out of time.

🏆 ${winner.displayName} wins!

${xpLine} 🥭`;
  }

  return `🏆 TIC-TAC-TOE WINNER

${wMark} ${winner.displayName} defeated ${lMark} ${loser.displayName}!

${
    xpResult && xpResult.awarded
      ? `+${xpResult.pointsToAdd} PvP XP 🥭`
      : `${xpLine} 🥭`
  }`;
}

function buildDrawText(session) {
  const x = session.players.X;
  const o = session.players.O;
  return `🤝 TIC-TAC-TOE DRAW

${x.displayName} ${MARK_X} vs ${o.displayName} ${MARK_O}

Good game! 🥭`;
}

function buildExpiredText() {
  return `⏱ TIC-TAC-TOE EXPIRED

No opponent joined in time.`;
}

function renderMessage(session, xpResult) {
  const { emptyInlineKeyboardExtra } = require("../utils/expiredMessageCleanup");
  if (session.status === STATUS.WAITING) {
    return {
      text: buildWaitingText(session),
      extra: buildJoinKeyboard(session.id),
    };
  }
  if (session.status === STATUS.ACTIVE) {
    return {
      text: buildActiveText(session),
      extra: buildBoardKeyboard(session, true),
    };
  }
  if (session.status === STATUS.WON) {
    return {
      text: buildWonText(session, xpResult),
      extra: emptyInlineKeyboardExtra(),
    };
  }
  if (session.status === STATUS.DRAW) {
    return {
      text: buildDrawText(session),
      extra: emptyInlineKeyboardExtra(),
    };
  }
  if (session.status === STATUS.EXPIRED) {
    return { text: buildExpiredText(), extra: emptyInlineKeyboardExtra() };
  }
  return { text: "🎮 TIC-TAC-TOE", extra: emptyInlineKeyboardExtra() };
}

function createTicTacToeService(options = {}) {
  const joinTimeoutMs =
    typeof options.joinTimeoutMs === "number"
      ? options.joinTimeoutMs
      : JOIN_TIMEOUT_MS;
  const turnTimeoutMs =
    typeof options.turnTimeoutMs === "number"
      ? options.turnTimeoutMs
      : TURN_TIMEOUT_MS;
  const pairCooldownMs =
    typeof options.pairCooldownMs === "number"
      ? options.pairCooldownMs
      : PAIR_COOLDOWN_MS;

  const manager =
    options.manager ||
    createPvpSessionManager({
      now: options.now,
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn,
      pairCooldownMs,
      randomIdFn: options.randomIdFn,
    });

  const onSessionEnded =
    typeof options.onSessionEnded === "function"
      ? options.onSessionEnded
      : null;

  function snapshot(session) {
    if (!session) return null;
    return JSON.parse(
      JSON.stringify({
        id: session.id,
        game: session.game,
        chatId: session.chatId,
        messageId: session.messageId,
        status: session.status,
        players: session.players,
        currentPlayer: session.currentPlayer,
        board: session.board,
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        lastMoveAt: session.lastMoveAt,
        winnerUserId: session.winnerUserId,
        winnerSeat: session.winnerSeat,
        rewardEligible: session.rewardEligible,
        xpAwarded: session.xpAwarded,
        endReason: session.endReason || null,
      })
    );
  }

  function isOpen() {
    return manager.hasAnyOpenGame(GAME_ID);
  }

  function getActiveForChat(chatId) {
    return manager.getActiveSession(chatId, GAME_ID);
  }

  function startChallenge({ chatId } = {}) {
    if (chatId == null || !isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }
    if (manager.isChatBusy(chatId) || manager.isGameOpen(chatId, GAME_ID)) {
      return { ok: false, reason: "already-active" };
    }

    const id = manager.generateSessionId();
    const session = {
      id,
      game: GAME_ID,
      chatId: String(chatId),
      messageId: null,
      status: STATUS.WAITING,
      players: { X: null, O: null },
      currentPlayer: "X",
      board: emptyBoard(),
      createdAt: manager.now(),
      startedAt: null,
      lastMoveAt: null,
      winnerUserId: null,
      winnerSeat: null,
      rewardEligible: true,
      xpAwarded: false,
      endReason: null,
      timers: { joinTimeoutId: null, turnTimeoutId: null },
    };

    manager.registerSession(session);
    manager.schedule(session, "join", joinTimeoutMs, () => {
      expireJoin(session.id);
    });

    const rendered = renderMessage(session);
    return {
      ok: true,
      session: snapshot(session),
      text: rendered.text,
      keyboard: rendered.extra,
    };
  }

  function setMessageId(sessionId, messageId) {
    const session = manager.getSession(sessionId);
    if (!session) return false;
    session.messageId = messageId;
    return true;
  }

  function expireJoin(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.WAITING) {
        return { ok: false, reason: "not-waiting" };
      }
      session.status = STATUS.EXPIRED;
      session.endReason = "join-timeout";
      manager.clearTimers(session);
      manager.clearActiveIndex(session);
      return { ok: true, session: snapshot(session), rendered: renderMessage(session) };
    });
    if (locked.ok && onSessionEnded) {
      try {
        onSessionEnded(locked.session);
      } catch (_err) {
        /* ignore */
      }
    }
    return locked;
  }

  function seatForUser(session, userId) {
    const id = String(userId);
    if (session.players.X && String(session.players.X.userId) === id) {
      return "X";
    }
    if (session.players.O && String(session.players.O.userId) === id) {
      return "O";
    }
    return null;
  }

  function startTurnTimer(session) {
    manager.schedule(session, "turn", turnTimeoutMs, () => {
      resolveTurnTimeout(session.id);
    });
  }

  function resolveTurnTimeout(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.ACTIVE) {
        return { ok: false, reason: "not-active" };
      }
      if (session.winnerUserId != null) {
        return { ok: false, reason: "already-ended" };
      }
      const loserSeat = session.currentPlayer;
      const winnerSeat = loserSeat === "X" ? "O" : "X";
      const winner = session.players[winnerSeat];
      session.status = STATUS.WON;
      session.winnerSeat = winnerSeat;
      session.winnerUserId = String(winner.userId);
      session.endReason = "timeout";
      manager.clearTimers(session);
      manager.clearActiveIndex(session);
      manager.markPairCooldown(
        session.players.X.userId,
        session.players.O.userId,
        GAME_ID
      );
      return {
        ok: true,
        needsXp: true,
        session: snapshot(session),
        rendered: renderMessage(session),
      };
    });
    if (locked.ok && onSessionEnded) {
      try {
        onSessionEnded(locked.session);
      } catch (_err) {
        /* ignore */
      }
    }
    return locked;
  }

  function join({ sessionId, userId, displayName, chatId, isBot } = {}) {
    return manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) {
        return { ok: false, reason: "invalid-session" };
      }
      if (chatId != null && String(chatId) !== String(session.chatId)) {
        return { ok: false, reason: "wrong-chat" };
      }
      if (session.status !== STATUS.WAITING) {
        return { ok: false, reason: "not-waiting" };
      }
      if (isBot) {
        return { ok: false, reason: "bot" };
      }
      if (userId == null) {
        return { ok: false, reason: "no-user" };
      }

      const uid = String(userId);
      const name = sanitizePvpDisplayName(displayName);

      if (!session.players.X) {
        session.players.X = { userId: uid, displayName: name };
        return {
          ok: true,
          role: "X",
          started: false,
          session: snapshot(session),
          rendered: renderMessage(session),
        };
      }

      if (String(session.players.X.userId) === uid) {
        return { ok: false, reason: "already-joined" };
      }

      if (session.players.O) {
        return { ok: false, reason: "full" };
      }

      session.players.O = { userId: uid, displayName: name };
      const onCooldown = manager.isPairOnCooldown(
        session.players.X.userId,
        session.players.O.userId,
        GAME_ID
      );
      session.rewardEligible = !onCooldown;
      session.status = STATUS.ACTIVE;
      session.startedAt = manager.now();
      session.lastMoveAt = session.startedAt;
      session.currentPlayer = "X";
      manager.clearTimers(session);
      // clear join timer only — start turn timer
      session.timers.joinTimeoutId = null;
      startTurnTimer(session);

      return {
        ok: true,
        role: "O",
        started: true,
        session: snapshot(session),
        rendered: renderMessage(session),
      };
    });
  }

  function move({ sessionId, userId, cell, chatId } = {}) {
    return manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) {
        return { ok: false, reason: "invalid-session" };
      }
      if (chatId != null && String(chatId) !== String(session.chatId)) {
        return { ok: false, reason: "wrong-chat" };
      }
      if (session.status === STATUS.WON || session.status === STATUS.DRAW) {
        return { ok: false, reason: "already-ended" };
      }
      if (session.status !== STATUS.ACTIVE) {
        return { ok: false, reason: "not-active" };
      }
      if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
        return { ok: false, reason: "bad-cell" };
      }

      const seat = seatForUser(session, userId);
      if (!seat) {
        return { ok: false, reason: "outsider" };
      }
      if (seat !== session.currentPlayer) {
        return { ok: false, reason: "not-your-turn" };
      }
      if (session.board[cell] != null) {
        return { ok: false, reason: "occupied" };
      }

      session.board[cell] = seat;
      session.lastMoveAt = manager.now();

      const winMark = checkWinner(session.board);
      if (winMark) {
        session.status = STATUS.WON;
        session.winnerSeat = winMark;
        session.winnerUserId = String(session.players[winMark].userId);
        session.endReason = "win";
        manager.clearTimers(session);
        manager.clearActiveIndex(session);
        manager.markPairCooldown(
          session.players.X.userId,
          session.players.O.userId,
          GAME_ID
        );
        return {
          ok: true,
          ended: true,
          needsXp: true,
          session: snapshot(session),
          rendered: renderMessage(session),
        };
      }

      if (isBoardFull(session.board)) {
        session.status = STATUS.DRAW;
        session.endReason = "draw";
        manager.clearTimers(session);
        manager.clearActiveIndex(session);
        manager.markPairCooldown(
          session.players.X.userId,
          session.players.O.userId,
          GAME_ID
        );
        return {
          ok: true,
          ended: true,
          needsXp: false,
          session: snapshot(session),
          rendered: renderMessage(session),
        };
      }

      session.currentPlayer = seat === "X" ? "O" : "X";
      startTurnTimer(session);
      return {
        ok: true,
        ended: false,
        session: snapshot(session),
        rendered: renderMessage(session),
      };
    });
  }

  /**
   * Claim XP award once (sync). Returns whether caller should award XP.
   */
  function claimXpAward(sessionId) {
    return manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) {
        return { ok: false, reason: "invalid-session" };
      }
      if (session.status !== STATUS.WON) {
        return { ok: false, reason: "not-won" };
      }
      if (!session.rewardEligible) {
        return {
          ok: true,
          shouldAward: false,
          reason: "rematch-cooldown",
          session: snapshot(session),
        };
      }
      if (session.xpAwarded) {
        return {
          ok: true,
          shouldAward: false,
          reason: "already-awarded",
          session: snapshot(session),
        };
      }
      session.xpAwarded = true;
      return {
        ok: true,
        shouldAward: true,
        winnerUserId: session.winnerUserId,
        winnerName:
          session.players[session.winnerSeat] &&
          session.players[session.winnerSeat].displayName,
        session: snapshot(session),
      };
    });
  }

  function applyXpResultToRender(sessionId, xpResult) {
    const session = manager.getSession(sessionId);
    if (!session) {
      return null;
    }
    return renderMessage(session, xpResult);
  }

  function getSession(sessionId) {
    return snapshot(manager.getSession(sessionId));
  }

  function reset() {
    manager.resetAll();
  }

  return {
    GAME_ID,
    STATUS,
    startChallenge,
    setMessageId,
    join,
    move,
    expireJoin,
    resolveTurnTimeout,
    claimXpAward,
    applyXpResultToRender,
    getSession,
    getActiveForChat,
    isOpen,
    reset,
    renderMessage,
    snapshot,
    manager,
    joinTimeoutMs,
    turnTimeoutMs,
    pairCooldownMs,
  };
}

const ticTacToeRuntime = createTicTacToeService({
  manager: getSharedPvpSessionManager(),
});

function startTicTacToeChallenge(params) {
  return ticTacToeRuntime.startChallenge(params);
}

function isTicTacToeOpen() {
  return ticTacToeRuntime.isOpen();
}

function getTicTacToeRuntime() {
  return ticTacToeRuntime;
}

module.exports = {
  GAME_ID,
  STATUS,
  JOIN_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  PAIR_COOLDOWN_MS,
  WIN_LINES,
  emptyBoard,
  checkWinner,
  isBoardFull,
  buildJoinCallbackData,
  buildMoveCallbackData,
  parsePvpCallbackData,
  sanitizePvpDisplayName,
  createTicTacToeService,
  ticTacToeRuntime,
  startTicTacToeChallenge,
  isTicTacToeOpen,
  getTicTacToeRuntime,
  renderMessage,
  cellLabel,
  MARK_X,
  MARK_O,
  EMPTY_CELL,
};
