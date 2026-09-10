/**
 * /mangoormoon — single-player vs ManGoBot in the Games topic.
 * Callbacks: mom:m|n|f|a:<sessionId>:<round>
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startMangoOrMoonGame,
  getMangoOrMoonRuntime,
  parseMomCallbackData,
  PLAYER_BUSY_TEXT,
  GAME_ENDED_TOAST,
  renderMessage,
} = require("../services/mangoOrMoon");
const {
  awardLightweightStreakXp,
  getLightweightXpStatus,
} = require("../services/points");
const { noteDailyQuestGame } = require("../services/dailyQuest");
const { sanitizePvpDisplayName } = require("../services/pvpSessionManager");
const {
  GAME_TYPE,
  handleStaleGameCallback,
} = require("../utils/gameCleanup");
const {
  GAMES_TOPIC_REQUIRED_MESSAGE,
  assertCanStartInteractiveGame,
  withCtxThreadExtra,
  getMessageThreadId,
} = require("../utils/gameTopic");
const { error: logError } = require("../utils/logger");

const PRIVATE_MOM_TEXT =
  "🥭 ManGo or Moon is played in the ManGo group Games topic.";

function cbAnswer(ctx, text) {
  if (ctx && typeof ctx.answerCbQuery === "function") {
    return Promise.resolve(ctx.answerCbQuery(text || "")).catch(() => {});
  }
  return Promise.resolve();
}

async function refreshMomRewards(runtime, session, user, { award = false, pointsFile, walletFile, shopFile } = {}) {
  if (!runtime || !session || !user) {
    return null;
  }
  const userId = user.id;
  const name = sanitizePvpDisplayName(user);
  let status = getLightweightXpStatus(userId, pointsFile);
  if (award && session.streak != null) {
    status = await awardLightweightStreakXp(
      userId,
      name,
      {
        streak: session.streak,
        game: "mom",
        walletFile,
        pointsFile,
        shopFile,
      },
      pointsFile,
      walletFile
    );
  }
  if (typeof runtime.setRewardStatus === "function") {
    runtime.setRewardStatus(session.id, status);
  }
  noteDailyQuestGame(userId, "mom", { shopFile, walletFile, pointsFile });
  const live = runtime.getSession(session.id);
  return renderMessage(live || { ...session, rewardStatus: status });
}

async function safeEdit(ctx, text, extra) {
  try {
    if (ctx && typeof ctx.editMessageText === "function") {
      await ctx.editMessageText(text, extra || undefined);
      return true;
    }
  } catch (err) {
    logError(
      "[mom] editMessageText failed:",
      err && err.message ? err.message : err
    );
  }
  return false;
}

function wireMangoOrMoonRuntime(runtime, botOrTelegram) {
  if (!runtime || typeof runtime.setRenderHandler !== "function") {
    return;
  }
  const telegram =
    botOrTelegram && botOrTelegram.telegram
      ? botOrTelegram.telegram
      : botOrTelegram;
  if (!telegram || typeof telegram.editMessageText !== "function") {
    return;
  }
  if (typeof telegram.deleteMessage === "function" && typeof runtime.setDeleteMessageHandler === "function") {
    runtime.setDeleteMessageHandler((chatId, messageId) =>
      telegram.deleteMessage(chatId, messageId)
    );
  }
  runtime.setRenderHandler((result) => {
    const session = result && result.session;
    const rendered = result && result.rendered;
    if (!session || session.messageId == null || !rendered || !rendered.text) {
      return;
    }
    Promise.resolve(
      telegram.editMessageText(
        session.chatId,
        session.messageId,
        undefined,
        rendered.text,
        rendered.extra || undefined
      )
    ).catch((err) => {
      logError(
        "[mom] timeout edit failed:",
        err && err.message ? err.message : err
      );
    });
  });
}

async function handleMangoOrMoon(ctx, options = {}) {
  const startFn =
    typeof options.startChallengeFn === "function"
      ? options.startChallengeFn
      : typeof options.startGameFn === "function"
        ? options.startGameFn
        : startMangoOrMoonGame;
  const busyFn =
    typeof options.isBusyFn === "function"
      ? options.isBusyFn
      : isCommunityChallengeBusy;
  const busyReasonFn =
    typeof options.getBusyReasonFn === "function"
      ? options.getBusyReasonFn
      : getCommunityBusyReason;
  const setMessageIdFn =
    typeof options.setMessageIdFn === "function"
      ? options.setMessageIdFn
      : (sessionId, messageId) =>
          getMangoOrMoonRuntime().setMessageId(sessionId, messageId);
  const assertStartFn =
    typeof options.assertCanStartFn === "function"
      ? options.assertCanStartFn
      : assertCanStartInteractiveGame;

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    return ctx.reply(PRIVATE_MOM_TEXT);
  }

  const gate = await assertStartFn(ctx, options);
  if (!gate.ok) {
    if (gate.reason === "bot") {
      return ctx.reply("🥭 Bots cannot start ManGo or Moon.");
    }
    if (gate.reason === "wrong-topic") {
      return ctx.reply(GAMES_TOPIC_REQUIRED_MESSAGE);
    }
    return ctx.reply("🥭 ManGo or Moon is not available in this group.");
  }

  if (
    busyFn({
      isChatFightOpenFn: options.isChatFightOpenFn,
      isTicTacToeOpenFn: options.isTicTacToeOpenFn,
      isConnectFourOpenFn: options.isConnectFourOpenFn,
      isTriviaOpenFn: options.isTriviaOpenFn,
      isMangoBombOpenFn: options.isMangoBombOpenFn,
      isBlackjackOpenFn: options.isBlackjackOpenFn,
    })
  ) {
    const reason = busyReasonFn({
      isChatFightOpenFn: options.isChatFightOpenFn,
      isTicTacToeOpenFn: options.isTicTacToeOpenFn,
      isConnectFourOpenFn: options.isConnectFourOpenFn,
      isTriviaOpenFn: options.isTriviaOpenFn,
      isMangoBombOpenFn: options.isMangoBombOpenFn,
      isBlackjackOpenFn: options.isBlackjackOpenFn,
    });
    if (reason === "chatfight") {
      return ctx.reply("⚔️ A ChatFight is already running.");
    }
    if (reason === "trivia") {
      return ctx.reply("🧠 A Trivia challenge is already open.");
    }
    if (reason === "mangobomb") {
      return ctx.reply("🥭💣 A ManGo Bomb round is already running.");
    }
    return ctx.reply("⚔️ A community game is already running.");
  }

  const result = startFn({
    chatId: ctx.chat.id,
    threadId: getMessageThreadId(ctx),
    starter: {
      userId: ctx.from.id,
      displayName: ctx.from,
      isBot: Boolean(ctx.from.is_bot),
    },
  });
  if (!result.ok) {
    if (result.reason === "player-busy") {
      return ctx.reply(PLAYER_BUSY_TEXT);
    }
    if (result.reason === "already-active") {
      return ctx.reply("🥭 You already have a ManGo or Moon game.");
    }
    if (result.reason === "bot") {
      return ctx.reply("🥭 Bots cannot start ManGo or Moon.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("🥭 ManGo or Moon is not available in this group.");
    }
    return ctx.reply("🥭 Could not start ManGo or Moon.");
  }

  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getMangoOrMoonRuntime());
  if (result.session && runtime && typeof runtime.setRewardStatus === "function") {
    runtime.setRewardStatus(
      result.session.id,
      getLightweightXpStatus(ctx.from.id, options.pointsFile)
    );
    const live = runtime.getSession(result.session.id);
    if (live) {
      const rendered = renderMessage(live);
      result.text = rendered.text;
      result.extra = rendered.extra;
      result.keyboard = rendered.extra;
    }
  }

  const sent = await ctx.reply(
    result.text,
    withCtxThreadExtra(ctx, result.keyboard || result.extra || undefined)
  );
  if (sent && sent.message_id != null && result.session) {
    setMessageIdFn(result.session.id, sent.message_id);
  }
  return sent;
}

async function handleMangoOrMoonCallback(ctx, options = {}) {
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getMangoOrMoonRuntime());
  const parseFn =
    typeof options.parseCallbackData === "function"
      ? options.parseCallbackData
      : parseMomCallbackData;

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
  const input = {
    sessionId: parsed.sessionId,
    userId,
    round: parsed.round,
    chatId,
    action: parsed.action,
  };

  async function rejectStale(result) {
    await handleStaleGameCallback(ctx, {
      gameType: GAME_TYPE.MOM,
      sessionId: parsed.sessionId,
      text: result && result.rendered && result.rendered.text,
      toast: (result && result.toast) || GAME_ENDED_TOAST,
      generation: parsed.round,
      telegram: ctx.telegram,
    });
  }

  if (parsed.action === "m" || parsed.action === "n") {
    const result = runtime.guess(input);
    if (!result.ok) {
      if (result.reason === "outsider") {
        await cbAnswer(ctx, result.toast);
        return;
      }
      if (result.reason === "stale-round") {
        await cbAnswer(ctx, result.toast || "This round already ended.");
        return;
      }
      if (result.reason === "wrong-chat") {
        await cbAnswer(ctx, result.toast || "Wrong chat.");
        return;
      }
      await rejectStale(result);
      return;
    }
    await cbAnswer(ctx, result.correct ? "✅ Correct!" : "❌ Wrong!");
    let rendered = result.rendered;
    if (result.session) {
      const updated = await refreshMomRewards(runtime, result.session, ctx.from, {
        award: Boolean(result.correct),
        pointsFile: options.pointsFile,
        walletFile: options.walletFile,
        shopFile: options.shopFile,
      });
      if (updated) {
        rendered = updated;
      }
    }
    if (rendered) {
      await safeEdit(ctx, rendered.text, rendered.extra);
    }
    return;
  }

  if (parsed.action === "f") {
    const result = runtime.finish(input);
    if (!result.ok) {
      if (result.reason === "outsider") {
        await cbAnswer(ctx, result.toast);
        return;
      }
      if (result.reason === "stale-round") {
        await cbAnswer(ctx, result.toast || "This round already ended.");
        return;
      }
      await rejectStale(result);
      return;
    }
    await cbAnswer(ctx);
    if (result.rendered) {
      await safeEdit(ctx, result.rendered.text, result.rendered.extra);
    }
    return;
  }

  if (parsed.action === "a") {
    const result = runtime.playAgain(input);
    if (!result.ok) {
      if (result.reason === "outsider") {
        await cbAnswer(ctx, result.toast);
        return;
      }
      if (result.reason === "stale-round") {
        await cbAnswer(ctx, result.toast || "This round already ended.");
        return;
      }
      if (result.reason === "player-busy") {
        await cbAnswer(ctx, PLAYER_BUSY_TEXT);
        return;
      }
      if (result.reason === "already-active") {
        await cbAnswer(ctx, result.toast || "This round is still open.");
        return;
      }
      await rejectStale(result);
      return;
    }
    await cbAnswer(ctx);
    if (result.session && runtime && typeof runtime.setRewardStatus === "function") {
      runtime.setRewardStatus(
        result.session.id,
        getLightweightXpStatus(ctx.from.id, options.pointsFile)
      );
      const live = runtime.getSession(result.session.id);
      if (live) {
        const rendered = renderMessage(live);
        result.text = rendered.text;
        result.extra = rendered.extra;
        result.keyboard = rendered.extra;
      }
    }
    if (result.extra || result.keyboard) {
      await safeEdit(
        ctx,
        result.text,
        result.keyboard || result.extra
      );
    }
  }
}

module.exports = (bot) => {
  wireMangoOrMoonRuntime(getMangoOrMoonRuntime(), bot);
  bot.command(["mangoormoon", "mom"], (ctx) => handleMangoOrMoon(ctx));
  bot.action(/^mom:(m|n|f|a):[a-f0-9]+:\d+$/i, (ctx) =>
    handleMangoOrMoonCallback(ctx)
  );
};

module.exports.handleMangoOrMoon = handleMangoOrMoon;
module.exports.handleMangoOrMoonCallback = handleMangoOrMoonCallback;
module.exports.wireMangoOrMoonRuntime = wireMangoOrMoonRuntime;
module.exports.PRIVATE_MOM_TEXT = PRIVATE_MOM_TEXT;
