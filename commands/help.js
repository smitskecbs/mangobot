/**
 * /help — beginner-friendly ManGo loop. Slash commands still exist for power users.
 */

const {
  isPrivateChat,
  getPrivateHelpMenuExtra,
} = require("../utils/botMenu");

const HELP_MESSAGE = `ℹ️ Help

ManGo is simple:

1. Register your wallet
2. Open /menu
3. Check Daily Quest
4. Chat, play and join in
5. Earn XP and build your Activity Streak
6. Check Rankings
7. Help ManGo grow in Community Builder to earn Builder Points (BP, not XP)
8. Daily Quests earn ManGo Loot you can use in the Shop

Rewards shows gifts and claims tied to your linked wallet.

Wallet comes first. XP and Loot stay locked until your wallet is linked.

Open /menu anytime to get back.

Power users can still type commands. You do not need them for ordinary use.`;

function handleHelp(ctx) {
  if (isPrivateChat(ctx)) {
    return ctx.reply(HELP_MESSAGE, getPrivateHelpMenuExtra());
  }
  return ctx.reply(HELP_MESSAGE);
}

module.exports = (bot) => {
  bot.help(handleHelp);
};

module.exports.handleHelp = handleHelp;
module.exports.HELP_MESSAGE = HELP_MESSAGE;
