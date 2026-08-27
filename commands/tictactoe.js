/**
 * /tictactoe — member-start PvP Tic-Tac-Toe challenge in the community group.
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startTicTacToeChallenge,
  getTicTacToeRuntime,
  PLAYER_BUSY_TEXT,
} = require("../services/ticTacToe");
const {
  GAMES_TOPIC_REQUIRED_MESSAGE,
  assertCanStartInteractiveGame,
  withCtxThreadExtra,
} = require("../utils/gameTopic");

async function handleTicTacToe(ctx, options = {}) {
  const startFn =
    typeof options.startChallengeFn === "function"
      ? options.startChallengeFn
      : startTicTacToeChallenge;
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
  const assertStartFn =
    typeof options.assertCanStartFn === "function"
      ? options.assertCanStartFn
      : assertCanStartInteractiveGame;

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    return ctx.reply("🎮 Tic-Tac-Toe is played in the ManGo community group.");
  }

  const gate = await assertStartFn(ctx, options);
  if (!gate.ok) {
    if (gate.reason === "bot") {
      return ctx.reply("🎮 Bots cannot start Tic-Tac-Toe.");
    }
    if (gate.reason === "wrong-topic") {
      return ctx.reply(GAMES_TOPIC_REQUIRED_MESSAGE);
    }
    return ctx.reply("🎮 Tic-Tac-Toe is not available in this group.");
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
    if (reason === "connect4") {
      return ctx.reply("🟡 A Connect Four challenge is already open.");
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
    if (result.reason === "bot") {
      return ctx.reply("🎮 Bots cannot start Tic-Tac-Toe.");
    }
    if (result.reason === "already-active") {
      return ctx.reply("🎮 A Tic-Tac-Toe challenge is already open.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("🎮 Tic-Tac-Toe is not available in this group.");
    }
    return ctx.reply("🎮 Could not start Tic-Tac-Toe.");
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
  bot.command("tictactoe", (ctx) => handleTicTacToe(ctx));
};

module.exports.handleTicTacToe = handleTicTacToe;
