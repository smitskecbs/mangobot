/**
 * /trivia | /quiz — admin-start community trivia race.
 * Callbacks: trivia:<sessionId>:<answerIndex>
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const { canManageGroup } = require("../utils/admin");
const { isAllowedChatFightChat } = require("../services/chatFight");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startTrivia,
  getTriviaRuntime,
  parseTriviaCallbackData,
  sanitizePvpDisplayName,
} = require("../services/trivia");
const { awardTriviaWinXp } = require("../services/points");
const { logError } = require("../utils/logger");

function busyOptions(options = {}) {
  return {
    isChatFightOpenFn: options.isChatFightOpenFn,
    isTicTacToeOpenFn: options.isTicTacToeOpenFn,
    isConnectFourOpenFn: options.isConnectFourOpenFn,
    isTriviaOpenFn: options.isTriviaOpenFn,
  };
}

async function handleTrivia(ctx, options = {}) {
  const startFn =
    typeof options.startTriviaFn === "function"
      ? options.startTriviaFn
      : startTrivia;
  const canManageFn =
    typeof options.canManageGroupFn === "function"
      ? options.canManageGroupFn
      : canManageGroup;
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
          getTriviaRuntime().setMessageId(sessionId, messageId);

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    return ctx.reply("🧠 Trivia is played in the ManGo community group.");
  }

  if (!isAllowedChatFightChat(ctx.chat.id)) {
    return ctx.reply("🧠 Trivia is not available in this group.");
  }

  let allowed = false;
  try {
    allowed = Boolean(
      await canManageFn(ctx, {
        isAdminFn: options.isAdminFn,
        getChatMember: options.getChatMember,
      })
    );
  } catch (_err) {
    allowed = false;
  }

  if (!allowed) {
    return ctx.reply("🧠 Trivia can currently only be started by an admin.");
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
    return ctx.reply("🧠 A Trivia challenge is already open.");
  }

  const result = startFn({ chatId: ctx.chat.id });
  if (!result.ok) {
    if (result.reason === "already-active") {
      return ctx.reply("🧠 A Trivia challenge is already open.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("🧠 Trivia is not available in this group.");
    }
    return ctx.reply("🧠 Could not start Trivia.");
  }

  const sent = await ctx.reply(result.text, result.keyboard || undefined);
  if (sent && sent.message_id != null && result.session) {
    setMessageIdFn(result.session.id, sent.message_id);
  }
  return sent;
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
  const awardXpFn =
    typeof options.awardTriviaWinXpFn === "function"
      ? options.awardTriviaWinXpFn
      : (userId, name) => awardTriviaWinXp(userId, name, options.pointsFile);

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

  // Sync attempt + winner flag before any XP await.
  const result = runtime.tryAnswer({
    sessionId: parsed.sessionId,
    userId: ctx.from.id,
    answerIndex: parsed.answerIndex,
    chatId,
    displayName,
    isBot: Boolean(ctx.from.is_bot),
  });

  if (!result.ok) {
    if (result.reason === "already-answered") {
      await answer("You already answered.");
    } else if (result.reason === "finished" || result.reason === "inactive") {
      await answer("This trivia is over.");
    } else if (result.reason === "wrong-chat") {
      await answer("Wrong chat.");
    } else if (result.reason === "bot") {
      await answer("Bots cannot play.");
    } else if (result.reason === "invalid-session") {
      await answer("This trivia is no longer available.");
    } else {
      await answer();
    }
    return;
  }

  if (!result.correct) {
    await answer(result.toast || "Wrong answer ❌");
    return;
  }

  await answer("Correct! 🏆");

  const claim = runtime.claimXpAward(parsed.sessionId);
  let awardResult = { awarded: false, pointsToAdd: 0 };
  if (claim.ok && claim.shouldAward) {
    try {
      awardResult = awardXpFn(claim.winnerUserId, claim.winnerName || "Player");
    } catch (err) {
      logError(
        "[trivia] awardTriviaWinXp failed:",
        err && err.message ? err.message : err
      );
      awardResult = { awarded: false, reason: "award-error", pointsToAdd: 0 };
    }
  }

  const rendered = runtime.applyXpResultToRender(parsed.sessionId, awardResult);
  if (rendered && typeof ctx.editMessageText === "function") {
    try {
      await ctx.editMessageText(rendered.text, rendered.extra || undefined);
    } catch (err) {
      logError(
        "[trivia] editMessageText failed:",
        err && err.message ? err.message : err
      );
      if (typeof ctx.reply === "function") {
        await ctx.reply(rendered.text).catch(() => {});
      }
    }
  }
}

module.exports = (bot) => {
  const runtime = getTriviaRuntime();
  if (bot && bot.telegram && typeof bot.telegram.editMessageText === "function") {
    runtime.setEditMessageHandler((chatId, messageId, text) =>
      bot.telegram.editMessageText(chatId, messageId, undefined, text)
    );
  }

  bot.command(["trivia", "quiz"], (ctx) =>
    Promise.resolve(handleTrivia(ctx)).catch(() => undefined)
  );
  bot.action(/^trivia:[a-f0-9]+:[0-3]$/i, (ctx) =>
    Promise.resolve(handleTriviaAnswer(ctx)).catch(() => undefined)
  );
};

module.exports.handleTrivia = handleTrivia;
module.exports.handleTriviaAnswer = handleTriviaAnswer;
