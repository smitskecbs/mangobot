/**
 * /points — slim personal status. Today's checklist lives in Daily Quest.
 */

const {
  isPrivateChat,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");
const { formatMemberStatusCard } = require("../services/memberActivityProfile");

function handlePoints(ctx, options = {}) {
  const displayName =
    ctx && ctx.from && typeof ctx.from.first_name === "string"
      ? ctx.from.first_name
      : "";
  const text = formatMemberStatusCard(ctx.from.id, {
    ...options,
    displayName,
  });

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getPrivateMenuKeyboard());
  }
  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("points", handlePoints);
};

module.exports.handlePoints = handlePoints;
