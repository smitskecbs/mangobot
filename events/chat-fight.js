/**
 * ChatFight answer listener — first correct text wins XP.
 * Registered before points-trigger (alphabetical) so winner claim runs first.
 *
 * CRITICAL: always call next() so later middleware (community activity /
 * points-trigger) still runs. Telegraf 4 stops the chain when next is omitted.
 */

const {
  isCommandText,
  awardChatFightXp,
} = require("../services/points");
const {
  tryClaimWinner,
  buildWinnerReply,
  isAllowedChatFightChat,
  registerFightBotMessage,
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

  bot.on("text", (ctx, next) => {
    const continueChain =
      typeof next === "function" ? next : () => undefined;

    if (!ctx || !ctx.from || !ctx.chat || !ctx.message) {
      return continueChain();
    }

    if (ctx.from.is_bot) {
      return continueChain();
    }

    if (!isAllowedChatFightChat(ctx.chat.id)) {
      return continueChain();
    }

    const text = ctx.message.text;
    if (isCommandText(text)) {
      return continueChain();
    }

    // Sync claim before any XP / reply work (near-simultaneous safety).
    const claim = tryClaim(ctx.from.id, ctx.chat.id, text);
    if (!claim.claimed) {
      return continueChain();
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
    const sentPromise = Promise.resolve(ctx.reply(reply));
    sentPromise
      .then((sent) => {
        const mid = sent && sent.message_id;
        if (mid == null || !claim.fight || claim.fight.id == null) {
          return;
        }
        if (typeof registerFightBotMessage === "function") {
          registerFightBotMessage(mid, claim.fight);
        }
      })
      .catch(() => {});

    return continueChain();
  });
}

module.exports = (bot) => {
  registerChatFightListener(bot);
};

module.exports.registerChatFightListener = registerChatFightListener;
