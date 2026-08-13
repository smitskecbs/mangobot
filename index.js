const path = require("path");
const { loadAppEnv } = require("./utils/loadEnv");
loadAppEnv({ envPath: path.join(__dirname, ".env") });

const fs = require("fs");
const { Telegraf } = require("telegraf");
const { log } = require("./utils/logger");
const {
  startCommunityScheduler,
} = require("./services/communityScheduler");
const { startBotRuntime } = require("./utils/botLifecycle");

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

const runtime = startBotRuntime({
  bot,
  startScheduler: startCommunityScheduler,
  logFn: log,
});

process.once("SIGINT", () => runtime.shutdown("SIGINT"));
process.once("SIGTERM", () => runtime.shutdown("SIGTERM"));
