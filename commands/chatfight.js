/**
 * /chatfight — start (hidden) + reveal callback.
 * Admin = ADMIN_USER_ID allowlist OR Telegram creator/administrator.
 */

const { isPrivateChat, isGroupChat } = require("../utils/botMenu");
const { canManageGroup } = require("../utils/admin");
const {
  USAGE_TEXT,
  parseFightTypeArg,
  isAllowedChatFightChat,
  startFight,
  revealFight,
  setFightMessageId,
  REVEAL_CALLBACK_DATA,
} = require("../services/chatFight");

/**
 * @param {object} ctx
 * @param {object} [options]
 */
async function handleChatFight(ctx, options = {}) {
  const startFightFn =
    typeof options.startFightFn === "function" ? options.startFightFn : startFight;
  const canManageFn =
    typeof options.canManageGroupFn === "function"
      ? options.canManageGroupFn
      : canManageGroup;
  const setMessageIdFn =
    typeof options.setFightMessageIdFn === "function"
      ? options.setFightMessageIdFn
      : setFightMessageId;

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

  const sent = await ctx.reply(
    result.teaser,
    result.revealKeyboard || undefined
  );
  if (sent && sent.message_id != null) {
    setMessageIdFn(sent.message_id);
  }
  return sent;
}

/**
 * First click reveals the challenge for the whole group (edit message).
 * No Daily Activity XP (callback is not text).
 */
async function handleChatFightReveal(ctx, options = {}) {
  const revealFn =
    typeof options.revealFightFn === "function"
      ? options.revealFightFn
      : revealFight;

  if (!ctx || !ctx.from || ctx.from.is_bot) {
    if (ctx && typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery().catch(() => undefined);
    }
    return;
  }

  if (!ctx.chat || !isAllowedChatFightChat(ctx.chat.id)) {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery("Not available here.").catch(() => undefined);
    }
    return;
  }

  // Sync reveal before edit/await boundaries for concurrent clicks.
  const result = revealFn(ctx.chat.id);

  if (!result.ok && result.reason === "already-revealed") {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx
        .answerCbQuery("Challenge already revealed.")
        .catch(() => undefined);
    }
    return;
  }

  if (!result.ok) {
    if (typeof ctx.answerCbQuery === "function") {
      await ctx.answerCbQuery("No challenge to reveal.").catch(() => undefined);
    }
    return;
  }

  if (typeof ctx.answerCbQuery === "function") {
    await ctx.answerCbQuery("Challenge revealed!").catch(() => undefined);
  }

  try {
    if (typeof ctx.editMessageText === "function") {
      await ctx.editMessageText(result.prompt);
    }
  } catch (_err) {
    // Fallback: post challenge if edit fails (e.g. message too old).
    if (typeof ctx.reply === "function") {
      await ctx.reply(result.prompt);
    }
  }
}

module.exports = (bot) => {
  bot.command("chatfight", (ctx) =>
    Promise.resolve(handleChatFight(ctx)).catch(() => undefined)
  );
  bot.action(REVEAL_CALLBACK_DATA, (ctx) =>
    Promise.resolve(handleChatFightReveal(ctx)).catch(() => undefined)
  );
};

module.exports.handleChatFight = handleChatFight;
module.exports.handleChatFightReveal = handleChatFightReveal;
