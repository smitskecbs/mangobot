/**
 * /mangobomb — join-only community hot-potato in the Games topic.
 * Callbacks: mb:join:<id> / mb:pass:<id> / mb:wait:<id>. Server uses ctx.from.id.
 */

const { Markup } = require("telegraf");
const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const {
  isAdmin,
  awardMangoBombXp,
} = require("../services/points");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startLobby,
  abortUnpublishedStart,
  getMangoBombRuntime,
    parseMangoBombCallbackData,
    STALE_CALLBACK,
    STATUS,
} = require("../services/mangoBomb");
const { reminderForBlockedXp } = require("../services/xpWalletGate");
const { error: logError } = require("../utils/logger");
const { TELEGRAM_TIMEOUT_MS, raceWithTimeout } = require("../utils/safeFetch");
const {
  emptyInlineKeyboardExtra,
} = require("../utils/expiredMessageCleanup");
const {
  GAME_TYPE,
  stripStaleCallbackButtons,
} = require("../utils/gameCleanup");
const {
  assertCanStartInteractiveGame,
  withCtxThreadExtra,
  getMessageThreadId,
  buildGamesTopicUrl,
} = require("../utils/gameTopic");

const PRIVATE_MANGO_BOMB_TEXT = `🥭💣 ManGo Bomb

This is a live community game.

Play it in the ManGo Games topic.`;

const MANGO_BOMB_TOPIC_REQUIRED_TEXT = `🥭💣 ManGo Bomb is played in the Games topic.

Open Games and start the next round there. 🎮`;

const START_FAILED_TEXT = `🥭💣 Could not start ManGo Bomb.

No game was created. You can try again now.`;

function busyOptions(options = {}) {
  return {
    isChatFightOpenFn: options.isChatFightOpenFn,
    isTicTacToeOpenFn: options.isTicTacToeOpenFn,
    isConnectFourOpenFn: options.isConnectFourOpenFn,
    isTriviaOpenFn: options.isTriviaOpenFn,
    isMangoBombOpenFn: options.isMangoBombOpenFn,
    isBlackjackOpenFn: options.isBlackjackOpenFn,
  };
}

function openGamesExtra() {
  const url = buildGamesTopicUrl();
  if (!url) {
    return undefined;
  }
  return Markup.inlineKeyboard([[Markup.button.url("🎮 Open Games", url)]]);
}

function wireMangoBombRuntime(runtime, botOrTelegram, options = {}) {
  if (!runtime) {
    return;
  }

  const telegram =
    botOrTelegram && botOrTelegram.telegram
      ? botOrTelegram.telegram
      : botOrTelegram;

  runtime.setAwardXpHandler((userId, name, pointsToAdd, roundId) =>
    awardMangoBombXp(
      userId,
      name,
      pointsToAdd,
      roundId,
      options.pointsFile,
      options.walletFile
    )
  );

  if (telegram && typeof telegram.deleteMessage === "function") {
    if (typeof runtime.setDeleteMessageHandler === "function") {
      runtime.setDeleteMessageHandler((chatId, messageId) =>
        telegram.deleteMessage(chatId, messageId)
      );
    }
  }

  if (telegram && typeof telegram.editMessageText === "function") {
    runtime.setEditMessageHandler((chatId, messageId, text, extra) =>
      telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        text,
        extra || emptyInlineKeyboardExtra()
      )
    );
  }

  if (telegram && typeof telegram.sendMessage === "function") {
    if (typeof runtime.setSendMessageHandler === "function") {
      runtime.setSendMessageHandler((chatId, text, extra) =>
        telegram.sendMessage(chatId, text, extra || emptyInlineKeyboardExtra())
      );
    }
    runtime.setWalletReminderHandler((userId, result, chatId, threadId) => {
      const text = reminderForBlockedXp(userId, result);
      if (!text) {
        return null;
      }
      const extra = {};
      if (threadId != null) {
        extra.message_thread_id = threadId;
      }
      return telegram.sendMessage(chatId, text, extra).catch(() => undefined);
    });
  }
}

