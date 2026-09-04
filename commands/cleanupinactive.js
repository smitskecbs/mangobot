/**
 * Admin-only /cleanupinactive — dry-run scan of known inactive users.
 * Never bans, kicks, unbans, or writes persistent stores.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const {
  scanInactiveCandidates,
  formatCleanupMessages,
} = require("../services/inactiveCleanupScan");

const ADMIN_ONLY = "This command is admin only.";

async function handleCleanupInactive(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return;
  }

  const getChatMember =
    typeof options.getChatMember === "function"
      ? options.getChatMember
      : ctx.telegram && typeof ctx.telegram.getChatMember === "function"
        ? (chatId, userId) => ctx.telegram.getChatMember(chatId, userId)
        : null;

  const result = await scanInactiveCandidates({
    ...options,
    getChatMember,
  });

  const messages = formatCleanupMessages(result);
  let last;
  for (const text of messages) {
    last = await ctx.reply(text);
  }
  return last;
}

module.exports = (bot) => {
  bot.command("cleanupinactive", (ctx) => handleCleanupInactive(ctx));
};

module.exports.handleCleanupInactive = handleCleanupInactive;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
