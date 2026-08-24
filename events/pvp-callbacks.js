/**
 * PvP inline callbacks — Tic-Tac-Toe and Connect Four join + move.
 * Callback data: pvp:ttt:... | pvp:c4:...  (opaque session ids, never uids)
 */

const { logError } = require("../utils/logger");
const { awardPvpWinXp } = require("../services/points");
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
  scheduleExpiredMessageCleanup,
} = require("../utils/expiredMessageCleanup");
const {
  GAME_OVER_TOAST,
  GAME_TYPE,
  stripStaleCallbackButtons,
} = require("../utils/gameCleanup");

function pvpGameType(parsed) {
  return parsed && parsed.game === "connect4"
    ? GAME_TYPE.CONNECT4
    : GAME_TYPE.TICTACTOE;
}

function cbAnswer(ctx, text) {
  if (ctx && typeof ctx.answerCbQuery === "function") {
    return ctx.answerCbQuery(text || "").catch(() => {});
  }
  return Promise.resolve();
}

async function rejectStalePvp(ctx, runtime, parsed) {
  await cbAnswer(ctx, GAME_OVER_TOAST);
  let text;
  if (runtime && parsed && typeof runtime.getSession === "function") {
    const session = runtime.getSession(parsed.sessionId);
    if (session && typeof runtime.renderMessage === "function") {
      const rendered = runtime.renderMessage(session);
      text = rendered && rendered.text;
    }
  }
  await stripStaleCallbackButtons(ctx, {
    gameType: pvpGameType(parsed),
    text,
  });
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
    xpResult = awardXpFn(claim.winnerUserId, claim.winnerName || "Player");
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
    }
  };

  const origExpire = runtime.expireJoin.bind(runtime);
  runtime.expireJoin = (sessionId) => {
    const result = origExpire(sessionId);
    if (result && result.ok && result.rendered) {
      Promise.resolve(editSessionMessage(result.session, result.rendered))
        .then(() => {
          if (
            result.session &&
            result.session.messageId != null &&
            result.session.chatId != null
          ) {
            scheduleExpiredMessageCleanup({
              telegram,
              chatId: result.session.chatId,
              messageId: result.session.messageId,
            });
          }
        })
        .catch(() => {});
    }
    return result;
  };

  const origTimeout = runtime.resolveTurnTimeout.bind(runtime);
  runtime.resolveTurnTimeout = (sessionId) => {
    const result = origTimeout(sessionId);
    if (result && result.ok) {
      Promise.resolve()
        .then(async () => {
          let rendered = result.rendered;
          if (result.needsXp) {
            const fin = await finalizeWinXp(runtime, sessionId, awardXpFn);
            if (fin.rendered) rendered = fin.rendered;
          }
          await editSessionMessage(result.session, rendered);
        })
        .catch(() => {});
    }
    return result;
  };
}

/**
 * @param {object} ctx
 * @param {object} [options]
 */
async function handlePvpCallback(ctx, options = {}) {
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
      } else if (result.reason === "bot") {
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

  if (parsed.action === "move") {
    const result = runtime.move({
      sessionId: parsed.sessionId,
      userId,
      cell: parsed.cell,
      column: parsed.column,
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
      } else if (
        result.reason === "already-ended" ||
        result.reason === "not-active" ||
        result.reason === "invalid-session"
      ) {
        await rejectStalePvp(ctx, runtime, parsed);
      } else if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, "Wrong chat.");
      } else {
        await cbAnswer(ctx, "Invalid move.");
      }
      return;
    }

    await cbAnswer(ctx);

    let rendered = result.rendered;
    if (result.needsXp) {
      const fin = await finalizeWinXp(runtime, parsed.sessionId, awardXpFn);
      if (fin.rendered) {
        rendered = fin.rendered;
      }
    }

    if (rendered) {
      await safeEdit(ctx, rendered.text, rendered.extra);
    }
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

  const awardXpFn =
    typeof options.awardPvpWinXpFn === "function"
      ? options.awardPvpWinXpFn
      : (userId, name) => awardPvpWinXp(userId, name, options.pointsFile);

  if (bot && bot.telegram && !options.skipTimeoutHook) {
    wireTimeoutMessageEdits(tttRuntime, bot.telegram, awardXpFn);
    if (c4Runtime && c4Runtime !== tttRuntime) {
      wireTimeoutMessageEdits(c4Runtime, bot.telegram, awardXpFn);
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
}

module.exports = (bot) => {
  registerPvpCallbacks(bot);
};

module.exports.registerPvpCallbacks = registerPvpCallbacks;
module.exports.handlePvpCallback = handlePvpCallback;
module.exports.finalizeWinXp = finalizeWinXp;
