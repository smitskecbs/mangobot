/**
 * Telegraf long-polling lifecycle helper.
 *
 * Telegraf v4 `launch()` calls an optional onLaunch callback after getMe(),
 * then awaits the polling loop. The returned Promise stays pending until
 * polling stops — so scheduler startup must use the onLaunch callback,
 * never `launch().then(...)`.
 *
 * Order inside onLaunch:
 * 1. log "ManGo Bot running"
 * 2. optional beforeScheduler (e.g. streak repair) — must not throw out
 * 3. start community scheduler
 */

function startBotRuntime({
  bot,
  startScheduler,
  logFn = console.log,
  onLaunchFailed,
  beforeScheduler,
}) {
  if (!bot || typeof bot.launch !== "function") {
    throw new Error("startBotRuntime requires bot.launch");
  }
  if (typeof startScheduler !== "function") {
    throw new Error("startBotRuntime requires startScheduler");
  }

  let communityScheduler = null;
  let schedulerStarted = false;

  function onBotLaunched() {
    if (schedulerStarted) {
      return;
    }
    schedulerStarted = true;
    logFn("🥭 ManGo Bot running...");

    if (typeof beforeScheduler === "function") {
      try {
        beforeScheduler();
      } catch (err) {
        logFn(
          "[lifecycle] beforeScheduler failed:",
          err && err.message ? err.message : err
        );
      }
    }

    try {
      communityScheduler = startScheduler(bot.telegram);
    } catch (err) {
      logFn(
        "[community-scheduler] Failed to start:",
        err && err.message ? err.message : err
      );
    }
  }

  const launchResult = bot.launch(onBotLaunched);
  Promise.resolve(launchResult).catch((err) => {
    if (typeof onLaunchFailed === "function") {
      onLaunchFailed(err);
      return;
    }
    logFn(
      "Failed to launch ManGo Bot:",
      err && err.message ? err.message : err
    );
    process.exitCode = 1;
  });

  function shutdown(signal) {
    if (communityScheduler && typeof communityScheduler.stop === "function") {
      communityScheduler.stop("shutdown");
    }
    try {
      const {
        clearAllExpiredMessageCleanups,
      } = require("./expiredMessageCleanup");
      clearAllExpiredMessageCleanups();
    } catch (_err) {
      /* ignore */
    }
    try {
      const { getTriviaRuntime } = require("../services/trivia");
      const runtime = getTriviaRuntime();
      if (runtime && typeof runtime.clearAllTimers === "function") {
        runtime.clearAllTimers();
      }
    } catch (_err) {
      /* ignore */
    }
    bot.stop(signal);
  }

  return {
    shutdown,
    getCommunityScheduler: () => communityScheduler,
    isSchedulerStarted: () => schedulerStarted,
  };
}

module.exports = {
  startBotRuntime,
};
