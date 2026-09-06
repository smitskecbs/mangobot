/**
 * Admin-only explicit wallet-cleanup whitelist.
 * /walletprotect and /walletunprotect — persistent, not inferred from XP/activity.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const { getReplyTargetUser } = require("../utils/telegramReplyTarget");
const {
  addProtectedUser,
  removeProtectedUser,
  asTelegramUserId,
  loadKnownMembersStore,
} = require("../services/knownMembers");

const ADMIN_ONLY = "This command is admin only.";
const USAGE =
  "Reply to a member, or pass a Telegram user id: /walletprotect 123456789";

function parseUserId(ctx) {
  const reply = getReplyTargetUser(ctx);
  if (reply && reply.id != null) {
    return asTelegramUserId(reply.id);
  }
  const text =
    ctx && ctx.message && typeof ctx.message.text === "string" ? ctx.message.text : "";
  const parts = text.trim().split(/\s+/);
  if (parts.length >= 2) {
    return asTelegramUserId(parts[1]);
  }
  return "";
}

async function handleWalletProtect(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }
  const userId = parseUserId(ctx);
  if (!userId) {
    return ctx.reply(USAGE);
  }
  const result = addProtectedUser(userId, {
    membersFile: options.membersFile,
    note: "manual",
  });
  if (!result || result.ok !== true) {
    return ctx.reply("Could not protect that user.");
  }
  return ctx.reply(`Protected ${userId}. They will be skipped by wallet cleanup.`);
}

async function handleWalletUnprotect(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }
  const userId = parseUserId(ctx);
  if (!userId) {
    return ctx.reply(USAGE.replace("walletprotect", "walletunprotect"));
  }
  const result = removeProtectedUser(userId, { membersFile: options.membersFile });
  if (!result.existed) {
    return ctx.reply(`${userId} was not on the protection list.`);
  }
  return ctx.reply(`Removed ${userId} from the protection list.`);
}

async function handleWalletProtectList(ctx, options = {}) {
  if (!ctx || !ctx.from || !isPrivateChat(ctx)) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply(ADMIN_ONLY);
  }
  const store = loadKnownMembersStore(options.membersFile);
  const ids = Object.keys(store.protectedUserIds || {});
  if (!ids.length) {
    return ctx.reply("No explicitly protected users.");
  }
  return ctx.reply(`Explicitly protected:\n${ids.join("\n")}`);
}

module.exports = (bot) => {
  bot.command("walletprotect", (ctx) => handleWalletProtect(ctx));
  bot.command("walletunprotect", (ctx) => handleWalletUnprotect(ctx));
  bot.command("walletprotectlist", (ctx) => handleWalletProtectList(ctx));
};

module.exports.handleWalletProtect = handleWalletProtect;
module.exports.handleWalletUnprotect = handleWalletUnprotect;
module.exports.handleWalletProtectList = handleWalletProtectList;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.USAGE = USAGE;
