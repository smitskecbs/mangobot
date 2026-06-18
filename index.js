require("dotenv").config();
const { Telegraf } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply("🥭 Welcome to ManGo Bot!\n\nType /help for commands.");
});

bot.help((ctx) => {
  ctx.reply(`🥭 Commands

/about
/community
/launch
/links
/rules
/help`);
});

bot.command("about", (ctx) => {
  ctx.reply(
    "🥭 ManGo is a community meme project built in public using the CBS tools ecosystem."
  );
});

bot.command("community", (ctx) => {
  ctx.reply(`🥭 ManGo Community

ManGo is a community-driven meme project built in public.

No fake promises.
No paid hype.
No launch pressure.

Just building, learning and having fun together.`);
});

bot.command("launch", (ctx) => {
  ctx.reply(`🥭 Launch Status

ManGo has not launched yet.

 No presale
 No public CA
 No launch date announced

Follow official channels for updates.`);
});

bot.command("links", (ctx) => {
  ctx.reply(`🥭 Official ManGo Links

🌐 Website
https://mangomeme.fun

🐦 X
https://x.com/ManGomemefun

💬 Telegram
https://t.me/mangomeme

📱 WhatsApp
https://chat.whatsapp.com/HYuIoFGtvB20c5oHgI4Lcs

📘 Facebook
https://www.facebook.com/profile.php?id=61590572230511

🛠 CBS Tools
https://tools.cbs-coin.com

💻 GitHub
https://github.com/smitskecbs`);
});

bot.command("rules", (ctx) => {
  ctx.reply(`🥭 Rules

1. No spam
2. No scams
3. No paid promo
4. Respect everyone`);
});

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

bot.launch();

console.log("🥭 ManGo Bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
