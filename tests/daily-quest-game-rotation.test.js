/**
 * Daily Quest game rotation: PvP, Trivia, bot games.
 * Run: node tests/daily-quest-game-rotation.test.js
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
  noteDailyQuestGame,
  noteDailyQuestPvp,
} = require("../services/dailyQuest");
const { noteHumanPvpMatch } = require("../services/pvpProgress");
const { awardTriviaAttemptXp, awardChatFightXp } = require("../services/points");
const { handleTrivia } = require("../commands/trivia");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-dq-game-"));
let n = 0;
const USER = "7201";
const CHAT = -1001234567890;
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
  registerManualWallet(USER, walletAddress(`g-${n}`), walletFile);
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

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

const pvpDay = findUtcDateForSelection({ game: QUEST_IDS.PVP_GAME_1 });
const triviaDay = findUtcDateForSelection({ game: QUEST_IDS.TRIVIA_1 });
const botDay = findUtcDateForSelection({ game: QUEST_IDS.BOT_GAME_1 });

(async () => {
await runTest("human PvP completion", async () => {
  const files = nextFiles();
  await noteHumanPvpMatch(
    USER,
    {
      game: "tictactoe",
      matchId: "m1",
      opponentType: "human",
      shopFile: files.shopFile,
      walletFile: files.walletFile,
      now: pvpDay.now,
    },
    files.pointsFile
  );
  const q = questProgress(getDailyQuestSnapshot(USER, opts(files, pvpDay.now)), QUEST_IDS.PVP_GAME_1);
  assert.strictEqual(q.completed, true);
});

await runTest("bot PvP excluded from PVP quest", async () => {
  const files = nextFiles();
  await noteHumanPvpMatch(
    USER,
    {
      game: "tictactoe",
      matchId: "m-bot",
      opponentType: "bot",
      shopFile: files.shopFile,
      now: pvpDay.now,
    },
    files.pointsFile
  );
  noteDailyQuestGame(USER, "tictactoe", opts(files, pvpDay.now));
  const q = questProgress(getDailyQuestSnapshot(USER, opts(files, pvpDay.now)), QUEST_IDS.PVP_GAME_1);
  assert.strictEqual(q.completed, false);
});

await runTest("valid Trivia answer", async () => {
  const files = nextFiles();
  await awardTriviaAttemptXp(
    USER,
    "Ada",
    { correct: false, shopFile: files.shopFile, now: triviaDay.now },
    files.pointsFile,
    files.walletFile
  );
  const q = questProgress(
    getDailyQuestSnapshot(USER, opts(files, triviaDay.now)),
    QUEST_IDS.TRIVIA_1
  );
  assert.strictEqual(q.completed, true);
});

await runTest("chooser alone excluded", async () => {
  const files = nextFiles();
  const replies = [];
  const ctx = {
    from: { id: Number(USER), first_name: "Ada" },
    chat: { id: CHAT, type: "supergroup" },
    message: { text: "/trivia", message_id: 1 },
    reply(text) {
      replies.push(text);
      return Promise.resolve();
    },
  };
  await handleTrivia(ctx, {
    isBusyFn: () => false,
    pointsFile: files.pointsFile,
    shopFile: files.shopFile,
  });
  const q = questProgress(
    getDailyQuestSnapshot(USER, opts(files, triviaDay.now)),
    QUEST_IDS.TRIVIA_1
  );
  assert.strictEqual(q.completed, false);
});

await runTest("bot game completion", async () => {
  const files = nextFiles();
  await awardChatFightXp(USER, "Ada", files.pointsFile, files.walletFile);
  noteDailyQuestGame(USER, "chatfight", opts(files, botDay.now));
  const q = questProgress(
    getDailyQuestSnapshot(USER, opts(files, botDay.now)),
    QUEST_IDS.BOT_GAME_1
  );
  assert.strictEqual(q.completed, true);
});

await runTest("noteDailyQuestPvp is selected-only", async () => {
  const files = nextFiles();
  noteDailyQuestPvp(USER, opts(files, triviaDay.now));
  const triviaSnap = getDailyQuestSnapshot(USER, opts(files, triviaDay.now));
  assert.strictEqual(questProgress(triviaSnap, QUEST_IDS.TRIVIA_1).completed, false);
  noteDailyQuestPvp(USER, opts(files, pvpDay.now));
  const pvpSnap = getDailyQuestSnapshot(USER, opts(files, pvpDay.now));
  assert.strictEqual(questProgress(pvpSnap, QUEST_IDS.PVP_GAME_1).completed, true);
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
console.log("All daily-quest-game-rotation tests passed.");

})().catch((err) => {
  console.error(err);
  process.exit(1);
});
