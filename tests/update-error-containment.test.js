/**
 * One update TypeError must not kill launch / wipe PvP sessions.
 * Genuine launch failure must still take the startup-failure path.
 * The original production Checkers TypeError remains unidentified.
 * Run: node tests/update-error-containment.test.js
 */

const assert = require("assert");
const { Telegraf } = require("telegraf");

const {
  startBotRuntime,
  attachUpdateErrorHandler,
} = require("../utils/botLifecycle");
const { createPvpSessionManager } = require("../services/pvpSessionManager");
const { formatErrorForLog } = require("../utils/logger");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function createFakeBot({ rejectLaunch, launchPromise } = {}) {
  let capturedOnLaunch = null;
  const stopCalls = [];
  const bot = {
    telegram: { token: "fake" },
    launch(_config, onLaunch) {
      capturedOnLaunch = onLaunch;
      if (rejectLaunch) {
        return Promise.reject(rejectLaunch);
      }
      if (typeof onLaunch === "function") {
        onLaunch();
      }
      return launchPromise || new Promise(() => {});
    },
    stop(signal) {
      stopCalls.push(signal);
    },
  };
  return { bot, stopCalls, getCapturedOnLaunch: () => capturedOnLaunch };
}

async function handleBoomUpdate(bot) {
  return bot.handleUpdate({
    update_id: 7,
    callback_query: {
      id: "q-boom",
      from: { id: 9, is_bot: false, first_name: "X" },
      chat_instance: "1",
      data: "boom",
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 1, type: "private" },
      },
    },
  });
}

async function main() {
  await runTest("default Telegraf handleError rethrows TypeError and sets exitCode", async () => {
    const bot = new Telegraf("123:TESTTOKEN");
    bot.botInfo = { id: 1, is_bot: true, first_name: "t", username: "t" };
    bot.telegram.callApi = async () => true;
    bot.action("boom", () => {
      throw new TypeError("forced update failure");
    });
    const prev = process.exitCode;
    process.exitCode = undefined;
    let threw = null;
    try {
      await handleBoomUpdate(bot);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof TypeError);
    assert.strictEqual(threw.message, "forced update failure");
    assert.strictEqual(process.exitCode, 1);
    process.exitCode = prev;
  });

  await runTest("bot.catch logs TypeError, answers callback, does not throw or reset PvP", async () => {
    const manager = createPvpSessionManager();
    manager.registerSession({
      id: "keep-me",
      chatId: "1",
      game: "checkers",
      status: "active",
      timers: {},
    });
    const logs = [];
    const bot = new Telegraf("123:TESTTOKEN");
    bot.botInfo = { id: 1, is_bot: true, first_name: "t", username: "t" };
    bot.telegram.callApi = async () => true;
    attachUpdateErrorHandler(bot, (...args) => logs.push(args.join(" ")));
    bot.action("boom", () => {
      throw new TypeError("forced update failure");
    });
    const prev = process.exitCode;
    process.exitCode = undefined;
    await handleBoomUpdate(bot);
    assert.strictEqual(process.exitCode, undefined);
    process.exitCode = prev;
    assert.ok(
      logs.some((line) =>
        line.includes("[update] handler failed name=TypeError message=forced update failure")
      )
    );
    assert.ok(logs.some((line) => line.includes("[update] handler stack")));
    assert.ok(logs.some((line) => line.includes("forced update failure")));
    assert.ok(!logs.some((line) => line.includes("callback_query")));
    assert.ok(manager.getSession("keep-me"));
    assert.strictEqual(manager.getSession("keep-me").status, "active");
  });

  await runTest("genuine launch failure still invokes onLaunchFailed and does not start scheduler", async () => {
    const failures = [];
    let startCount = 0;
    const err = new TypeError("getMe failed");
    const fake = createFakeBot({ rejectLaunch: err });
    const runtime = startBotRuntime({
      bot: fake.bot,
      startScheduler: () => {
        startCount += 1;
        return { stop() {} };
      },
      logFn: () => {},
      onLaunchFailed: (caught) => failures.push(caught),
    });
    await sleep(20);
    assert.strictEqual(startCount, 0);
    assert.strictEqual(runtime.isSchedulerStarted(), false);
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0], err);
  });

  await runTest("post-launch update error does not call shutdown or onLaunchFailed", async () => {
    const logs = [];
    const failures = [];
    const stopCalls = [];
    let catchHandler = null;
    const pending = new Promise(() => {});
    const bot = {
      telegram: { token: "fake" },
      catch(handler) {
        catchHandler = handler;
        this.handleError = handler;
      },
      launch(_config, onLaunch) {
        onLaunch();
        return pending;
      },
      stop(signal) {
        stopCalls.push(signal);
      },
    };
    const manager = createPvpSessionManager();
    manager.registerSession({
      id: "live-chk",
      chatId: "1",
      game: "checkers",
      status: "active",
      timers: {},
    });
    const runtime = startBotRuntime({
      bot,
      startScheduler: () => ({ stop() {} }),
      logFn: () => {},
      logErrorFn: (...args) => logs.push(args.join(" ")),
      onLaunchFailed: (err) => failures.push(err),
    });
    assert.ok(typeof catchHandler === "function");
    assert.strictEqual(runtime.isSchedulerStarted(), true);
    const answered = [];
    await catchHandler(new TypeError("forced update failure"), {
      callbackQuery: { id: "q" },
      async answerCbQuery(text) {
        answered.push(text);
      },
    });
    assert.deepStrictEqual(answered, ["Something went wrong. Try again."]);
    assert.strictEqual(failures.length, 0);
    assert.deepStrictEqual(stopCalls, []);
    assert.ok(manager.getSession("live-chk"));
    assert.ok(
      logs.some((line) =>
        line.includes("[update] handler failed name=TypeError message=forced update failure")
      )
    );
  });

  await runTest("formatErrorForLog keeps name/message/stack and redacts bot tokens", () => {
    const err = new TypeError("call https://api.telegram.org/bot123:SECRET/getMe");
    err.stack = "TypeError: x\n    at https://api.telegram.org/bot123:SECRET/getMe";
    const formatted = formatErrorForLog(err);
    assert.strictEqual(formatted.name, "TypeError");
    assert.ok(formatted.message.includes("bot[REDACTED]"));
    assert.ok(!formatted.message.includes("SECRET"));
    assert.ok(formatted.stack.includes("TypeError"));
    assert.ok(!formatted.stack.includes("SECRET"));
  });

  console.log("\nAll update error containment tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
