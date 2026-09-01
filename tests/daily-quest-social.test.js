/**
 * Daily Quest social rotation: replies, media, messages.
 * Run: node tests/daily-quest-social.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const { setWalletFileForTests, registerManualWallet } = require("../services/walletLinks");
require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);
const {
  QUEST_IDS,
  findUtcDateForSelection,
  getDailyQuestSnapshot,
} = require("../services/dailyQuest");
const { processCommunityMessage } = require("../events/points-trigger");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-dq-social-"));
let n = 0;
const USER = "7101";
const OTHER = "7102";
const BOT = "7103";
const CHAT = -1001234567890;
const WRONG_CHAT = -1009990001111;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
process.env.TELEGRAM_CHAT_ID = String(CHAT);

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function walletAddress(seed) {
  return encodeBase58(crypto.createHash("sha256").update(String(seed)).digest());
}

function nextFiles() {
  n += 1;
  const shopFile = path.join(tempDir, `shop-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(walletFile, JSON.stringify({ users: {}, wallets: {} }, null, 2), "utf8");
  setMangoShopFileForTests(shopFile);
  setWalletFileForTests(walletFile);
  registerManualWallet(USER, walletAddress(`s-${n}`), walletFile);
  return { shopFile, walletFile, pointsFile };
}

function opts(files, now) {
  return {
    shopFile: files.shopFile,
    walletFile: files.walletFile,
    pointsFile: files.pointsFile,
    now,
  };
}

function questProgress(snap, questId) {
  return (snap.questList || []).find((q) => q.id === questId) || null;
}

let msgSeq = 1;
function groupCtx({
  userId = USER,
  text = "hello mango",
  isBot = false,
  chatId = CHAT,
  extra = {},
} = {}) {
  msgSeq += 1;
  const message = Object.assign({ text }, extra);
  if (message.message_id == null) {
    message.message_id = extra.message_id != null ? extra.message_id : msgSeq;
  }
  return {
    from: { id: Number(userId), is_bot: isBot, first_name: "Ada" },
    chat: { id: chatId, type: "supergroup" },
    message,
  };
}

function replyCtx(extra = {}) {
  return groupCtx({
    text: extra.text || "nice one",
    extra: {
      reply_to_message: extra.reply_to_message,
      message_id: extra.message_id,
    },
  });
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

const repliesDay = findUtcDateForSelection({ social: QUEST_IDS.REPLIES_5 });
const mediaDay = findUtcDateForSelection({ social: QUEST_IDS.MEDIA_2 });
const messagesDay = findUtcDateForSelection({ social: QUEST_IDS.MESSAGES_5 });

(async () => {
  await runTest("5 valid replies completes", async () => {
    const files = nextFiles();
    for (let i = 0; i < 5; i += 1) {
      await processCommunityMessage(
        replyCtx({
          reply_to_message: { from: { id: Number(OTHER), is_bot: false }, message_id: 10 + i },
        }),
        opts(files, repliesDay.now)
      );
    }
    const snap = getDailyQuestSnapshot(USER, opts(files, repliesDay.now));
    const q = questProgress(snap, QUEST_IDS.REPLIES_5);
    assert.strictEqual(q.progress, 5);
    assert.strictEqual(q.completed, true);
    assert.strictEqual(snap.completedToday, 1);
  });

  await runTest("self reply ignored", async () => {
    const files = nextFiles();
    await processCommunityMessage(
      replyCtx({
        reply_to_message: { from: { id: Number(USER), is_bot: false }, message_id: 1 },
      }),
      opts(files, repliesDay.now)
    );
    const q = questProgress(getDailyQuestSnapshot(USER, opts(files, repliesDay.now)), QUEST_IDS.REPLIES_5);
    assert.strictEqual(q.progress, 0);
    assert.strictEqual(q.completed, false);
  });

  await runTest("bot reply ignored", async () => {
    const files = nextFiles();
    await processCommunityMessage(
      replyCtx({
        reply_to_message: { from: { id: Number(BOT), is_bot: true }, message_id: 2 },
      }),
      opts(files, repliesDay.now)
    );
    const q = questProgress(getDailyQuestSnapshot(USER, opts(files, repliesDay.now)), QUEST_IDS.REPLIES_5);
    assert.strictEqual(q.progress, 0);
  });

  await runTest("duplicate message ignored", async () => {
    const files = nextFiles();
    const ctx = replyCtx({
      message_id: 4242,
      reply_to_message: { from: { id: Number(OTHER), is_bot: false }, message_id: 9 },
    });
    await processCommunityMessage(ctx, opts(files, repliesDay.now));
    await processCommunityMessage(ctx, opts(files, repliesDay.now));
    const q = questProgress(getDailyQuestSnapshot(USER, opts(files, repliesDay.now)), QUEST_IDS.REPLIES_5);
    assert.strictEqual(q.progress, 1);
  });

  await runTest("2 media completes", async () => {
    const files = nextFiles();
    await processCommunityMessage(
      groupCtx({ text: undefined, extra: { photo: [{ file_id: "p1" }] } }),
      opts(files, mediaDay.now)
    );
    await processCommunityMessage(
      groupCtx({ text: undefined, extra: { animation: { file_id: "g1" } } }),
      opts(files, mediaDay.now)
    );
    const q = questProgress(getDailyQuestSnapshot(USER, opts(files, mediaDay.now)), QUEST_IDS.MEDIA_2);
    assert.strictEqual(q.progress, 2);
    assert.strictEqual(q.completed, true);
  });

  await runTest("sticker ignored", async () => {
    const files = nextFiles();
    const ctx = groupCtx({ text: undefined, extra: { sticker: { file_id: "s1" } } });
    delete ctx.message.text;
    await processCommunityMessage(ctx, opts(files, mediaDay.now));
    const q = questProgress(getDailyQuestSnapshot(USER, opts(files, mediaDay.now)), QUEST_IDS.MEDIA_2);
    assert.strictEqual(q.progress, 0);
    assert.strictEqual(q.completed, false);
  });

  await runTest("5 messages completes", async () => {
    const files = nextFiles();
    for (let i = 0; i < 5; i += 1) {
      await processCommunityMessage(groupCtx({ text: `hello ${i}` }), opts(files, messagesDay.now));
    }
    const q = questProgress(
      getDailyQuestSnapshot(USER, opts(files, messagesDay.now)),
      QUEST_IDS.MESSAGES_5
    );
    assert.strictEqual(q.progress, 5);
    assert.strictEqual(q.completed, true);
  });

  await runTest("wrong chat ignored", async () => {
    const files = nextFiles();
    await processCommunityMessage(
      groupCtx({ text: "hello mango", chatId: WRONG_CHAT }),
      opts(files, messagesDay.now)
    );
    const q = questProgress(
      getDailyQuestSnapshot(USER, opts(files, messagesDay.now)),
      QUEST_IDS.MESSAGES_5
    );
    assert.strictEqual(q.progress, 0);
  });

  for (const [file, mtime] of Object.entries(prodMtimes)) {
    if (fs.existsSync(file)) {
      assert.strictEqual(fs.statSync(file).mtimeMs, mtime, file);
    }
  }

  setMangoShopFileForTests(null);
  setWalletFileForTests(null);
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("All daily-quest-social tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
