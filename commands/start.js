/**
 * /start — initial welcome message for new users.
 */

module.exports = (bot) => {
  bot.start((ctx) => {
    ctx.reply("🥭 Welcome to ManGo Bot!\n\nType /help for commands.");
  });
};
