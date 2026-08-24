/**
 * /points — show a user's lifetime and weekly points.
 */

const {
  loadPoints,
  getUserRecord,
  formatPointsCard,
} = require("../services/points");
const { isWalletVerified, isWalletRegistered } = require("../services/walletLinks");
const {
  isPrivateChat,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");
const { formatShopProgressBlock } = require("../services/mangoShop");

function handlePoints(ctx, options = {}) {
  const data = loadPoints(options.pointsFile);
  const user = getUserRecord(data, ctx.from.id);
  const walletVerified = isWalletVerified(ctx.from.id, options.walletFile);
  const walletRegistered = isWalletRegistered(ctx.from.id, options.walletFile);
  let text = formatPointsCard(user, { walletVerified, walletRegistered });
  try {
    text = `${text}\n\n${formatShopProgressBlock(ctx.from.id, options)}`;
  } catch (_err) {
    // Shop store unavailable: still show XP/rank.
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getPrivateMenuKeyboard());
  }
  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("points", handlePoints);
};

module.exports.handlePoints = handlePoints;
