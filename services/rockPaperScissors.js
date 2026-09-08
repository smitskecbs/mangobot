/**
 * Rock Paper Scissors — human PvP only (no bot fallback).
 * Private choices; public message shows ready/choosing status until both lock.
 */

const { Markup } = require("telegraf");
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
} = require("./pvpMatchReservation");
const {
  takeResolvedQuestUsers,
  emitResolvedPvpDailyQuest,
} = require("./pvpDailyQuest");
const { isAllowedChatFightChat } = require("./chatFight");
const {
  GAME_TYPE,
  FINAL_STATE,
  logGameCleanup,
} = require("../utils/gameCleanup");
const { emptyInlineKeyboardExtra } = require("../utils/expiredMessageCleanup");
const { buildPrivateDeepLink, resolveBotUsername } = require("../utils/botMenu");

const GAME_ID = "rps";
const JOIN_TIMEOUT_MS = 60 * 1000;
const CHOICE_TIMEOUT_MS = 45 * 1000;
const PAIR_COOLDOWN_MS = DEFAULT_PAIR_COOLDOWN_MS;

const STATUS = Object.freeze({
  WAITING: "waiting",
  ACTIVE: "active",
  WON: "won",
  DRAW: "draw",
  EXPIRED: "expired",
});

const PHASE = Object.freeze({
  START_CHOICE: "start_choice",
  LOBBY: "lobby",
  CHOOSING: "choosing",
  RESULT: "result",
});

const MOVES = Object.freeze(["rock", "paper", "scissors"]);
const MOVE_LABEL = Object.freeze({
  rock: "✊ Rock",
  paper: "✋ Paper",
  scissors: "✌️ Scissors",
});
const BEATS = Object.freeze({
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
});

function isMove(value) {
  return MOVES.includes(value);
}

function buildModeCallbackData(sessionId, mode) {
  return `pvp:rps:mode:${sessionId}:${mode}`;
}

function buildJoinCallbackData(sessionId) {
  return `pvp:rps:join:${sessionId}`;
}

function buildChoiceCallbackData(sessionId, round, move) {
  return `pvp:rps:choice:${sessionId}:${round}:${move}`;
}

function buildReplayCallbackData(sessionId, round) {
  return `pvp:rps:replay:${sessionId}:${round}`;
}

function buildFinishCallbackData(sessionId, round) {
  return `pvp:rps:finish:${sessionId}:${round}`;
}

function buildRetryCallbackData(sessionId) {
  return `pvp:rps:retry:${sessionId}`;
}

function parsePvpCallbackData(data) {
  if (typeof data !== "string" || !data.startsWith("pvp:rps:")) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length < 4 || parts[0] !== "pvp" || parts[1] !== "rps") {
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
  if (action === "mode") {
    if (parts.length !== 5) return null;
    const mode = parts[4];
    if (mode !== "pvp" && mode !== "cancel") return null;
    return { action: "mode", sessionId, mode, game: GAME_ID };
  }
  if (action === "choice") {
    if (parts.length !== 6) return null;
    const round = Number(parts[4]);
    const move = parts[5];
    if (!Number.isInteger(round) || round < 1) return null;
    if (!isMove(move)) return null;
    return { action: "choice", sessionId, round, move, game: GAME_ID };
  }
  if (action === "replay" || action === "finish") {
    if (parts.length !== 5) return null;
    const round = Number(parts[4]);
    if (!Number.isInteger(round) || round < 1) return null;
    return { action, sessionId, round, game: GAME_ID };
  }
  if (action === "retry") {
    if (parts.length !== 4) return null;
    return { action: "retry", sessionId, game: GAME_ID };
  }
  return null;
}

function buildStartKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👥 Wait for Opponent", buildModeCallbackData(sessionId, "pvp"))],
    [Markup.button.callback("❌ Cancel", buildModeCallbackData(sessionId, "cancel"))],
  ]);
}

function buildLobbyKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("JOIN GAME", buildJoinCallbackData(sessionId))],
    [Markup.button.callback("❌ Cancel", buildModeCallbackData(sessionId, "cancel"))],
  ]);
}

