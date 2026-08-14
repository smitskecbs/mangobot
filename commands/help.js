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
/leaderboard
/weekly
/chatfight
/tictactoe — Start Tic-Tac-Toe PvP
/connect4 — Start Connect Four PvP
/streak — Active streak leaderboard
/streakrecord — Longest streak leaderboard

🐍 Snake
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
    return ctx.reply(HELP_MESSAGE, getPrivateMenuKeyboard());
  }
  return ctx.reply(HELP_MESSAGE);
}

module.exports = (bot) => {
  bot.help(handleHelp);
};

module.exports.handleHelp = handleHelp;
module.exports.HELP_MESSAGE = HELP_MESSAGE;
