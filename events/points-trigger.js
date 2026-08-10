/**
 * Text pipeline: daily activity (silent) then gm/gn trigger awards.
 * Rank-ups may announce; activity itself never posts "+1".
 *
 * Runs after events/chat-fight.js (alphabetical). If ChatFight already
 * announced a rank-up on the winner reply, skip a duplicate rank-up here.
 */

const {
  isCommandText,
  detectTrigger,
  awardDailyActivityPoint,
  awardTriggerPoints,
  getCombinedRankUpReply,
} = require("../services/points");
const {
  isPrivateChat,
  isPrivateMenuLabel,
} = require("../utils/botMenu");

/**
 * Private reply-keyboard taps are UI actions, not community messages.
 * @param {object} ctx
 * @param {string} text
 * @returns {boolean}
 */
function shouldSkipCommunityActivity(ctx, text) {
  if (isCommandText(text)) {
    return true;
  }
  return isPrivateChat(ctx) && isPrivateMenuLabel(text);
}

module.exports = (bot) => {
  bot.on("text", (ctx) => {
    if (!ctx.from) {
      return;
    }

    const text = ctx.message.text;
    const userName = ctx.from.first_name || ctx.from.username || "friend";
    const userId = ctx.from.id;
    const skipActivity = shouldSkipCommunityActivity(ctx, text);
    const isMenuTap = isPrivateChat(ctx) && isPrivateMenuLabel(text);

    let activityResult = null;
    if (!ctx.from.is_bot && !skipActivity) {
      activityResult = awardDailyActivityPoint(userId, userName);
    }

    const trigger = isMenuTap ? null : detectTrigger(text);
    let triggerResult = null;
    if (trigger) {
      triggerResult = awardTriggerPoints(userId, userName, trigger);
    }

    const fightAward =
      ctx.state && ctx.state.chatFightAward ? ctx.state.chatFightAward : null;

    // Winner reply already includes rank-up when the fight award crossed a threshold.
    if (fightAward && fightAward.rankUp) {
      return;
    }

    const reply = getCombinedRankUpReply(
      activityResult,
      triggerResult,
      userName,
      fightAward
    );
    if (reply) {
      ctx.reply(reply);
    }
  });
};

module.exports.shouldSkipCommunityActivity = shouldSkipCommunityActivity;
