/**
 * /launch — current launch status.
 */

module.exports = (bot) => {
  bot.command("launch", (ctx) => {
    ctx.reply(`🥭 Launch Status

ManGo is still building.

Our bags are slowly filling to prepare the future liquidity pool while the community continues to grow.

No presale.
No public CA.
No launch date.

We're building first.
Launching later.`);
  });
};
