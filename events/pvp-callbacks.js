/**
 * PvP inline callbacks — Tic-Tac-Toe, Connect Four, Checkers, and Rock Paper Scissors.
 * Callback data: pvp:ttt:... | pvp:c4:... | pvp:chk:... | pvp:rps:...  (opaque session ids, never uids)
 */

const { log, error: logError, formatErrorForLog } = require("../utils/logger");
const { awardPvpWinXp } = require("../services/points");
const { PLAYER_BUSY_TEXT } = require("../services/pvpMatchReservation");
const {
  parsePvpCallbackData: parseTttCallbackData,
  sanitizePvpDisplayName,
  getTicTacToeRuntime,
} = require("../services/ticTacToe");
const {
  parsePvpCallbackData: parseC4CallbackData,
  getConnectFourRuntime,
} = require("../services/connectFour");
const {
  parsePvpCallbackData: parseChkCallbackData,
  getCheckersRuntime,
  MUST_CAPTURE_TOAST,
  NOT_YOUR_PIECE_TOAST,
  EMPTY_SQUARE_TOAST,
  STALE_BOARD_TOAST,
  NO_MOVES_TOAST,
} = require("../services/checkers");
const {
  parsePvpCallbackData: parseRpsCallbackData,
  getRockPaperScissorsRuntime,
} = require("../services/rockPaperScissors");
const {
  GAME_OVER_TOAST,
  GAME_TYPE,
  scheduleGameMessageCleanup,
  clearGameMessageCleanup,
  handleStaleGameCallback,
} = require("../utils/gameCleanup");

function pvpCleanupGameType(runtime, session) {
  const id = (session && session.game) || (runtime && runtime.GAME_ID);
  if (id === "connect4") {
    return GAME_TYPE.CONNECT4;
  }
  if (id === "checkers") {
    return GAME_TYPE.CHECKERS;
  }
  if (id === "rps") {
    return GAME_TYPE.RPS;
  }
  return GAME_TYPE.TICTACTOE;
}

function isPvpTerminalStatus(status) {
  return status === "won" || status === "draw" || status === "expired";
}

function isRpsReplayableIntermission(session) {
  if (!session || session.game !== "rps") {
    return false;
  }
  if (session.status === "won" || session.status === "draw") {
    return true;
  }
  return (
    session.status === "expired" &&
    (session.endReason === "choice-timeout" || session.endReason === "join-timeout")
  );
}

function shouldSchedulePvpMessageCleanup(runtime, session) {
  if (!session || !isPvpTerminalStatus(session.status)) {
    return false;
  }
  const gameId = session.game || (runtime && runtime.GAME_ID);
  if (gameId === "rps" && isRpsReplayableIntermission(session)) {
    return false;
  }
  return true;
}

function pvpSnapshotStillCurrent(runtime, sessionSnap) {
  if (!sessionSnap || !runtime || typeof runtime.getSession !== "function") {
    return true;
  }
  const live = runtime.getSession(sessionSnap.id);
  if (!live) {
    return false;
  }
  if (live.status !== sessionSnap.status) {
    return false;
  }
  if (
    sessionSnap.turnGeneration != null &&
    live.turnGeneration != null &&
    Number(live.turnGeneration) !== Number(sessionSnap.turnGeneration)
  ) {
    return false;
  }
  if (
    sessionSnap.boardGeneration != null &&
    live.boardGeneration != null &&
    Number(live.boardGeneration) !== Number(sessionSnap.boardGeneration)
  ) {
    return false;
  }
  return true;
}

function pvpCleanupGeneration(session) {
  if (!session) {
    return null;
  }
  if (session.round != null) {
    return session.round;
  }
  if (session.turnGeneration != null) {
    return session.turnGeneration;
  }
  if (session.boardGeneration != null) {
    return session.boardGeneration;
  }
  return null;
}

