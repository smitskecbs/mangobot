/**
 * Human Blackjack PvP counts toward PvP matches played; bot/lobby do not.
 * Run: node tests/blackjack-pvp-progression.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);

const { encodeBase58 } = require("../utils/base58");
const {
  createBlackjackService,
  getBlackjackRuntime,
} = require("../services/blackjack");
const {
  createTicTacToeService,
  STATUS: TTT_STATUS,
} = require("../services/ticTacToe");
const {
  loadPoints,
  getPvpMatchesPlayedToday,
  getPvpRewardedWinsToday,
  awardBlackjackPassXp,
  reserveBlackjackRewardedRound,
  awardBlackjackBotResultXp,
  awardBlackjackPvpResultXp,
  markBlackjackPvpMatchup,
  getBlackjackStatus,
} = require("../services/points");
const { registerManualWallet, setWalletFileForTests } = require("../services/walletLinks");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const { noteHumanPvpMatch } = require("../services/pvpProgress");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-bj-pvp-"));
let n = 0;
const COMMUNITY_CHAT = -1001234567890;
const USER_A = "111";
const USER_B = "222";

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
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  const shopFile = path.join(tempDir, `shop-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(walletFile, JSON.stringify({ users: {}, wallets: {} }, null, 2), "utf8");
  setWalletFileForTests(walletFile);
  setMangoShopFileForTests(shopFile);
  return { pointsFile, walletFile, shopFile };
}

function link(files, userId) {
  registerManualWallet(userId, walletAddress(`${n}-${userId}`), files.walletFile);
}

function matchesOf(files, userId) {
  return getPvpMatchesPlayedToday(loadPoints(files.pointsFile).users[String(userId)]);
}

function winsOf(files, userId) {
  return getPvpRewardedWinsToday(loadPoints(files.pointsFile).users[String(userId)]);
}

function createFakeTimers() {
  let nowMs = 1_700_000_000_000;
  const timers = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
      const due = timers
        .filter((t) => !t.cleared && t.fireAt <= nowMs)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const t of due) {
        if (t.cleared) continue;
        t.cleared = true;
        t.fn();
      }
    },
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.push({ id, fn, fireAt: nowMs + delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
  };
}

function attachXp(service, files) {
  service.setAwardHandlers({
    reserve: (userId, name, payload) => reserveBlackjackRewardedRound(userId, name, payload, files.pointsFile, files.walletFile),
    pass: (userId, name, payload) => awardBlackjackPassXp(
        userId,
        name,
        { ...payload, shopFile: files.shopFile },
        files.pointsFile,
        files.walletFile
      ),
    bot: (userId, name, payload) => awardBlackjackBotResultXp(
        userId,
        name,
        { ...payload, shopFile: files.shopFile },
        files.pointsFile,
        files.walletFile
      ),
    pvp: (userId, name, payload) => awardBlackjackPvpResultXp(
        userId,
        name,
        { ...payload, shopFile: files.shopFile },
        files.pointsFile,
        files.walletFile
      ),
    status: (userId) => getBlackjackStatus(userId, files.pointsFile),
    markPair: (userId, opponentId) => markBlackjackPvpMatchup(userId, opponentId, files.pointsFile),
  });
}

function createBj(files) {
  const timers = createFakeTimers();
  const service = createBlackjackService({
    now: () => timers.now(),
    setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
    randomIntFn: () => 0,
    randomIdFn: () => `bj${n}id`,
    botThinkMs: 0,
    shopFile: files.shopFile,
    walletFile: files.walletFile,
    pointsFile: files.pointsFile,
  });
  service.setEditMessageHandler(async () => {});
  service.setSendMessageHandler(async () => {});
  attachXp(service, files);
  return { service, timers };
}

function starter(userId, name) {
  return { userId, displayName: { first_name: name, id: userId }, isBot: false };
}

async function startBotGame(service) {
  const started = service.startLobby({
    chatId: COMMUNITY_CHAT,
    threadId: 123,
    starter: starter(USER_A, "Alice"),
  });
  service.setMessageId(started.gameId, 9001);
  await service.forceLobbyEnd(started.gameId);
  await service.whenIdle(COMMUNITY_CHAT);
  return started.gameId;
}

async function startPvp(service) {
  const started = service.startLobby({
    chatId: COMMUNITY_CHAT,
    threadId: 123,
    starter: starter(USER_A, "Alice"),
  });
  service.setMessageId(started.gameId, 9001);
  service.tryJoin({
    gameId: started.gameId,
    userId: USER_B,
    displayName: { first_name: "Bob", id: USER_B },
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  });
  await service.forceLobbyEnd(started.gameId);
  await service.whenIdle(COMMUNITY_CHAT);
  return started.gameId;
}

async function decide(service, gameId, userId, choice) {
  return service.tryDecide({
    gameId,
    userId,
    choice,
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  });
}

async function runTest(name, fn) {
  getBlackjackRuntime().reset();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  } finally {
    getBlackjackRuntime().reset();
  }
}

(async () => {
  await runTest("human BJ completion counts PvP", async () => {
    const files = nextFiles();
    link(files, USER_A);
    link(files, USER_B);
    const { service } = createBj(files);
    const gameId = await startPvp(service);
    await decide(service, gameId, USER_A, "pass");
    await decide(service, gameId, USER_B, "pass");
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(matchesOf(files, USER_A), 1);
    assert.strictEqual(matchesOf(files, USER_B), 1);
    assert.strictEqual(winsOf(files, USER_A), 0);
  });

  await runTest("bot BJ does not count PvP", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createBj(files);
    const gameId = await startBotGame(service);
    await decide(service, gameId, USER_A, "pass");
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(matchesOf(files, USER_A), 0);
  });

  await runTest("lobby does not count PvP", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const { service } = createBj(files);
    const started = service.startLobby({
      chatId: COMMUNITY_CHAT,
      threadId: 123,
      starter: starter(USER_A, "Alice"),
    });
    assert.ok(started.ok);
    assert.strictEqual(matchesOf(files, USER_A), 0);
    service.cancelAll("test");
    assert.strictEqual(matchesOf(files, USER_A), 0);
  });

  await runTest("duplicate resolution counts once", async () => {
    const files = nextFiles();
    link(files, USER_A);
    link(files, USER_B);
    const { service } = createBj(files);
    const gameId = await startPvp(service);
    await decide(service, gameId, USER_A, "pass");
    await decide(service, gameId, USER_B, "pass");
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(matchesOf(files, USER_A), 1);
    await noteHumanPvpMatch(
      USER_A,
      { game: "blackjack", matchId: gameId, opponentType: "human", shopFile: files.shopFile },
      files.pointsFile
    );
    assert.strictEqual(matchesOf(files, USER_A), 1);
  });

  await runTest("existing TTT/C4 human vs bot behavior unchanged", async () => {
    const files = nextFiles();
    link(files, USER_A);
    link(files, USER_B);
    const ttt = createTicTacToeService({
      shopFile: files.shopFile,
      walletFile: files.walletFile,
      pointsFile: files.pointsFile,
      joinTimeoutMs: 300_000,
    });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Alice", isBot: false },
    });
    ttt.setMessageId(started.session.id, 1);
    ttt.join({
      sessionId: started.session.id,
      userId: USER_B,
      displayName: "Bob",
      chatId: COMMUNITY_CHAT,
    });
    await ttt.move({ sessionId: started.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: started.session.id, userId: USER_B, cell: 3, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: started.session.id, userId: USER_A, cell: 1, chatId: COMMUNITY_CHAT });
    await ttt.move({ sessionId: started.session.id, userId: USER_B, cell: 4, chatId: COMMUNITY_CHAT });
    const win = await ttt.move({
      sessionId: started.session.id,
      userId: USER_A,
      cell: 2,
      chatId: COMMUNITY_CHAT,
    });
    assert.strictEqual(win.session.status, TTT_STATUS.WON);
    assert.strictEqual(matchesOf(files, USER_A), 1);
    assert.strictEqual(matchesOf(files, USER_B), 1);
  });

  await runTest("TTT vs bot does not count PvP matches", async () => {
    const files = nextFiles();
    link(files, USER_A);
    const ttt = createTicTacToeService({
      shopFile: files.shopFile,
      walletFile: files.walletFile,
      pointsFile: files.pointsFile,
      joinTimeoutMs: 300_000,
    });
    const started = ttt.startChallenge({
      chatId: COMMUNITY_CHAT,
      starter: { userId: USER_A, displayName: "Alice", isBot: false },
    });
    ttt.setMessageId(started.session.id, 1);
    const expired = ttt.expireJoin(started.session.id);
    assert.strictEqual(expired.session.opponentType, "bot");
    await ttt.move({ sessionId: started.session.id, userId: USER_A, cell: 0, chatId: COMMUNITY_CHAT });
    const ended = await ttt.resolveTurnTimeout(started.session.id);
    assert.ok(ended.session.status === TTT_STATUS.WON || ended.session.status === TTT_STATUS.DRAW);
    assert.strictEqual(matchesOf(files, USER_A), 0);
  });

  for (const [file, mtime] of Object.entries(prodMtimes)) {
    if (fs.existsSync(file)) {
      assert.strictEqual(fs.statSync(file).mtimeMs, mtime, `mutated ${file}`);
    }
  }

  setWalletFileForTests(null);
  setMangoShopFileForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("All blackjack PvP progression tests passed.");
})().catch((err) => {
  setWalletFileForTests(null);
  setMangoShopFileForTests(null);
  console.error(err);
  process.exitCode = 1;
});
