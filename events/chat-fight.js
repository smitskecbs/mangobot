/**
 * ChatFight answer listener — first correct text wins XP.
 * Registered before points-trigger (alphabetical) so winner claim runs first.
 */

const {
  isCommandText,
  awardChatFightXp,
} = require("../services/points");
const {
  tryClaimWinner,
  buildWinnerReply,
  isAllowedChatFightChat,
} = require("../services/chatFight");

/**
 * @param {object} bot
 * @param {object} [options]
 * @param {typeof tryClaimWinner} [options.tryClaimWinnerFn]
 * @param {typeof awardChatFightXp} [options.awardChatFightXpFn]
 * @param {string} [options.pointsFile]
 */
function registerChatFightListener(bot, options = {}) {
  const tryClaim =
    typeof options.tryClaimWinnerFn === "function"
      ? options.tryClaimWinnerFn
      : tryClaimWinner;
  const awardXp =
    typeof options.awardChatFightXpFn === "function"
      ? options.awardChatFightXpFn
      : awardChatFightXp;
  const pointsFile = options.pointsFile;

  bot.on("text", (ctx) => {
    if (!ctx || !ctx.from || !ctx.chat || !ctx.message) {
      return;
    }

    if (ctx.from.is_bot) {
      return;
    }

    if (!isAllowedChatFightChat(ctx.chat.id)) {
      return;
    }

    const text = ctx.message.text;
    if (isCommandText(text)) {
      return;
    }

    // Sync claim before any XP / reply work (near-simultaneous safety).
    const claim = tryClaim(ctx.from.id, ctx.chat.id, text);
    if (!claim.claimed) {
      return;
    }

    const userName =
      ctx.from.first_name || ctx.from.username || "Player";

    const awardResult =
      pointsFile !== undefined
        ? awardXp(ctx.from.id, userName, pointsFile)
        : awardXp(ctx.from.id, userName);

    if (!ctx.state || typeof ctx.state !== "object") {
      ctx.state = {};
    }
    ctx.state.chatFightAward = awardResult;
    ctx.state.chatFightWinnerName = userName;

    const reply = buildWinnerReply(userName, awardResult);
    ctx.reply(reply);
  });
}

module.exports = (bot) => {
  registerChatFightListener(bot);
};

module.exports.registerChatFightListener = registerChatFightListener;
