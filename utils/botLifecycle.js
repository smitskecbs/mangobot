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

const { noteRuntimeEvent } = require("./runtimeHealth");
const { formatErrorForLog } = require("./logger");

const TELEGRAM_ALLOWED_UPDATES = Object.freeze([
  "message",
  "edited_message",
  "callback_query",
  "inline_query",
  "chosen_inline_result",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "poll",
  "poll_answer",
  "pre_checkout_query",
  "shipping_query",
]);

function attachUpdateErrorHandler(bot, logErrorFn) {
  if (!bot || typeof bot.catch !== "function") {
    return false;
  }
  bot.catch(async (err, ctx) => {
    const formatted = formatErrorForLog(err);
    logErrorFn(
      `[update] handler failed name=${formatted.name} message=${formatted.message}`
    );
    if (formatted.stack) {
      logErrorFn(`[update] handler stack ${formatted.stack}`);
    }
    if (ctx && ctx.callbackQuery && typeof ctx.answerCbQuery === "function") {
      try {
        await ctx.answerCbQuery("Something went wrong. Try again.");
      } catch (_err) {
        /* ignore */
      }
    }
  });
  return true;
}

function startBotRuntime({
  bot,
  startScheduler,
  logFn = console.log,
  logErrorFn,
  onLaunchFailed,
  beforeScheduler,
}) {
  if (!bot || typeof bot.launch !== "function") {
    throw new Error("startBotRuntime requires bot.launch");
  }
  if (typeof startScheduler !== "function") {
    throw new Error("startBotRuntime requires startScheduler");
  }

  const errorFn = typeof logErrorFn === "function" ? logErrorFn : logFn;

  let communityScheduler = null;
  let schedulerStarted = false;

  attachUpdateErrorHandler(bot, errorFn);

  async function onBotLaunched() {
    if (schedulerStarted) {
      return;
    }
    schedulerStarted = true;
    logFn("[startup] mango bot running");

    if (typeof beforeScheduler === "function") {
      try {
        await beforeScheduler();
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

  const launchResult = bot.launch(
    { allowedUpdates: [...TELEGRAM_ALLOWED_UPDATES] },
    onBotLaunched
  );
  Promise.resolve(launchResult).catch((err) => {
    const formatted = formatErrorForLog(err);
    if (typeof onLaunchFailed === "function") {
      onLaunchFailed(err);
      return;
    }
    logFn(
      `[startup] telegram launch failed name=${formatted.name} message=${formatted.message}`
    );
    if (formatted.stack) {
      logFn(`[startup] telegram launch stack ${formatted.stack}`);
    }
    process.exitCode = 1;
  });

  function shutdown(signal) {
    noteRuntimeEvent("shutdown");
    logFn(`[shutdown] bot signal=${signal}`);
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
      const { clearAllGameMessageCleanups } = require("./gameCleanup");
      clearAllGameMessageCleanups();
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
    try {
      const { getMangoBombRuntime } = require("../services/mangoBomb");
      const runtime = getMangoBombRuntime();
      if (runtime && typeof runtime.clearAllTimers === "function") {
        runtime.clearAllTimers();
      }
    } catch (_err) {
      /* ignore */
    }
    try {
      const { getBlackjackRuntime } = require("../services/blackjack");
      const runtime = getBlackjackRuntime();
      if (runtime && typeof runtime.clearAllTimers === "function") {
        runtime.clearAllTimers();
      }
    } catch (_err) {
      /* ignore */
    }
    try {
      const { getSharedPvpSessionManager } = require("../services/pvpSessionManager");
      getSharedPvpSessionManager().resetAll();
    } catch (_err) {
      /* ignore */
    }
    try {
      const { getSharedPvpMatchReservation } = require("../services/pvpMatchReservation");
      getSharedPvpMatchReservation().reset();
    } catch (_err) {
      /* ignore */
    }
    try {
      bot.stop(signal);
    } catch (_err) {
      /* ignore */
    }
  }

  return {
    shutdown,
    getCommunityScheduler: () => communityScheduler,
    isSchedulerStarted: () => schedulerStarted,
  };
}

module.exports = {
  startBotRuntime,
  TELEGRAM_ALLOWED_UPDATES,
  attachUpdateErrorHandler,
};
