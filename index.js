require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Telegraf } = require("telegraf");
const { log } = require("./utils/logger");
const {
  startCommunityScheduler,
} = require("./services/communityScheduler");

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

let communityScheduler = null;

bot
  .launch()
  .then(() => {
    log("🥭 ManGo Bot running...");
    communityScheduler = startCommunityScheduler(bot.telegram);
  })
  .catch((err) => {
    log("Failed to launch ManGo Bot:", err && err.message ? err.message : err);
    process.exit(1);
  });

function shutdown(signal) {
  if (communityScheduler) {
    communityScheduler.stop();
  }
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
