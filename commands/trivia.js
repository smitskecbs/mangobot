/**
 * /trivia | /quiz — Trivia Hub category chooser, then community questions.
 * Auto Trivia uses the same runtime via Activity Engine (Random, 5-question round).
 * Answer callbacks: trivia:<sessionId>:<answerIndex>
 * Hub callbacks: trivia:hub | trivia:next | trivia:change | trivia:games | trivia:cat:<id>
 */

const {
  isPrivateChat,
  isGroupChat,
  getGroupGamesMenuExtra,
  GROUP_GAMES_TEXT,
} = require("../utils/botMenu");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startTrivia,
  getTriviaRuntime,
  parseTriviaCallbackData,
  parseTriviaHubCallback,
  sanitizePvpDisplayName,
  buildTriviaChooserText,
  buildTriviaChooserKeyboard,
} = require("../services/trivia");
const { isHubCategoryId } = require("../services/triviaQuestions");
const {
  awardTriviaAttemptXp,
  getTriviaAttemptStatus,
} = require("../services/points");
const { logError } = require("../utils/logger");
const {
  emptyInlineKeyboardExtra,
} = require("../utils/expiredMessageCleanup");
const {
  GAME_OVER_TOAST,
  GAME_TYPE,
  stripStaleCallbackButtons,
} = require("../utils/gameCleanup");
const {
  GAMES_TOPIC_REQUIRED_MESSAGE,
  assertCanStartInteractiveGame,
  withCtxThreadExtra,
} = require("../utils/gameTopic");

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

