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
  PRIVATE_MENU_HINT,
} = require("../utils/botMenu");
const {
  listRewardsForUser,
  userFacingRewardLine,
} = require("../services/memberRewards");

const GROUP_REWARDS_TEXT = "🎁 View your rewards privately.";

const REWARDS_HUB_CALLBACK = Object.freeze({
  BACK: "rhub:back",
});

const EMPTY_REWARDS_TEXT = `🥭 ManGo Rewards

No rewards yet.

Stay active, play, contribute and help the community.
Mystery Gifts and other rewards may appear here. 🎁`;

function getGroupRewardsExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "rewards");
  if (!url) {
    return {};
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Rewards", url)]]);
}

function buildRewardsHubExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Back", REWARDS_HUB_CALLBACK.BACK)],
  ]);
}

function formatOwnRewards(rewards) {
  const summary = {
    pending: 0,
    delivered: 0,
    mysteryPending: 0,
  };
  for (const reward of rewards) {
    if (reward.status === "pending" || reward.status === "prepared") {
      summary.pending += 1;
      if (reward.type === "mystery-gift") {
        summary.mysteryPending += 1;
      }
    } else if (reward.status === "sent") {
      summary.delivered += 1;
    }
  }

  if (!rewards.length) {
    return EMPTY_REWARDS_TEXT;
  }

  const lines = [
    "🥭 ManGo Rewards",
    "",
    "Pending:",
    String(summary.pending),
    "",
    "Sent:",
    String(summary.delivered),
    "",
    "Mystery Gifts:",
    `${summary.mysteryPending} pending`,
    "",
  ];
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
  return ctx.reply(formatOwnRewards(rewards), buildRewardsHubExtra());
}

async function handleRewardsCallback(ctx) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";
  if (data !== REWARDS_HUB_CALLBACK.BACK) {
    return;
  }
  try {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery();
    }
  } catch {
    // still try to handle
  }
  if (!isPrivateChat(ctx)) {
    return ctx.reply(GROUP_REWARDS_TEXT, getGroupRewardsExtra(ctx));
  }
  return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard());
}

module.exports = (bot) => {
  bot.command("rewards", (ctx) => handleRewards(ctx));
  bot.action(/^rhub:back$/, (ctx) => handleRewardsCallback(ctx));
};

module.exports.handleRewards = handleRewards;
module.exports.handleRewardsCallback = handleRewardsCallback;
module.exports.GROUP_REWARDS_TEXT = GROUP_REWARDS_TEXT;
module.exports.EMPTY_REWARDS_TEXT = EMPTY_REWARDS_TEXT;
module.exports.formatOwnRewards = formatOwnRewards;
module.exports.getGroupRewardsExtra = getGroupRewardsExtra;
module.exports.REWARDS_HUB_CALLBACK = REWARDS_HUB_CALLBACK;
