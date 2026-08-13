const path = require("path");
const { loadAppEnv } = require("./utils/loadEnv");
loadAppEnv({ envPath: path.join(__dirname, ".env") });

const fs = require("fs");
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
    try {
      communityScheduler = startCommunityScheduler(bot.telegram);
    } catch (err) {
      log(
        "[community-scheduler] Failed to start:",
        err && err.message ? err.message : err
      );
    }
  })
  .catch((err) => {
    log("Failed to launch ManGo Bot:", err && err.message ? err.message : err);
    process.exit(1);
  });

function shutdown(signal) {
  if (communityScheduler) {
    communityScheduler.stop("shutdown");
  }
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
