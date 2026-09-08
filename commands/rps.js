/**
 * /rps — member-start PvP Rock Paper Scissors in the community Games topic.
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
} = require("../services/communityGameState");
const {
  startRockPaperScissorsChallenge,
  getRockPaperScissorsRuntime,
  PLAYER_BUSY_TEXT,
} = require("../services/rockPaperScissors");
const {
  GAMES_TOPIC_REQUIRED_MESSAGE,
  assertCanStartInteractiveGame,
  withCtxThreadExtra,
} = require("../utils/gameTopic");

const PRIVATE_RPS_TEXT =
  "✊✋✌️ Rock Paper Scissors is played in the ManGo group Games topic.";

async function handleRps(ctx, options = {}) {
  const startFn =
    typeof options.startChallengeFn === "function"
      ? options.startChallengeFn
      : startRockPaperScissorsChallenge;
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
          getRockPaperScissorsRuntime().setMessageId(sessionId, messageId);
  const assertStartFn =
    typeof options.assertCanStartFn === "function"
      ? options.assertCanStartFn
      : assertCanStartInteractiveGame;

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx) || !isGroupChat(ctx)) {
    return ctx.reply(PRIVATE_RPS_TEXT);
  }

  const gate = await assertStartFn(ctx, options);
  if (!gate.ok) {
    if (gate.reason === "bot") {
      return ctx.reply("✊✋✌️ Bots cannot start Rock Paper Scissors.");
    }
    if (gate.reason === "wrong-topic") {
      return ctx.reply(GAMES_TOPIC_REQUIRED_MESSAGE);
    }
    return ctx.reply("✊✋✌️ Rock Paper Scissors is not available in this group.");
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
      return ctx.reply("✊✋✌️ Bots cannot start Rock Paper Scissors.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("✊✋✌️ Rock Paper Scissors is not available in this group.");
    }
    return ctx.reply("✊✋✌️ Could not start Rock Paper Scissors.");
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

async function handleRpsPrivateStart(ctx, payload, options = {}) {
  const runtime =
    options.runtime ||
    (typeof options.getRuntimeFn === "function"
      ? options.getRuntimeFn()
      : getRockPaperScissorsRuntime());
  const raw = String(payload || "");
  const sessionId = raw.startsWith("rps_") ? raw.slice(4) : null;
  const view = runtime.getPrivateView(ctx.from && ctx.from.id, sessionId);
  if (!view.ok) {
    return ctx.reply(PRIVATE_RPS_TEXT);
  }
  return ctx.reply(view.text, view.extra);
}

module.exports = (bot) => {
  bot.command("rps", (ctx) => handleRps(ctx));
};

module.exports.handleRps = handleRps;
module.exports.handleRpsPrivateStart = handleRpsPrivateStart;
module.exports.PRIVATE_RPS_TEXT = PRIVATE_RPS_TEXT;
