/**
 * Admin-only /reward and /memberrewards.
 * Creates pending reward-queue records. Does not send on-chain assets.
 */

const { isAdmin } = require("../services/points");
const {
  createReward,
  listRewardsForUser,
  defaultLabelForType,
  normalizeRewardType,
} = require("../services/memberRewards");
const { getReplyTargetUser, parseCommandArg } = require("../utils/telegramReplyTarget");
const { shortenWallet } = require("../utils/solanaWallet");
const { isPrivateChat } = require("../utils/botMenu");

const ADMIN_ONLY = "This command is admin only.";
const USAGE_REWARD = "Reply to a member's message with /reward or /reward mystery.";
const USAGE_HISTORY = "Reply to a member's message with /memberrewards.";

function formatRewardPrepared(reward, displayName) {
  const mystery = reward.type === "mystery-gift";
  return [
    mystery ? "🎁 Mystery Gift prepared" : "🎁 Reward prepared",
    "",
    `Member: ${displayName}`,
    `Wallet: ${shortenWallet(reward.walletSnapshot)}`,
    `Type: ${defaultLabelForType(reward.type)}`,
    `Status: Pending`,
    "",
    `Reward ID: ${reward.rewardId}`,
  ].join("\n");
}

function formatRewardHistory(rewards, displayName) {
  if (!rewards.length) {
    return `🎁 Rewards for ${displayName}\n\nNo rewards recorded.`;
  }
  const lines = [`🎁 Rewards for ${displayName}`, ""];
  for (const reward of rewards.slice(0, 10)) {
    const title =
      reward.type === "mystery-gift"
        ? "Mystery Gift"
        : defaultLabelForType(reward.type);
    lines.push(`• ${title} · ${reward.status} · ${reward.rewardId}`);
  }
  return lines.join("\n");
}

function handleReward(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }

  const target = getReplyTargetUser(ctx);
  if (!target) {
    return ctx.reply(USAGE_REWARD);
  }

  const arg = parseCommandArg(ctx);
  const type = normalizeRewardType(arg || "mystery-gift");
  if (!type) {
    return ctx.reply(USAGE_REWARD);
  }

  const result = createReward({
    telegramUserId: target.id,
    type,
    createdBy: ctx.from.id,
    walletFile: options.walletFile,
    rewardsFile: options.rewardsFile,
    now: options.now,
  });

  if (!result.ok) {
    return ctx.reply(result.error || "Invalid request.");
  }

  return ctx.reply(formatRewardPrepared(result.reward, target.firstName));
}

function handleMemberRewards(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }

  const target = getReplyTargetUser(ctx);
  if (!target) {
    return ctx.reply(USAGE_HISTORY);
  }

  const rewards = listRewardsForUser(target.id, options.rewardsFile);
  return ctx.reply(formatRewardHistory(rewards, target.firstName));
}

module.exports = (bot) => {
  bot.command("reward", (ctx) => handleReward(ctx));
  bot.command("memberrewards", (ctx) => handleMemberRewards(ctx));
};

module.exports.handleReward = handleReward;
module.exports.handleMemberRewards = handleMemberRewards;
module.exports.formatRewardPrepared = formatRewardPrepared;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.USAGE_REWARD = USAGE_REWARD;
module.exports.USAGE_HISTORY = USAGE_HISTORY;
