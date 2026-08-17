/**
 * Admin-only /presalestatus — aggregate ledger, no participant dump, no keys.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const { getPresaleStatus, reconcileExpiredPresaleOrders } = require("../services/presaleLedger");

const ADMIN_ONLY = "This command is admin only.";

function formatPresaleStatus(status) {
  return [
    "🥭 ManGo Presale Status",
    "",
    `Presale enabled: ${status.enabled ? "YES" : "NO"}`,
    `Live: ${status.live ? "YES" : "NO"}`,
    `Confirmed SOL: ${status.confirmedSol}`,
    `Reserved SOL: ${status.reservedSol}`,
    `Available SOL: ${status.availableSol}`,
    `Hard cap: ${status.hardCapSol} SOL`,
    `Allocated confirmed MANGO: ${status.allocatedMango}`,
    `Reserved MANGO: ${status.reservedMango}`,
    `Participants confirmed: ${status.participantCount}`,
    `Active reservations: ${status.activeReservations}`,
  ].join("\n");
}

async function handlePresaleStatus(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }
  await reconcileExpiredPresaleOrders(options);
  const status = getPresaleStatus(options);
  return ctx.reply(formatPresaleStatus(status));
}

module.exports = (bot) => {
  bot.command("presalestatus", (ctx) => handlePresaleStatus(ctx));
};

module.exports.handlePresaleStatus = handlePresaleStatus;
module.exports.formatPresaleStatus = formatPresaleStatus;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
