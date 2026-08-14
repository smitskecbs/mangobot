/**
 * /connect4 — admin-start PvP Connect Four challenge in the community group.
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const { canManageGroup } = require("../utils/admin");
const { isAllowedChatFightChat } = require("../services/chatFight");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startConnectFourChallenge,
  getConnectFourRuntime,
} = require("../services/connectFour");

async function handleConnectFour(ctx, options = {}) {
  const startFn =
    typeof options.startChallengeFn === "function"
      ? options.startChallengeFn
      : startConnectFourChallenge;
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
          getConnectFourRuntime().setMessageId(sessionId, messageId);

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    return ctx.reply("🟡 Connect Four is played in the ManGo community group.");
  }

  if (!isAllowedChatFightChat(ctx.chat.id)) {
    return ctx.reply("🟡 Connect Four is not available in this group.");
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
      "🟡 Connect Four can currently only be started by an admin."
    );
  }

  if (
    busyFn({
      isChatFightOpenFn: options.isChatFightOpenFn,
      isTicTacToeOpenFn: options.isTicTacToeOpenFn,
      isConnectFourOpenFn: options.isConnectFourOpenFn,
    })
  ) {
    const reason = busyReasonFn({
      isChatFightOpenFn: options.isChatFightOpenFn,
      isTicTacToeOpenFn: options.isTicTacToeOpenFn,
      isConnectFourOpenFn: options.isConnectFourOpenFn,
    });
    if (reason === "chatfight") {
      return ctx.reply("⚔️ A ChatFight is already running.");
    }
    if (reason === "tictactoe") {
      return ctx.reply("🎮 A Tic-Tac-Toe challenge is already open.");
    }
    return ctx.reply("🟡 A Connect Four challenge is already open.");
  }

  const result = startFn({ chatId: ctx.chat.id });
  if (!result.ok) {
    if (result.reason === "already-active") {
      return ctx.reply("🟡 A Connect Four challenge is already open.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("🟡 Connect Four is not available in this group.");
    }
    return ctx.reply("🟡 Could not start Connect Four.");
  }

  const sent = await ctx.reply(result.text, result.keyboard || undefined);
  if (sent && sent.message_id != null && result.session) {
    setMessageIdFn(result.session.id, sent.message_id);
  }
  return sent;
}

module.exports = (bot) => {
  bot.command(["connect4", "connectfour"], (ctx) => handleConnectFour(ctx));
};

module.exports.handleConnectFour = handleConnectFour;