function pvpShouldDeleteMessage(runtime, sessionId, messageId, generation) {
  return () => {
    if (!runtime || typeof runtime.getSession !== "function") {
      return true;
    }
    const live = runtime.getSession(sessionId);
    if (!live) {
      return true;
    }
    if (live.status === "waiting" || live.status === "active") {
      return false;
    }
    if (isRpsReplayableIntermission(live)) {
      return false;
    }
    if (
      messageId != null &&
      live.messageId != null &&
      String(live.messageId) !== String(messageId)
    ) {
      return false;
    }
    if (
      generation != null &&
      live.round != null &&
      String(live.round) !== String(generation)
    ) {
      return false;
    }
    if (
      generation != null &&
      live.turnGeneration != null &&
      sessionHasTurnGeneration(live) &&
      String(live.turnGeneration) !== String(generation)
    ) {
      return false;
    }
    return true;
  };
}

function sessionHasTurnGeneration(session) {
  return session && session.round == null && session.turnGeneration != null;
}

function schedulePvpSessionCleanup(session, telegram, gameType, runtime) {
  if (!shouldSchedulePvpMessageCleanup(runtime, session)) {
    return;
  }
  if (session.messageId == null || session.chatId == null) {
    return;
  }
  const generation = pvpCleanupGeneration(session);
  log(
    `[pvp] schedule-message-cleanup game=${gameType || "-"} session=${
      session.id || "-"
    } status=${session.status || "-"} endReason=${session.endReason || "-"}`
  );
  scheduleGameMessageCleanup({
    gameType,
    sessionId: session.id,
    chatId: session.chatId,
    messageIds: [session.messageId],
    generation,
    telegram,
    shouldDeleteFn: pvpShouldDeleteMessage(
      runtime,
      session.id,
      session.messageId,
      generation
    ),
  });
}

function pvpGameType(parsed) {
  if (parsed && parsed.game === "connect4") {
    return GAME_TYPE.CONNECT4;
  }
  if (parsed && parsed.game === "checkers") {
    return GAME_TYPE.CHECKERS;
  }
  if (parsed && parsed.game === "rps") {
    return GAME_TYPE.RPS;
  }
  return GAME_TYPE.TICTACTOE;
}

function isPrivateCtx(ctx) {
  return Boolean(ctx && ctx.chat && ctx.chat.type === "private");
}

async function editPublicSessionMessage(ctx, session, rendered) {
  if (!session || session.messageId == null || !rendered || !rendered.text) {
    return false;
  }
  const telegram = ctx && ctx.telegram;
  if (telegram && typeof telegram.editMessageText === "function") {
    try {
      await telegram.editMessageText(
        session.chatId,
        session.messageId,
        undefined,
        rendered.text,
        rendered.extra || undefined
      );
      return true;
    } catch (err) {
      logError(
        "[pvp] public edit failed:",
        err && err.message ? err.message : err
      );
    }
  }
  if (!isPrivateCtx(ctx)) {
    return safeEdit(ctx, rendered.text, rendered.extra);
  }
  return false;
}

function cbAnswer(ctx, text) {
  try {
    if (ctx && typeof ctx.answerCbQuery === "function") {
      return Promise.resolve(ctx.answerCbQuery(text || "")).catch(() => {});
    }
  } catch (_err) {
    return Promise.resolve();
  }
  return Promise.resolve();
}

