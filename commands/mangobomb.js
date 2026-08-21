/**
 * /mangobomb — join-only community hot-potato in the Games topic.
 * Callbacks: mb:join:<id> / mb:pass:<id>. Server uses ctx.from.id.
 */

const { Markup } = require("telegraf");
const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startLobby,
  getMangoBombRuntime,
  parseMangoBombCallbackData,
  STALE_CALLBACK,
} = require("../services/mangoBomb");
const { awardMangoBombXp } = require("../services/points");
const { reminderForBlockedXp } = require("../services/xpWalletGate");
const { logError } = require("../utils/logger");
const {
  emptyInlineKeyboardExtra,
} = require("../utils/expiredMessageCleanup");
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

function busyOptions(options = {}) {
  return {
    isChatFightOpenFn: options.isChatFightOpenFn,
    isTicTacToeOpenFn: options.isTicTacToeOpenFn,
    isConnectFourOpenFn: options.isConnectFourOpenFn,
    isTriviaOpenFn: options.isTriviaOpenFn,
    isMangoBombOpenFn: options.isMangoBombOpenFn,
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
      : (gameId, messageId) => getMangoBombRuntime().setMessageId(gameId, messageId);
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
    return ctx.reply("🥭💣 A ManGo Bomb round is already running.");
  }

  const result = startFn({
    chatId: ctx.chat.id,
    threadId: getMessageThreadId(ctx),
    source: "manual",
  });
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
    return ctx.reply("🥭💣 Could not start ManGo Bomb.");
  }

  const sent = await ctx.reply(
    result.text,
    withCtxThreadExtra(ctx, result.extra || undefined)
  );
  if (sent && sent.message_id != null && result.gameId) {
    setMessageIdFn(result.gameId, sent.message_id);
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
      : await runtime.enqueuePass(input);

  if (!result || !result.ok) {
    await answer((result && result.toast) || STALE_CALLBACK);
    return;
  }

  await answer(parsed.action === "join" ? "Joined!" : "Passed!");

  const shouldEdit =
    result.text &&
    typeof ctx.editMessageText === "function" &&
    !(parsed.action === "join" && result.rendered);
  if (shouldEdit) {
    try {
      await ctx.editMessageText(
        result.text,
        result.extra || emptyInlineKeyboardExtra()
      );
    } catch (err) {
      const desc = err && (err.description || err.message || "");
      if (!String(desc).toLowerCase().includes("message is not modified")) {
        logError(
          "[mango-bomb] render failed stage=callback",
          err && err.message ? err.message : err
        );
      }
    }
  }
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
  bot.action(/^mb:(join|pass):[a-f0-9]{8,16}$/i, (ctx) =>
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
module.exports.wireMangoBombRuntime = wireMangoBombRuntime;
module.exports.PRIVATE_MANGO_BOMB_TEXT = PRIVATE_MANGO_BOMB_TEXT;
module.exports.MANGO_BOMB_TOPIC_REQUIRED_TEXT = MANGO_BOMB_TOPIC_REQUIRED_TEXT;