async function handleMangoBomb(ctx, options = {}) {
  const startFn =
    typeof options.startLobbyFn === "function" ? options.startLobbyFn : startLobby;
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
      : (gameId, messageId, instanceSeq) =>
          getMangoBombRuntime().setMessageId(gameId, messageId, instanceSeq);
  const abortFn =
    typeof options.abortUnpublishedStartFn === "function"
      ? options.abortUnpublishedStartFn
      : (gameId, instanceSeq) => abortUnpublishedStart(gameId, instanceSeq);
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getMangoBombRuntime());
  const armPublishTimeoutFn =
    typeof options.armUnpublishedPublishTimeoutFn === "function"
      ? options.armUnpublishedPublishTimeoutFn
      : (gameId, instanceSeq) =>
          runtime && typeof runtime.armUnpublishedPublishTimeout === "function"
            ? runtime.armUnpublishedPublishTimeout(gameId, instanceSeq)
            : false;
  const isStartAttemptLiveFn =
    typeof options.isStartAttemptLiveFn === "function"
      ? options.isStartAttemptLiveFn
      : (gameId, instanceSeq) =>
          runtime && typeof runtime.isStartAttemptLive === "function"
            ? runtime.isStartAttemptLive(gameId, instanceSeq)
            : false;
  const publishTimeoutMs =
    Number.isFinite(options.publishTimeoutMs) && options.publishTimeoutMs > 0
      ? options.publishTimeoutMs
      : TELEGRAM_TIMEOUT_MS;
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function" ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn =
    typeof options.clearTimeoutFn === "function"
      ? options.clearTimeoutFn
      : clearTimeout;
  const deleteStartMessageFn =
    typeof options.deleteStartMessageFn === "function"
      ? options.deleteStartMessageFn
      : ctx && ctx.telegram && typeof ctx.telegram.deleteMessage === "function"
        ? (chatId, messageId) => ctx.telegram.deleteMessage(chatId, messageId)
        : null;
  const editStartMessageFn =
    typeof options.editStartMessageFn === "function"
      ? options.editStartMessageFn
      : ctx && ctx.telegram && typeof ctx.telegram.editMessageText === "function"
        ? (chatId, messageId, text, extra) =>
            ctx.telegram.editMessageText(chatId, messageId, undefined, text, extra)
        : null;
  const assertStartFn =
    typeof options.assertCanStartFn === "function"
      ? options.assertCanStartFn
      : assertCanStartInteractiveGame;

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    return ctx.reply(PRIVATE_MANGO_BOMB_TEXT, openGamesExtra());
  }

  const gate = await assertStartFn(ctx, {
    ...options,
    allowAdminTopicBypass: false,
  });
  if (!gate.ok) {
    if (gate.reason === "bot") {
      return ctx.reply("🥭💣 Bots cannot start ManGo Bomb.");
    }
    if (gate.reason === "wrong-topic") {
      return ctx.reply(
        MANGO_BOMB_TOPIC_REQUIRED_TEXT,
        withCtxThreadExtra(ctx, openGamesExtra())
      );
    }
    return ctx.reply("🥭💣 ManGo Bomb is not available in this group.");
  }

  if (busyFn(busyOptions(options))) {
    const reason = busyReasonFn(busyOptions(options));
    if (reason === "chatfight") {
      return ctx.reply("⚔️ A ChatFight is already running.");
    }
    if (reason === "tictactoe") {
      return ctx.reply("🎮 A Tic-Tac-Toe challenge is already open.");
    }
    if (reason === "connect4") {
      return ctx.reply("🟡 A Connect Four challenge is already open.");
    }
    if (reason === "trivia") {
      return ctx.reply("🧠 A Trivia challenge is already open.");
    }
    if (reason === "blackjack") {
      return ctx.reply("🃏 A Blackjack round is already running.");
    }
    return ctx.reply("🥭💣 A ManGo Bomb round is already running.");
  }

  let result;
  try {
    result = startFn({
      chatId: ctx.chat.id,
      threadId: getMessageThreadId(ctx),
      source: "manual",
    });
  } catch (err) {
    logError(
      "[mango-bomb] startLobby threw",
      err && err.message ? err.message : err
    );
    return ctx.reply(START_FAILED_TEXT);
  }
  if (!result.ok) {
    if (result.reason === "already-active") {
      return ctx.reply("🥭💣 A ManGo Bomb round is already running.");
    }
    if (result.reason === "cooldown") {
      return ctx.reply("🥭💣 ManGo Bomb is cooling down. Try again shortly.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("🥭💣 ManGo Bomb is not available in this group.");
    }
    return ctx.reply(START_FAILED_TEXT);
  }

  async function cleanupOrphanStartMessage(sent) {
    const chatId = ctx.chat && ctx.chat.id;
    const messageId =
      sent && (sent.message_id != null ? sent.message_id : sent.messageId);
    if (chatId == null || messageId == null) {
      return;
    }
    if (typeof deleteStartMessageFn === "function") {
      try {
        await deleteStartMessageFn(chatId, messageId);
        return;
      } catch (err) {
        logError(
          "[mango-bomb] orphan start delete failed",
          err && err.message ? err.message : err
        );
      }
    }
    if (typeof editStartMessageFn === "function") {
      try {
        await editStartMessageFn(
          chatId,
          messageId,
          START_FAILED_TEXT,
          emptyInlineKeyboardExtra()
        );
      } catch (err) {
        logError(
          "[mango-bomb] orphan start edit failed",
          err && err.message ? err.message : err
        );
      }
    }
  }

  function ignoreLatePublish(err) {
    if (err) {
      logError(
        "[mango-bomb] late start publish ignored",
        err && err.message ? err.message : err
      );
    }
  }

  async function absorbLatePublish(sent) {
    if (isStartAttemptLiveFn(result.gameId, result.instanceSeq)) {
      return;
    }
    await cleanupOrphanStartMessage(sent);
  }

  async function failUnpublishedStart(err, sent) {
    abortFn(result.gameId, result.instanceSeq);
    if (err) {
      logError(
        "[mango-bomb] start publish failed",
        err && err.message ? err.message : err
      );
    }
    await cleanupOrphanStartMessage(sent);
    try {
      return await ctx.reply(START_FAILED_TEXT, withCtxThreadExtra(ctx));
    } catch (_err) {
      return undefined;
    }
  }

  armPublishTimeoutFn(result.gameId, result.instanceSeq);

  const publishWork = Promise.resolve().then(() =>
    ctx.reply(result.text, withCtxThreadExtra(ctx, result.extra || undefined))
  );
  let sent;
  try {
    sent = await raceWithTimeout(publishWork, publishTimeoutMs, {
      setTimeoutFn,
      clearTimeoutFn,
    });
  } catch (err) {
    const failed = await failUnpublishedStart(err);
    publishWork.then(absorbLatePublish, ignoreLatePublish);
    return failed;
  }
  if (!isStartAttemptLiveFn(result.gameId, result.instanceSeq)) {
    publishWork.then(absorbLatePublish, ignoreLatePublish);
    await cleanupOrphanStartMessage(sent);
    return undefined;
  }
  if (!sent || sent.message_id == null || !result.gameId) {
    return failUnpublishedStart(null, sent);
  }
  try {
    const published = setMessageIdFn(
      result.gameId,
      sent.message_id,
      result.instanceSeq
    );
    if (published === false) {
      return failUnpublishedStart(null, sent);
    }
  } catch (err) {
    return failUnpublishedStart(err, sent);
  }
  return sent;
}

