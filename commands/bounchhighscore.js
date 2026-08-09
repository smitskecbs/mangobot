/**
 * /bounchhighscore and /bounchscore — global Bounch leaderboard.
 */

const { formatBounchLeaderboardMessage } = require("../services/bounchLeaderboard");
const {
  getBotUsername,
  getConfiguredBotUsername,
} = require("../utils/botMenu");

function replyWithLeaderboard(ctx) {
  const username = getBotUsername(ctx) || getConfiguredBotUsername();
  return ctx.reply(formatBounchLeaderboardMessage(undefined, username));
}

module.exports = (bot) => {
  bot.command("bounchhighscore", replyWithLeaderboard);
  bot.command("bounchscore", replyWithLeaderboard);
};

module.exports.replyWithLeaderboard = replyWithLeaderboard;
