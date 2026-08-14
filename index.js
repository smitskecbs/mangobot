const path = require("path");
const { loadAppEnv } = require("./utils/loadEnv");
loadAppEnv({ envPath: path.join(__dirname, ".env") });

const fs = require("fs");
const { Telegraf } = require("telegraf");
const { log, error: logError } = require("./utils/logger");
const {
  startCommunityScheduler,
} = require("./services/communityScheduler");
const { startBotRuntime } = require("./utils/botLifecycle");
const { repairCurrentDayStreaks } = require("./services/points");

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

/**
 * Production order:
 * load env → register modules → bot.launch(onLaunch)
 * → onLaunch: "ManGo running" → streak repair → start scheduler
 * Streak repair must NOT wait for launch() Promise resolution.
 */
const runtime = startBotRuntime({
  bot,
  startScheduler: startCommunityScheduler,
  logFn: log,
  beforeScheduler: () => {
    try {
      const streakRepair = repairCurrentDayStreaks();
      if (streakRepair && streakRepair.repaired > 0) {
        log(
          `[streak] repaired current-day streaks count=${streakRepair.repaired}`
        );
      }
    } catch (err) {
      logError(
        "[streak] repairCurrentDayStreaks failed:",
        err && err.message ? err.message : err
      );
    }
  },
});

process.once("SIGINT", () => runtime.shutdown("SIGINT"));
process.once("SIGTERM", () => runtime.shutdown("SIGTERM"));
