/**
 * Tic-Tac-Toe PvP — in-memory sessions via generic PvP manager.
 * Not auto-started by Activity Engine in v1 (enabledForAuto: false).
 */

const { Markup } = require("telegraf");
const crypto = require("crypto");
const { log, logError } = require("../utils/logger");
const {
  createPvpSessionManager,
  getSharedPvpSessionManager,
  sanitizePvpDisplayName,
  DEFAULT_PAIR_COOLDOWN_MS,
} = require("./pvpSessionManager");
const {
  createPvpMatchReservation,
  getSharedPvpMatchReservation,
  PLAYER_BUSY_TEXT,
  BOT_USER_ID,
} = require("./pvpMatchReservation");
const { chooseTicTacToeBotCell } = require("./ticTacToeBot");
const {
  takeResolvedQuestUsers,
  emitResolvedPvpDailyQuest,
} = require("./pvpDailyQuest");
const { isAllowedChatFightChat } = require("./chatFight");
const {
  GAME_TYPE,
  FINAL_STATE,
  buildFinalGameText,
  logGameCleanup,
} = require("../utils/gameCleanup");

const GAME_ID = "tictactoe";

const JOIN_TIMEOUT_MS = 60 * 1000;
const LOBBY_COUNTDOWN_MS = 5 * 1000;
const TURN_TIMEOUT_MS = 60 * 1000;
const BOT_THINK_MIN_MS = 700;
const BOT_THINK_MAX_MS = 1000;
const PAIR_COOLDOWN_MS = DEFAULT_PAIR_COOLDOWN_MS;
const BOT_DISPLAY_NAME = "🤖 ManGo Bot";

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
    Markup.button.callback("JOIN GAME", buildJoinCallbackData(sessionId)),
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

function lobbyRemainingSeconds(session, nowMs) {
  const endsAt = Number(session.lobbyEndsAt) || 0;
  return Math.max(0, Math.ceil((endsAt - nowMs) / 1000));
}

