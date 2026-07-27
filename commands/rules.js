/**
 * /rules — community rules.
 */

module.exports = (bot) => {
  bot.command("rules", (ctx) => {
    ctx.reply(`🥭 Rules

1. No spam
2. No scams
3. No paid promo
4. Respect everyone`);
  });
};
