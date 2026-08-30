/**
 * /blackjack — heads-up ManGo Blackjack in the Games topic.
 * Callbacks: bj:join|play|pass|hit|stand:<id>. Server uses ctx.from.id.
 */

const { Markup } = require("telegraf");
const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const {
  reserveBlackjackRewardedRound,
  awardBlackjackPassXp,
  awardBlackjackBotResultXp,
  awardBlackjackPvpResultXp,
  getBlackjackStatus,
  markBlackjackPvpMatchup,
} = require("../services/points");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
  formatCommunityBusyReply,
} = require("../services/communityGameState");
const {
  startLobby,
  getBlackjackRuntime,
  parseBlackjackCallbackData,
  STALE_CALLBACK,
  STATUS,
  PLAYER_BUSY_TEXT,
} = require("../services/blackjack");
const { reminderForBlockedXp } = require("../services/xpWalletGate");
const { emptyInlineKeyboardExtra } = require("../utils/expiredMessageCleanup");
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

const PRIVATE_BLACKJACK_TEXT = `🃏 ManGo Blackjack

This is a live community game.

Play it in the ManGo Games topic.`;

const BLACKJACK_TOPIC_REQUIRED_TEXT = `🃏 Blackjack is played in the Games topic.

Open Games and start the next round there. 🎮`;

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

function wireBlackjackRuntime(runtime, botOrTelegram, options = {}) {
  if (!runtime) {
    return;
  }

  const telegram =
    botOrTelegram && botOrTelegram.telegram
      ? botOrTelegram.telegram
      : botOrTelegram;

  runtime.setAwardHandlers({
    reserve: (userId, name, payload) =>
      reserveBlackjackRewardedRound(
        userId,
        name,
        payload || {},
        options.pointsFile,
        options.walletFile
      ),
    pass: (userId, name, payload) =>
      awardBlackjackPassXp(
        userId,
        name,
        payload || {},
        options.pointsFile,
        options.walletFile
      ),
    bot: (userId, name, payload) =>
      awardBlackjackBotResultXp(
        userId,
        name,
        payload || {},
        options.pointsFile,
        options.walletFile
      ),
    pvp: (userId, name, payload) =>
      awardBlackjackPvpResultXp(
        userId,
        name,
        payload || {},
        options.pointsFile,
        options.walletFile
      ),
    status: (userId) => getBlackjackStatus(userId, options.pointsFile),
    markPair: (userId, opponentId) =>
      markBlackjackPvpMatchup(userId, opponentId, options.pointsFile),
  });

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
    runtime.setSendMessageHandler((chatId, text, extra) =>
      telegram.sendMessage(chatId, text, extra || emptyInlineKeyboardExtra())
    );
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

async function handleBlackjack(ctx, options = {}) {
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
      : (gameId, messageId) => getBlackjackRuntime().setMessageId(gameId, messageId);
  const assertStartFn =
    typeof options.assertCanStartFn === "function"
      ? options.assertCanStartFn
      : assertCanStartInteractiveGame;

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    return ctx.reply(PRIVATE_BLACKJACK_TEXT, openGamesExtra());
  }

  const gate = await assertStartFn(ctx, {
    ...options,
    allowAdminTopicBypass: false,
  });
  if (!gate.ok) {
    if (gate.reason === "bot") {
      return ctx.reply("🃏 Bots cannot start Blackjack.");
    }
    if (gate.reason === "wrong-topic") {
      return ctx.reply(
        BLACKJACK_TOPIC_REQUIRED_TEXT,
        withCtxThreadExtra(ctx, openGamesExtra())
      );
    }
    return ctx.reply("🃏 Blackjack is not available in this group.");
  }

  if (busyFn(busyOptions(options))) {
    const reason = busyReasonFn(busyOptions(options));
    if (reason === "blackjack") {
      return ctx.reply("🃏 A Blackjack round is already running.");
    }
    return ctx.reply(formatCommunityBusyReply(reason));
  }

  const result = startFn({
    chatId: ctx.chat.id,
    threadId: getMessageThreadId(ctx),
    source: "manual",
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
      return ctx.reply("🃏 A Blackjack round is already running.");
    }
    if (result.reason === "bot") {
      return ctx.reply("🃏 Bots cannot start Blackjack.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("🃏 Blackjack is not available in this group.");
    }
    return ctx.reply("🃏 Could not start Blackjack.");
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

async function handleBlackjackCallback(ctx, options = {}) {
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getBlackjackRuntime());
  const parseFn =
    typeof options.parseCallbackData === "function"
      ? options.parseCallbackData
      : parseBlackjackCallbackData;

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

  let result;
  if (parsed.action === "join") {
    result = await runtime.enqueueJoin(input);
  } else if (parsed.action === "play") {
    result = await runtime.enqueuePlay(input);
  } else if (parsed.action === "pass") {
    result = await runtime.enqueuePass(input);
  } else if (parsed.action === "hit") {
    result = await runtime.enqueueHit(input);
  } else {
    result = await runtime.enqueueStand(input);
  }

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
        gameType: GAME_TYPE.BLACKJACK,
        text: finalUi && finalUi.text,
      });
    }
    return;
  }

  const toasts = {
    join: "Joined!",
    play: "Play!",
    pass: "Pass.",
    hit: "Hit!",
    stand: "Stand.",
  };
  await answer(toasts[parsed.action] || "OK");
}

module.exports = (bot) => {
  wireBlackjackRuntime(getBlackjackRuntime(), bot);
  bot.command("blackjack", (ctx) => handleBlackjack(ctx));
  bot.action(/^bj:(join|play|pass|hit|stand):/, (ctx) =>
    handleBlackjackCallback(ctx)
  );
};

module.exports.handleBlackjack = handleBlackjack;
module.exports.handleBlackjackCallback = handleBlackjackCallback;
module.exports.wireBlackjackRuntime = wireBlackjackRuntime;
module.exports.PRIVATE_BLACKJACK_TEXT = PRIVATE_BLACKJACK_TEXT;
module.exports.BLACKJACK_TOPIC_REQUIRED_TEXT = BLACKJACK_TOPIC_REQUIRED_TEXT;
