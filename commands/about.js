/**
 * /about — short project description.
 */

module.exports = (bot) => {
  bot.command("about", (ctx) => {
    ctx.reply(
      "🥭 ManGo is a community meme project built in public using the CBS tools ecosystem."
    );
  });
};
