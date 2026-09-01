/**
 * Attribute group joins that used a Community Builder invite link,
 * open First Welcome windows, and claim valid targeted welcomes.
 * Requires chat_member updates (see TELEGRAM_ALLOWED_UPDATES).
 *
 * Text handler MUST call next() so chat-fight / points-trigger still run.
 */

const {
  handleChatMemberUpdate,
  tryClaimFirstWelcomeFromMessage,
  FIRST_WELCOME_GROUP_TEXT,
} = require("../services/communityBuilder");

function registerCommunityBuilderListener(bot, options = {}) {
  if (!bot || typeof bot.on !== "function") {
    return;
  }
  bot.on("chat_member", async (ctx) => {
    const update = ctx && ctx.update && ctx.update.chat_member;
    if (!update) {
      return;
    }
    try {
      return await handleChatMemberUpdate(update, {
        ...options,
        telegram: ctx.telegram,
        botId: ctx.botInfo && ctx.botInfo.id,
      });
    } catch (_err) {
      const { error: logError } = require("../utils/logger");
      logError("[community-builder] join handler failed");
    }
  });

  bot.on("text", (ctx, next) => {
    const continueChain =
      typeof next === "function" ? next : () => undefined;
    try {
      const result = tryClaimFirstWelcomeFromMessage(ctx, {
        ...options,
        telegram: ctx.telegram,
      });
      if (result && result.ok && result.awarded && ctx && typeof ctx.reply === "function") {
        const extra =
          ctx.message && ctx.message.message_id
            ? { reply_to_message_id: ctx.message.message_id }
            : undefined;
        Promise.resolve(ctx.reply(FIRST_WELCOME_GROUP_TEXT, extra)).catch(() => undefined);
      }
    } catch (_err) {
      const { error: logError } = require("../utils/logger");
      logError("[community-builder] first-welcome handler failed");
    }
    return continueChain();
  });
}

module.exports = (bot) => {
  registerCommunityBuilderListener(bot);
};

module.exports.registerCommunityBuilderListener = registerCommunityBuilderListener;