function buildExpiredLobbyKeyboard(sessionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔁 Try Again", buildRetryCallbackData(sessionId))],
    [Markup.button.callback("❌ Close", buildFinishCallbackData(sessionId, 1))],
  ]);
}

function buildResultKeyboard(sessionId, round) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔁 Play Again", buildReplayCallbackData(sessionId, round))],
    [Markup.button.callback("❌ Finish", buildFinishCallbackData(sessionId, round))],
  ]);
}

function buildChoiceKeyboard(sessionId, round) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✊ Rock", buildChoiceCallbackData(sessionId, round, "rock")),
      Markup.button.callback("✋ Paper", buildChoiceCallbackData(sessionId, round, "paper")),
    ],
    [Markup.button.callback("✌️ Scissors", buildChoiceCallbackData(sessionId, round, "scissors"))],
  ]);
}

function buildStartText() {
  return `✊✋✌️ Rock Paper Scissors

Challenge another ManGo member.`;
}

function p1Name(session) {
  return (session.players.p1 && session.players.p1.displayName) || "Player";
}

function p2Name(session) {
  return (session.players.p2 && session.players.p2.displayName) || "Player";
}

function buildLobbyText(session) {
  return `✊✋✌️ Rock Paper Scissors

${p1Name(session)} is looking for an opponent.

Players: 1/2`;
}

function readyLine(player, choice) {
  const name = player && player.displayName ? player.displayName : "Player";
  return choice ? `${name}: ✅ Ready` : `${name}: ⏳ Choosing...`;
}

function buildChoosingText(session, botUsername) {
  const url = buildPrivateDeepLink(botUsername, `rps_${session.id}`);
  const linkLine = url
    ? `\n🔒 Open ManGoBot privately to choose your move.`
    : `\n🔒 Open ManGoBot privately to choose your move.`;
  return `✊✋✌️ Rock Paper Scissors

${p1Name(session)} vs ${p2Name(session)}

Both players: choose your move privately.

${readyLine(session.players.p1, session.choices.p1)}
${readyLine(session.players.p2, session.choices.p2)}${linkLine}`;
}

function buildChoosingExtra(session, botUsername) {
  const url = buildPrivateDeepLink(botUsername, `rps_${session.id}`);
  if (!url) {
    return emptyInlineKeyboardExtra();
  }
  return Markup.inlineKeyboard([
    [Markup.button.url("🔒 Choose privately", url)],
  ]);
}

function buildPrivateChoiceText() {
  return `✊✋✌️ Rock Paper Scissors

Choose your move.`;
}

function buildLockedPrivateText(move) {
  return `✅ Choice locked: ${MOVE_LABEL[move]}

Waiting for your opponent...`;
}

function buildRevealText(session, xpResult) {
  const a = session.players.p1;
  const b = session.players.p2;
  const moveA = MOVE_LABEL[session.choices.p1];
  const moveB = MOVE_LABEL[session.choices.p2];
  let outcome;
  if (session.status === STATUS.DRAW) {
    outcome = "🤝 Draw!";
  } else {
    const winnerName =
      String(session.winnerUserId) === String(a.userId) ? a.displayName : b.displayName;
    outcome = `🏆 ${winnerName} wins!`;
  }
  let xpLine = "";
  if (session.status === STATUS.WON) {
    if (xpResult && xpResult.awarded) {
      xpLine = `\n\n+${xpResult.pointsToAdd} PvP XP 🥭`;
    } else if (!session.rewardEligible) {
      xpLine = "\n\nPvP XP already earned with this opponent recently. 🥭";
    }
  }
  return `✊✋✌️ Rock Paper Scissors

${a.displayName}: ${moveA}
${b.displayName}: ${moveB}

${outcome}${xpLine}`;
}

function buildExpiredLobbyText() {
  return `✊✋✌️ Rock Paper Scissors

⏳ No opponent joined.`;
}

function buildExpiredChoiceText() {
  return `✊✋✌️ Rock Paper Scissors

⏳ Round expired — one or both players did not choose in time.`;
}

function buildCancelledText() {
  return `✊✋✌️ Rock Paper Scissors

Challenge cancelled.`;
}

