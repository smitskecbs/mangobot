/**
 * /snakehighscore and /snakescore — global Snake leaderboard.
 */

const { formatSnakeLeaderboardMessage } = require("../services/snakeLeaderboard");

function replyWithLeaderboard(ctx) {
  ctx.reply(formatSnakeLeaderboardMessage());
}

module.exports = (bot) => {
  bot.command("snakehighscore", replyWithLeaderboard);
  bot.command("snakescore", replyWithLeaderboard);
};