async function handleMangoBombCallback(ctx, options = {}) {
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getMangoBombRuntime());
  const parseFn =
    typeof options.parseCallbackData === "function"
      ? options.parseCallbackData
      : parseMangoBombCallbackData;

  if (!ctx || !ctx.from || !ctx.callbackQuery) {
    return;
  }

  const data =
    typeof ctx.callbackQuery.data === "string" ? ctx.callbackQuery.data : "";
  const parsed = parseFn(data);
  if (!parsed) {
    return;
  }

  async function answer(text) {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery(text || "").catch(() => {});
    }
  }

  const chatId = ctx.chat && ctx.chat.id;
  const input = {
    gameId: parsed.gameId,
    userId: ctx.from.id,
    displayName: ctx.from,
    isBot: Boolean(ctx.from.is_bot),
    chatId,
    threadId: getMessageThreadId(ctx),
  };

  const result =
    parsed.action === "join"
      ? await runtime.enqueueJoin(input)
      : parsed.action === "wait"
        ? await runtime.enqueueWait(input)
        : await runtime.enqueuePass(input);

  if (!result || !result.ok) {
    await answer((result && result.toast) || STALE_CALLBACK);
    const live =
      parsed.gameId && runtime && typeof runtime.getGame === "function"
        ? runtime.getGame(parsed.gameId)
        : null;
    const over =
      !live ||
      live.status === STATUS.FINISHED ||
      live.status === STATUS.CANCELLED;
    if (!over) {
      return;
    }
    const finalUi =
      parsed.gameId && runtime && typeof runtime.getFinalUi === "function"
        ? runtime.getFinalUi(parsed.gameId)
        : null;
    const cbMessage =
      ctx.callbackQuery && ctx.callbackQuery.message
        ? ctx.callbackQuery.message
        : null;
    const sameEndedMessage =
      !finalUi ||
      finalUi.messageId == null ||
      !cbMessage ||
      cbMessage.message_id == null ||
      String(cbMessage.message_id) === String(finalUi.messageId);
    if (sameEndedMessage) {
      await stripStaleCallbackButtons(ctx, {
        gameType: GAME_TYPE.MANGOBOMB,
        text: finalUi && finalUi.text,
      });
    }
    return;
  }

  await answer(parsed.action === "join" ? "Joined!" : "Passed!");
}

