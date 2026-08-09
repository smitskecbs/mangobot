/**
 * /snakehighscore and /snakescore — global Snake leaderboard.
 */

const { formatSnakeLeaderboardMessage } = require("../services/snakeLeaderboard");
const {
  getBotUsername,
  getConfiguredBotUsername,
} = require("../utils/botMenu");

function replyWithLeaderboard(ctx) {
  const username = getBotUsername(ctx) || getConfiguredBotUsername();
  return ctx.reply(formatSnakeLeaderboardMessage(undefined, username));
}

module.exports = (bot) => {
  bot.command("snakehighscore", replyWithLeaderboard);
  bot.command("snakescore", replyWithLeaderboard);
};

module.exports.replyWithLeaderboard = replyWithLeaderboard;
