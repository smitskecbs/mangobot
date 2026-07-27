/**
 * /community — community overview message.
 */

module.exports = (bot) => {
  bot.command("community", (ctx) => {
    ctx.reply(`🥭 ManGo Community

ManGo is a community-driven meme project built in public.

No fake promises.
No paid hype.
No launch pressure.

Just building, learning and having fun together.`);
  });
};
