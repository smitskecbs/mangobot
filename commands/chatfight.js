/**
 * /chatfight — admin-only manual ChatFight start in the community group.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
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
 * @param {(userId: *) => boolean} [options.isAdminFn]
 */
function handleChatFight(ctx, options = {}) {
  const startFightFn =
    typeof options.startFightFn === "function" ? options.startFightFn : startFight;
  const isAdminFn =
    typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;

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

  if (!isAdminFn(ctx.from.id)) {
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
  bot.command("chatfight", handleChatFight);
};

module.exports.handleChatFight = handleChatFight;