async function rejectStalePvp(ctx, runtime, parsed) {
  const session =
    runtime && parsed && typeof runtime.getSession === "function"
      ? runtime.getSession(parsed.sessionId)
      : null;
  const live =
    session && (session.status === "waiting" || session.status === "active");
  if (live) {
    await cbAnswer(ctx, "This game already started.");
    if (typeof runtime.renderMessage === "function") {
      const rendered = runtime.renderMessage(session);
      if (rendered && rendered.text) {
        await safeEdit(ctx, rendered.text, rendered.extra);
      }
    }
    return;
  }
  if (isRpsReplayableIntermission(session)) {
    await cbAnswer(ctx, GAME_OVER_TOAST);
    if (typeof runtime.renderMessage === "function") {
      const rendered = runtime.renderMessage(session);
      if (rendered && rendered.text) {
        await safeEdit(ctx, rendered.text, rendered.extra);
      }
    }
    return;
  }
  let text;
  if (session && runtime && typeof runtime.renderMessage === "function") {
    const rendered = runtime.renderMessage(session);
    text = rendered && rendered.text;
  }
  log(
    `[pvp] stale-callback game=${parsed.game || "-"} session=${
      parsed.sessionId || "-"
    } present=${Boolean(session)} status=${(session && session.status) || "-"} endReason=${
      (session && session.endReason) || "-"
    } endedCopy=${text ? "session-render" : "default-cancelled"}`
  );
  const generation = pvpCleanupGeneration(session);
  await handleStaleGameCallback(ctx, {
    gameType: pvpGameType(parsed),
    sessionId: parsed && parsed.sessionId,
    text,
    toast: GAME_OVER_TOAST,
    generation,
    telegram: ctx && ctx.telegram,
    shouldDeleteFn: pvpShouldDeleteMessage(
      runtime,
      parsed && parsed.sessionId,
      callbackMessageIdSafe(ctx),
      generation
    ),
  });
}

function callbackMessageIdSafe(ctx) {
  const message =
    ctx && ctx.callbackQuery && ctx.callbackQuery.message
      ? ctx.callbackQuery.message
      : null;
  return message && message.message_id != null ? message.message_id : null;
}

async function safeEdit(ctx, text, extra) {
  try {
    if (typeof ctx.editMessageText === "function") {
      await ctx.editMessageText(text, extra || undefined);
      return true;
    }
  } catch (err) {
    logError(
      "[pvp] editMessageText failed:",
      err && err.message ? err.message : err
    );
  }
  return false;
}

async function applyRenderedEdit(ctx, runtime, parsed, rendered) {
  let edited = false;
  if (rendered && rendered.text) {
    edited = await safeEdit(ctx, rendered.text, rendered.extra);
  }
  if (!edited && parsed && parsed.game === "checkers") {
    await refreshLivePvpBoard(ctx, runtime, parsed.sessionId);
  } else if (!edited && parsed && parsed.game === "tictactoe") {
    await refreshLivePvpBoard(ctx, runtime, parsed.sessionId);
  }
  return edited;
}

async function refreshLivePvpBoard(ctx, runtime, sessionId) {
  if (
    !runtime ||
    typeof runtime.getSession !== "function" ||
    typeof runtime.renderMessage !== "function"
  ) {
    return false;
  }
  const live = runtime.getSession(sessionId);
  if (!live) {
    return false;
  }
  const fresh = runtime.renderMessage(live);
  if (!fresh || !fresh.text) {
    return false;
  }
  return safeEdit(ctx, fresh.text, fresh.extra);
}

async function finalizeWinXp(runtime, sessionId, awardXpFn) {
  const claim = runtime.claimXpAward(sessionId);
  if (!claim.ok || !claim.shouldAward) {
    const rendered = runtime.applyXpResultToRender(sessionId, {
      awarded: false,
      reason: claim.reason || "none",
      pointsToAdd: 0,
    });
    return { xpResult: null, rendered, claim };
  }

  let xpResult;
  try {
    xpResult = await Promise.resolve(
      awardXpFn(claim.winnerUserId, claim.winnerName || "Player")
    );
  } catch (err) {
    logError(
      "[pvp] awardPvpWinXp failed:",
      err && err.message ? err.message : err
    );
    xpResult = { awarded: false, reason: "award-error", pointsToAdd: 0 };
  }

  const rendered = runtime.applyXpResultToRender(sessionId, xpResult);
  return { xpResult, rendered, claim };
}

