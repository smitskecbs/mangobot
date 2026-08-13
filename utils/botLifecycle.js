/**
 * Telegraf long-polling lifecycle helper.
 *
 * Telegraf v4 `launch()` calls an optional onLaunch callback after getMe(),
 * then awaits the polling loop. The returned Promise stays pending until
 * polling stops — so scheduler startup must use the onLaunch callback,
 * never `launch().then(...)`.
 */

function startBotRuntime({
  bot,
  startScheduler,
  logFn = console.log,
  onLaunchFailed,
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
