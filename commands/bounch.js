/**
 * /bounch — play link and leaderboard pointer.
 */

module.exports = (bot) => {
  bot.command("bounch", (ctx) => {
    ctx.reply(`🏀 ManGo Bounch

Clear levels and climb the board.

🎮 Play:
https://www.mangomeme.fun/mango-labs

🏆 Global leaderboard:
/bounchhighscore

🥭 How far can you bounce?`);
  });
};
