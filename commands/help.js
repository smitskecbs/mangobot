/**
 * /help — beginner-friendly ManGo loop. Slash commands still exist for power users.
 */

const {
  isPrivateChat,
  getPrivateHelpMenuExtra,
} = require("../utils/botMenu");

const HELP_MESSAGE = `🥭 How ManGo works

1. Connect your wallet
2. Check Daily Quest
3. Chat, play and join in
4. Earn XP and build your Activity Streak
5. Complete Daily Quests for ManGo Loot
6. Help ManGo grow in Community Builder
7. Active contributors can be considered for Mystery Gifts

Open /menu anytime.`;

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
