/**
 * Welcome new members when they join the group chat.
 */

module.exports = (bot) => {
  bot.on("new_chat_members", (ctx) => {
    const members = ctx.message.new_chat_members;

    members.forEach((member) => {
      const name = member.first_name || "friend";

      ctx.reply(`🥭 Welcome ${name}!

Welcome to the ManGo community.

📌 Please read the pinned message
🌐 Use /links for official links
🚀 Use /launch for project status

Enjoy the build!`);
    });
  });
};