async function handleBombDebug(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return;
  }
  if (!isPrivateChat(ctx)) {
    return;
  }
  if (!isAdmin(ctx.from.id)) {
    return;
  }
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getMangoBombRuntime());
  const snapshot =
    typeof runtime.getDebugSnapshot === "function"
      ? runtime.getDebugSnapshot()
      : { status: "idle", communityBusy: false };
  const text =
    typeof runtime.formatBombDebug === "function"
      ? runtime.formatBombDebug(snapshot)
      : "🥭💣 Bomb debug\n\nstatus: idle\ncommunityBusy: no";
  return ctx.reply(text);
}

module.exports = (bot) => {
  wireMangoBombRuntime(getMangoBombRuntime(), bot);

  bot.command("mangobomb", (ctx) =>
    Promise.resolve(handleMangoBomb(ctx)).catch((err) => {
      logError(
        "[mango-bomb] internal error stage=start",
        err && err.message ? err.message : err
      );
    })
  );
  bot.command("bombdebug", (ctx) =>
    Promise.resolve(handleBombDebug(ctx)).catch((err) => {
      logError(
        "[mango-bomb] internal error stage=debug",
        err && err.message ? err.message : err
      );
    })
  );
  bot.action(/^mb:(join|pass|wait):[a-f0-9]{8,16}$/i, (ctx) =>
    Promise.resolve(handleMangoBombCallback(ctx)).catch((err) => {
      logError(
        "[mango-bomb] internal error stage=callback",
        err && err.message ? err.message : err
      );
      if (ctx && typeof ctx.answerCbQuery === "function") {
        return ctx.answerCbQuery(STALE_CALLBACK).catch(() => {});
      }
      return undefined;
    })
  );
};

module.exports.handleMangoBomb = handleMangoBomb;
module.exports.handleMangoBombCallback = handleMangoBombCallback;
module.exports.handleBombDebug = handleBombDebug;
module.exports.wireMangoBombRuntime = wireMangoBombRuntime;
module.exports.PRIVATE_MANGO_BOMB_TEXT = PRIVATE_MANGO_BOMB_TEXT;
module.exports.MANGO_BOMB_TOPIC_REQUIRED_TEXT = MANGO_BOMB_TOPIC_REQUIRED_TEXT;
module.exports.START_FAILED_TEXT = START_FAILED_TEXT;
