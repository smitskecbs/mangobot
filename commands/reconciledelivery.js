/**
 * Admin-only /reconciledelivery <rewardId> <signature>
 * Marks an already-paid on-chain delivery as Sent after exact verification.
 * Never builds or sends a new transaction.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const { parseCommandArg } = require("../utils/telegramReplyTarget");
const { getReward, userFacingRewardLine } = require("../services/memberRewards");
const { reconcileDeliveryPayment } = require("../services/rewardDelivery");

const ADMIN_ONLY = "This command is admin only.";
const USAGE =
  "Use /reconciledelivery <rewardId> <signature> in a private chat with the bot.";
const PRIVATE_ONLY = "Use /reconciledelivery in a private chat with the bot.";

function handleReconcileDelivery(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    return ctx.reply(PRIVATE_ONLY);
  }

  const arg = parseCommandArg(ctx);
  const parts = arg ? arg.split(/\s+/).filter(Boolean) : [];
  if (parts.length < 2) {
    return ctx.reply(USAGE);
  }

  const rewardId = parts[0];
  const signature = parts.slice(1).join(" ");
  const existing = getReward(rewardId, options.rewardsFile);
  if (!existing) {
    return ctx.reply(USAGE);
  }

  return Promise.resolve(
    reconcileDeliveryPayment({
      adminUserId: ctx.from.id,
      rewardId,
      signature,
      walletFile: options.walletFile,
      rewardsFile: options.rewardsFile,
      deliveryFile: options.deliveryFile,
      env: options.env,
      now: options.now,
      getTransactionImpl: options.getTransactionImpl,
      fetchImpl: options.fetchImpl,
      announceMysteryGift: options.announceMysteryGift,
      notifyMysteryGift: options.notifyMysteryGift,
    })
  ).then((result) => {
    if (result && result.pending) {
      return ctx.reply(
        "Delivery submitted. Waiting for network confirmation. Try again in a moment."
      );
    }
    if (!result || !result.ok) {
      return ctx.reply((result && result.error) || "This transaction could not be verified.");
    }
    const reward = getReward(rewardId, options.rewardsFile);
    const line = reward ? userFacingRewardLine(reward) : "Status: Sent";
    return ctx.reply(
      result.idempotent
        ? `🎁 Delivery already verified.\n\n${line}`
        : `🎁 Delivery verified and marked sent.\n\n${line}`
    );
  });
}

module.exports = (bot) => {
  bot.command("reconciledelivery", (ctx) => handleReconcileDelivery(ctx));
};

module.exports.handleReconcileDelivery = handleReconcileDelivery;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.USAGE = USAGE;
module.exports.PRIVATE_ONLY = PRIVATE_ONLY;