function wireTriviaRuntime(runtime, botOrTelegram, options = {}) {
  if (!runtime) {
    return;
  }

  const telegram =
    botOrTelegram && botOrTelegram.telegram
      ? botOrTelegram.telegram
      : botOrTelegram;

  runtime.setAwardXpHandler((userId, name, payload) =>
    awardTriviaAttemptXp(
      userId,
      name,
      payload || {},
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

  runtime.setRoundCompleteHandler(async (payload) => {
    if (!payload || !payload.session || payload.session.messageId == null) {
      return;
    }
    if (!telegram || typeof telegram.editMessageText !== "function") {
      return;
    }
    try {
      await telegram.editMessageText(
        payload.session.chatId,
        payload.session.messageId,
        undefined,
        payload.text,
        payload.extra || emptyInlineKeyboardExtra()
      );
    } catch (err) {
      logError(
        "[trivia] final edit failed:",
        err && err.message ? err.message : err
      );
    }
  });
}

async function presentTriviaView(ctx, text, extra) {
  const withThread = withCtxThreadExtra(ctx, extra || undefined);
  if (ctx && ctx.callbackQuery && typeof ctx.editMessageText === "function") {
    try {
      return await ctx.editMessageText(text, withThread);
    } catch (_err) {
      // Fall through to a new reply.
    }
  }
  return ctx.reply(text, withThread);
}

function chooserPayload(userId, options = {}) {
  const status = getTriviaAttemptStatus(userId, options.pointsFile);
  return {
    text: buildTriviaChooserText(status),
    extra: buildTriviaChooserKeyboard(),
    status,
  };
}

async function assertTriviaStart(ctx, options = {}) {
  const assertStartFn =
    typeof options.assertCanStartFn === "function"
      ? options.assertCanStartFn
      : assertCanStartInteractiveGame;

  if (!ctx || !ctx.from) {
    return { ok: false, reason: "no-user" };
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    await ctx.reply("🧠 Trivia is played in the ManGo community group.");
    return { ok: false, reason: "private" };
  }

  const gate = await assertStartFn(ctx, options);
  if (!gate.ok) {
    if (gate.reason === "bot") {
      await ctx.reply("🧠 Bots cannot start Trivia.");
    } else if (gate.reason === "wrong-topic") {
      await ctx.reply(GAMES_TOPIC_REQUIRED_MESSAGE);
    } else {
      await ctx.reply("🧠 Trivia is not available in this group.");
    }
    return gate;
  }
  return { ok: true };
}

function busyReply(ctx, options = {}) {
  const busyFn =
    typeof options.isBusyFn === "function"
      ? options.isBusyFn
      : isCommunityChallengeBusy;
  const busyReasonFn =
    typeof options.getBusyReasonFn === "function"
      ? options.getBusyReasonFn
      : getCommunityBusyReason;
  if (!busyFn(busyOptions(options))) {
    return null;
  }
  const reason = busyReasonFn(busyOptions(options));
  if (reason === "chatfight") {
    return "⚔️ A ChatFight is already running.";
  }
  if (reason === "tictactoe") {
    return "🎮 A Tic-Tac-Toe challenge is already open.";
  }
  if (reason === "connect4") {
    return "🟡 A Connect Four challenge is already open.";
  }
  if (reason === "mangobomb") {
    return "🥭💣 A ManGo Bomb round is already running.";
  }
  if (reason === "blackjack") {
    return "🃏 A Blackjack round is already running.";
  }
  return "🧠 A Trivia challenge is already open.";
}

async function handleTrivia(ctx, options = {}) {
  const gate = await assertTriviaStart(ctx, options);
  if (!gate.ok) {
    return;
  }

  const busyText = busyReply(ctx, options);
  if (busyText) {
    return ctx.reply(busyText);
  }

  const chooser = chooserPayload(ctx.from.id, options);
  return presentTriviaView(ctx, chooser.text, chooser.extra);
}

async function handleTriviaCategoryStart(ctx, options = {}) {
  const startFn =
    typeof options.startTriviaFn === "function"
      ? options.startTriviaFn
      : startTrivia;
  const setMessageIdFn =
    typeof options.setMessageIdFn === "function"
      ? options.setMessageIdFn
      : (sessionId, messageId) =>
          getTriviaRuntime().setMessageId(sessionId, messageId);

  const parsed =
    ctx && ctx.callbackQuery
      ? parseTriviaHubCallback(ctx.callbackQuery.data)
      : null;
  const category =
    (parsed && parsed.category) ||
    (options.category && isHubCategoryId(options.category)
      ? options.category
      : null);

  async function answer(text) {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery(text || "").catch(() => {});
    }
  }

  if (!category) {
    await answer();
    return;
  }

  const gate = await assertTriviaStart(ctx, options);
  if (!gate.ok) {
    return;
  }

  const busyText = busyReply(ctx, options);
  if (busyText) {
    await answer(busyText);
    return ctx.reply(busyText);
  }

  const xpStatus = getTriviaAttemptStatus(ctx.from.id, options.pointsFile);
  const result = startFn({
    chatId: ctx.chat.id,
    source: "manual",
    category,
    hubMode: true,
    xpStatus,
  });
  if (!result.ok) {
    if (result.reason === "already-active") {
      await answer("🧠 A Trivia challenge is already open.");
      return ctx.reply("🧠 A Trivia challenge is already open.");
    }
    if (result.reason === "wrong-chat") {
      await answer();
      return ctx.reply("🧠 Trivia is not available in this group.");
    }
    await answer();
    return ctx.reply("🧠 Could not start Trivia.");
  }

  await answer();
  const sent = await presentTriviaView(
    ctx,
    result.text,
    result.keyboard || undefined
  );
  const messageId =
    sent && sent.message_id != null
      ? sent.message_id
      : ctx.callbackQuery &&
        ctx.callbackQuery.message &&
        ctx.callbackQuery.message.message_id;
  if (messageId != null && result.session) {
    setMessageIdFn(result.session.id, messageId);
  }
  return sent;
}

async function handleTriviaHubCallback(ctx, options = {}) {
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getTriviaRuntime());
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";
  const parsed = parseTriviaHubCallback(data);
  if (!parsed) {
    return;
  }

  async function answer(text) {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery(text || "").catch(() => {});
    }
  }

  if (parsed.action === "category") {
    return handleTriviaCategoryStart(ctx, options);
  }

  if (parsed.action === "hub") {
    const gate = await assertTriviaStart(ctx, options);
    if (!gate.ok) {
      return;
    }
    await answer();
    const chooser = chooserPayload(ctx.from.id, options);
    return presentTriviaView(ctx, chooser.text, chooser.extra);
  }

  if (parsed.action === "next") {
    if (ctx.from && ctx.from.is_bot) {
      await answer("Bots cannot play.");
      return;
    }
    const result = runtime.nextHubQuestion();
    if (!result.ok) {
      if (result.reason === "question-open") {
        await answer("Answer this question first.");
        return;
      }
      await answer(GAME_OVER_TOAST);
      await stripStaleCallbackButtons(ctx, { gameType: GAME_TYPE.TRIVIA });
      return;
    }
    await answer();
    if (typeof ctx.editMessageText === "function") {
      try {
        await ctx.editMessageText(
          result.text,
          result.keyboard || emptyInlineKeyboardExtra()
        );
      } catch (err) {
        logError(
          "[trivia] next edit failed:",
          err && err.message ? err.message : err
        );
      }
    }
    return;
  }

  if (parsed.action === "change") {
    if (runtime.isTriviaOpen()) {
      runtime.releaseHubSession("change-category");
    }
    const gate = await assertTriviaStart(ctx, options);
    if (!gate.ok) {
      return;
    }
    await answer();
    const chooser = chooserPayload(ctx.from.id, options);
    return presentTriviaView(ctx, chooser.text, chooser.extra);
  }

  if (parsed.action === "games") {
    if (runtime.isTriviaOpen()) {
      runtime.releaseHubSession("back-games");
    }
    await answer();
    return presentTriviaView(
      ctx,
      GROUP_GAMES_TEXT,
      getGroupGamesMenuExtra(ctx)
    );
  }
}

