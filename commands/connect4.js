/**
 * /connect4 — member-start PvP Connect Four challenge in the community group.
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startConnectFourChallenge,
  getConnectFourRuntime,
} = require("../services/connectFour");
const {
  GAMES_TOPIC_REQUIRED_MESSAGE,
  assertCanStartInteractiveGame,
  withCtxThreadExtra,
} = require("../utils/gameTopic");

async function handleConnectFour(ctx, options = {}) {
  const startFn =
    typeof options.startChallengeFn === "function"
      ? options.startChallengeFn
      : startConnectFourChallenge;
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
  const assertStartFn =
    typeof options.assertCanStartFn === "function"
      ? options.assertCanStartFn
      : assertCanStartInteractiveGame;

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    return ctx.reply("🟡 Connect Four is played in the ManGo community group.");
  }

  const gate = await assertStartFn(ctx, options);
  if (!gate.ok) {
    if (gate.reason === "bot") {
      return ctx.reply("🟡 Bots cannot start Connect Four.");
    }
    if (gate.reason === "wrong-topic") {
      return ctx.reply(GAMES_TOPIC_REQUIRED_MESSAGE);
    }
    return ctx.reply("🟡 Connect Four is not available in this group.");
  }

  if (
    busyFn({
      isChatFightOpenFn: options.isChatFightOpenFn,
      isTicTacToeOpenFn: options.isTicTacToeOpenFn,
      isConnectFourOpenFn: options.isConnectFourOpenFn,
      isTriviaOpenFn: options.isTriviaOpenFn,
      isMangoBombOpenFn: options.isMangoBombOpenFn,
    })
  ) {
    const reason = busyReasonFn({
      isChatFightOpenFn: options.isChatFightOpenFn,
      isTicTacToeOpenFn: options.isTicTacToeOpenFn,
      isConnectFourOpenFn: options.isConnectFourOpenFn,
      isTriviaOpenFn: options.isTriviaOpenFn,
      isMangoBombOpenFn: options.isMangoBombOpenFn,
    });
    if (reason === "chatfight") {
      return ctx.reply("⚔️ A ChatFight is already running.");
    }
    if (reason === "tictactoe") {
      return ctx.reply("🎮 A Tic-Tac-Toe challenge is already open.");
    }
    if (reason === "trivia") {
      return ctx.reply("🧠 A Trivia challenge is already open.");
    }
    if (reason === "mangobomb") {
      return ctx.reply("🥭💣 A ManGo Bomb round is already running.");
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

  const sent = await ctx.reply(
    result.text,
    withCtxThreadExtra(ctx, result.keyboard || undefined)
  );
  if (sent && sent.message_id != null && result.session) {
    setMessageIdFn(result.session.id, sent.message_id);
  }
  return sent;
}

module.exports = (bot) => {
  bot.command(["connect4", "connectfour"], (ctx) => handleConnectFour(ctx));
};

module.exports.handleConnectFour = handleConnectFour;