function buildWaitingText(session, nowMs) {
  const x = session.players.X;
  const name = x && x.displayName ? x.displayName : "Player";
  const seconds = lobbyRemainingSeconds(session, nowMs);
  const display = seconds > 0 ? seconds : 1;
  return `❌⭕ ManGo Tic-Tac-Toe

${name} is looking for an opponent.

Players:
1/2

⏳ Starting in ${display}s

If nobody joins, ${name} will play against 🤖 ManGo Bot.`;
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

function buildExpiredText(session) {
  const joined = Boolean(session && session.players && session.players.X);
  return buildFinalGameText(
    GAME_TYPE.TICTACTOE,
    joined ? FINAL_STATE.NOT_ENOUGH : FINAL_STATE.EMPTY
  );
}

function renderMessage(session, xpResult, nowMs = Date.now()) {
  const { emptyInlineKeyboardExtra } = require("../utils/expiredMessageCleanup");
  if (session.status === STATUS.WAITING) {
    return {
      text: buildWaitingText(session, nowMs),
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
    return { text: buildExpiredText(session), extra: emptyInlineKeyboardExtra() };
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
  const countdownMs =
    typeof options.countdownMs === "number" && options.countdownMs > 0
      ? options.countdownMs
      : LOBBY_COUNTDOWN_MS;
  const botThinkMinMs =
    typeof options.botThinkMinMs === "number" ? options.botThinkMinMs : BOT_THINK_MIN_MS;
  const botThinkMaxMs =
    typeof options.botThinkMaxMs === "number" ? options.botThinkMaxMs : BOT_THINK_MAX_MS;
  const randomIntFn =
    typeof options.randomIntFn === "function"
      ? options.randomIntFn
      : (min, max) => crypto.randomInt(min, max);

  const manager =
    options.manager ||
    createPvpSessionManager({
      now: options.now,
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn,
      pairCooldownMs,
      randomIdFn: options.randomIdFn,
    });
  const reservation =
    options.reservation || createPvpMatchReservation();

  const onSessionEnded =
    typeof options.onSessionEnded === "function"
      ? options.onSessionEnded
      : null;
  let renderHandler =
    typeof options.onRender === "function" ? options.onRender : null;

  function setRenderHandler(fn) {
    renderHandler = typeof fn === "function" ? fn : null;
  }

  function notifyRender(result) {
    if (!result || !result.ok || !renderHandler) {
      return;
    }
    try {
      renderHandler(result);
    } catch (_err) {
      /* ignore */
    }
  }

  function opponentIsBot(session) {
    return Boolean(
      session &&
        ((session.players.X && session.players.X.isBot) ||
          (session.players.O && session.players.O.isBot))
    );
  }

  function maybeMarkPairCooldown(session) {
    if (!session || !session.players.X || !session.players.O) {
      return;
    }
    if (opponentIsBot(session)) {
      return;
    }
    manager.markPairCooldown(
      session.players.X.userId,
      session.players.O.userId,
      GAME_ID
    );
  }

  function finishOpen(session) {
    manager.clearTimers(session);
    manager.clearActiveIndex(session);
    reservation.releaseMatch(session.id);
  }

  function botThinkDelay() {
    const min = Math.max(0, botThinkMinMs);
    const max = Math.max(min, botThinkMaxMs);
    if (max <= min) {
      return min;
    }
    return randomIntFn(min, max + 1);
  }

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
        lobbyEndsAt: session.lobbyEndsAt,
        startedAt: session.startedAt,
        lastMoveAt: session.lastMoveAt,
        winnerUserId: session.winnerUserId,
        winnerSeat: session.winnerSeat,
        rewardEligible: session.rewardEligible,
        xpAwarded: session.xpAwarded,
        questNoted: Boolean(session.questNoted),
        endReason: session.endReason || null,
        opponentType: session.opponentType || "human",
        botMoveGeneration: session.botMoveGeneration || 0,
      })
    );
  }

  function isOpen() {
    return manager.hasAnyOpenGame(GAME_ID);
  }

  function getActiveForChat(chatId) {
    return manager.getActiveSession(chatId, GAME_ID);
  }

  function startChallenge({ chatId, starter } = {}) {
    if (chatId == null || !isAllowedChatFightChat(chatId)) {
      return { ok: false, reason: "wrong-chat" };
    }
    if (!starter || starter.isBot || starter.userId == null) {
      return { ok: false, reason: starter && starter.isBot ? "bot" : "no-starter" };
    }

    const id = manager.generateSessionId();
    const reserved = reservation.tryReserve(starter.userId, GAME_ID, id);
    if (!reserved.ok) {
      return { ok: false, reason: "player-busy" };
    }

    const now = manager.now();
    const session = {
      id,
      game: GAME_ID,
      chatId: String(chatId),
      messageId: null,
      status: STATUS.WAITING,
      players: {
        X: {
          userId: String(starter.userId),
          displayName: sanitizePvpDisplayName(starter.displayName),
          isBot: false,
        },
        O: null,
      },
      currentPlayer: "X",
      board: emptyBoard(),
      createdAt: now,
      lobbyEndsAt: now + joinTimeoutMs,
      startedAt: null,
      lastMoveAt: null,
      winnerUserId: null,
      winnerSeat: null,
      rewardEligible: true,
      xpAwarded: false,
      questNoted: false,
      endReason: null,
      opponentType: "human",
      botMoveGeneration: 0,
      timers: {
        joinTimeoutId: null,
        turnTimeoutId: null,
        countdownTimeoutId: null,
        botTimeoutId: null,
      },
    };

    manager.registerSession(session);
    manager.schedule(session, "join", joinTimeoutMs, () => {
      expireJoin(session.id);
    });
    scheduleLobbyCountdown(session);
    log("[pvp] match started game=tictactoe mode=lobby");

    const rendered = renderMessage(session, null, manager.now());
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

  function msUntilNextCountdown(session) {
    const now = manager.now();
    if (!session.lobbyEndsAt || session.lobbyEndsAt - now <= 0) {
      return null;
    }
    const elapsed = Math.max(0, now - session.createdAt);
    const nextOffset = (Math.floor(elapsed / countdownMs) + 1) * countdownMs;
    const nextAt = session.createdAt + nextOffset;
    if (nextAt >= session.lobbyEndsAt) {
      return null;
    }
    return Math.max(1, nextAt - now);
  }

  function scheduleLobbyCountdown(session) {
    if (!session || session.status !== STATUS.WAITING) {
      return;
    }
    const wait = msUntilNextCountdown(session);
    if (wait == null) {
      return;
    }
    const sessionId = session.id;
    manager.schedule(session, "countdown", wait, () => {
      tickLobbyCountdown(sessionId);
    });
  }

  function tickLobbyCountdown(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.WAITING) {
        return { ok: false, reason: "not-waiting" };
      }
      scheduleLobbyCountdown(session);
      return {
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
    notifyRender(locked);
    return locked;
  }

  function activateMatch(session, opponentType) {
    session.opponentType = opponentType;
    if (opponentType !== "bot") {
      const onCooldown = manager.isPairOnCooldown(
        session.players.X.userId,
        session.players.O.userId,
        GAME_ID
      );
      session.rewardEligible = !onCooldown;
    } else {
      session.rewardEligible = true;
    }
    session.status = STATUS.ACTIVE;
    session.startedAt = manager.now();
    session.lastMoveAt = session.startedAt;
    session.currentPlayer = "X";
    manager.clearTimers(session);
    session.timers.joinTimeoutId = null;
    session.timers.countdownTimeoutId = null;
    startTurnTimer(session);
    if (isBotPlayer(session.players[session.currentPlayer])) {
      scheduleBotMove(session);
    }
    log(
      `[pvp] match started game=tictactoe mode=${opponentType === "bot" ? "bot" : "pvp"}`
    );
  }

  function isBotPlayer(player) {
    return Boolean(player && (player.isBot || String(player.userId) === BOT_USER_ID));
  }

  function takeQuestUsers(session) {
    return takeResolvedQuestUsers(session, isBotPlayer);
  }

  function emitQuest(result) {
    emitResolvedPvpDailyQuest(result && result.questUsers, GAME_ID, {
      shopFile: options.shopFile,
      walletFile: options.walletFile,
      noteDailyQuestGameFn: options.noteDailyQuestGameFn,
    });
  }

  function makeBotPlayer() {
    return {
      userId: BOT_USER_ID,
      displayName: BOT_DISPLAY_NAME,
      isBot: true,
    };
  }

  function expireJoin(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.WAITING) {
        return { ok: false, reason: "not-waiting" };
      }
      const starter = session.players && session.players.X;
      if (!starter || isBotPlayer(starter)) {
        session.status = STATUS.EXPIRED;
        session.endReason = "join-timeout";
        finishOpen(session);
        logGameCleanup(GAME_TYPE.TICTACTOE, FINAL_STATE.EMPTY);
        return {
          ok: true,
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }
      session.players.O = makeBotPlayer();
      activateMatch(session, "bot");
      return {
        ok: true,
        startedBot: true,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
    notifyRender(locked);
    if (locked.ok && locked.session && locked.session.status !== STATUS.ACTIVE && onSessionEnded) {
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
      finishOpen(session);
      maybeMarkPairCooldown(session);
      return {
        ok: true,
        needsXp: true,
        questUsers: takeQuestUsers(session),
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
    if (locked.ok && onSessionEnded) {
      try {
        onSessionEnded(locked.session);
      } catch (_err) {
        /* ignore */
      }
    }
    emitQuest(locked);
    notifyRender(locked);
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

      if (session.players.X && String(session.players.X.userId) === uid) {
        return { ok: false, reason: "already-joined" };
      }

      if (session.players.O) {
        return { ok: false, reason: "full" };
      }

      const reserved = reservation.tryReserve(uid, GAME_ID, session.id);
      if (!reserved.ok) {
        return { ok: false, reason: "player-busy" };
      }

      session.players.O = { userId: uid, displayName: name, isBot: false };
      activateMatch(session, "human");

      return {
        ok: true,
        role: "O",
        started: true,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
  }

  function move({ sessionId, userId, cell, chatId } = {}) {
    const locked = manager.withSessionLock(sessionId, () => {
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
        finishOpen(session);
        maybeMarkPairCooldown(session);
        return {
          ok: true,
          ended: true,
          needsXp: true,
          questUsers: takeQuestUsers(session),
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }

      if (isBoardFull(session.board)) {
        session.status = STATUS.DRAW;
        session.endReason = "draw";
        finishOpen(session);
        maybeMarkPairCooldown(session);
        return {
          ok: true,
          ended: true,
          needsXp: false,
          questUsers: takeQuestUsers(session),
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }

      session.currentPlayer = seat === "X" ? "O" : "X";
      startTurnTimer(session);
      if (isBotPlayer(session.players[session.currentPlayer])) {
        scheduleBotMove(session);
      }
      return {
        ok: true,
        ended: false,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
    emitQuest(locked);
    return locked;
  }

  function scheduleBotMove(session) {
    session.botMoveGeneration = (session.botMoveGeneration || 0) + 1;
    const gen = session.botMoveGeneration;
    const sessionId = session.id;
    manager.schedule(session, "bot", botThinkDelay(), () => {
      performBotMove(sessionId, gen);
    });
  }

  function performBotMove(sessionId, expectedGen) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.ACTIVE) {
        return { ok: false, reason: "not-active" };
      }
      if (expectedGen != null && session.botMoveGeneration !== expectedGen) {
        return { ok: false, reason: "stale-bot" };
      }
      const seat = session.currentPlayer;
      const player = session.players[seat];
      if (!isBotPlayer(player)) {
        return { ok: false, reason: "not-bot-turn" };
      }
      const cell = chooseTicTacToeBotCell(session.board, seat, randomIntFn);
      if (!Number.isInteger(cell) || cell < 0 || cell > 8 || session.board[cell] != null) {
        return { ok: false, reason: "illegal-bot" };
      }
      session.board[cell] = seat;
      session.lastMoveAt = manager.now();

      const winMark = checkWinner(session.board);
      if (winMark) {
        session.status = STATUS.WON;
        session.winnerSeat = winMark;
        session.winnerUserId = String(session.players[winMark].userId);
        session.endReason = "win";
        finishOpen(session);
        maybeMarkPairCooldown(session);
        return {
          ok: true,
          ended: true,
          needsXp: true,
          questUsers: takeQuestUsers(session),
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }

      if (isBoardFull(session.board)) {
        session.status = STATUS.DRAW;
        session.endReason = "draw";
        finishOpen(session);
        maybeMarkPairCooldown(session);
        return {
          ok: true,
          ended: true,
          needsXp: false,
          questUsers: takeQuestUsers(session),
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }

      session.currentPlayer = seat === "X" ? "O" : "X";
      startTurnTimer(session);
      if (isBotPlayer(session.players[session.currentPlayer])) {
        scheduleBotMove(session);
      }
      return {
        ok: true,
        ended: false,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
    if (locked.ok && locked.ended && onSessionEnded) {
      try {
        onSessionEnded(locked.session);
      } catch (_err) {
        /* ignore */
      }
    }
    emitQuest(locked);
    notifyRender(locked);
    return locked;
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
      if (isBotPlayer(session.players[session.winnerSeat])) {
        return {
          ok: true,
          shouldAward: false,
          reason: "bot-winner",
          session: snapshot(session),
        };
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
    reservation.reset();
  }

  return {
    GAME_ID,
    STATUS,
    startChallenge,
    setMessageId,
    join,
    move,
    expireJoin,
    tickLobbyCountdown,
    resolveTurnTimeout,
    performBotMove,
    claimXpAward,
    applyXpResultToRender,
    getSession,
    getActiveForChat,
    isOpen,
    reset,
    clearAllTimers: reset,
    setRenderHandler,
    renderMessage,
    snapshot,
    manager,
    reservation,
    joinTimeoutMs,
    turnTimeoutMs,
    pairCooldownMs,
  };
}

const ticTacToeRuntime = createTicTacToeService({
  manager: getSharedPvpSessionManager(),
  reservation: getSharedPvpMatchReservation(),
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
  LOBBY_COUNTDOWN_MS,
  TURN_TIMEOUT_MS,
  PAIR_COOLDOWN_MS,
  BOT_THINK_MIN_MS,
  BOT_THINK_MAX_MS,
  BOT_USER_ID,
  PLAYER_BUSY_TEXT,
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
