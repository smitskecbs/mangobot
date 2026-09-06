/**
 * Admin-only /walletgrace — visibility into the 48-hour wallet join timer.
 * Does not kick anyone. /walletprotect remains the exemption mechanism.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const { asTelegramUserId } = require("../services/knownMembers");
const { formatWalletGraceAdmin } = require("../services/walletGrace");

const ADMIN_ONLY = "This command is admin only.";
const PRIVATE_ONLY = "Open a private chat with the bot to view wallet grace.";

function parseUserId(ctx) {
  const text =
    ctx && ctx.message && typeof ctx.message.text === "string" ? ctx.message.text : "";
  const parts = text.trim().split(/\s+/);
  if (parts.length >= 2) {
    return asTelegramUserId(parts[1]);
  }
  return "";
}

async function handleWalletGrace(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    if (!isAdmin(ctx.from.id)) {
      return undefined;
    }
    return ctx.reply(PRIVATE_ONLY);
  }
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply(ADMIN_ONLY);
  }
  const userId = parseUserId(ctx);
  const text = formatWalletGraceAdmin({
    membersFile: options.membersFile,
    walletFile: options.walletFile,
    now: options.now,
    userId,
  });
  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("walletgrace", (ctx) => handleWalletGrace(ctx));
};

module.exports.handleWalletGrace = handleWalletGrace;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.PRIVATE_ONLY = PRIVATE_ONLY;
