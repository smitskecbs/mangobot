/**
 * Production wiring: Telegraf middleware chain for community activity.
 * Reproduces index.js alphabetical event registration order.
 * Run: node tests/community-activity-wiring.test.js
 *
 * Root-cause regression: chat-fight bot.on("text") must call next() so
 * points-trigger still runs (Telegraf 4.16.3 stops the chain otherwise).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { Telegraf } = require("telegraf");

const { loadPoints, getTodayDate } = require("../services/points");
const { isGroupChat } = require("../utils/botMenu");
const { isAllowedChatFightChat } = require("../services/chatFight");
const {
  registerChatFightListener,
} = require("../events/chat-fight");
const {
  registerCommunityActivityListener,
  isEligibleCommunityActivityMessage,
  COMMUNITY_ACTIVITY_UPDATES,
} = require("../events/points-trigger");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);
const { awardDailyActivityPoint } = require("../services/points");
const registerWalletCommand = require("../commands/wallet");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-activity-wiring-"));
const PROD_CHAT = -1003916996602;
const OWNER_ID = 1238384546;
const USER_ID = 999999;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;

process.env.TELEGRAM_CHAT_ID = String(PROD_CHAT);
process.env.ADMIN_USER_ID = String(OWNER_ID);

let n = 0;
function pointsFile() {
  n += 1;
  return path.join(tempDir, `points-${n}.json`);
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
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

/**
 * Same alphabetical loader as index.js registerModules("events").
 */
function listEventModulesSorted() {
  const dir = path.join(__dirname, "..", "events");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
}

function createBot(pointsPath) {
  const bot = new Telegraf("000000000:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "ManGo",
    username: "mango_test_bot",
  };
  // Mirror production: commands (incl. wallet text handler) before events.
  registerWalletCommand(bot);
  registerChatFightListener(bot, { pointsFile: pointsPath });
  registerCommunityActivityListener(bot, { pointsFile: pointsPath });
  return bot;
}

function baseMessage(extra = {}) {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: PROD_CHAT, type: "supergroup" },
    from: {
      id: USER_ID,
      is_bot: false,
      first_name: "ActivityTest",
    },
    ...extra,
  };
}

async function sendUpdate(bot, message) {
  await bot.handleUpdate({
    update_id: Date.now(),
    message,
  });
}

function assertDailyAwarded(file, userId = USER_ID) {
  const today = getTodayDate();
  const user = loadPoints(file).users[String(userId)];
  assert.ok(user, "user record missing");
  assert.strictEqual(user.activityDate, today);
  assert.strictEqual(user.streak.current, 1);
  assert.strictEqual(user.streak.longest, 1);
  assert.strictEqual(user.streak.lastActiveDate, today);
  assert.strictEqual(user.points, 1);
  assert.strictEqual(user.weeklyPoints, 1);
  return user;
}

function assertNoUser(file, userId = USER_ID) {
  const users = loadPoints(file).users || {};
  assert.strictEqual(users[String(userId)], undefined);
}

