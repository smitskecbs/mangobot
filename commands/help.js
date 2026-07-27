/**
 * /help — list available commands.
 */

module.exports = (bot) => {
  bot.help((ctx) => {
    ctx.reply(`🥭 Commands

/about
/community
/launch
/links
/points
/leaderboard
/weekly
/rules
/help`);
  });
};
