/**
 * /help — list available commands.
 */

module.exports = (bot) => {
  bot.help((ctx) => {
    ctx.reply(`🥭 Commands

🥭 Community
/points
/leaderboard
/weekly

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

/help`);
  });
};
