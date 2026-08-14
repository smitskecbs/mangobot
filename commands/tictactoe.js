/**
 * /tictactoe — admin-start PvP Tic-Tac-Toe challenge in the community group.
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const { canManageGroup } = require("../utils/admin");
const { isAllowedChatFightChat } = require("../services/chatFight");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startTicTacToeChallenge,
  getTicTacToeRuntime,
} = require("../services/ticTacToe");

async function handleTicTacToe(ctx, options = {}) {
  const startFn =
    typeof options.startChallengeFn === "function"
      ? options.startChallengeFn
      : startTicTacToeChallenge;
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
          getTicTacToeRuntime().setMessageId(sessionId, messageId);

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply("🎮 Tic-Tac-Toe is played in the ManGo community group.");
  }

  if (!isGroupChat(ctx)) {
    return ctx.reply("🎮 Tic-Tac-Toe is played in the ManGo community group.");
  }

  if (!isAllowedChatFightChat(ctx.chat.id)) {
    return ctx.reply("🎮 Tic-Tac-Toe is not available in this group.");
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
    return ctx.reply(
      "🎮 Tic-Tac-Toe can currently only be started by an admin."
    );
  }

    if (busyFn({
      isChatFightOpenFn: options.isChatFightOpenFn,
      isTicTacToeOpenFn: options.isTicTacToeOpenFn,
      isConnectFourOpenFn: options.isConnectFourOpenFn,
      isTriviaOpenFn: options.isTriviaOpenFn,
    })) {
    const reason = busyReasonFn({
      isChatFightOpenFn: options.isChatFightOpenFn,
      isTicTacToeOpenFn: options.isTicTacToeOpenFn,
      isConnectFourOpenFn: options.isConnectFourOpenFn,
      isTriviaOpenFn: options.isTriviaOpenFn,
    });
    if (reason === "chatfight") {
      return ctx.reply("⚔️ A ChatFight is already running.");
    }
    if (reason === "connect4") {
      return ctx.reply("🟡 A Connect Four challenge is already open.");
    }
    if (reason === "trivia") {
      return ctx.reply("🧠 A Trivia challenge is already open.");
    }
    return ctx.reply("🎮 A Tic-Tac-Toe challenge is already open.");
  }

  const result = startFn({ chatId: ctx.chat.id });
  if (!result.ok) {
    if (result.reason === "already-active") {
      return ctx.reply("🎮 A Tic-Tac-Toe challenge is already open.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("🎮 Tic-Tac-Toe is not available in this group.");
    }
    return ctx.reply("🎮 Could not start Tic-Tac-Toe.");
  }

  const sent = await ctx.reply(result.text, result.keyboard || undefined);
  if (sent && sent.message_id != null && result.session) {
    setMessageIdFn(result.session.id, sent.message_id);
  }
  return sent;
}

module.exports = (bot) => {
  bot.command("tictactoe", (ctx) => handleTicTacToe(ctx));
};

module.exports.handleTicTacToe = handleTicTacToe;