function publicTextHasSecret(text, session) {
  if (!text || !session) return false;
  const secrets = [];
  if (session.choices.p1) secrets.push(MOVE_LABEL[session.choices.p1]);
  if (session.choices.p2) secrets.push(MOVE_LABEL[session.choices.p2]);
  return secrets.some((label) => text.includes(label));
}

function createRockPaperScissorsService(options = {}) {
  const joinTimeoutMs =
    typeof options.joinTimeoutMs === "number" ? options.joinTimeoutMs : JOIN_TIMEOUT_MS;
  const choiceTimeoutMs =
    typeof options.choiceTimeoutMs === "number"
      ? options.choiceTimeoutMs
      : CHOICE_TIMEOUT_MS;
  const pairCooldownMs =
    typeof options.pairCooldownMs === "number"
      ? options.pairCooldownMs
      : PAIR_COOLDOWN_MS;
  const botUsername =
    typeof options.botUsername === "string" ? options.botUsername : null;

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

  let renderHandler =
    typeof options.onRender === "function" ? options.onRender : null;

  function setRenderHandler(fn) {
    renderHandler = typeof fn === "function" ? fn : null;
  }

  function notifyRender(result) {
    if (!result || !result.ok || !renderHandler) return;
    try {
      renderHandler(result);
    } catch (_err) {
      /* ignore */
    }
  }

  function resolveUsername(ctx) {
    if (botUsername) return botUsername;
    return resolveBotUsername(ctx) || null;
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
        phase: session.phase,
        round: session.round,
        players: session.players,
        choices: session.choices,
        createdAt: session.createdAt,
        lobbyEndsAt: session.lobbyEndsAt,
        choiceEndsAt: session.choiceEndsAt,
        startedAt: session.startedAt,
        winnerUserId: session.winnerUserId,
        winnerSeat: session.winnerSeat,
        rewardEligible: session.rewardEligible,
        xpAwarded: session.xpAwarded,
        questNoted: Boolean(session.questNoted),
        endReason: session.endReason || null,
        opponentType: session.opponentType || "human",
        turnGeneration: session.round,
      })
    );
  }

  function finishOpen(session) {
    manager.clearTimers(session);
    manager.clearActiveIndex(session);
    reservation.releaseMatch(session.id);
  }

  function starterUserId(session) {
    return session && session.players && session.players.p1
      ? String(session.players.p1.userId)
      : null;
  }

  function seatForUser(session, userId) {
    const id = String(userId);
    if (session.players.p1 && String(session.players.p1.userId) === id) return "p1";
    if (session.players.p2 && String(session.players.p2.userId) === id) return "p2";
    return null;
  }

  function renderMessage(session, xpResult, ctx) {
    const username = resolveUsername(ctx);
    if (session.status === STATUS.WAITING && session.phase === PHASE.START_CHOICE) {
      return { text: buildStartText(), extra: buildStartKeyboard(session.id) };
    }
    if (session.status === STATUS.WAITING && session.phase === PHASE.LOBBY) {
      return { text: buildLobbyText(session), extra: buildLobbyKeyboard(session.id) };
    }
    if (session.status === STATUS.ACTIVE && session.phase === PHASE.CHOOSING) {
      return {
        text: buildChoosingText(session, username),
        extra: buildChoosingExtra(session, username),
      };
    }
    if (session.status === STATUS.WON || session.status === STATUS.DRAW) {
      return {
        text: buildRevealText(session, xpResult),
        extra: buildResultKeyboard(session.id, session.round),
      };
    }
    if (session.status === STATUS.EXPIRED) {
      if (session.endReason === "join-timeout") {
        return {
          text: buildExpiredLobbyText(),
          extra: buildExpiredLobbyKeyboard(session.id),
        };
      }
      if (session.endReason === "choice-timeout") {
        return {
          text: buildExpiredChoiceText(),
          extra: buildResultKeyboard(session.id, session.round),
        };
      }
      return { text: buildCancelledText(), extra: emptyInlineKeyboardExtra() };
    }
    return { text: "✊✋✌️ Rock Paper Scissors", extra: emptyInlineKeyboardExtra() };
  }

  function privatePromptsFor(session) {
    const round = session.round;
    const prompts = [];
    for (const seat of ["p1", "p2"]) {
      const player = session.players[seat];
      if (!player || player.userId == null) continue;
      if (session.choices[seat]) {
        prompts.push({
          userId: player.userId,
          text: buildLockedPrivateText(session.choices[seat]),
          extra: emptyInlineKeyboardExtra(),
          alreadyLocked: true,
        });
      } else {
        prompts.push({
          userId: player.userId,
          text: buildPrivateChoiceText(),
          extra: buildChoiceKeyboard(session.id, round),
          alreadyLocked: false,
        });
      }
    }
    return prompts;
  }

  function beginChoosing(session) {
    session.status = STATUS.ACTIVE;
    session.phase = PHASE.CHOOSING;
    session.startedAt = manager.now();
    session.choiceEndsAt = session.startedAt + choiceTimeoutMs;
    session.choices = { p1: null, p2: null };
    session.winnerUserId = null;
    session.winnerSeat = null;
    session.xpAwarded = false;
    session.questNoted = false;
    session.endReason = null;
    manager.clearScheduled(session, "join");
    manager.schedule(session, "turn", choiceTimeoutMs, () => {
      expireChoice(session.id);
    });
  }

  function activateHumanMatch(session) {
    const onCooldown = manager.isPairOnCooldown(
      session.players.p1.userId,
      session.players.p2.userId,
      GAME_ID
    );
    session.rewardEligible = !onCooldown;
    session.opponentType = "human";
    manager.markPairCooldown(
      session.players.p1.userId,
      session.players.p2.userId,
      GAME_ID
    );
    beginChoosing(session);
  }

  function takeQuestUsers(session) {
    return takeResolvedQuestUsers(session, () => false);
  }

  async function emitQuest(result) {
    if (!result || !result.ok || !result.questUsers) return;
    await emitResolvedPvpDailyQuest(result.questUsers, GAME_ID, {
      opponentType: "human",
      matchId: result.session && result.session.id,
      shopFile: options.shopFile,
      walletFile: options.walletFile,
      pointsFile: options.pointsFile,
      noteDailyQuestGameFn: options.noteDailyQuestGameFn,
      noteHumanPvpMatchFn: options.noteHumanPvpMatchFn,
    });
  }

  function resolveRound(session) {
    const a = session.choices.p1;
    const b = session.choices.p2;
    if (a === b) {
      session.status = STATUS.DRAW;
      session.phase = PHASE.RESULT;
      session.endReason = "draw";
      session.winnerUserId = null;
      session.winnerSeat = null;
      finishOpen(session);
      return { draw: true, needsXp: false };
    }
    const winnerSeat = BEATS[a] === b ? "p1" : "p2";
    session.status = STATUS.WON;
    session.phase = PHASE.RESULT;
    session.endReason = "win";
    session.winnerSeat = winnerSeat;
    session.winnerUserId = String(session.players[winnerSeat].userId);
    finishOpen(session);
    return { draw: false, needsXp: true };
  }

  function isOpen() {
    return manager.hasAnyOpenGame(GAME_ID);
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
      phase: PHASE.START_CHOICE,
      round: 1,
      players: {
        p1: {
          userId: String(starter.userId),
          displayName: sanitizePvpDisplayName(starter.displayName),
          isBot: false,
        },
        p2: null,
      },
      choices: { p1: null, p2: null },
      createdAt: now,
      lobbyEndsAt: null,
      choiceEndsAt: null,
      startedAt: null,
      winnerUserId: null,
      winnerSeat: null,
      rewardEligible: true,
      xpAwarded: false,
      questNoted: false,
      endReason: null,
      opponentType: "human",
      timers: {
        joinTimeoutId: null,
        turnTimeoutId: null,
        countdownTimeoutId: null,
        botTimeoutId: null,
      },
    };
    manager.registerSession(session);
    log("[pvp] match started game=rps mode=choice");
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

  function beginPvpLobby(session) {
    session.phase = PHASE.LOBBY;
    session.status = STATUS.WAITING;
    session.lobbyEndsAt = manager.now() + joinTimeoutMs;
    manager.schedule(session, "join", joinTimeoutMs, () => {
      expireJoin(session.id);
    });
    log("[pvp] match started game=rps mode=lobby");
  }

  function cancelSession(session, endReason) {
    session.status = STATUS.EXPIRED;
    session.endReason = endReason;
    session.phase = PHASE.START_CHOICE;
    finishOpen(session);
    logGameCleanup(GAME_TYPE.RPS, FINAL_STATE.CANCELLED);
  }

  function chooseMode({ sessionId, userId, mode, chatId } = {}) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) return { ok: false, reason: "invalid-session" };
      if (chatId != null && String(chatId) !== String(session.chatId)) {
        return { ok: false, reason: "wrong-chat" };
      }
      if (userId == null) return { ok: false, reason: "no-user" };
      if (String(userId) !== starterUserId(session)) {
        return { ok: false, reason: "not-starter" };
      }
      if (session.status !== STATUS.WAITING) {
        return {
          ok: false,
          reason: "not-waiting",
          session: snapshot(session),
          rendered: renderMessage(session),
        };
      }
      if (mode === "cancel") {
        cancelSession(session, "cancelled");
        return {
          ok: true,
          cancelled: true,
          session: snapshot(session),
          rendered: renderMessage(session),
        };
      }
      if (mode === "pvp") {
        if (session.phase !== PHASE.START_CHOICE) {
          return { ok: false, reason: "wrong-phase" };
        }
        beginPvpLobby(session);
        return {
          ok: true,
          waiting: true,
          session: snapshot(session),
          rendered: renderMessage(session),
        };
      }
      return { ok: false, reason: "bad-mode" };
    });
    notifyRender(locked);
    return locked;
  }

  function expireJoin(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.WAITING) {
        return { ok: false, reason: "not-waiting" };
      }
      session.status = STATUS.EXPIRED;
      session.endReason = "join-timeout";
      finishOpen(session);
      logGameCleanup(GAME_TYPE.RPS, FINAL_STATE.NOT_ENOUGH);
      return {
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session),
      };
    });
    notifyRender(locked);
    return locked;
  }

  function expireChoice(sessionId) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session || session.status !== STATUS.ACTIVE) {
        return { ok: false, reason: "not-active" };
      }
      session.status = STATUS.EXPIRED;
      session.phase = PHASE.RESULT;
      session.endReason = "choice-timeout";
      finishOpen(session);
      logGameCleanup(GAME_TYPE.RPS, FINAL_STATE.EXPIRED);
      return {
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session),
        needsXp: false,
      };
    });
    notifyRender(locked);
    return locked;
  }

  function join({ sessionId, userId, displayName, chatId, isBot } = {}) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) return { ok: false, reason: "invalid-session" };
      if (chatId != null && String(chatId) !== String(session.chatId)) {
        return { ok: false, reason: "wrong-chat" };
      }
      if (session.status !== STATUS.WAITING || session.phase !== PHASE.LOBBY) {
        return { ok: false, reason: "not-waiting" };
      }
      if (isBot) return { ok: false, reason: "bot" };
      if (userId == null) return { ok: false, reason: "no-user" };
      if (String(userId) === starterUserId(session)) {
        return { ok: false, reason: "already-joined" };
      }
      if (session.players.p2) {
        return { ok: false, reason: "full" };
      }
      const reserved = reservation.tryReserve(userId, GAME_ID, session.id);
      if (!reserved.ok) {
        return { ok: false, reason: "player-busy" };
      }
      session.players.p2 = {
        userId: String(userId),
        displayName: sanitizePvpDisplayName(displayName),
        isBot: false,
      };
      activateHumanMatch(session);
      return {
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session),
        privatePrompts: privatePromptsFor(session),
      };
    });
    notifyRender(locked);
    return locked;
  }

  function choose({ sessionId, userId, move, round, chatId, source } = {}) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) return { ok: false, reason: "invalid-session" };
      if (
        source !== "private" &&
        chatId != null &&
        String(chatId) !== String(session.chatId)
      ) {
        return { ok: false, reason: "wrong-chat" };
      }
      if (session.status !== STATUS.ACTIVE || session.phase !== PHASE.CHOOSING) {
        return { ok: false, reason: "not-active" };
      }
      if (round != null && Number(round) !== Number(session.round)) {
        return { ok: false, reason: "stale-round" };
      }
      const seat = seatForUser(session, userId);
      if (!seat) return { ok: false, reason: "outsider" };
      if (!isMove(move)) return { ok: false, reason: "bad-move" };
      if (session.choices[seat]) {
        return {
          ok: false,
          reason: "already-chosen",
          session: snapshot(session),
          privateEdit: {
            text: buildLockedPrivateText(session.choices[seat]),
            extra: emptyInlineKeyboardExtra(),
          },
        };
      }
      session.choices[seat] = move;
      const both = Boolean(session.choices.p1 && session.choices.p2);
      let outcome = { draw: false, needsXp: false };
      let questUsers = null;
      if (both) {
        outcome = resolveRound(session);
        questUsers = takeQuestUsers(session);
      }
      return {
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session),
        privateEdit: {
          text: both
            ? `✅ Choice locked: ${MOVE_LABEL[move]}`
            : buildLockedPrivateText(move),
          extra: emptyInlineKeyboardExtra(),
        },
        needsXp: outcome.needsXp,
        questUsers,
        resolved: both,
      };
    });
    notifyRender(locked);
    return emitQuest(locked).then(() => locked);
  }

  function replay({ sessionId, userId, round, chatId } = {}) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) return { ok: false, reason: "invalid-session" };
      if (chatId != null && String(chatId) !== String(session.chatId)) {
        return { ok: false, reason: "wrong-chat" };
      }
      const seat = seatForUser(session, userId);
      if (!seat) return { ok: false, reason: "outsider" };
      if (round != null && Number(round) !== Number(session.round)) {
        return { ok: false, reason: "stale-round" };
      }
      const replayable =
        session.status === STATUS.WON ||
        session.status === STATUS.DRAW ||
        (session.status === STATUS.EXPIRED && session.endReason === "choice-timeout");
      if (!replayable) {
        return { ok: false, reason: "not-active" };
      }
      const p1 = session.players.p1;
      const p2 = session.players.p2;
      if (!p1 || !p2) return { ok: false, reason: "not-active" };
      const r1 = reservation.tryReserve(p1.userId, GAME_ID, session.id);
      if (!r1.ok) return { ok: false, reason: "player-busy" };
      const r2 = reservation.tryReserve(p2.userId, GAME_ID, session.id);
      if (!r2.ok) {
        reservation.release(p1.userId, session.id);
        return { ok: false, reason: "player-busy" };
      }
      manager.registerSession(session);
      session.round += 1;
      beginChoosing(session);
      return {
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session),
        privatePrompts: privatePromptsFor(session),
      };
    });
    notifyRender(locked);
    return locked;
  }

  function finish({ sessionId, userId, round, chatId } = {}) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) return { ok: false, reason: "invalid-session" };
      if (chatId != null && String(chatId) !== String(session.chatId)) {
        return { ok: false, reason: "wrong-chat" };
      }
      const seat = seatForUser(session, userId);
      const isStarter = String(userId) === starterUserId(session);
      if (!seat && !isStarter) return { ok: false, reason: "outsider" };
      if (round != null && Number(round) !== Number(session.round)) {
        if (session.status === STATUS.WAITING || session.status === STATUS.ACTIVE) {
          return { ok: false, reason: "stale-round" };
        }
      }
      if (session.status === STATUS.WAITING || session.status === STATUS.ACTIVE) {
        return { ok: false, reason: "not-waiting" };
      }
      session.status = STATUS.EXPIRED;
      if (!session.endReason) session.endReason = "finished";
      finishOpen(session);
      return {
        ok: true,
        session: snapshot(session),
        rendered: { text: buildCancelledText(), extra: emptyInlineKeyboardExtra() },
      };
    });
    notifyRender(locked);
    return locked;
  }

  function retry({ sessionId, userId, chatId } = {}) {
    const locked = manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) return { ok: false, reason: "invalid-session" };
      if (chatId != null && String(chatId) !== String(session.chatId)) {
        return { ok: false, reason: "wrong-chat" };
      }
      if (String(userId) !== starterUserId(session)) {
        return { ok: false, reason: "not-starter" };
      }
      if (session.status !== STATUS.EXPIRED || session.endReason !== "join-timeout") {
        return { ok: false, reason: "not-waiting" };
      }
      const reserved = reservation.tryReserve(userId, GAME_ID, session.id);
      if (!reserved.ok) return { ok: false, reason: "player-busy" };
      session.players.p2 = null;
      session.choices = { p1: null, p2: null };
      session.round = 1;
      session.winnerUserId = null;
      session.winnerSeat = null;
      session.xpAwarded = false;
      session.questNoted = false;
      session.endReason = null;
      manager.registerSession(session);
      beginPvpLobby(session);
      return {
        ok: true,
        session: snapshot(session),
        rendered: renderMessage(session),
      };
    });
    notifyRender(locked);
    return locked;
  }

  function claimXpAward(sessionId) {
    return manager.withSessionLock(sessionId, () => {
      const session = manager.getSession(sessionId);
      if (!session) return { ok: false, reason: "invalid-session" };
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
    if (!session) return null;
    return renderMessage(session, xpResult);
  }

  function getSession(sessionId) {
    return snapshot(manager.getSession(sessionId));
  }

  function getPrivateView(userId, sessionId) {
    const session = sessionId
      ? manager.getSession(sessionId)
      : null;
    let live = session;
    if (!live) {
      const held = reservation.get(userId);
      if (held && held.game === GAME_ID) {
        live = manager.getSession(held.matchId);
      }
    }
    if (!live) return { ok: false, reason: "no-session" };
    const seat = seatForUser(live, userId);
    if (!seat) return { ok: false, reason: "outsider" };
    if (live.status !== STATUS.ACTIVE || live.phase !== PHASE.CHOOSING) {
      if (live.choices[seat]) {
        return {
          ok: true,
          text: `✅ Choice locked: ${MOVE_LABEL[live.choices[seat]]}`,
          extra: emptyInlineKeyboardExtra(),
        };
      }
      return { ok: false, reason: "not-active" };
    }
    if (live.choices[seat]) {
      return {
        ok: true,
        text: buildLockedPrivateText(live.choices[seat]),
        extra: emptyInlineKeyboardExtra(),
      };
    }
    return {
      ok: true,
      text: buildPrivateChoiceText(),
      extra: buildChoiceKeyboard(live.id, live.round),
    };
  }

  function reset() {
    manager.resetAll();
    reservation.reset();
  }

  return {
    GAME_ID,
    STATUS,
    PHASE,
    startChallenge,
    setMessageId,
    chooseMode,
    join,
    choose,
    replay,
    finish,
    retry,
    expireJoin,
    expireChoice,
    claimXpAward,
    applyXpResultToRender,
    getSession,
    getPrivateView,
    renderMessage,
    setRenderHandler,
    isOpen,
    reset,
    reservation,
    manager,
  };
}

const rpsRuntime = createRockPaperScissorsService({
  manager: getSharedPvpSessionManager(),
  reservation: getSharedPvpMatchReservation(),
});

function startRockPaperScissorsChallenge(params) {
  return rpsRuntime.startChallenge(params);
}

function isRockPaperScissorsOpen() {
  return rpsRuntime.isOpen();
}

function getRockPaperScissorsRuntime() {
  return rpsRuntime;
}

module.exports = {
  GAME_ID,
  JOIN_TIMEOUT_MS,
  CHOICE_TIMEOUT_MS,
  MOVES,
  MOVE_LABEL,
  BEATS,
  STATUS,
  PHASE,
  PLAYER_BUSY_TEXT,
  parsePvpCallbackData,
  buildModeCallbackData,
  buildJoinCallbackData,
  buildChoiceCallbackData,
  buildReplayCallbackData,
  buildFinishCallbackData,
  buildRetryCallbackData,
  publicTextHasSecret,
  createRockPaperScissorsService,
  startRockPaperScissorsChallenge,
  isRockPaperScissorsOpen,
  getRockPaperScissorsRuntime,
  rpsRuntime,
};