function wireTimeoutMessageEdits(runtime, telegram, awardXpFn) {
  if (!runtime || !telegram || typeof telegram.editMessageText !== "function") {
    return;
  }
  if (runtime.__pvpTimeoutWired) {
    return;
  }
  runtime.__pvpTimeoutWired = true;

  const editSessionMessage = async (sessionSnap, rendered) => {
    if (!sessionSnap || sessionSnap.messageId == null || !rendered) return;
    if (!pvpSnapshotStillCurrent(runtime, sessionSnap)) {
      return;
    }
    try {
      await telegram.editMessageText(
        sessionSnap.chatId,
        sessionSnap.messageId,
        undefined,
        rendered.text,
        rendered.extra || undefined
      );
    } catch (err) {
      logError(
        "[pvp] timeout edit failed:",
        err && err.message ? err.message : err
      );
      return;
    }
    if (pvpSnapshotStillCurrent(runtime, sessionSnap)) {
      return;
    }
    const live =
      typeof runtime.getSession === "function"
        ? runtime.getSession(sessionSnap.id)
        : null;
    if (!live || typeof runtime.renderMessage !== "function") {
      return;
    }
    const fresh = runtime.renderMessage(live);
    if (!fresh || !fresh.text) {
      return;
    }
    try {
      await telegram.editMessageText(
        live.chatId,
        live.messageId,
        undefined,
        fresh.text,
        fresh.extra || undefined
      );
    } catch (err) {
      logError(
        "[pvp] timeout edit failed:",
        err && err.message ? err.message : err
      );
    }
  };

  const handleTimedResult = async (result) => {
    if (!result || !result.ok || !result.session) {
      return;
    }
    if (result.rendered) {
      await editSessionMessage(result.session, result.rendered);
    }
    let rendered = result.rendered;
    if (result.needsXp) {
      const fin = await finalizeWinXp(runtime, result.session.id, awardXpFn);
      if (fin.rendered) {
        rendered = fin.rendered;
      }
      if (rendered) {
        await editSessionMessage(result.session, rendered);
      }
    }
    const live =
      typeof runtime.getSession === "function"
        ? runtime.getSession(result.session.id)
        : result.session;
    schedulePvpSessionCleanup(
      live,
      telegram,
      pvpCleanupGameType(runtime, live || result.session),
      runtime
    );
  };

  if (typeof runtime.setRenderHandler === "function") {
    runtime.setRenderHandler((result) => {
      Promise.resolve(handleTimedResult(result)).catch(() => {});
    });
    return;
  }

  const origExpire = runtime.expireJoin.bind(runtime);
  runtime.expireJoin = (sessionId) => {
    const result = origExpire(sessionId);
    return Promise.resolve(result).then((resolved) => {
      if (resolved && resolved.ok && resolved.rendered) {
        return handleTimedResult(resolved).then(() => resolved);
      }
      return resolved;
    });
  };

  const origTimeout = runtime.resolveTurnTimeout.bind(runtime);
  runtime.resolveTurnTimeout = (sessionId) => {
    const result = origTimeout(sessionId);
    return Promise.resolve(result).then((resolved) => {
      if (resolved && resolved.ok) {
        return handleTimedResult(resolved).then(() => resolved);
      }
      return resolved;
    });
  };
}

/**
 * @param {object} ctx
 * @param {object} [options]
 */
async function handlePvpCallback(ctx, options = {}) {
  try {
    await handlePvpCallbackBody(ctx, options);
  } catch (err) {
    const formatted = formatErrorForLog(err);
    logError(
      `[pvp] callback failed name=${formatted.name} message=${formatted.message}`
    );
    if (formatted.stack) {
      logError(`[pvp] callback stack ${formatted.stack}`);
    }
    await cbAnswer(ctx, "Something went wrong. Try again.");
  }
}

