/**
 * Connect Four / Vier-op-een-rij PvP — in-memory sessions via generic PvP manager.
 * Not auto-started by Activity Engine (enabledForAuto: false).
 */

const { Markup } = require("telegraf");
const crypto = require("crypto");
const { log } = require("../utils/logger");
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
const { chooseConnectFourBotColumn } = require("./connectFourBot");
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

const GAME_ID = "connect4";

const JOIN_TIMEOUT_MS = 60 * 1000;
const LOBBY_COUNTDOWN_MS = 5 * 1000;
const TURN_TIMEOUT_MS = 60 * 1000;
const BOT_THINK_MIN_MS = 700;
const BOT_THINK_MAX_MS = 1000;
const PAIR_COOLDOWN_MS = DEFAULT_PAIR_COOLDOWN_MS;
const BOT_DISPLAY_NAME = "🤖 ManGo Bot";

const ROWS = 6;
const COLS = 7;
const WIN_LENGTH = 4;

const STATUS = Object.freeze({
  WAITING: "waiting",
  ACTIVE: "active",
  WON: "won",
  DRAW: "draw",
  EXPIRED: "expired",
});

const MARK_R = "🔴";
const MARK_Y = "🟡";
const EMPTY_CELL = "⚪";
const COL_HEADERS = "1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣";

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

/**
 * Drop a token into the lowest empty cell of a column (0–6).
 * Mutates board. Row 5 is the bottom.
 */
function dropToken(board, column, mark) {
  if (!Number.isInteger(column) || column < 0 || column >= COLS) {
    return { ok: false, reason: "bad-cell" };
  }
  for (let row = ROWS - 1; row >= 0; row -= 1) {
    if (board[row][column] == null) {
      board[row][column] = mark;
      return { ok: true, row, column };
    }
  }
  return { ok: false, reason: "full" };
}

function countDir(board, row, col, dRow, dCol, mark) {
  let n = 0;
  let r = row + dRow;
  let c = col + dCol;
  while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === mark) {
    n += 1;
    r += dRow;
    c += dCol;
  }
  return n;
}

/**
 * Winner if 4 or more connected horizontally, vertically, or diagonally.
 * @param {Array<Array<string|null>>} board
 * @returns {"R"|"Y"|null}
 */
function checkConnectFourWinner(board) {
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const mark = board[row][col];
      if (mark !== "R" && mark !== "Y") {
        continue;
      }
      for (const [dRow, dCol] of dirs) {
        const run =
          1 +
          countDir(board, row, col, dRow, dCol, mark) +
          countDir(board, row, col, -dRow, -dCol, mark);
        if (run >= WIN_LENGTH) {
          return mark;
        }
      }
    }
  }
  return null;
}

function isBoardFull(board) {
  return board.every((row) => row.every((cell) => cell === "R" || cell === "Y"));
}

function cellEmoji(value) {
  if (value === "R") return MARK_R;
  if (value === "Y") return MARK_Y;
  return EMPTY_CELL;
}

function formatBoard(board) {
  const lines = board.map((row) => row.map(cellEmoji).join(" "));
  lines.push(COL_HEADERS);
  return lines.join("\n");
}

function buildJoinCallbackData(sessionId) {
  return `pvp:c4:join:${sessionId}`;
}

function buildMoveCallbackData(sessionId, column) {
  return `pvp:c4:move:${sessionId}:${column}`;
}

function parsePvpCallbackData(data) {
  if (typeof data !== "string" || !data.startsWith("pvp:c4:")) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length < 4 || parts[0] !== "pvp" || parts[1] !== "c4") {
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
    const column = Number(parts[4]);
    if (!Number.isInteger(column) || column < 0 || column > 6) return null;
    return { action: "move", sessionId, column, game: GAME_ID };
  }
  return null;
}

function buildJoinKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    Markup.button.callback("JOIN GAME", buildJoinCallbackData(sessionId)),
  ]);
}

function buildBoardKeyboard(session) {
  const rows = [];
  const labels = ["1", "2", "3", "4", "5", "6", "7"];
  const first = [];
  for (let col = 0; col < 4; col += 1) {
    first.push(
      Markup.button.callback(labels[col], buildMoveCallbackData(session.id, col))
    );
  }
  rows.push(first);
  const second = [];
  for (let col = 4; col < 7; col += 1) {
    second.push(
      Markup.button.callback(labels[col], buildMoveCallbackData(session.id, col))
    );
  }
  rows.push(second);
  return Markup.inlineKeyboard(rows);
}

function lobbyRemainingSeconds(session, nowMs) {
  const endsAt = Number(session.lobbyEndsAt) || 0;
  return Math.max(0, Math.ceil((endsAt - nowMs) / 1000));
}

