/**
 * Welcome new members when they join the group chat.
 * Also opens a First Welcome Builder window and stores message ids for targeting.
 */

const {
  registerWelcomeOpportunity,
  noteBotWelcomeMessage,
  safeDisplayName,
} = require("../services/communityBuilder");

const WELCOME_TEXT = (name) => `🥭 Welcome ${name}!

Welcome to the ManGo community.

📌 Please read the pinned message
🌐 Use /links for official links
🚀 Use /launch for project status

Enjoy the build!`;

module.exports = (bot) => {
  bot.on("new_chat_members", async (ctx, next) => {
    const continueChain =
      typeof next === "function" ? next : () => undefined;
    const members =
      ctx && ctx.message && Array.isArray(ctx.message.new_chat_members)
        ? ctx.message.new_chat_members
        : [];
    const chatId = ctx && ctx.chat ? ctx.chat.id : undefined;
    const joinMessageId = ctx && ctx.message ? ctx.message.message_id : undefined;

    for (const member of members) {
      if (!member || member.is_bot) {
        continue;
      }
      const name = member.first_name || "friend";
      try {
        registerWelcomeOpportunity({
          chatId,
          userId: member.id,
          isBot: Boolean(member.is_bot),
          username: member.username,
          displayName: safeDisplayName(member),
          joinMessageId,
        });
      } catch (_err) {
        /* fail closed; public welcome still sends */
      }
      try {
        const sent = await ctx.reply(WELCOME_TEXT(name));
        if (sent && sent.message_id) {
          noteBotWelcomeMessage(member.id, sent.message_id, { chatId });
        }
      } catch (_err) {
        /* welcome send failed */
      }
    }
    return continueChain();
  });
};

module.exports.WELCOME_TEXT = WELCOME_TEXT;
