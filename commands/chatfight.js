/**
 * /chatfight — admin-only manual ChatFight start in the community group.
 * Admin = ADMIN_USER_ID allowlist OR Telegram creator/administrator.
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const { canManageGroup } = require("../utils/admin");
const {
  USAGE_TEXT,
  parseFightTypeArg,
  isAllowedChatFightChat,
  startFight,
} = require("../services/chatFight");

/**
 * @param {object} ctx
 * @param {object} [options]
 * @param {(params: object) => object} [options.startFightFn]
 * @param {(ctx: object, options?: object) => Promise<boolean>|boolean} [options.canManageGroupFn]
 * @param {(userId: *) => boolean} [options.isAdminFn]
 * @param {(chatId: *, userId: *) => Promise<object>|object} [options.getChatMember]
 * @returns {Promise<*>}
 */
async function handleChatFight(ctx, options = {}) {
  const startFightFn =
    typeof options.startFightFn === "function" ? options.startFightFn : startFight;
  const canManageFn =
    typeof options.canManageGroupFn === "function"
      ? options.canManageGroupFn
      : canManageGroup;

  if (!ctx || !ctx.from) {
    return;
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply(
      "⚔️ ChatFight is played in the ManGo community group."
    );
  }

  if (!isGroupChat(ctx)) {
    return ctx.reply(
      "⚔️ ChatFight is played in the ManGo community group."
    );
  }

  if (!isAllowedChatFightChat(ctx.chat.id)) {
    return ctx.reply("⚔️ ChatFight is not available in this group.");
  }

  let allowed = false;
  try {
    allowed = Boolean(
      await canManageFn(ctx, {
        isAdminFn: options.isAdminFn,
        getChatMember: options.getChatMember,
      })
    );
  } catch (_err) {
    allowed = false;
  }

  if (!allowed) {
    return ctx.reply(
      "⚔️ ChatFight can currently only be started by an admin."
    );
  }

  const rawText =
    (ctx.message && typeof ctx.message.text === "string"
      ? ctx.message.text
      : "") || "";
  const parts = rawText.trim().split(/\s+/);
  // parts[0] is /chatfight[@bot]; optional type in parts[1]
  const typeArg = parts.length > 1 ? parts[1] : "";
  const parsed = parseFightTypeArg(typeArg);
  if (!parsed.ok) {
    return ctx.reply(USAGE_TEXT);
  }

  const result = startFightFn({
    chatId: ctx.chat.id,
    type: parsed.random ? null : parsed.type,
    sendMessage: (chatId, text) => ctx.telegram.sendMessage(chatId, text),
  });

  if (!result.ok) {
    if (result.reason === "cooldown") {
      const minutes = result.remainingMinutes || 1;
      return ctx.reply(
        `⚔️ ChatFight cooldown active.\nTry again in about ${minutes} minutes.`
      );
    }
    if (result.reason === "already-active") {
      return ctx.reply("⚔️ A ChatFight is already running.");
    }
    if (result.reason === "wrong-chat") {
      return ctx.reply("⚔️ ChatFight is not available in this group.");
    }
    return ctx.reply("⚔️ Could not start ChatFight.");
  }

  return ctx.reply(result.prompt);
}

module.exports = (bot) => {
  bot.command("chatfight", (ctx) =>
    Promise.resolve(handleChatFight(ctx)).catch(() => undefined)
  );
};

module.exports.handleChatFight = handleChatFight;
