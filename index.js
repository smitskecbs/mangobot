require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Telegraf } = require("telegraf");
const { log } = require("./utils/logger");

const bot = new Telegraf(process.env.BOT_TOKEN);

function registerModules(dir) {
  const fullDir = path.join(__dirname, dir);

  if (!fs.existsSync(fullDir)) {
    return;
  }

  for (const file of fs.readdirSync(fullDir).sort()) {
    if (file.endsWith(".js")) {
      require(path.join(fullDir, file))(bot);
    }
  }
}

registerModules("commands");
registerModules("events");

bot.launch();
log("🥭 ManGo Bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