async function handleTriviaAnswer(ctx, options = {}) {
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getTriviaRuntime());
  const parseFn =
    typeof options.parseCallbackData === "function"
      ? options.parseCallbackData
      : parseTriviaCallbackData;

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

  if (ctx.from.is_bot) {
    await answer("Bots cannot play.");
    return;
  }

  const chatId = ctx.chat && ctx.chat.id;
  const displayName = sanitizePvpDisplayName(ctx.from);

  const result = runtime.tryAnswer({
    sessionId: parsed.sessionId,
    userId: ctx.from.id,
    answerIndex: parsed.answerIndex,
    chatId,
    displayName,
    isBot: Boolean(ctx.from.is_bot),
  });

  if (!result.ok) {
    if (
      result.reason === "already-answered" ||
      result.reason === "question-closed"
    ) {
      await answer("This question is already finished.");
    } else if (
      result.reason === "finished" ||
      result.reason === "inactive" ||
      result.reason === "invalid-session"
    ) {
      await answer(GAME_OVER_TOAST);
      await stripStaleCallbackButtons(ctx, { gameType: GAME_TYPE.TRIVIA });
    } else if (result.reason === "wrong-chat") {
      await answer("Wrong chat.");
    } else if (result.reason === "bot") {
      await answer("Bots cannot play.");
    } else {
      await answer();
    }
    return;
  }

  if (result.correct) {
    await answer("Correct! 🏆");
  } else {
    await answer(result.toast || "❌ Wrong answer!");
  }

  if (result.rendered && typeof ctx.editMessageText === "function") {
    try {
      await ctx.editMessageText(
        result.rendered.text,
        result.rendered.extra || emptyInlineKeyboardExtra()
      );
    } catch (err) {
      logError(
        "[trivia] editMessageText failed:",
        err && err.message ? err.message : err
      );
    }
  }
}

module.exports = (bot) => {
  wireTriviaRuntime(getTriviaRuntime(), bot);

  bot.command(["trivia", "quiz"], (ctx) =>
    Promise.resolve(handleTrivia(ctx)).catch(() => undefined)
  );
  bot.action(/^trivia:[a-f0-9]+:[0-3]$/i, (ctx) =>
    Promise.resolve(handleTriviaAnswer(ctx)).catch(() => undefined)
  );
  bot.action(/^trivia:(hub|next|change|games)$/, (ctx) =>
    Promise.resolve(handleTriviaHubCallback(ctx)).catch(() => undefined)
  );
  bot.action(
    /^trivia:cat:(geography|history|math|science|general|entertainment|random)$/,
    (ctx) => Promise.resolve(handleTriviaHubCallback(ctx)).catch(() => undefined)
  );
};

module.exports.handleTrivia = handleTrivia;
module.exports.handleTriviaAnswer = handleTriviaAnswer;
module.exports.handleTriviaHubCallback = handleTriviaHubCallback;
module.exports.handleTriviaCategoryStart = handleTriviaCategoryStart;
module.exports.wireTriviaRuntime = wireTriviaRuntime;