async function handlePvpCallbackBody(ctx, options = {}) {
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getTicTacToeRuntime());
  const parseFn =
    typeof options.parseCallbackData === "function"
      ? options.parseCallbackData
      : parseTttCallbackData;
  const awardXpFn =
    typeof options.awardPvpWinXpFn === "function"
      ? options.awardPvpWinXpFn
      : (userId, name) => awardPvpWinXp(userId, name, options.pointsFile);

  if (!ctx || !ctx.from || !ctx.callbackQuery) {
    return;
  }

  const data =
    typeof ctx.callbackQuery.data === "string" ? ctx.callbackQuery.data : "";
  const parsed = parseFn(data);
  if (!parsed) {
    return;
  }

  if (ctx.from.is_bot) {
    await cbAnswer(ctx, "Bots cannot play.");
    return;
  }

  const chatId = ctx.chat && ctx.chat.id;
  const userId = ctx.from.id;
  const displayName = sanitizePvpDisplayName(ctx.from);

  if (parsed.action === "noop") {
    await cbAnswer(ctx);
    return;
  }

  if (parsed.action === "join") {
    const result = runtime.join({
      sessionId: parsed.sessionId,
      userId,
      displayName,
      chatId,
      isBot: Boolean(ctx.from.is_bot),
    });

    if (!result.ok) {
      if (result.reason === "already-joined") {
        await cbAnswer(ctx, "You already joined this challenge.");
      } else if (result.reason === "full") {
        await cbAnswer(ctx, "This challenge is already full.");
      } else if (result.reason === "player-busy") {
        await cbAnswer(ctx, PLAYER_BUSY_TEXT);
      } else if (result.reason === "busy") {
        await cbAnswer(ctx);
        return;
        await cbAnswer(ctx, "Bots cannot play.");
      } else if (result.reason === "invalid-session" || result.reason === "not-waiting") {
        await rejectStalePvp(ctx, runtime, parsed);
      } else if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
      } else {
        await cbAnswer(ctx, "Could not join.");
      }
      return;
    }

    await cbAnswer(ctx);
    if (result.rendered) {
      await safeEdit(ctx, result.rendered.text, result.rendered.extra);
    }
    return;
  }

  if (parsed.action === "mode") {
    if (typeof runtime.chooseMode !== "function") {
      await cbAnswer(ctx, "Invalid move.");
      return;
    }
    const result = runtime.chooseMode({
      sessionId: parsed.sessionId,
      userId,
      mode: parsed.mode,
      chatId,
    });
    if (!result.ok) {
      if (result.reason === "not-starter") {
        await cbAnswer(ctx, "Only the player who started this can choose.");
      } else if (result.reason === "player-busy") {
        await cbAnswer(ctx, PLAYER_BUSY_TEXT);
      } else if (result.reason === "busy") {
        await cbAnswer(ctx);
        return;
      } else if (
        result.reason === "invalid-session" ||
        result.reason === "not-waiting" ||
        result.reason === "wrong-phase"
      ) {
        await rejectStalePvp(ctx, runtime, parsed);
        return;
      } else if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
      } else {
        await cbAnswer(ctx, "Could not start.");
      }
      if (result.rendered) {
        await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
      }
      return;
    }
    await cbAnswer(ctx);
    await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
    return;
  }

  if (parsed.action === "choice") {
    if (typeof runtime.choose !== "function") {
      await cbAnswer(ctx, "Invalid move.");
      return;
    }
    const result = await runtime.choose({
      sessionId: parsed.sessionId,
      userId,
      move: parsed.move,
      round: parsed.round,
      chatId,
    });

    if (!result.ok) {
      if (result.reason === "already-chosen") {
        await cbAnswer(ctx, result.toast || "✅ Your move is already locked.");
        return;
      }
      if (result.reason === "stale-round") {
        await cbAnswer(ctx, "This round already ended.");
        return;
      }
      if (result.reason === "outsider") {
        await cbAnswer(ctx, "This game belongs to two other players.");
        return;
      }
      if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
        return;
      }
      if (
        result.reason === "not-active" ||
        result.reason === "invalid-session" ||
        result.reason === "already-ended"
      ) {
        if (isPrivateCtx(ctx)) {
          await cbAnswer(ctx, GAME_OVER_TOAST);
          return;
        }
        await rejectStalePvp(ctx, runtime, parsed);
        return;
      }
      await cbAnswer(ctx, "Could not lock that choice.");
      return;
    }

    await cbAnswer(ctx, result.toast || "");
    let rendered = result.rendered;
    if (result.needsXp) {
      const fin = await finalizeWinXp(runtime, parsed.sessionId, awardXpFn);
      if (fin.rendered) {
        rendered = fin.rendered;
      }
    }
    await editPublicSessionMessage(ctx, result.session, rendered);
    if (result.resolved) {
      schedulePvpSessionCleanup(
        result.session,
        ctx.telegram,
        pvpGameType(parsed),
        runtime
      );
    }
    return;
  }

  if (parsed.action === "replay") {
    if (typeof runtime.replay !== "function") {
      await cbAnswer(ctx, "Invalid move.");
      return;
    }
    const result = runtime.replay({
      sessionId: parsed.sessionId,
      userId,
      round: parsed.round,
      chatId,
    });
    if (!result.ok) {
      if (result.reason === "outsider") {
        await cbAnswer(ctx, "This game belongs to two other players.");
      } else if (result.reason === "stale-round") {
        await cbAnswer(ctx, "This round already ended.");
      } else if (result.reason === "player-busy") {
        await cbAnswer(ctx, PLAYER_BUSY_TEXT);
      } else if (result.reason === "busy") {
        await cbAnswer(ctx);
        return;
      } else if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
      } else if (
        result.reason === "invalid-session" ||
        result.reason === "not-active"
      ) {
        await rejectStalePvp(ctx, runtime, parsed);
        return;
      } else {
        await cbAnswer(ctx, "Could not start the next round.");
      }
      return;
    }
    clearGameMessageCleanup(pvpGameType(parsed), parsed.sessionId);
    await cbAnswer(ctx);
    await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
    return;
  }

  if (parsed.action === "finish") {
    if (typeof runtime.finish !== "function") {
      await cbAnswer(ctx, "Invalid move.");
      return;
    }
    const result = runtime.finish({
      sessionId: parsed.sessionId,
      userId,
      round: parsed.round,
      chatId,
    });
    if (!result.ok) {
      if (result.reason === "outsider") {
        await cbAnswer(ctx, "This game belongs to two other players.");
      } else if (result.reason === "stale-round") {
        await cbAnswer(ctx, "This round already ended.");
      } else if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
      } else if (
        result.reason === "invalid-session" ||
        result.reason === "not-waiting" ||
        result.reason === "not-active"
      ) {
        await rejectStalePvp(ctx, runtime, parsed);
        return;
      } else {
        await cbAnswer(ctx, "Could not finish.");
      }
      return;
    }
    await cbAnswer(ctx);
    await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
    schedulePvpSessionCleanup(
      result.session,
      ctx.telegram,
      pvpGameType(parsed),
      runtime
    );
    return;
  }

  if (parsed.action === "retry") {
    if (typeof runtime.retry !== "function") {
      await cbAnswer(ctx, "Invalid move.");
      return;
    }
    const result = runtime.retry({
      sessionId: parsed.sessionId,
      userId,
      chatId,
    });
    if (!result.ok) {
      if (result.reason === "not-starter") {
        await cbAnswer(ctx, "Only the player who started this can choose.");
      } else if (result.reason === "player-busy") {
        await cbAnswer(ctx, PLAYER_BUSY_TEXT);
      } else if (result.reason === "busy") {
        await cbAnswer(ctx);
        return;
      } else if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
      } else if (
        result.reason === "invalid-session" ||
        result.reason === "not-waiting"
      ) {
        await rejectStalePvp(ctx, runtime, parsed);
        return;
      } else {
        await cbAnswer(ctx, "Could not retry.");
      }
      return;
    }
    clearGameMessageCleanup(pvpGameType(parsed), parsed.sessionId);
    await cbAnswer(ctx);
    await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
    return;
  }

  if (parsed.action === "sel") {
    if (typeof runtime.select !== "function") {
      await cbAnswer(ctx, "Invalid move.");
      return;
    }
    const result = runtime.select({
      sessionId: parsed.sessionId,
      userId,
      square: parsed.square,
      generation: parsed.generation,
      chatId,
    });

    if (!result.ok) {
      if (result.reason === "not-your-turn") {
        await cbAnswer(ctx, "Not your turn.");
      } else if (result.reason === "outsider") {
        await cbAnswer(ctx, "This game belongs to two other players.");
      } else if (result.reason === "invalid-piece") {
        await cbAnswer(ctx, NOT_YOUR_PIECE_TOAST);
      } else if (result.reason === "empty") {
        await cbAnswer(ctx, EMPTY_SQUARE_TOAST);
      } else if (result.reason === "must-capture") {
        await cbAnswer(ctx, MUST_CAPTURE_TOAST);
      } else if (result.reason === "stale-board") {
        await cbAnswer(ctx, STALE_BOARD_TOAST);
      } else if (result.reason === "no-moves") {
        await cbAnswer(ctx, NO_MOVES_TOAST);
      } else if (result.reason === "must-continue") {
        await cbAnswer(ctx, "You must continue with the same piece.");
      } else if (
        result.reason === "already-ended" ||
        result.reason === "not-active" ||
        result.reason === "invalid-session"
      ) {
        await rejectStalePvp(ctx, runtime, parsed);
        return;
      } else if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
      } else {
        await cbAnswer(ctx, "Invalid move.");
      }
      await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
      return;
    }

    if (result.moved) {
      await cbAnswer(ctx);
      await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
      if (result.needsXp) {
        const fin = await finalizeWinXp(runtime, parsed.sessionId, awardXpFn);
        if (fin.rendered) {
          await applyRenderedEdit(ctx, runtime, parsed, fin.rendered);
        }
      }
      schedulePvpSessionCleanup(
        result.session,
        ctx.telegram,
        pvpGameType(parsed),
        runtime
      );
      return;
    }

    await cbAnswer(ctx);
    await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
    return;
  }

  if (parsed.action === "move" || parsed.action === "mv") {
    const result = await runtime.move({
      sessionId: parsed.sessionId,
      userId,
      cell: parsed.cell,
      column: parsed.column,
      from: parsed.from,
      to: parsed.to,
      generation: parsed.generation,
      chatId,
    });

    if (!result.ok) {
      if (result.reason === "not-your-turn") {
        await cbAnswer(ctx, "Not your turn.");
      } else if (result.reason === "outsider") {
        await cbAnswer(ctx, "This game belongs to two other players.");
      } else if (result.reason === "occupied") {
        await cbAnswer(ctx, "That square is already taken.");
      } else if (result.reason === "full") {
        await cbAnswer(ctx, "That column is full.");
      } else if (result.reason === "must-capture") {
        await cbAnswer(ctx, MUST_CAPTURE_TOAST);
      } else if (result.reason === "stale-board") {
        await cbAnswer(ctx, STALE_BOARD_TOAST);
      } else if (result.reason === "empty") {
        await cbAnswer(ctx, EMPTY_SQUARE_TOAST);
      } else if (result.reason === "must-continue") {
        await cbAnswer(ctx, "You must continue with the same piece.");
      } else if (
        result.reason === "already-ended" ||
        result.reason === "not-active" ||
        result.reason === "invalid-session"
      ) {
        await rejectStalePvp(ctx, runtime, parsed);
        return;
      } else if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
        return;
      } else {
        await cbAnswer(ctx, "Invalid move.");
      }
      await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
      return;
    }

    await cbAnswer(ctx);

    const isCheckers = parsed.game === "checkers";
    if (isCheckers) {
      await applyRenderedEdit(ctx, runtime, parsed, result.rendered);
      if (result.needsXp) {
        const fin = await finalizeWinXp(runtime, parsed.sessionId, awardXpFn);
        if (fin.rendered) {
          await applyRenderedEdit(ctx, runtime, parsed, fin.rendered);
        }
      }
    } else {
      let rendered = result.rendered;
      if (result.needsXp) {
        const fin = await finalizeWinXp(runtime, parsed.sessionId, awardXpFn);
        if (fin.rendered) {
          rendered = fin.rendered;
        }
      }
      if (rendered) {
        const edited = await safeEdit(ctx, rendered.text, rendered.extra);
        if (!edited && parsed.game === "tictactoe") {
          await refreshLivePvpBoard(ctx, runtime, parsed.sessionId);
        }
      }
    }
    schedulePvpSessionCleanup(
      result.session,
      ctx.telegram,
      pvpGameType(parsed),
      runtime
    );
  }
}

