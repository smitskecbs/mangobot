/**
 * /rewards — member's own reward history (private).
 * Group: private deep-link only. Never shows another user's rewards.
 */

const { Markup } = require("telegraf");
const {
  isPrivateChat,
  isGroupChat,
  getPrivateMenuKeyboard,
  resolveBotUsername,
  buildPrivateDeepLink,
} = require("../utils/botMenu");
const {
  listRewardsForUser,
  userFacingRewardLine,
} = require("../services/memberRewards");

const GROUP_REWARDS_TEXT = "🎁 View your rewards privately.";

function getGroupRewardsExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "rewards");
  if (!url) {
    return {};
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Rewards", url)]]);
}

function formatOwnRewards(rewards) {
  if (!rewards.length) {
    return "🎁 Your ManGo Rewards\n\nNo pending rewards.";
  }
  const lines = ["🎁 Your ManGo Rewards", ""];
  for (const reward of rewards.slice(0, 10)) {
    lines.push(userFacingRewardLine(reward));
    lines.push("");
  }
  return lines.join("\n").trim();
}

function handleRewards(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }

  if (!isPrivateChat(ctx)) {
    if (isGroupChat(ctx)) {
      return ctx.reply(GROUP_REWARDS_TEXT, getGroupRewardsExtra(ctx));
    }
    return ctx.reply(GROUP_REWARDS_TEXT);
  }

  const rewards = listRewardsForUser(ctx.from.id, options.rewardsFile);
  return ctx.reply(formatOwnRewards(rewards), getPrivateMenuKeyboard());
}

module.exports = (bot) => {
  bot.command("rewards", (ctx) => handleRewards(ctx));
};

module.exports.handleRewards = handleRewards;
module.exports.GROUP_REWARDS_TEXT = GROUP_REWARDS_TEXT;
module.exports.formatOwnRewards = formatOwnRewards;
module.exports.getGroupRewardsExtra = getGroupRewardsExtra;
