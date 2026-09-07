/**
 * /weeklywinners — Top 3 of the last fully closed UTC week.
 */

const { getRankingsResultExtra } = require("../utils/botMenu");
const {
  getLatestWeeklyWinners,
  formatWeeklyWinnersMessage,
  syncAndFinalizeWeeklyWinners,
} = require("../services/weeklyWinners");

/**
 * @param {object} ctx
 * @param {object} [options]
 * @param {string} [options.winnersFile]
 * @param {string} [options.pointsFile]
 */
function handleWeeklyWinners(ctx, options = {}) {
  // Best-effort sync so a missed boundary still surfaces before reply.
  try {
    syncAndFinalizeWeeklyWinners({
      winnersFile: options.winnersFile,
      pointsFile: options.pointsFile,
      now: options.now,
    });
  } catch (_err) {
    /* ignore — still show stored latest */
  }

  const latest = getLatestWeeklyWinners(options.winnersFile);
  const text = formatWeeklyWinnersMessage(latest);

  return ctx.reply(text, getRankingsResultExtra(ctx));
}

module.exports = (bot) => {
  bot.command("weeklywinners", handleWeeklyWinners);
};

module.exports.handleWeeklyWinners = handleWeeklyWinners;
