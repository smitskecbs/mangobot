/**
 * /bounchhighscore and /bounchscore — global Bounch leaderboard.
 */

const { formatBounchLeaderboardMessage } = require("../services/bounchLeaderboard");

function replyWithLeaderboard(ctx) {
  ctx.reply(formatBounchLeaderboardMessage());
}

module.exports = (bot) => {
  bot.command("bounchhighscore", replyWithLeaderboard);
  bot.command("bounchscore", replyWithLeaderboard);
};
