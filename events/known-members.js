/**
 * Record community joins/leaves into the known-member registry.
 * Does not kick or remind. Grace start lives in recordObservedJoin.
 * chat_member join/leave is recorded from community-builder (this file must call next()).
 */

const {
  recordObservedJoin,
  recordObservedLeave,
  SOURCE,
} = require("../services/knownMembers");

function displayNameFromUser(user) {
  if (!user || typeof user !== "object") {
    return "";
  }
  const first = typeof user.first_name === "string" ? user.first_name.trim() : "";
  const last = typeof user.last_name === "string" ? user.last_name.trim() : "";
  return `${first} ${last}`.trim();
}

function recordJoinFromUser(user, chatId, source) {
  if (!user || user.is_bot) {
    return;
  }
  try {
    recordObservedJoin({
      chatId,
      userId: user.id,
      isBot: Boolean(user.is_bot),
      username: user.username,
      displayName: displayNameFromUser(user),
      source,
    });
  } catch (_err) {
    /* fail closed; do not block welcome */
  }
}

function recordLeaveFromUser(user, chatId, source) {
  if (!user || user.is_bot) {
    return;
  }
  try {
    recordObservedLeave({
      chatId,
      userId: user.id,
      username: user.username,
      displayName: displayNameFromUser(user),
      source,
    });
  } catch (_err) {
    /* fail closed */
  }
}

function registerKnownMemberListeners(bot) {
  if (!bot || typeof bot.on !== "function") {
    return;
  }

  bot.on("new_chat_members", (ctx, next) => {
    const continueChain = typeof next === "function" ? next : () => undefined;
    const members =
      ctx && ctx.message && Array.isArray(ctx.message.new_chat_members)
        ? ctx.message.new_chat_members
        : [];
    const chatId = ctx && ctx.chat ? ctx.chat.id : undefined;
    for (const member of members) {
      recordJoinFromUser(member, chatId, SOURCE.NEW_CHAT_MEMBERS);
    }
    return continueChain();
  });

  bot.on("left_chat_member", (ctx, next) => {
    const continueChain = typeof next === "function" ? next : () => undefined;
    const user =
      ctx && ctx.message && ctx.message.left_chat_member
        ? ctx.message.left_chat_member
        : null;
    const chatId = ctx && ctx.chat ? ctx.chat.id : undefined;
    recordLeaveFromUser(user, chatId, SOURCE.LEFT_CHAT_MEMBER);
    return continueChain();
  });
}

module.exports = (bot) => {
  registerKnownMemberListeners(bot);
};

module.exports.registerKnownMemberListeners = registerKnownMemberListeners;
