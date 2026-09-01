/**
 * Linked-wallet XP gate: manual counts, verified counts, no wallet blocks future XP.
 * Run: node tests/xp-wallet-gate.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  awardDailyActivityPoint,
  awardTriggerPoints,
  awardSnakeGameXp,
  awardBounchGameXp,
  awardTriviaRoundXp,
  awardTriviaAttemptXp,
  awardPvpWinXp,
  awardChatFightXp,
  loadPoints,
  mutatePoints,
  getRank,
  getTodayDate,
  formatPointsCard,
  publicGameXpFromAward,
  TRIVIA_ROUND_WIN_XP,
  XP_WALLET_REQUIRED,
} = require("../services/points");
const {
  canEarnXp,
  getXpWalletLinkStatus,
  takeXpWalletReminder,
  resetXpWalletRemindersForTests,
  setXpWalletAutoLinkForTests,
  XP_WALLET_REMINDER_TEXT,
  XP_WALLET_TRIGGER_REMINDER_TEXT,
  XP_WALLET_GAME_LOCKED_TEXT,
  XP_WALLET_LOCKED_POINTS_LINE,
} = require("../services/xpWalletGate");
const {
  registerManualWallet,
  disconnectWallet,
  getVerifiedWalletForUser,
  getLinkedWalletForUser,
  setWalletFileForTests,
} = require("../services/walletLinks");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { createPresaleSession } = require("../services/presaleSessions");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");
const { processCommunityMessage } = require("../events/points-trigger");
const { handlePoints } = require("../commands/points");
const { formatMemberCheck } = require("../commands/membercheck");
const { getMemberActivityProfile } = require("../services/memberActivityProfile");
const { isRewardEligible } = require("../services/memberRewards");
const { submitScore } = require("../services/snakeScores");
const { buildWinnerReply } = require("../services/chatFight");

setXpWalletAutoLinkForTests(false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-xp-gate-"));
const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "member-rewards.json"),
  path.join(__dirname, "..", "data", "presale-participation.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

let n = 0;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";
const originalChat = process.env.TELEGRAM_CHAT_ID;
process.env.TELEGRAM_CHAT_ID = "-1003916996602";

function files() {
  n += 1;
  const shopFile = path.join(tempDir, `shop-${n}.json`);
  setMangoShopFileForTests(shopFile);
  return {
    pointsFile: path.join(tempDir, `p-${n}.json`),
    walletFile: path.join(tempDir, `w-${n}.json`),
    rewardsFile: path.join(tempDir, `r-${n}.json`),
    snakeFile: path.join(tempDir, `s-${n}.json`),
    shopFile,
  };
}

function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    address: encodeBase58(publicKeyRaw),
    sign(message) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      return signEd25519Detached(buf, privateKey);
    },
  };
}

function verifyUser(walletFile, userId, wallet, now) {
  const created = createLinkToken(userId, { walletFile, now });
  const limiter = createMemoryRateLimiter();
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile, now: now + 1, rateLimiter: limiter }
  );
  const verified = verifyWalletSignature(
    {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    },
    { walletFile, now: now + 2, rateLimiter: limiter }
  );
  assert.strictEqual(verified.ok, true, verified.error);
}

function seedXp(pointsFile, userId, name, points) {
  mutatePoints((data) => {
    data.users[String(userId)] = {
      points,
      weeklyPoints: 0,
      weekId: getTodayDate(),
      name,
      triggerDate: null,
      triggersUsed: [],
      activityDate: null,
    };
  }, pointsFile);
}

function groupCtx(userId, text) {
  return {
    chat: { id: -1003916996602, type: "supergroup" },
    from: { id: userId, is_bot: false, first_name: "Ada" },
    message: { text, message_id: 1, date: Math.floor(Date.now() / 1000) },
  };
}

async function runTest(name, fn) {
  resetXpWalletRemindersForTests();
  setXpWalletAutoLinkForTests(false);
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

(async () => {
await runTest("12. no wallet → no XP", async () => {
  const { pointsFile, walletFile } = files();
  const result = await awardDailyActivityPoint(10, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.awarded, false);
  assert.strictEqual(result.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(result.points, 0);
  assert.strictEqual(loadPoints(pointsFile).users["10"].points, 0);
  assert.strictEqual(canEarnXp(10, walletFile), false);
});

await runTest("13. manual wallet → XP yes", async () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(11, generateSolanaWallet().address, walletFile, 1000);
  const result = await awardDailyActivityPoint(11, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 1);
  assert.strictEqual(getXpWalletLinkStatus(11, walletFile), "registered");
  assert.strictEqual(getVerifiedWalletForUser(11, walletFile), null);
  assert.ok(getLinkedWalletForUser(11, walletFile));
});

await runTest("14. verified wallet → XP yes", async () => {
  const { pointsFile, walletFile } = files();
  verifyUser(walletFile, 12, generateSolanaWallet(), 2000);
  const result = await awardTriggerPoints(12, "Ada", "gmango", pointsFile, walletFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 2);
  assert.strictEqual(getXpWalletLinkStatus(12, walletFile), "verified");
});

await runTest("15. remove wallet → future XP blocked", async () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(13, generateSolanaWallet().address, walletFile, 3000);
  assert.strictEqual((await awardTriggerPoints(13, "Ada", "gm", pointsFile, walletFile)).awarded, true);
  disconnectWallet(13, walletFile);
  const blocked = await awardTriggerPoints(13, "Ada", "gn", pointsFile, walletFile);
  assert.strictEqual(blocked.awarded, false);
  assert.strictEqual(blocked.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(loadPoints(pointsFile).users["13"].points, 1);
});

await runTest("16. existing XP preserved", async () => {
  const { pointsFile, walletFile } = files();
  seedXp(pointsFile, 14, "Ada", 40);
  await awardDailyActivityPoint(14, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(loadPoints(pointsFile).users["14"].points, 40);
  assert.strictEqual(getRank(40).title, "Sprout");
});

await runTest("17. no retroactive XP", async () => {
  const { pointsFile, walletFile } = files();
  await awardDailyActivityPoint(15, "Ada", pointsFile, undefined, walletFile);
  registerManualWallet(15, generateSolanaWallet().address, walletFile, 4000);
  const later = await awardDailyActivityPoint(15, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(later.awarded, false);
  assert.strictEqual(loadPoints(pointsFile).users["15"].points, 0);
});

await runTest("18. unlinked activity updates metadata but XP 0", async () => {
  const { pointsFile, walletFile } = files();
  const result = await awardDailyActivityPoint(16, "Ada", pointsFile, undefined, walletFile);
  const user = loadPoints(pointsFile).users["16"];
  assert.strictEqual(result.awarded, false);
  assert.strictEqual(user.points, 0);
  assert.strictEqual(user.weeklyPoints, 0);
  assert.strictEqual(user.activityDate, getTodayDate());
  assert.strictEqual(user.streak.current, 1);
  assert.strictEqual(user.streak.lastActiveDate, getTodayDate());
});

await runTest("19. linked activity XP works", async () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(17, generateSolanaWallet().address, walletFile, 5000);
  const result = await awardDailyActivityPoint(17, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(loadPoints(pointsFile).users["17"].points, 1);
  assert.strictEqual(loadPoints(pointsFile).users["17"].weeklyPoints, 1);
});

await runTest("20. reminder does not spam", async () => {
  const { pointsFile, walletFile } = files();
  const first = await processCommunityMessage(groupCtx(18, "hello there"), {
    pointsFile,
    walletFile,
    now: 10_000,
  });
  assert.strictEqual(first.activityResult.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(first.reply, XP_WALLET_REMINDER_TEXT);
  assert.ok(first.reply.includes("🔒 XP locked"));
  const second = await processCommunityMessage(groupCtx(18, "hello again"), {
    pointsFile,
    walletFile,
    now: 20_000,
  });
  assert.strictEqual(second.reply, null);
  assert.strictEqual(takeXpWalletReminder(18, 20_000), false);
});

await runTest("21. gm unlinked → 0 XP", async () => {
  const { pointsFile, walletFile } = files();
  const result = await awardTriggerPoints(19, "Ada", "gm", pointsFile, walletFile);
  assert.strictEqual(result.awarded, false);
  assert.strictEqual(result.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(loadPoints(pointsFile).users["19"] ? loadPoints(pointsFile).users["19"].points : 0, 0);
  const msg = await processCommunityMessage(groupCtx(19, "gm"), {
    pointsFile,
    walletFile,
    now: 30_000,
  });
  assert.strictEqual(msg.triggerResult.awarded, false);
  assert.ok(!msg.triggerResult.awarded);
  assert.strictEqual(msg.reply, XP_WALLET_TRIGGER_REMINDER_TEXT);
  const used = loadPoints(pointsFile).users["19"];
  assert.ok(!used || !Array.isArray(used.triggersUsed) || !used.triggersUsed.includes("gm"));
});

await runTest("22. gm linked → XP", async () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(20, generateSolanaWallet().address, walletFile, 6000);
  const result = await awardTriggerPoints(20, "Ada", "gm", pointsFile, walletFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 1);
});

await runTest("23. failed pre-link gm does not consume future claim", async () => {
  const { pointsFile, walletFile } = files();
  await awardTriggerPoints(21, "Ada", "gm", pointsFile, walletFile);
  const used = loadPoints(pointsFile).users["21"];
  assert.ok(!used || !Array.isArray(used.triggersUsed) || !used.triggersUsed.includes("gm"));
  registerManualWallet(21, generateSolanaWallet().address, walletFile, 7000);
  const after = await awardTriggerPoints(21, "Ada", "gm", pointsFile, walletFile);
  assert.strictEqual(after.awarded, true);
  assert.strictEqual(after.points, 1);
});

await runTest("24. gmango/gn/gnango same consume rule", async () => {
  const { pointsFile, walletFile } = files();
  for (const trigger of ["gmango", "gn", "gnango"]) {
    await awardTriggerPoints(22, "Ada", trigger, pointsFile, walletFile);
  }
  registerManualWallet(22, generateSolanaWallet().address, walletFile, 8000);
  assert.strictEqual((await awardTriggerPoints(22, "Ada", "gmango", pointsFile, walletFile)).awarded, true);
  assert.strictEqual((await awardTriggerPoints(22, "Ada", "gn", pointsFile, walletFile)).awarded, true);
  assert.strictEqual((await awardTriggerPoints(22, "Ada", "gnango", pointsFile, walletFile)).awarded, true);
  assert.strictEqual(loadPoints(pointsFile).users["22"].points, 5);
});

await runTest("25. Snake unlinked → highscore works, XP 0", async () => {
  const { pointsFile, walletFile, snakeFile } = files();
  const submission = submitScore(snakeFile, "Guest", 99);
  assert.ok(!submission.error);
  const xp = await awardSnakeGameXp(25, "Guest", pointsFile, walletFile);
  assert.strictEqual(xp.awarded, false);
  assert.strictEqual(xp.reason, XP_WALLET_REQUIRED);
  const payload = publicGameXpFromAward(xp);
  assert.strictEqual(payload.walletRequired, true);
  assert.strictEqual(payload.message, XP_WALLET_GAME_LOCKED_TEXT);
  assert.deepStrictEqual(loadPoints(pointsFile), { users: {} });
  const spoof = await awardSnakeGameXp(25, "Guest", pointsFile, walletFile);
  assert.strictEqual(spoof.awarded, false);
});

await runTest("26. Bounch unlinked → XP 0, play state not consumed", async () => {
  const { pointsFile, walletFile } = files();
  const blocked = await awardBounchGameXp(26, "Ada", 3, pointsFile, walletFile);
  assert.strictEqual(blocked.awarded, false);
  assert.strictEqual(publicGameXpFromAward(blocked).message, XP_WALLET_GAME_LOCKED_TEXT);
  registerManualWallet(26, generateSolanaWallet().address, walletFile, 9000);
  const later = await awardBounchGameXp(26, "Ada", 3, pointsFile, walletFile);
  assert.strictEqual(later.awarded, true);
  assert.strictEqual(later.xp.unlock, 3);
});

await runTest("27. Trivia correct unlinked → XP 0, attempt consumed, no retroactive XP", async () => {
  const { pointsFile, walletFile } = files();
  const blocked = await awardTriviaAttemptXp(
    27,
    "Ada",
    { correct: true },
    pointsFile,
    walletFile
  );
  assert.strictEqual(blocked.awarded, false);
  assert.strictEqual(blocked.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(blocked.attemptsUsed, 1);
  assert.strictEqual(blocked.pointsToAdd, 0);
  const triviaSrc = fs.readFileSync(path.join(__dirname, "../services/trivia.js"), "utf8");
  assert.ok(triviaSrc.includes("Trivia XP: 🔒 0 XP — wallet not linked — /wallet"));
  registerManualWallet(27, generateSolanaWallet().address, walletFile, 10_000);
  const later = await awardTriviaAttemptXp(
    27,
    "Ada",
    { correct: true },
    pointsFile,
    walletFile
  );
  assert.strictEqual(later.awarded, true);
  assert.strictEqual(later.points, 1);
  assert.strictEqual(later.attemptsUsed, 2);
  assert.strictEqual(loadPoints(pointsFile).users["27"].trivia.attemptsUsed, 2);
  assert.strictEqual(loadPoints(pointsFile).users["27"].points, 1);
});

await runTest("28. linked game XP amounts unchanged", async () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(28, generateSolanaWallet().address, walletFile, 11_000);
  assert.strictEqual((await awardSnakeGameXp(28, "Ada", pointsFile, walletFile)).pointsToAdd, 1);
  assert.strictEqual((await awardPvpWinXp(28, "Ada", pointsFile, walletFile)).pointsToAdd, 3);
  assert.strictEqual((await awardChatFightXp(28, "Ada", pointsFile, walletFile)).pointsToAdd, 2);
});

await runTest("26b. PvP/ChatFight blocked XP feedback", async () => {
  const { pointsFile, walletFile } = files();
  const pvp = await awardPvpWinXp(260, "Ada", pointsFile, walletFile);
  assert.strictEqual(pvp.reason, XP_WALLET_REQUIRED);
  const fight = await awardChatFightXp(261, "Ada", pointsFile, walletFile);
  assert.strictEqual(fight.reason, XP_WALLET_REQUIRED);
  const reply = buildWinnerReply("Ada", fight);
  assert.ok(reply.includes("🔒 0 XP — wallet not linked — /wallet"));
  const ttt = fs.readFileSync(path.join(__dirname, "../services/ticTacToe.js"), "utf8");
  const c4 = fs.readFileSync(path.join(__dirname, "../services/connectFour.js"), "utf8");
  assert.ok(ttt.includes("PvP XP: 🔒 0 XP — wallet not linked — /wallet"));
  assert.ok(c4.includes("PvP XP: 🔒 0 XP — wallet not linked — /wallet"));
});

await runTest("29. no duplicate wallet reminder spam", async () => {
  resetXpWalletRemindersForTests();
  assert.strictEqual(takeXpWalletReminder(29, 1), true);
  assert.strictEqual(takeXpWalletReminder(29, 2), false);
  assert.strictEqual(takeXpWalletReminder(30, 2), true);
});

await runTest("30. unlinked cannot rank up", async () => {
  const { pointsFile, walletFile } = files();
  seedXp(pointsFile, 31, "Ada", 24);
  const result = await awardDailyActivityPoint(31, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.rankUp, false);
  assert.strictEqual(getRank(loadPoints(pointsFile).users["31"].points).title, "Seed");
});

await runTest("31. existing rank preserved", async () => {
  const { pointsFile, walletFile } = files();
  seedXp(pointsFile, 32, "Ada", 75);
  await awardDailyActivityPoint(32, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(getRank(loadPoints(pointsFile).users["32"].points).title, "Tree");
});

await runTest("32. linked rank-up semantics unchanged", async () => {
  const { pointsFile, walletFile } = files();
  seedXp(pointsFile, 33, "Ada", 24);
  registerManualWallet(33, generateSolanaWallet().address, walletFile, 12_000);
  const result = await awardDailyActivityPoint(33, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.rankUp, true);
  assert.strictEqual(result.rank.title, "Sprout");
});

await runTest("33. frontend cannot spoof linked state", async () => {
  const { pointsFile, walletFile } = files();
  const xp = await awardSnakeGameXp(34, "Ada", pointsFile, walletFile);
  assert.strictEqual(xp.awarded, false);
  assert.strictEqual(canEarnXp(34, walletFile), false);
});

await runTest("34. manual wallet counts linked but not verified", async () => {
  const { walletFile } = files();
  registerManualWallet(35, generateSolanaWallet().address, walletFile, 13_000);
  assert.strictEqual(canEarnXp(35, walletFile), true);
  assert.strictEqual(getVerifiedWalletForUser(35, walletFile), null);
  assert.strictEqual(isRewardEligible(35, walletFile), true);
});

await runTest("35. presale manual remains blocked", async () => {
  const { walletFile } = files();
  registerManualWallet(36, generateSolanaWallet().address, walletFile, 14_000);
  const session = createPresaleSession(36, { walletFile, now: 14_000 });
  assert.strictEqual(session.ok, false);
  assert.strictEqual(session.reason, "unverified");
  assert.strictEqual(canEarnXp(36, walletFile), true);
});

await runTest("36. no production files touched", async () => {
  for (const [file, before] of Object.entries(prodMtimes)) {
    assert.strictEqual(fs.statSync(file).mtimeMs, before, file);
  }
});

await runTest("37. no secrets in reminder/list copy", async () => {
  assert.ok(!/BOT_TOKEN|private key|seed/i.test(XP_WALLET_REMINDER_TEXT));
  assert.ok(!XP_WALLET_REMINDER_TEXT.includes("cryptographically verified"));
  assert.ok(XP_WALLET_REMINDER_TEXT.includes("🔒 XP locked"));
  assert.ok(XP_WALLET_TRIGGER_REMINDER_TEXT.includes("/wallet"));
  assert.ok(XP_WALLET_GAME_LOCKED_TEXT.includes("Game completed"));
});

await runTest("membercheck XP earning lines", async () => {
  const { pointsFile, walletFile, rewardsFile } = files();
  const none = formatMemberCheck(getMemberActivityProfile(40, { pointsFile, walletFile, rewardsFile }));
  assert.ok(none.includes("Wallet: ⬜ Not linked"));
  assert.ok(none.includes("XP earning: 🔒 Locked — link wallet"));
  registerManualWallet(41, generateSolanaWallet().address, walletFile, 15_000);
  const registered = formatMemberCheck(
    getMemberActivityProfile(41, { pointsFile, walletFile, rewardsFile }),
    "Alice"
  );
  assert.ok(registered.includes("Wallet: 🟡 Registered"));
  assert.ok(registered.includes("XP earning: ✅ Enabled"));
  verifyUser(walletFile, 42, generateSolanaWallet(), 16_000);
  const verified = formatMemberCheck(
    getMemberActivityProfile(42, { pointsFile, walletFile, rewardsFile }),
    "Kevin"
  );
  assert.ok(verified.includes("Wallet: 🟢 Verified"));
  assert.ok(verified.includes("XP earning: ✅ Enabled"));
});

await runTest("/points locked copy", async () => {
  const { pointsFile, walletFile } = files();
  const ctx = {
    chat: { type: "private" },
    from: { id: 50, first_name: "Ada" },
    replies: [],
    reply(text) {
      this.replies.push(text);
    },
  };
  handlePoints(ctx, { pointsFile, walletFile });
  assert.ok(ctx.replies[0].includes(XP_WALLET_LOCKED_POINTS_LINE));
  registerManualWallet(50, generateSolanaWallet().address, walletFile, 17_000);
  const linked = {
    chat: { type: "private" },
    from: { id: 50, first_name: "Ada" },
    replies: [],
    reply(text) {
      this.replies.push(text);
    },
  };
  handlePoints(linked, { pointsFile, walletFile });
  assert.ok(!linked.replies[0].includes("XP earning locked"));
});

await runTest("slash commands do not claim daily XP", async () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(51, generateSolanaWallet().address, walletFile, 18_000);
  const result = await processCommunityMessage(groupCtx(51, "/points"), {
    pointsFile,
    walletFile,
  });
  assert.strictEqual(result.activityResult, null);
});

await runTest("canEarnXp never uses verified-only", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "xpWalletGate.js"), "utf8");
  const start = src.indexOf("function canEarnXp");
  const end = src.indexOf("function getXpWalletLinkStatus");
  const body = src.slice(start, end);
  assert.ok(body.includes("getLinkedWalletForUser"));
  assert.ok(!body.includes("getVerifiedWalletForUser"));
});

if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
else process.env.ADMIN_USER_ID = originalAdmin;
if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
else process.env.TELEGRAM_CHAT_ID = originalChat;
setWalletFileForTests(null);


  console.log("xp-wallet-gate tests passed");

})().catch((err) => {
  console.error(err);
  process.exit(1);
});