async function main() {
  await runTest("event module load order: chat-fight before points-trigger", () => {
    const files = listEventModulesSorted();
    assert.ok(files.includes("chat-fight.js"));
    assert.ok(files.includes("points-trigger.js"));
    assert.ok(
      files.indexOf("chat-fight.js") < files.indexOf("points-trigger.js"),
      `expected chat-fight before points-trigger, got ${files.join(",")}`
    );
  });

  await runTest("Telegraf 4.16.3 Composer.on accepts filter arrays", () => {
    const telegrafMain = require.resolve("telegraf");
    const composerPath = path.join(path.dirname(telegrafMain), "composer.js");
    const src = fs.readFileSync(composerPath, "utf8");
    assert.ok(src.includes("Array.isArray(updateType)"));
    assert.ok(src.includes("filter in update.message"));
    assert.deepStrictEqual(
      [...COMMUNITY_ACTIVITY_UPDATES],
      ["text", "sticker", "animation", "photo", "video", "video_note"]
    );
  });

  await runTest("isGroupChat(supergroup) true; isAllowedChatFightChat(prod id) true", () => {
    const ctx = {
      chat: { id: PROD_CHAT, type: "supergroup" },
      from: { id: USER_ID, is_bot: false, first_name: "ActivityTest" },
      message: { text: "hello mango" },
    };
    assert.strictEqual(isGroupChat(ctx), true);
    assert.strictEqual(isAllowedChatFightChat(PROD_CHAT), true);
    assert.strictEqual(isAllowedChatFightChat(String(PROD_CHAT)), true);
    assert.strictEqual(isEligibleCommunityActivityMessage(ctx), true);
  });

  await runTest("awardDailyActivityPoint standalone writes activityDate+streak", () => {
    const file = pointsFile();
    const r = awardDailyActivityPoint(USER_ID, "ActivityTest", file);
    assert.strictEqual(r.awarded, true);
    assertDailyAwarded(file);
  });

  await runTest("production wiring: text hello mango awards daily activity", async () => {
    const file = pointsFile();
    const bot = createBot(file);
    await sendUpdate(bot, baseMessage({ text: "hello mango" }));
    assertDailyAwarded(file);
  });

  await runTest("production wiring: reply text awards", async () => {
    const file = pointsFile();
    const bot = createBot(file);
    await sendUpdate(
      bot,
      baseMessage({
        text: "replying",
        reply_to_message: {
          message_id: 99,
          date: 1,
          chat: { id: PROD_CHAT, type: "supergroup" },
          from: { id: 1, is_bot: false, first_name: "Other" },
          text: "original",
        },
      })
    );
    assertDailyAwarded(file);
  });

  await runTest("production wiring: sticker / animation / photo / video / video_note", async () => {
    const cases = [
      { sticker: { file_id: "s", width: 1, height: 1, is_animated: false, is_video: false } },
      { animation: { file_id: "a", width: 1, height: 1, duration: 1 } },
      { photo: [{ file_id: "p", width: 1, height: 1 }] },
      { video: { file_id: "v", width: 1, height: 1, duration: 1 } },
      { video_note: { file_id: "vn", length: 1, duration: 1 } },
    ];
    for (const extra of cases) {
      const file = pointsFile();
      const bot = createBot(file);
      await sendUpdate(bot, baseMessage(extra));
      assertDailyAwarded(file);
    }
  });

  await runTest("negative: private chat", async () => {
    const file = pointsFile();
    const bot = createBot(file);
    await sendUpdate(
      bot,
      baseMessage({
        text: "hello",
        chat: { id: USER_ID, type: "private" },
      })
    );
    assertNoUser(file);
  });

  await runTest("negative: wrong group", async () => {
    const file = pointsFile();
    const bot = createBot(file);
    await sendUpdate(
      bot,
      baseMessage({
        text: "hello",
        chat: { id: -1009999999999, type: "supergroup" },
      })
    );
    assertNoUser(file);
  });

  await runTest("negative: slash command", async () => {
    const file = pointsFile();
    const bot = createBot(file);
    await sendUpdate(bot, baseMessage({ text: "/points" }));
    assertNoUser(file);
  });

  await runTest("negative: bot user", async () => {
    const file = pointsFile();
    const bot = createBot(file);
    await sendUpdate(
      bot,
      baseMessage({
        text: "hello",
        from: { id: USER_ID, is_bot: true, first_name: "Bot" },
      })
    );
    assertNoUser(file);
  });

  await runTest("negative: owner/admin excluded (+0)", async () => {
    const file = pointsFile();
    const bot = createBot(file);
    await sendUpdate(
      bot,
      baseMessage({
        text: "hello mango",
        from: { id: OWNER_ID, is_bot: false, first_name: "Kevin" },
      })
    );
    const users = loadPoints(file).users || {};
    assert.strictEqual(users[String(OWNER_ID)], undefined);
  });

  await runTest("regression proof: omitting next() blocks points-trigger for text", async () => {
    const file = pointsFile();
    const bot = new Telegraf("000000000:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: "ManGo",
      username: "mango_test_bot",
    };
    bot.on("text", (_ctx) => {
      /* intentional: no next — old chat-fight bug */
    });
    registerCommunityActivityListener(bot, { pointsFile: file });
    await sendUpdate(bot, baseMessage({ text: "hello mango" }));
    assertNoUser(file);
  });

  console.log("\nAll community-activity-wiring tests passed.");
  restoreEnv();
}

main().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
