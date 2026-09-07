/**
 * Checkers PvP — in-memory sessions via generic PvP manager.
 * Start always asks bot vs wait. Lobby timeout re-prompts; it does not
 * silently start a bot match. Not auto-started by Activity Engine.
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
const { chooseCheckersBotMove } = require("./checkersBot");
const {
  BLACK,
  WHITE,
  BLACK_KING,
  WHITE_KING,
  BOARD_SIZE,
  SQUARE_COUNT,
  emptyBoard,
  initialBoard,
  cloneBoard,
  legalMoves,
  destinations,
  applyMove,
  isPlayableSquare,
  isDark,
  rowColToSq,
  sideOf,
  allCaptures,
} = require("./checkersRules");
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

const GAME_ID = "checkers";

const JOIN_TIMEOUT_MS = 60 * 1000;
const LOBBY_COUNTDOWN_MS = 5 * 1000;
const TURN_TIMEOUT_MS = 120 * 1000;
const BOT_THINK_MIN_MS = 400;
const BOT_THINK_MAX_MS = 700;
const BOT_CHAIN_THINK_MIN_MS = 250;
const BOT_CHAIN_THINK_MAX_MS = 400;
const PAIR_COOLDOWN_MS = DEFAULT_PAIR_COOLDOWN_MS;
const BOT_DISPLAY_NAME = "ManGoBot";

const STATUS = Object.freeze({
  WAITING: "waiting",
  ACTIVE: "active",
  WON: "won",
  DRAW: "draw",
  EXPIRED: "expired",
});

const PHASE = Object.freeze({
  START_CHOICE: "start-choice",
  PVP_LOBBY: "pvp-lobby",
  WAIT_PROMPT: "wait-prompt",
  PLAYING: "playing",
});

const MUST_CAPTURE_TOAST = "⚠️ You must capture. Select a highlighted piece.";
const NOT_YOUR_PIECE_TOAST = "That's not your piece.";
const EMPTY_SQUARE_TOAST = "That square is empty.";
const STALE_BOARD_TOAST = "Board updated.";
const NO_MOVES_TOAST = "That piece has no moves.";

// Round pieces on a square board. Telegram still auto-sizes buttons;
// circles read as draughts on a phone better than colored squares.
const MARK_B = "🟠";
const MARK_W = "🟢";
const MARK_BK = "🔶";
const MARK_WK = "💚";
const MARK_DEST = "✨";
const EMPTY_DARK = "⬛";
const LIGHT_CELL = "⬜";
const KEY_EMPTY = EMPTY_DARK;
const NOOP_ACTION = "noop";

function pieceEmoji(piece) {
  if (piece === BLACK) return MARK_B;
  if (piece === WHITE) return MARK_W;
  if (piece === BLACK_KING) return MARK_BK;
  if (piece === WHITE_KING) return MARK_WK;
  return EMPTY_DARK;
}

function formatBoard(board, options = {}) {
  const cells = Array.isArray(board) ? board : emptyBoard();
  const destSet = new Set(
    Array.isArray(options.destinations) ? options.destinations : []
  );
  const lines = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    let line = "";
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (!isDark(row, col)) {
        line += LIGHT_CELL;
        continue;
      }
      const sq = rowColToSq(row, col);
      if (destSet.has(sq)) {
        line += MARK_DEST;
      } else {
        line += pieceEmoji(cells[sq]);
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function boardState(session) {
  return {
    board: session.board,
    current: session.currentPlayer,
    pendingFrom: session.pendingFrom,
  };
}

function destSquares(session) {
  if (!isPlayableSquare(session.selectedSquare)) {
    return [];
  }
  return destinations(boardState(session), session.selectedSquare).map(
    (m) => m.to
  );
}

function captureFromSquares(session) {
  if (!session || !session.board || !session.currentPlayer) {
    return [];
  }
  const moves = allCaptures(session.board, session.currentPlayer);
  const froms = [];
  const seen = new Set();
  for (let i = 0; i < moves.length; i += 1) {
    const from = moves[i].from;
    if (seen.has(from)) continue;
    seen.add(from);
    froms.push(from);
  }
  return froms;
}

function appendGeneration(base, generation) {
  if (!Number.isInteger(generation)) {
    return base;
  }
  return `${base}:${generation}`;
}

function buildJoinCallbackData(sessionId) {
  return `pvp:chk:join:${sessionId}`;
}

function buildSelectCallbackData(sessionId, square, generation) {
  return appendGeneration(`pvp:chk:sel:${sessionId}:${square}`, generation);
}

function buildMoveCallbackData(sessionId, from, to, generation) {
  return appendGeneration(`pvp:chk:mv:${sessionId}:${from}:${to}`, generation);
}

function buildNoopCallbackData(sessionId) {
  return `pvp:chk:${NOOP_ACTION}:${sessionId}`;
}

function buildModeCallbackData(sessionId, mode) {
  return `pvp:chk:mode:${sessionId}:${mode}`;
}

function parseOptionalGeneration(raw) {
  if (raw == null || raw === "") {
    return null;
  }
  const generation = Number(raw);
  if (!Number.isInteger(generation) || generation < 0) {
    return null;
  }
  return generation;
}

function parsePvpCallbackData(data) {
  if (typeof data !== "string" || !data.startsWith("pvp:chk:")) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length < 4 || parts[0] !== "pvp" || parts[1] !== "chk") {
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
  if (action === NOOP_ACTION) {
    if (parts.length !== 4) return null;
    return { action: NOOP_ACTION, sessionId, game: GAME_ID };
  }
  if (action === "mode") {
    if (parts.length !== 5) return null;
    const mode = parts[4];
    if (mode !== "bot" && mode !== "pvp" && mode !== "cancel" && mode !== "keep") {
      return null;
    }
    return { action: "mode", sessionId, mode, game: GAME_ID };
  }
  if (action === "sel") {
    if (parts.length !== 5 && parts.length !== 6) return null;
    const square = Number(parts[4]);
    if (!isPlayableSquare(square)) return null;
    const generation = parts.length === 6 ? parseOptionalGeneration(parts[5]) : null;
    if (parts.length === 6 && generation == null) return null;
    const parsedSel = { action: "sel", sessionId, square, game: GAME_ID };
    if (generation != null) {
      parsedSel.generation = generation;
    }
    return parsedSel;
  }
  if (action === "mv") {
    if (parts.length !== 6 && parts.length !== 7) return null;
    const from = Number(parts[4]);
    const to = Number(parts[5]);
    if (!isPlayableSquare(from) || !isPlayableSquare(to)) return null;
    const generation = parts.length === 7 ? parseOptionalGeneration(parts[6]) : null;
    if (parts.length === 7 && generation == null) return null;
    const parsedMv = { action: "mv", sessionId, from, to, game: GAME_ID };
    if (generation != null) {
      parsedMv.generation = generation;
    }
    return parsedMv;
  }
  return null;
}

function buildJoinKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    Markup.button.callback("JOIN GAME", buildJoinCallbackData(sessionId)),
  ]);
}

function buildStartChoiceKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🤖 Play vs ManGoBot", buildModeCallbackData(sessionId, "bot"))],
    [Markup.button.callback("👥 Wait for Opponent", buildModeCallbackData(sessionId, "pvp"))],
    [Markup.button.callback("❌ Cancel", buildModeCallbackData(sessionId, "cancel"))],
  ]);
}

function buildWaitPromptKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👥 Keep Waiting", buildModeCallbackData(sessionId, "keep"))],
    [Markup.button.callback("🤖 Play vs ManGoBot", buildModeCallbackData(sessionId, "bot"))],
    [Markup.button.callback("❌ Cancel", buildModeCallbackData(sessionId, "cancel"))],
  ]);
}

function squareButtonLabel(session, sq, destSet) {
  if (destSet.has(sq)) {
    return MARK_DEST;
  }
  const piece = session.board[sq];
  if (!piece) {
    return KEY_EMPTY;
  }
  return pieceEmoji(piece);
}

function buildBoardKeyboard(session) {
  const destSet = new Set(destSquares(session));
  const selected = isPlayableSquare(session.selectedSquare)
    ? session.selectedSquare
    : null;
  const gen = Number.isInteger(session.boardGeneration)
    ? session.boardGeneration
    : 0;
  const noopData = buildNoopCallbackData(session.id);
  const rows = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const buttons = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (!isDark(row, col)) {
        buttons.push(Markup.button.callback(LIGHT_CELL, noopData));
        continue;
      }
      const sq = rowColToSq(row, col);
      let data;
      if (selected != null && destSet.has(sq)) {
        data = buildMoveCallbackData(session.id, selected, sq, gen);
      } else {
        data = buildSelectCallbackData(session.id, sq, gen);
      }
      buttons.push(
        Markup.button.callback(squareButtonLabel(session, sq, destSet), data)
      );
    }
    rows.push(buttons);
  }
  return Markup.inlineKeyboard(rows);
}

function lobbyRemainingSeconds(session, nowMs) {
  const endsAt = Number(session.lobbyEndsAt) || 0;
  return Math.max(0, Math.ceil((endsAt - nowMs) / 1000));
}

function buildStartChoiceText() {
  return `♟️ Checkers

How do you want to play?`;
}

function buildWaitingText(session, nowMs) {
  const black = session.players.b;
  const name = black && black.displayName ? black.displayName : "Player";
  const seconds = lobbyRemainingSeconds(session, nowMs);
  const display = seconds > 0 ? seconds : 1;
  return `♟️ Checkers

${name} is looking for an opponent.

Players: 1/2
⏳ Waiting... ${display}s`;
}

function buildWaitPromptText() {
  return `⏳ Still waiting for an opponent...

What would you like to do?`;
}

function turnMark(side) {
  return side === WHITE ? MARK_W : MARK_B;
}

function playerLooksLikeBot(player) {
  return Boolean(
    player && (player.isBot || String(player.userId) === BOT_USER_ID)
  );
}

function seatLabel(side) {
  return side === WHITE ? "White" : "Black";
}

function hasForcedCapture(session) {
  if (!session || session.status !== STATUS.ACTIVE) {
    return false;
  }
  if (isPlayableSquare(session.pendingFrom)) {
    return true;
  }
  return captureFromSquares(session).length > 0;
}

function buildActiveText(session) {
  const black = session.players.b;
  const white = session.players.w;
  const turnPlayer =
    session.currentPlayer === WHITE ? white : black;
  const turnName = turnPlayer && turnPlayer.displayName ? turnPlayer.displayName : "Player";
  const botThinking = playerLooksLikeBot(turnPlayer);
  const vsBot = opponentIsBotPlayers(session);
  const lines = ["♟️ Checkers", ""];
  if (vsBot) {
    const humanSeat = playerLooksLikeBot(black) ? WHITE : BLACK;
    lines.push(`${turnMark(humanSeat)} You: ${seatLabel(humanSeat)}`);
    lines.push(`${turnMark(humanSeat === BLACK ? WHITE : BLACK)} ManGoBot: ${seatLabel(humanSeat === BLACK ? WHITE : BLACK)}`);
  } else {
    lines.push(`${MARK_B} ${black.displayName}`);
    lines.push(`${MARK_W} ${white.displayName}`);
  }
  lines.push("");
  if (botThinking) {
    lines.push(`${MARK_W} ManGoBot is thinking...`);
  } else {
    const youTurn =
      vsBot && !playerLooksLikeBot(turnPlayer) ? "👉 Your turn" : `👉 ${turnName}'s turn`;
    lines.push(youTurn);
    if (hasForcedCapture(session)) {
      lines.push("⚠️ Capture required");
    }
    if (isPlayableSquare(session.pendingFrom)) {
      lines.push("Continue with the same piece.");
    } else if (isPlayableSquare(session.selectedSquare)) {
      lines.push("Choose a ✨ square.");
    }
  }
  return lines.join("\n");
}

function opponentIsBotPlayers(session) {
  return Boolean(
    session &&
      session.players &&
      ((session.players.b && playerLooksLikeBot(session.players.b)) ||
        (session.players.w && playerLooksLikeBot(session.players.w)))
  );
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
  const loserSeat = winnerSeat === BLACK ? WHITE : BLACK;
  const winner = session.players[winnerSeat];
  const loser = session.players[loserSeat];
  const wMark = turnMark(winnerSeat);
  const lMark = turnMark(loserSeat);
  const byTimeout = session.endReason === "timeout";
  const xpLine = formatXpLine(xpResult, session.rewardEligible);

  if (byTimeout) {
    return `⏱ CHECKERS

${loser.displayName} ran out of time.

🏆 ${winner.displayName} wins!

${xpLine} 🥭`;
  }

  return `🏆 CHECKERS WINNER

${wMark} ${winner.displayName} defeated ${lMark} ${loser.displayName}!

${
    xpResult && xpResult.awarded
      ? `+${xpResult.pointsToAdd} PvP XP 🥭`
      : `${xpLine} 🥭`
  }

${formatBoard(session.board)}`;
}

function buildDrawText(session) {
  return `🤝 CHECKERS DRAW

${session.players.b.displayName} ${MARK_B} vs ${session.players.w.displayName} ${MARK_W}

${formatBoard(session.board)}

Good game! 🥭`;
}

function buildExpiredText(session) {
  const joined = Boolean(session && session.players && session.players.b);
  return buildFinalGameText(
    GAME_TYPE.CHECKERS,
    joined ? FINAL_STATE.NOT_ENOUGH : FINAL_STATE.EMPTY
  );
}

function renderMessage(session, xpResult, nowMs = Date.now()) {
  const { emptyInlineKeyboardExtra } = require("../utils/expiredMessageCleanup");
  if (session.status === STATUS.WAITING) {
    if (session.phase === PHASE.START_CHOICE) {
      return {
        text: buildStartChoiceText(),
        extra: buildStartChoiceKeyboard(session.id),
      };
    }
    if (session.phase === PHASE.WAIT_PROMPT) {
      return {
        text: buildWaitPromptText(),
        extra: buildWaitPromptKeyboard(session.id),
      };
    }
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
  return { text: "🏁 CHECKERS", extra: emptyInlineKeyboardExtra() };
}

function logCheckersLifecycle(event, session, extra = "") {
  const id = session && session.id != null ? session.id : "-";
  const status = session && session.status ? session.status : "-";
  const gen =
    session && session.turnGeneration != null ? session.turnGeneration : "-";
  const current =
    session && session.currentPlayer ? session.currentPlayer : "-";
  const reason = session && session.endReason ? session.endReason : "-";
  const suffix = extra ? ` ${extra}` : "";
  log(
    `[checkers] session=${id} event=${event} status=${status} generation=${gen} currentPlayer=${current} endReason=${reason}${suffix}`
  );
}

function createCheckersService(options = {}) {
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
    typeof options.botThinkMinMs === "number"
      ? options.botThinkMinMs
      : BOT_THINK_MIN_MS;
  const botThinkMaxMs =
    typeof options.botThinkMaxMs === "number"
      ? options.botThinkMaxMs
      : BOT_THINK_MAX_MS;
  const botChainThinkMinMs =
    typeof options.botChainThinkMinMs === "number"
      ? options.botChainThinkMinMs
      : BOT_CHAIN_THINK_MIN_MS;
  const botChainThinkMaxMs =
    typeof options.botChainThinkMaxMs === "number"
      ? options.botChainThinkMaxMs
      : BOT_CHAIN_THINK_MAX_MS;
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
  const reservation = options.reservation || createPvpMatchReservation();

  const onSessionEnded =
    typeof options.onSessionEnded === "function" ? options.onSessionEnded : null;
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
        ((session.players.b && session.players.b.isBot) ||
          (session.players.w && session.players.w.isBot))
    );
  }

  function maybeMarkPairCooldown(session) {
    if (!session || !session.players.b || !session.players.w) {
      return;
    }
    if (opponentIsBot(session)) {
      return;
    }
    manager.markPairCooldown(
      session.players.b.userId,
      session.players.w.userId,
      GAME_ID
    );
  }

  function finishOpen(session) {
    manager.clearTimers(session);
    manager.clearActiveIndex(session);
    reservation.releaseMatch(session.id);
  }

  function botThinkDelay(chained) {
    const minRaw = chained ? botChainThinkMinMs : botThinkMinMs;
    const maxRaw = chained ? botChainThinkMaxMs : botThinkMaxMs;
    const min = Math.max(0, minRaw);
    const max = Math.max(min, maxRaw);
    if (max <= min) {
      return min;
    }
    return randomIntFn(min, max + 1);
  }

  function isBotPlayer(player) {
    return Boolean(
      player && (player.isBot || String(player.userId) === BOT_USER_ID)
    );
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
        selectedSquare: session.selectedSquare,
        pendingFrom: session.pendingFrom,
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
        phase: session.phase || PHASE.START_CHOICE,
        botMoveGeneration: session.botMoveGeneration || 0,
        turnGeneration: session.turnGeneration || 0,
        boardGeneration: session.boardGeneration || 0,
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
      return {
        ok: false,
        reason: starter && starter.isBot ? "bot" : "no-starter",
      };
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
      phase: PHASE.START_CHOICE,
      players: {
        b: {
          userId: String(starter.userId),
          displayName: sanitizePvpDisplayName(starter.displayName),
          isBot: false,
        },
        w: null,
      },
      currentPlayer: BLACK,
      board: initialBoard(),
      selectedSquare: null,
      pendingFrom: null,
      createdAt: now,
      lobbyEndsAt: null,
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
      turnGeneration: 0,
      boardGeneration: 1,
      timers: {
        joinTimeoutId: null,
        turnTimeoutId: null,
        countdownTimeoutId: null,
        botTimeoutId: null,
      },
    };

    manager.registerSession(session);
    log("[pvp] match started game=checkers mode=choice");
    logCheckersLifecycle("start-choice", session);

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
      if (!session || session.status !== STATUS.WAITING || session.phase !== PHASE.PVP_LOBBY) {
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
        session.players.b.userId,
        session.players.w.userId,
        GAME_ID
      );
      session.rewardEligible = !onCooldown;
    } else {
      session.rewardEligible = true;
    }
    session.status = STATUS.ACTIVE;
    session.phase = PHASE.PLAYING;
    session.startedAt = manager.now();
    session.lastMoveAt = session.startedAt;
    session.currentPlayer = BLACK;
    session.selectedSquare = null;
    session.pendingFrom = null;
    session.boardGeneration = (session.boardGeneration || 0) + 1;
    manager.clearTimers(session);
    session.timers.joinTimeoutId = null;
    session.timers.countdownTimeoutId = null;
    beginPlayerTurn(session);
    log(
      `[pvp] match started game=checkers mode=${
        opponentType === "bot" ? "bot" : "pvp"
      }`
    );
    logCheckersLifecycle(
      opponentType === "bot" ? "bot-start" : "pvp-start",
      session
    );
  }

  function bumpBoardGeneration(session) {
    session.boardGeneration = (session.boardGeneration || 0) + 1;
    return session.boardGeneration;
  }

  function generationMismatch(session, generation) {
    if (generation == null) {
      return false;
    }
    return Number(generation) !== Number(session.boardGeneration || 0);
  }

  function beginPvpLobby(session) {
    const now = manager.now();
    session.status = STATUS.WAITING;
    session.phase = PHASE.PVP_LOBBY;
    session.createdAt = now;
    session.lobbyEndsAt = now + joinTimeoutMs;
    manager.clearTimers(session);
    session.timers.joinTimeoutId = null;
    session.timers.countdownTimeoutId = null;
    session.timers.botTimeoutId = null;
    session.timers.turnTimeoutId = null;
    bumpBoardGeneration(session);
    manager.schedule(session, "join", joinTimeoutMs, () => {
      expireJoin(session.id);
    });
    scheduleLobbyCountdown(session);
    log("[pvp] match started game=checkers mode=lobby");
    logCheckersLifecycle("lobby-open", session);
  }

  function convertToBot(session) {
    session.players.w = makeBotPlayer();
    activateMatch(session, "bot");
  }

  function cancelSession(session, endReason) {
    session.status = STATUS.EXPIRED;
    session.endReason = endReason;
    session.phase = PHASE.START_CHOICE;
    bumpBoardGeneration(session);
    finishOpen(session);
    logGameCleanup(GAME_TYPE.CHECKERS, FINAL_STATE.NOT_ENOUGH);
    logCheckersLifecycle("cancelled", session);
  }

  function starterUserId(session) {
    return session && session.players && session.players.b
      ? String(session.players.b.userId)
      : null;
  }

  function chooseMode({ sessionId, userId, mode, chatId } = {}) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) {
        return { ok: false, reason: "invalid-session" };
      }
      if (chatId != null && String(chatId) !== String(session.chatId)) {
        return { ok: false, reason: "wrong-chat" };
      }
      if (userId == null) {
        return { ok: false, reason: "no-user" };
      }
      if (String(userId) !== starterUserId(session)) {
        return { ok: false, reason: "not-starter" };
      }
      if (session.status === STATUS.ACTIVE || session.status === STATUS.WON || session.status === STATUS.DRAW) {
        return {
          ok: false,
          reason: "not-waiting",
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }
      if (session.status !== STATUS.WAITING) {
        return { ok: false, reason: "not-waiting" };
      }

      if (mode === "cancel") {
        cancelSession(session, "cancelled");
        return {
          ok: true,
          cancelled: true,
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }

      if (session.phase === PHASE.START_CHOICE) {
        if (mode === "bot") {
          convertToBot(session);
          return {
            ok: true,
            startedBot: true,
            session: snapshot(session),
            rendered: renderMessage(session, null, manager.now()),
          };
        }
        if (mode === "pvp") {
          beginPvpLobby(session);
          return {
            ok: true,
            waiting: true,
            session: snapshot(session),
            rendered: renderMessage(session, null, manager.now()),
          };
        }
        return { ok: false, reason: "bad-mode" };
      }

      if (session.phase === PHASE.WAIT_PROMPT) {
        if (mode === "keep") {
          beginPvpLobby(session);
          return {
            ok: true,
            keptWaiting: true,
            session: snapshot(session),
            rendered: renderMessage(session, null, manager.now()),
          };
        }
        if (mode === "bot") {
          convertToBot(session);
          return {
            ok: true,
            startedBot: true,
            session: snapshot(session),
            rendered: renderMessage(session, null, manager.now()),
          };
        }
        return { ok: false, reason: "bad-mode" };
      }

      return {
        ok: false,
        reason: "wrong-phase",
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
    if (locked.ok && locked.cancelled && onSessionEnded) {
      try {
        onSessionEnded(locked.session);
      } catch (_err) {
        /* ignore */
      }
    }
    return locked;
  }

  function expireJoin(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) {
        logCheckersLifecycle("join-timeout-skip", null, "reason=missing-session");
        return { ok: false, reason: "not-waiting" };
      }
      if (session.status !== STATUS.WAITING) {
        logCheckersLifecycle("join-timeout-skip", session, "reason=not-waiting");
        return { ok: false, reason: "not-waiting" };
      }
      if (session.phase !== PHASE.PVP_LOBBY) {
        logCheckersLifecycle("join-timeout-skip", session, "reason=wrong-phase");
        return { ok: false, reason: "not-waiting" };
      }
      const starter = session.players && session.players.b;
      if (!starter || isBotPlayer(starter)) {
        session.status = STATUS.EXPIRED;
        session.endReason = "join-timeout";
        finishOpen(session);
        logGameCleanup(GAME_TYPE.CHECKERS, FINAL_STATE.EMPTY);
        logCheckersLifecycle("lobby-expired", session);
        return {
          ok: true,
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }
      session.phase = PHASE.WAIT_PROMPT;
      session.lobbyEndsAt = null;
      manager.clearTimers(session);
      bumpBoardGeneration(session);
      logCheckersLifecycle("wait-prompt", session);
      return {
        ok: true,
        waitPrompt: true,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
    notifyRender(locked);
    if (
      locked.ok &&
      locked.session &&
      locked.session.status === STATUS.EXPIRED &&
      onSessionEnded
    ) {
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
    if (session.players.b && String(session.players.b.userId) === id) {
      return BLACK;
    }
    if (session.players.w && String(session.players.w.userId) === id) {
      return WHITE;
    }
    return null;
  }

  function bumpTurnGeneration(session) {
    session.turnGeneration = (session.turnGeneration || 0) + 1;
    return session.turnGeneration;
  }

  function invalidateTurnTimer(session) {
    bumpTurnGeneration(session);
    if (typeof manager.clearScheduled === "function") {
      manager.clearScheduled(session, "turn");
    }
  }

  function startTurnTimer(session) {
    const gen = bumpTurnGeneration(session);
    const sessionId = session.id;
    manager.schedule(session, "turn", turnTimeoutMs, () => {
      Promise.resolve()
        .then(() => resolveTurnTimeout(sessionId, gen))
        .catch(() => {});
    });
  }

  function beginPlayerTurn(session) {
    const player = session.players[session.currentPlayer];
    if (isBotPlayer(player)) {
      // Human clock must not run during bot think delay or bot hops.
      invalidateTurnTimer(session);
      scheduleBotMove(session);
      return;
    }
    startTurnTimer(session);
  }

  function finishWin(session, winnerSeat, endReason) {
    const winner = session.players[winnerSeat];
    session.status = STATUS.WON;
    session.winnerSeat = winnerSeat;
    session.winnerUserId = String(winner.userId);
    session.endReason = endReason;
    session.selectedSquare = null;
    session.pendingFrom = null;
    finishOpen(session);
    maybeMarkPairCooldown(session);
    logCheckersLifecycle("ended", session, `winnerSeat=${winnerSeat}`);
  }

  function applyEngineMove(session, from, to) {
    const applied = applyMove(boardState(session), from, to);
    if (!applied.ok) {
      return applied;
    }
    session.board = applied.state.board;
    session.currentPlayer = applied.state.current;
    session.pendingFrom = applied.state.pendingFrom;
    session.selectedSquare = applied.state.pendingFrom;
    session.lastMoveAt = manager.now();
    bumpBoardGeneration(session);

    if (applied.ended) {
      finishWin(session, applied.winner, "win");
      return {
        ok: true,
        ended: true,
        needsXp: true,
        questUsers: takeQuestUsers(session),
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    }

    beginPlayerTurn(session);
    return {
      ok: true,
      ended: false,
      session: snapshot(session),
      rendered: renderMessage(session, null, manager.now()),
    };
  }

  async function resolveTurnTimeout(sessionId, expectedGen) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.ACTIVE) {
        return { ok: false, reason: "not-active" };
      }
      if (expectedGen != null && session.turnGeneration !== expectedGen) {
        return { ok: false, reason: "stale-timer" };
      }
      if (session.winnerUserId != null) {
        return { ok: false, reason: "already-ended" };
      }
      if (isBotPlayer(session.players[session.currentPlayer])) {
        return { ok: false, reason: "bot-turn" };
      }
      const loserSeat = session.currentPlayer;
      const winnerSeat = loserSeat === BLACK ? WHITE : BLACK;
      finishWin(session, winnerSeat, "timeout");
      return {
        ok: true,
        needsXp: true,
        questUsers: takeQuestUsers(session),
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
    if (!locked.ok) {
      logCheckersLifecycle(
        "turn-timeout-skip",
        manager.getSession(sessionId),
        `reason=${locked.reason || "unknown"} expectedGen=${
          expectedGen == null ? "-" : expectedGen
        }`
      );
    } else {
      logCheckersLifecycle(
        "turn-timeout",
        manager.getSession(sessionId),
        `expectedGen=${expectedGen == null ? "-" : expectedGen}`
      );
    }
    if (locked.ok && onSessionEnded) {
      try {
        onSessionEnded(locked.session);
      } catch (_err) {
        /* ignore */
      }
    }
    notifyRender(locked);
    Promise.resolve(emitQuest(locked)).catch(() => {});
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
      if (session.status !== STATUS.WAITING || session.phase !== PHASE.PVP_LOBBY) {
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

      if (session.players.b && String(session.players.b.userId) === uid) {
        return { ok: false, reason: "already-joined" };
      }

      if (session.players.w) {
        return { ok: false, reason: "full" };
      }

      const reserved = reservation.tryReserve(uid, GAME_ID, session.id);
      if (!reserved.ok) {
        return { ok: false, reason: "player-busy" };
      }

      session.players.w = { userId: uid, displayName: name, isBot: false };
      activateMatch(session, "human");

      return {
        ok: true,
        role: WHITE,
        started: true,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
  }

  function select({ sessionId, userId, square, chatId, generation } = {}) {
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
      if (!isPlayableSquare(square)) {
        return { ok: false, reason: "bad-square" };
      }

      const seat = seatForUser(session, userId);
      if (!seat) {
        return { ok: false, reason: "outsider" };
      }
      function rejectSelect(reason) {
        return {
          ok: false,
          reason,
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }
      if (seat !== session.currentPlayer) {
        return rejectSelect("not-your-turn");
      }

      const selected = isPlayableSquare(session.selectedSquare)
        ? session.selectedSquare
        : isPlayableSquare(session.pendingFrom)
          ? session.pendingFrom
          : null;
      if (selected != null) {
        const liveDests = destinations(boardState(session), selected);
        if (liveDests.some((m) => m.to === square)) {
          const applied = applyEngineMove(session, selected, square);
          if (!applied.ok) {
            return rejectSelect(applied.reason || "illegal");
          }
          return { ...applied, moved: true };
        }
      }

      if (generationMismatch(session, generation)) {
        return rejectSelect("stale-board");
      }

      if (isPlayableSquare(session.pendingFrom)) {
        if (square !== session.pendingFrom) {
          return rejectSelect("must-continue");
        }
        session.selectedSquare = session.pendingFrom;
        bumpBoardGeneration(session);
        return {
          ok: true,
          continued: true,
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }

      if (session.selectedSquare === square) {
        session.selectedSquare = null;
        bumpBoardGeneration(session);
        return {
          ok: true,
          deselected: true,
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }

      const pieceSide = sideOf(session.board[square]);
      if (pieceSide == null) {
        return rejectSelect("empty");
      }
      if (pieceSide !== seat) {
        return rejectSelect("invalid-piece");
      }

      const dests = destinations(boardState(session), square);
      if (!dests.length) {
        if (captureFromSquares(session).length) {
          return rejectSelect("must-capture");
        }
        return rejectSelect("no-moves");
      }

      session.selectedSquare = square;
      bumpBoardGeneration(session);
      return {
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session, null, manager.now()),
      };
    });
  }

  async function move({ sessionId, userId, from, to, chatId, generation } = {}) {
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
      function rejectMove(reason) {
        return {
          ok: false,
          reason,
          session: snapshot(session),
          rendered: renderMessage(session, null, manager.now()),
        };
      }
      if (seat !== session.currentPlayer) {
        return rejectMove("not-your-turn");
      }
      if (generationMismatch(session, generation)) {
        return rejectMove("stale-board");
      }

      const applied = applyEngineMove(session, from, to);
      if (!applied.ok) {
        return rejectMove(applied.reason || "illegal");
      }
      return applied;
    });
    if (locked.ok && locked.ended && onSessionEnded) {
      try {
        onSessionEnded(locked.session);
      } catch (_err) {
        /* ignore */
      }
    }
    Promise.resolve(emitQuest(locked)).catch(() => {});
    return locked;
  }

  function scheduleBotMove(session) {
    session.botMoveGeneration = (session.botMoveGeneration || 0) + 1;
    const gen = session.botMoveGeneration;
    const sessionId = session.id;
    const chained = isPlayableSquare(session.pendingFrom);
    manager.schedule(session, "bot", botThinkDelay(chained), () => {
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
      const state = boardState(session);
      let choice = chooseCheckersBotMove(state, randomIntFn);
      if (!choice) {
        const moves = legalMoves(state);
        if (!moves.length) {
          const winnerSeat = seat === BLACK ? WHITE : BLACK;
          finishWin(session, winnerSeat, "win");
          return {
            ok: true,
            ended: true,
            needsXp: true,
            questUsers: takeQuestUsers(session),
            session: snapshot(session),
            rendered: renderMessage(session, null, manager.now()),
          };
        }
        choice = { from: moves[0].from, to: moves[0].to };
      }
      const applied = applyEngineMove(session, choice.from, choice.to);
      if (!applied.ok) {
        return { ok: false, reason: "illegal-bot" };
      }
      return applied;
    });
    if (locked.ok && locked.ended && onSessionEnded) {
      try {
        onSessionEnded(locked.session);
      } catch (_err) {
        /* ignore */
      }
    }
    notifyRender(locked);
    Promise.resolve(emitQuest(locked)).catch(() => {});
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
    log("[checkers] event=reset-all");
    manager.resetAll();
    reservation.reset();
  }

  return {
    GAME_ID,
    STATUS,
    startChallenge,
    setMessageId,
    join,
    select,
    move,
    chooseMode,
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

const checkersRuntime = createCheckersService({
  manager: getSharedPvpSessionManager(),
  reservation: getSharedPvpMatchReservation(),
});

function startCheckersChallenge(params) {
  return checkersRuntime.startChallenge(params);
}

function isCheckersOpen() {
  return checkersRuntime.isOpen();
}

function getCheckersRuntime() {
  return checkersRuntime;
}

module.exports = {
  GAME_ID,
  STATUS,
  PHASE,
  JOIN_TIMEOUT_MS,
  LOBBY_COUNTDOWN_MS,
  TURN_TIMEOUT_MS,
  PAIR_COOLDOWN_MS,
  BOT_THINK_MIN_MS,
  BOT_THINK_MAX_MS,
  BOT_CHAIN_THINK_MIN_MS,
  BOT_CHAIN_THINK_MAX_MS,
  BOT_USER_ID,
  PLAYER_BUSY_TEXT,
  MUST_CAPTURE_TOAST,
  NOT_YOUR_PIECE_TOAST,
  EMPTY_SQUARE_TOAST,
  STALE_BOARD_TOAST,
  NO_MOVES_TOAST,
  MARK_B,
  MARK_W,
  MARK_BK,
  MARK_WK,
  MARK_DEST,
  EMPTY_DARK,
  LIGHT_CELL,
  SQUARE_COUNT,
  emptyBoard,
  initialBoard,
  cloneBoard,
  formatBoard,
  legalMoves,
  buildJoinCallbackData,
  buildSelectCallbackData,
  buildMoveCallbackData,
  buildNoopCallbackData,
  buildModeCallbackData,
  parsePvpCallbackData,
  sanitizePvpDisplayName,
  createCheckersService,
  checkersRuntime,
  startCheckersChallenge,
  isCheckersOpen,
  getCheckersRuntime,
  renderMessage,
};
