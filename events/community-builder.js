/**
 * Attribute group joins that used a Community Builder invite link.
 * Requires chat_member updates (see TELEGRAM_ALLOWED_UPDATES).
 */

const { handleChatMemberUpdate } = require("../services/communityBuilder");

function registerCommunityBuilderListener(bot, options = {}) {
  if (!bot || typeof bot.on !== "function") {
    return;
  }
  bot.on("chat_member", (ctx) => {
    const update = ctx && ctx.update && ctx.update.chat_member;
    if (!update) {
      return;
    }
    try {
      handleChatMemberUpdate(update, {
        ...options,
        telegram: ctx.telegram,
        botId: ctx.botInfo && ctx.botInfo.id,
      });
    } catch (_err) {
      /* Join handling must never crash the bot. */
    }
  });
}

module.exports = (bot) => {
  registerCommunityBuilderListener(bot);
};

module.exports.registerCommunityBuilderListener = registerCommunityBuilderListener;
