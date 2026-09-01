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
const { installProcessGuards } = require("./utils/processGuards");
const { noteRuntimeEvent } = require("./utils/runtimeHealth");
const { noteRankUpIdentity } = require("./services/rankUpAnnounce");

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use((ctx, next) => {
  noteRuntimeEvent("telegramUpdate");
  if (ctx && ctx.from) {
    noteRankUpIdentity(ctx.from);
  }
  return next();
});

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
  onLaunchFailed: (err) => {
    const code = (err && err.code) || (err && err.name) || "Error";
    logError(`[startup] telegram launch failed code=${code}`);
    try {
      runtime.shutdown("launch-failed");
    } catch (_err) {
      /* ignore */
    }
    process.exit(1);
  },
  beforeScheduler: async () => {
    try {
      const streakRepair = await repairCurrentDayStreaks();
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

    try {
      const {
        processWeeklyWinnersBoundary,
      } = require("./services/weeklyWinners");
      Promise.resolve(
        processWeeklyWinnersBoundary({ telegram: bot.telegram })
      ).catch((err) => {
        logError(
          "[weekly-winners] startup boundary failed:",
          err && err.message ? err.message : err
        );
      });
    } catch (err) {
      logError(
        "[weekly-winners] startup boundary failed:",
        err && err.message ? err.message : err
      );
    }

    try {
      const { persistReconcileBuilderEvents } = require("./services/communityBuilder");
      const reconciled = persistReconcileBuilderEvents();
      if (reconciled && reconciled.added > 0) {
        log(`[community-builder] reconciled history events=${reconciled.added}`);
      }
    } catch (err) {
      logError(
        "[community-builder] history reconcile failed:",
        err && err.message ? err.message : err
      );
    }
  },
});

process.once("SIGINT", () => runtime.shutdown("SIGINT"));
process.once("SIGTERM", () => runtime.shutdown("SIGTERM"));
installProcessGuards({
  name: "mangobot",
  shutdown: () => runtime.shutdown("crash"),
  logError,
});