function buildWaitingText(session, nowMs) {
  const r = session.players.R;
  const name = r && r.displayName ? r.displayName : "Player";
  const seconds = lobbyRemainingSeconds(session, nowMs);
  const display = seconds > 0 ? seconds : 1;
  return `🔴🟡 ManGo Connect Four

${name} is looking for an opponent.

Players:
1/2

⏳ Starting in ${display}s

If nobody joins, ${name} will play against 🤖 ManGo Bot.`;
}

function buildActiveText(session) {
  const r = session.players.R;
  const y = session.players.Y;
  const turnMark = session.currentPlayer === "R" ? MARK_R : MARK_Y;
  const turnName =
    session.currentPlayer === "R" ? r.displayName : y.displayName;
  return `🟡 CONNECT FOUR

${MARK_R} ${r.displayName}
${MARK_Y} ${y.displayName}

Turn: ${turnMark} ${turnName}

${formatBoard(session.board)}

Choose a column.`;
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
  if (xpResult && xpResult.reason === "excluded") {
    return "PvP XP: none";
  }
  if (xpResult && xpResult.reason === "wallet-required") {
    return "PvP XP: 🔒 0 XP — wallet not linked — /wallet";
  }
  return "PvP XP: none";
}

function buildWonText(session, xpResult) {
  const winnerSeat = session.winnerSeat;
  const loserSeat = winnerSeat === "R" ? "Y" : "R";
  const winner = session.players[winnerSeat];
  const loser = session.players[loserSeat];
  const wMark = winnerSeat === "R" ? MARK_R : MARK_Y;
  const lMark = loserSeat === "R" ? MARK_R : MARK_Y;
  const byTimeout = session.endReason === "timeout";
  const xpLine = formatXpLine(xpResult, session.rewardEligible);

  if (byTimeout) {
    return `⏱ CONNECT FOUR

${loser.displayName} ran out of time.

🏆 ${winner.displayName} wins!

${xpLine} 🥭`;
  }

  return `🏆 CONNECT FOUR WINNER

${wMark} ${winner.displayName} defeated ${lMark} ${loser.displayName}!

${
    xpResult && xpResult.awarded
      ? `+${xpResult.pointsToAdd} PvP XP 🥭`
      : `${xpLine} 🥭`
  }

${formatBoard(session.board)}`;
}

function buildDrawText(session) {
  return `🤝 CONNECT FOUR DRAW

${session.players.R.displayName} ${MARK_R} vs ${session.players.Y.displayName} ${MARK_Y}

${formatBoard(session.board)}

Good game! 🥭`;
}

