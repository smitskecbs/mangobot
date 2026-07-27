/**
 * /snake — play link and leaderboard pointer.
 */

module.exports = (bot) => {
  bot.command("snake", (ctx) => {
    ctx.reply(`🐍 ManGo Snake

🎮 Play:
https://www.mangomeme.fun/mango-labs.html

🏆 Global leaderboard:
/snakehighscore

🥭 Think you can beat the top score?`);
  });
};
