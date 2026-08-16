/**
 * Resolve a Telegram reply-to user for admin member commands.
 * Never uses a caller-supplied wallet or uid argument.
 */

function getReplyTargetUser(ctx) {
  const reply =
    ctx &&
    ctx.message &&
    ctx.message.reply_to_message &&
    ctx.message.reply_to_message.from;
  if (!reply || typeof reply !== "object") {
    return null;
  }
  if (reply.is_bot) {
    return null;
  }
  if (reply.id === undefined || reply.id === null) {
    return null;
  }
  const firstName =
    typeof reply.first_name === "string" && reply.first_name.trim()
      ? reply.first_name.trim()
      : "Member";
  return { id: reply.id, firstName };
}

function parseCommandArg(ctx) {
  const text =
    ctx && ctx.message && typeof ctx.message.text === "string"
      ? ctx.message.text
      : "";
  const parts = text.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
}

module.exports = {
  getReplyTargetUser,
  parseCommandArg,
};