function buildExpiredText(session) {
  const joined = Boolean(session && session.players && session.players.R);
  return buildFinalGameText(
    GAME_TYPE.CONNECT4,
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
      extra: buildBoardKeyboard(session),
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
  return { text: "🟡 CONNECT FOUR", extra: emptyInlineKeyboardExtra() };
}

function createConnectFourService(options = {}) {
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
        ((session.players.R && session.players.R.isBot) ||
          (session.players.Y && session.players.Y.isBot))
    );
  }

  function maybeMarkPairCooldown(session) {
    if (!session || !session.players.R || !session.players.Y) {
      return;
    }
    if (opponentIsBot(session)) {
      return;
    }
    manager.markPairCooldown(
      session.players.R.userId,
      session.players.Y.userId,
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

  function isBotPlayer(player) {
    return Boolean(player && (player.isBot || String(player.userId) === BOT_USER_ID));
  }

  function takeQuestUsers(session) {
    return takeResolvedQuestUsers(session, isBotPlayer);
  }

  async function emitQuest(result) {
    await emitResolvedPvpDailyQuest(result && result.questUsers, GAME_ID, {
      shopFile: options.shopFile,
      walletFile: options.walletFile,
      pointsFile: options.pointsFile,
      noteDailyQuestGameFn: options.noteDailyQuestGameFn,
      noteHumanPvpMatchFn: options.noteHumanPvpMatchFn,
      opponentType: result && result.session && result.session.opponentType,
      matchId: result && result.session && result.session.id,
    });
  }

  function makeBotPlayer() {
    return {
      userId: BOT_USER_ID,
      displayName: BOT_DISPLAY_NAME,
      isBot: true,
    };
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
        R: {
          userId: String(starter.userId),
          displayName: sanitizePvpDisplayName(starter.displayName),
          isBot: false,
        },
        Y: null,
      },
      currentPlayer: "R",
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
    log("[pvp] match started game=connect4 mode=lobby");

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
        session.players.R.userId,
        session.players.Y.userId,
        GAME_ID
      );
      session.rewardEligible = !onCooldown;
    } else {
      session.rewardEligible = true;
    }
    session.status = STATUS.ACTIVE;
    session.startedAt = manager.now();
    session.lastMoveAt = session.startedAt;
    session.currentPlayer = "R";
    manager.clearTimers(session);
    session.timers.joinTimeoutId = null;
    session.timers.countdownTimeoutId = null;
    startTurnTimer(session);
    if (isBotPlayer(session.players[session.currentPlayer])) {
      scheduleBotMove(session);
    }
    log(
      `[pvp] match started game=connect4 mode=${opponentType === "bot" ? "bot" : "pvp"}`
    );
  }

  function expireJoin(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.WAITING) {
        return { ok: false, reason: "not-waiting" };
      }
      const starter = session.players && session.players.R;
      if (!starter || isBotPlayer(starter)) {
        session.status = STATUS.EXPIRED;
        session.endReason = "join-timeout";
        finishOpen(session);
        logGameCleanup(GAME_TYPE.CONNECT4, FINAL_STATE.EMPTY);
        return {
          ok: true,
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }
      session.players.Y = makeBotPlayer();
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
    if (session.players.R && String(session.players.R.userId) === id) {
      return "R";
    }
    if (session.players.Y && String(session.players.Y.userId) === id) {
      return "Y";
    }
    return null;
  }

  function startTurnTimer(session) {
    manager.schedule(session, "turn", turnTimeoutMs, () => {
      Promise.resolve(resolveTurnTimeout(session.id)).catch(() => {});
    });
  }

  async function resolveTurnTimeout(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.ACTIVE) {
        return { ok: false, reason: "not-active" };
      }
      if (session.winnerUserId != null) {
        return { ok: false, reason: "already-ended" };
      }
      const loserSeat = session.currentPlayer;
      const winnerSeat = loserSeat === "R" ? "Y" : "R";
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
    notifyRender(locked);
    await emitQuest(locked);
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

      if (session.players.R && String(session.players.R.userId) === uid) {
        return { ok: false, reason: "already-joined" };
      }

      if (session.players.Y) {
        return { ok: false, reason: "full" };
      }

      const reserved = reservation.tryReserve(uid, GAME_ID, session.id);
      if (!reserved.ok) {
        return { ok: false, reason: "player-busy" };
      }

      session.players.Y = { userId: uid, displayName: name, isBot: false };
      activateMatch(session, "human");

      return {
        ok: true,
        role: "Y",
        started: true,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
  }

  async function move({ sessionId, userId, column, chatId } = {}) {
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

      const seat = seatForUser(session, userId);
      if (!seat) {
        return { ok: false, reason: "outsider" };
      }
      if (seat !== session.currentPlayer) {
        return { ok: false, reason: "not-your-turn" };
      }

      const dropped = dropToken(session.board, column, seat);
      if (!dropped.ok) {
        return { ok: false, reason: dropped.reason };
      }

      session.lastMoveAt = manager.now();

      const winMark = checkConnectFourWinner(session.board);
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

      session.currentPlayer = seat === "R" ? "Y" : "R";
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
    await emitQuest(locked);
    return locked;
  }

  function scheduleBotMove(session) {
    session.botMoveGeneration = (session.botMoveGeneration || 0) + 1;
    const gen = session.botMoveGeneration;
    const sessionId = session.id;
    manager.schedule(session, "bot", botThinkDelay(), () => {
      Promise.resolve(performBotMove(sessionId, gen)).catch(() => {});
    });
  }

  async function performBotMove(sessionId, expectedGen) {
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
      const column = chooseConnectFourBotColumn(session.board, seat, randomIntFn);
      const dropped = dropToken(session.board, column, seat);
      if (!dropped.ok) {
        return { ok: false, reason: "illegal-bot" };
      }
      session.lastMoveAt = manager.now();

      const winMark = checkConnectFourWinner(session.board);
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

      session.currentPlayer = seat === "R" ? "Y" : "R";
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
    notifyRender(locked);
    await emitQuest(locked);
    return locked;
  }

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

const connectFourRuntime = createConnectFourService({
  manager: getSharedPvpSessionManager(),
  reservation: getSharedPvpMatchReservation(),
});

function startConnectFourChallenge(params) {
  return connectFourRuntime.startChallenge(params);
}

function isConnectFourOpen() {
  return connectFourRuntime.isOpen();
}

function getConnectFourRuntime() {
  return connectFourRuntime;
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
  ROWS,
  COLS,
  WIN_LENGTH,
  emptyBoard,
  cloneBoard,
  dropToken,
  checkConnectFourWinner,
  isBoardFull,
  formatBoard,
  buildJoinCallbackData,
  buildMoveCallbackData,
  parsePvpCallbackData,
  sanitizePvpDisplayName,
  createConnectFourService,
  connectFourRuntime,
  startConnectFourChallenge,
  isConnectFourOpen,
  getConnectFourRuntime,
  renderMessage,
  cellEmoji,
  MARK_R,
  MARK_Y,
  EMPTY_CELL,
};
