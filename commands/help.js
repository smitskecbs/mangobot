/**
 * /help — list available commands.
 */

const {
  isPrivateChat,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");

const HELP_MESSAGE = `🥭 Commands

🥭 Community
/menu
/points
/wallet
/mywallet
/rewards
/presale
/leaderboard
/weekly
/weeklywinners
/builderboard
/chatfight
/tictactoe — Start Tic-Tac-Toe
/connect4 — Start Connect Four
/trivia — Open Trivia categories
/mangobomb — Start a ManGo Bomb round
/blackjack — Start a ManGo Blackjack round
/streak — Active streak leaderboard
/streakrecord — Longest streak leaderboard

🐍 Snake
4 difficulties on the game page: Classic, Walls, Center, Danger Zone. Harder = more points. One leaderboard. No unlocking.
/snake
/snakehighscore
/snakescore

🏀 Bounch
/bounch
/bounchhighscore
/bounchscore

📖 Information
/about
/community
/launch
/links
/rules

/help`;

function handleHelp(ctx) {
  if (isPrivateChat(ctx)) {
    return ctx.reply(HELP_MESSAGE, getPrivateMenuKeyboard(ctx));
  }
  return ctx.reply(HELP_MESSAGE);
}

module.exports = (bot) => {
  bot.help(handleHelp);
};

module.exports.handleHelp = handleHelp;
module.exports.HELP_MESSAGE = HELP_MESSAGE;