function registerPvpCallbacks(bot, options = {}) {
  const tttRuntime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getTicTacToeRuntime());
  const c4Runtime =
    options.connectFourRuntime ||
    (typeof options.getConnectFourRuntimeFn === "function"
      ? options.getConnectFourRuntimeFn()
      : getConnectFourRuntime());
  const chkRuntime =
    options.checkersRuntime ||
    (typeof options.getCheckersRuntimeFn === "function"
      ? options.getCheckersRuntimeFn()
      : getCheckersRuntime());
  const rpsRuntime =
    options.rockPaperScissorsRuntime ||
    (typeof options.getRockPaperScissorsRuntimeFn === "function"
      ? options.getRockPaperScissorsRuntimeFn()
      : getRockPaperScissorsRuntime());

  const awardXpFn =
    typeof options.awardPvpWinXpFn === "function"
      ? options.awardPvpWinXpFn
      : (userId, name) => awardPvpWinXp(userId, name, options.pointsFile);

  if (bot && bot.telegram && !options.skipTimeoutHook) {
    wireTimeoutMessageEdits(tttRuntime, bot.telegram, awardXpFn);
    if (c4Runtime && c4Runtime !== tttRuntime) {
      wireTimeoutMessageEdits(c4Runtime, bot.telegram, awardXpFn);
    }
    if (chkRuntime && chkRuntime !== tttRuntime && chkRuntime !== c4Runtime) {
      wireTimeoutMessageEdits(chkRuntime, bot.telegram, awardXpFn);
    }
    if (
      rpsRuntime &&
      rpsRuntime !== tttRuntime &&
      rpsRuntime !== c4Runtime &&
      rpsRuntime !== chkRuntime
    ) {
      wireTimeoutMessageEdits(rpsRuntime, bot.telegram, awardXpFn);
    }
  }

  bot.action(/^pvp:ttt:(join|move):/, (ctx) =>
    handlePvpCallback(ctx, {
      ...options,
      runtime: tttRuntime,
      parseCallbackData: parseTttCallbackData,
    })
  );
  bot.action(/^pvp:c4:(join|move):/, (ctx) =>
    handlePvpCallback(ctx, {
      ...options,
      runtime: c4Runtime,
      parseCallbackData: parseC4CallbackData,
    })
  );
  bot.action(/^pvp:chk:(join|sel|mv|noop|mode):/, (ctx) =>
    handlePvpCallback(ctx, {
      ...options,
      runtime: chkRuntime,
      parseCallbackData: parseChkCallbackData,
    })
  );
  bot.action(/^pvp:rps:(join|mode|choice|replay|finish|retry):/, (ctx) =>
    handlePvpCallback(ctx, {
      ...options,
      runtime: rpsRuntime,
      parseCallbackData: parseRpsCallbackData,
    })
  );
}

module.exports = (bot) => {
  registerPvpCallbacks(bot);
};

module.exports.registerPvpCallbacks = registerPvpCallbacks;
module.exports.handlePvpCallback = handlePvpCallback;
module.exports.finalizeWinXp = finalizeWinXp;
