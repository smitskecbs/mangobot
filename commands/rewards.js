/**
 * /rewards — Mystery Gifts explainer + member's own reward history (private).
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
const { getMemberActivityProfile } = require("../services/memberActivityProfile");
const { builderSummary } = require("../services/communityBuilder");

const GROUP_REWARDS_TEXT = "🎁 View your Mystery Gifts privately.";

const REWARDS_HUB_CALLBACK = Object.freeze({
  BACK: "rhub:back",
});

const MYSTERY_GIFTS_INTRO = `🎁 Mystery Gifts

Stay active and help ManGo grow.

Each week, ManGo can send Mystery Gifts to members who make a real contribution.

You can stand out through:

⚡ Community activity
🤝 Builder contributions
👥 Bringing real members into ManGo

If you are selected, ManGoBot will tell you what happens next.`;

const EMPTY_GIFTS_BLOCK = `🎁 Your Gifts

No Mystery Gifts yet.`;

const EMPTY_REWARDS_TEXT = `${MYSTERY_GIFTS_INTRO}

${EMPTY_GIFTS_BLOCK}`;

function getGroupRewardsExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "rewards");
  if (!url) {
    return {};
  }
  return Markup.inlineKeyboard([[Markup.button.url("Open Mystery Gifts", url)]]);
}

function buildRewardsHubExtra() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Back", REWARDS_HUB_CALLBACK.BACK)],
  ]);
}

function formatActivityBlock(userId, options = {}) {
  try {
    const profile = getMemberActivityProfile(userId, options);
    const summary = builderSummary(userId, options);
    const xp = profile && profile.xp ? profile.xp.lifetime : 0;
    const weekly = profile && profile.xp ? profile.xp.weekly : 0;
    const streak =
      profile && profile.streak && typeof profile.streak.current === "number"
        ? profile.streak.current
        : 0;
    const bp =
      summary && typeof summary.builderPoints === "number"
        ? summary.builderPoints
        : 0;
    const referrals =
      summary && typeof summary.validReferrals === "number"
        ? summary.validReferrals
        : 0;
    return [
      "📊 Your Activity",
      `⚡ XP: ${xp}`,
      `📅 Weekly XP: ${weekly}`,
      `🔥 Activity Streak: ${streak} days`,
      `🤝 Builder Points: ${bp}`,
      `👥 Referrals: ${referrals}`,
    ].join("\n");
  } catch (_err) {
    return "";
  }
}

function formatGiftsHistory(rewards) {
  const summary = {
    pending: 0,
    delivered: 0,
    mysteryPending: 0,
  };
  for (const reward of rewards) {
    if (
      reward.status === "pending" ||
      reward.status === "prepared" ||
      reward.status === "delivery-ready" ||
      reward.status === "submitted"
    ) {
      summary.pending += 1;
      if (reward.type === "mystery-gift") {
        summary.mysteryPending += 1;
      }
    } else if (reward.status === "sent") {
      summary.delivered += 1;
    }
  }

  const lines = [
    "🎁 Your Gifts",
    "",
    "Pending:",
    String(summary.pending),
    "",
    "Sent:",
    String(summary.delivered),
  ];
  if (summary.mysteryPending > 0) {
    lines.push("", "Mystery Gifts:", `${summary.mysteryPending} pending`);
  }
  lines.push("");
  for (const reward of rewards.slice(0, 10)) {
    lines.push(userFacingRewardLine(reward));
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatOwnRewards(rewards, extras = {}) {
  const activity = formatActivityBlock(extras.userId, extras);
  const gifts =
    !rewards || !rewards.length ? EMPTY_GIFTS_BLOCK : formatGiftsHistory(rewards);
  return [MYSTERY_GIFTS_INTRO, activity, gifts].filter(Boolean).join("\n\n");
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
  return ctx.reply(
    formatOwnRewards(rewards, { userId: ctx.from.id, ...options }),
    buildRewardsHubExtra()
  );
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
module.exports.MYSTERY_GIFTS_INTRO = MYSTERY_GIFTS_INTRO;
module.exports.formatOwnRewards = formatOwnRewards;
module.exports.getGroupRewardsExtra = getGroupRewardsExtra;
module.exports.REWARDS_HUB_CALLBACK = REWARDS_HUB_CALLBACK;
