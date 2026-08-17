/**
 * Admin-only /deliver and /presaledistribute.
 * Creates a one-time admin delivery session. Does not sign or hold keys.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const { getReplyTargetUser, parseCommandArg } = require("../utils/telegramReplyTarget");
const { shortenWallet } = require("../utils/solanaWallet");
const {
  prepareRewardDelivery,
  preparePresaleDistribution,
  listPendingRewardsForAdmin,
  findPendingPresaleContribution,
} = require("../services/rewardDelivery");
const { getReward } = require("../services/memberRewards");
const { formatMangoGrouped, formatMangoHuman } = require("../services/deliveryConstants");

const ADMIN_ONLY = "This command is admin only.";
const USAGE_DELIVER =
  "Use /deliver <rewardId> <mangoAmount>, or reply to a member with /deliver.";
const USAGE_PRESALE =
  "Reply to a member's message with /presaledistribute.";

function deliveryKeyboard(url) {
  if (!url) {
    return undefined;
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Delivery", url)]]);
}

function formatReady(review, url) {
  return {
    text: [
      "🎁 ManGo Delivery",
      "",
      `Type: ${review.typeLabel}`,
      `To: ${review.destinationShort}`,
      "Asset: MANGO",
      `Amount: ${review.amountDisplay} MANGO`,
      "",
      "Sign with the configured distribution wallet.",
      "The bot never holds private keys.",
    ].join("\n"),
    extra: deliveryKeyboard(url),
  };
}

function handleDeliver(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }

  const arg = parseCommandArg(ctx);
  const parts = arg ? arg.split(/\s+/).filter(Boolean) : [];
  const target = getReplyTargetUser(ctx);

  if (!parts.length && target) {
    const pending = listPendingRewardsForAdmin(target.id, options.rewardsFile);
    if (!pending.length) {
      return ctx.reply(`No pending rewards for ${target.firstName}.`);
    }
    const lines = [`🎁 Pending rewards for ${target.firstName}`, ""];
    for (const reward of pending.slice(0, 8)) {
      lines.push(
        `• ${reward.label || reward.type} · ${reward.rewardId} · ${reward.status}`
      );
    }
    lines.push("", "Use /deliver <rewardId> <mangoAmount>.");
    return ctx.reply(lines.join("\n"));
  }

  if (!parts.length) {
    return ctx.reply(USAGE_DELIVER);
  }

  const rewardId = parts[0];
  const amountHuman = parts.slice(1).join(" ");
  const existing = getReward(rewardId, options.rewardsFile);
  if (!existing) {
    return ctx.reply(USAGE_DELIVER);
  }

  const result = prepareRewardDelivery({
    adminUserId: ctx.from.id,
    rewardId,
    amountHuman: amountHuman || undefined,
    walletFile: options.walletFile,
    rewardsFile: options.rewardsFile,
    deliveryFile: options.deliveryFile,
    env: options.env,
    now: options.now,
    deliveryUrl: options.deliveryUrl,
  });

  if (!result.ok) {
    return ctx.reply(result.error || "Invalid request.");
  }

  const formatted = formatReady(result.review, result.url);
  return ctx.reply(formatted.text, formatted.extra);
}

function handlePresaleDistribute(ctx, options = {}) {
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
    return ctx.reply(USAGE_PRESALE);
  }

  const contribution = findPendingPresaleContribution(target.id, options);
  if (!contribution) {
    return ctx.reply(`No pending presale allocation for ${target.firstName}.`);
  }

  const result = preparePresaleDistribution({
    adminUserId: ctx.from.id,
    telegramUserId: target.id,
    contribution,
    presaleFile: options.presaleFile,
    deliveryFile: options.deliveryFile,
    env: options.env,
    now: options.now,
    deliveryUrl: options.deliveryUrl,
  });

  if (!result.ok) {
    return ctx.reply(result.error || "Invalid request.");
  }

  const formatted = formatReady(result.review, result.url);
  return ctx.reply(formatted.text, formatted.extra);
}

module.exports = (bot) => {
  bot.command("deliver", (ctx) => handleDeliver(ctx));
  bot.command("presaledistribute", (ctx) => handlePresaleDistribute(ctx));
};

module.exports.handleDeliver = handleDeliver;
module.exports.handlePresaleDistribute = handlePresaleDistribute;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.USAGE_DELIVER = USAGE_DELIVER;
module.exports.USAGE_PRESALE = USAGE_PRESALE;
module.exports.formatReady = formatReady;
module.exports.shortenWallet = shortenWallet;
module.exports.formatMangoGrouped = formatMangoGrouped;
module.exports.formatMangoHuman = formatMangoHuman;
