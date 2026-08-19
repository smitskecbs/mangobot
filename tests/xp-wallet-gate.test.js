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
  return {
    pointsFile: path.join(tempDir, `p-${n}.json`),
    walletFile: path.join(tempDir, `w-${n}.json`),
    rewardsFile: path.join(tempDir, `r-${n}.json`),
    snakeFile: path.join(tempDir, `s-${n}.json`),
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

function runTest(name, fn) {
  resetXpWalletRemindersForTests();
  setXpWalletAutoLinkForTests(false);
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

runTest("12. no wallet → no XP", () => {
  const { pointsFile, walletFile } = files();
  const result = awardDailyActivityPoint(10, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.awarded, false);
  assert.strictEqual(result.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(result.points, 0);
  assert.strictEqual(loadPoints(pointsFile).users["10"].points, 0);
  assert.strictEqual(canEarnXp(10, walletFile), false);
});

runTest("13. manual wallet → XP yes", () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(11, generateSolanaWallet().address, walletFile, 1000);
  const result = awardDailyActivityPoint(11, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 1);
  assert.strictEqual(getXpWalletLinkStatus(11, walletFile), "registered");
  assert.strictEqual(getVerifiedWalletForUser(11, walletFile), null);
  assert.ok(getLinkedWalletForUser(11, walletFile));
});

runTest("14. verified wallet → XP yes", () => {
  const { pointsFile, walletFile } = files();
  verifyUser(walletFile, 12, generateSolanaWallet(), 2000);
  const result = awardTriggerPoints(12, "Ada", "gmango", pointsFile, walletFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 2);
  assert.strictEqual(getXpWalletLinkStatus(12, walletFile), "verified");
});

runTest("15. remove wallet → future XP blocked", () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(13, generateSolanaWallet().address, walletFile, 3000);
  assert.strictEqual(awardTriggerPoints(13, "Ada", "gm", pointsFile, walletFile).awarded, true);
  disconnectWallet(13, walletFile);
  const blocked = awardTriggerPoints(13, "Ada", "gn", pointsFile, walletFile);
  assert.strictEqual(blocked.awarded, false);
  assert.strictEqual(blocked.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(loadPoints(pointsFile).users["13"].points, 1);
});

runTest("16. existing XP preserved", () => {
  const { pointsFile, walletFile } = files();
  seedXp(pointsFile, 14, "Ada", 40);
  awardDailyActivityPoint(14, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(loadPoints(pointsFile).users["14"].points, 40);
  assert.strictEqual(getRank(40).title, "Sprout");
});

runTest("17. no retroactive XP", () => {
  const { pointsFile, walletFile } = files();
  awardDailyActivityPoint(15, "Ada", pointsFile, undefined, walletFile);
  registerManualWallet(15, generateSolanaWallet().address, walletFile, 4000);
  const later = awardDailyActivityPoint(15, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(later.awarded, false);
  assert.strictEqual(loadPoints(pointsFile).users["15"].points, 0);
});

runTest("18. unlinked activity updates metadata but XP 0", () => {
  const { pointsFile, walletFile } = files();
  const result = awardDailyActivityPoint(16, "Ada", pointsFile, undefined, walletFile);
  const user = loadPoints(pointsFile).users["16"];
  assert.strictEqual(result.awarded, false);
  assert.strictEqual(user.points, 0);
  assert.strictEqual(user.weeklyPoints, 0);
  assert.strictEqual(user.activityDate, getTodayDate());
  assert.strictEqual(user.streak.current, 1);
  assert.strictEqual(user.streak.lastActiveDate, getTodayDate());
});

runTest("19. linked activity XP works", () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(17, generateSolanaWallet().address, walletFile, 5000);
  const result = awardDailyActivityPoint(17, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(loadPoints(pointsFile).users["17"].points, 1);
  assert.strictEqual(loadPoints(pointsFile).users["17"].weeklyPoints, 1);
});

runTest("20. reminder does not spam", () => {
  const { pointsFile, walletFile } = files();
  const first = processCommunityMessage(groupCtx(18, "hello there"), {
    pointsFile,
    walletFile,
    now: 10_000,
  });
  assert.strictEqual(first.activityResult.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(first.reply, XP_WALLET_REMINDER_TEXT);
  assert.ok(first.reply.includes("🔒 XP locked"));
  const second = processCommunityMessage(groupCtx(18, "hello again"), {
    pointsFile,
    walletFile,
    now: 20_000,
  });
  assert.strictEqual(second.reply, null);
  assert.strictEqual(takeXpWalletReminder(18, 20_000), false);
});

runTest("21. gm unlinked → 0 XP", () => {
  const { pointsFile, walletFile } = files();
  const result = awardTriggerPoints(19, "Ada", "gm", pointsFile, walletFile);
  assert.strictEqual(result.awarded, false);
  assert.strictEqual(result.reason, XP_WALLET_REQUIRED);
  assert.strictEqual(loadPoints(pointsFile).users["19"] ? loadPoints(pointsFile).users["19"].points : 0, 0);
  const msg = processCommunityMessage(groupCtx(19, "gm"), {
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

runTest("22. gm linked → XP", () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(20, generateSolanaWallet().address, walletFile, 6000);
  const result = awardTriggerPoints(20, "Ada", "gm", pointsFile, walletFile);
  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 1);
});

runTest("23. failed pre-link gm does not consume future claim", () => {
  const { pointsFile, walletFile } = files();
  awardTriggerPoints(21, "Ada", "gm", pointsFile, walletFile);
  const used = loadPoints(pointsFile).users["21"];
  assert.ok(!used || !Array.isArray(used.triggersUsed) || !used.triggersUsed.includes("gm"));
  registerManualWallet(21, generateSolanaWallet().address, walletFile, 7000);
  const after = awardTriggerPoints(21, "Ada", "gm", pointsFile, walletFile);
  assert.strictEqual(after.awarded, true);
  assert.strictEqual(after.points, 1);
});

runTest("24. gmango/gn/gnango same consume rule", () => {
  const { pointsFile, walletFile } = files();
  for (const trigger of ["gmango", "gn", "gnango"]) {
    awardTriggerPoints(22, "Ada", trigger, pointsFile, walletFile);
  }
  registerManualWallet(22, generateSolanaWallet().address, walletFile, 8000);
  assert.strictEqual(awardTriggerPoints(22, "Ada", "gmango", pointsFile, walletFile).awarded, true);
  assert.strictEqual(awardTriggerPoints(22, "Ada", "gn", pointsFile, walletFile).awarded, true);
  assert.strictEqual(awardTriggerPoints(22, "Ada", "gnango", pointsFile, walletFile).awarded, true);
  assert.strictEqual(loadPoints(pointsFile).users["22"].points, 5);
});

runTest("25. Snake unlinked → highscore works, XP 0", () => {
  const { pointsFile, walletFile, snakeFile } = files();
  const submission = submitScore(snakeFile, "Guest", 99);
  assert.ok(!submission.error);
  const xp = awardSnakeGameXp(25, "Guest", pointsFile, walletFile);
  assert.strictEqual(xp.awarded, false);
  assert.strictEqual(xp.reason, XP_WALLET_REQUIRED);
  const payload = publicGameXpFromAward(xp);
  assert.strictEqual(payload.walletRequired, true);
  assert.strictEqual(payload.message, XP_WALLET_GAME_LOCKED_TEXT);
  assert.deepStrictEqual(loadPoints(pointsFile), { users: {} });
  const spoof = awardSnakeGameXp(25, "Guest", pointsFile, walletFile);
  assert.strictEqual(spoof.awarded, false);
});

runTest("26. Bounch unlinked → XP 0, play state not consumed", () => {
  const { pointsFile, walletFile } = files();
  const blocked = awardBounchGameXp(26, "Ada", 3, pointsFile, walletFile);
  assert.strictEqual(blocked.awarded, false);
  assert.strictEqual(publicGameXpFromAward(blocked).message, XP_WALLET_GAME_LOCKED_TEXT);
  registerManualWallet(26, generateSolanaWallet().address, walletFile, 9000);
  const later = awardBounchGameXp(26, "Ada", 3, pointsFile, walletFile);
  assert.strictEqual(later.awarded, true);
  assert.strictEqual(later.xp.unlock, 3);
});

runTest("27. Trivia correct unlinked → XP 0", () => {
  const { pointsFile, walletFile } = files();
  const blocked = awardTriviaRoundXp(27, "Ada", TRIVIA_ROUND_WIN_XP, pointsFile, walletFile);
  assert.strictEqual(blocked.awarded, false);
  assert.strictEqual(blocked.reason, XP_WALLET_REQUIRED);
  const triviaSrc = fs.readFileSync(path.join(__dirname, "../services/trivia.js"), "utf8");
  assert.ok(triviaSrc.includes("Trivia XP: 🔒 0 XP — wallet not linked — /wallet"));
  registerManualWallet(27, generateSolanaWallet().address, walletFile, 10_000);
  const later = awardTriviaRoundXp(27, "Ada", TRIVIA_ROUND_WIN_XP, pointsFile, walletFile);
  assert.strictEqual(later.awarded, true);
  assert.strictEqual(later.points, 3);
});

runTest("28. linked game XP amounts unchanged", () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(28, generateSolanaWallet().address, walletFile, 11_000);
  assert.strictEqual(awardSnakeGameXp(28, "Ada", pointsFile, walletFile).pointsToAdd, 1);
  assert.strictEqual(awardPvpWinXp(28, "Ada", pointsFile, walletFile).pointsToAdd, 3);
  assert.strictEqual(awardChatFightXp(28, "Ada", pointsFile, walletFile).pointsToAdd, 2);
});

runTest("26b. PvP/ChatFight blocked XP feedback", () => {
  const { pointsFile, walletFile } = files();
  const pvp = awardPvpWinXp(260, "Ada", pointsFile, walletFile);
  assert.strictEqual(pvp.reason, XP_WALLET_REQUIRED);
  const fight = awardChatFightXp(261, "Ada", pointsFile, walletFile);
  assert.strictEqual(fight.reason, XP_WALLET_REQUIRED);
  const reply = buildWinnerReply("Ada", fight);
  assert.ok(reply.includes("🔒 0 XP — wallet not linked — /wallet"));
  const ttt = fs.readFileSync(path.join(__dirname, "../services/ticTacToe.js"), "utf8");
  const c4 = fs.readFileSync(path.join(__dirname, "../services/connectFour.js"), "utf8");
  assert.ok(ttt.includes("PvP XP: 🔒 0 XP — wallet not linked — /wallet"));
  assert.ok(c4.includes("PvP XP: 🔒 0 XP — wallet not linked — /wallet"));
});

runTest("29. no duplicate wallet reminder spam", () => {
  resetXpWalletRemindersForTests();
  assert.strictEqual(takeXpWalletReminder(29, 1), true);
  assert.strictEqual(takeXpWalletReminder(29, 2), false);
  assert.strictEqual(takeXpWalletReminder(30, 2), true);
});

runTest("30. unlinked cannot rank up", () => {
  const { pointsFile, walletFile } = files();
  seedXp(pointsFile, 31, "Ada", 24);
  const result = awardDailyActivityPoint(31, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.rankUp, false);
  assert.strictEqual(getRank(loadPoints(pointsFile).users["31"].points).title, "Seed");
});

runTest("31. existing rank preserved", () => {
  const { pointsFile, walletFile } = files();
  seedXp(pointsFile, 32, "Ada", 75);
  awardDailyActivityPoint(32, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(getRank(loadPoints(pointsFile).users["32"].points).title, "Tree");
});

runTest("32. linked rank-up semantics unchanged", () => {
  const { pointsFile, walletFile } = files();
  seedXp(pointsFile, 33, "Ada", 24);
  registerManualWallet(33, generateSolanaWallet().address, walletFile, 12_000);
  const result = awardDailyActivityPoint(33, "Ada", pointsFile, undefined, walletFile);
  assert.strictEqual(result.rankUp, true);
  assert.strictEqual(result.rank.title, "Sprout");
});

runTest("33. frontend cannot spoof linked state", () => {
  const { pointsFile, walletFile } = files();
  const xp = awardSnakeGameXp(34, "Ada", pointsFile, walletFile);
  assert.strictEqual(xp.awarded, false);
  assert.strictEqual(canEarnXp(34, walletFile), false);
});

runTest("34. manual wallet counts linked but not verified", () => {
  const { walletFile } = files();
  registerManualWallet(35, generateSolanaWallet().address, walletFile, 13_000);
  assert.strictEqual(canEarnXp(35, walletFile), true);
  assert.strictEqual(getVerifiedWalletForUser(35, walletFile), null);
  assert.strictEqual(isRewardEligible(35, walletFile), true);
});

runTest("35. presale manual remains blocked", () => {
  const { walletFile } = files();
  registerManualWallet(36, generateSolanaWallet().address, walletFile, 14_000);
  const session = createPresaleSession(36, { walletFile, now: 14_000 });
  assert.strictEqual(session.ok, false);
  assert.strictEqual(session.reason, "unverified");
  assert.strictEqual(canEarnXp(36, walletFile), true);
});

runTest("36. no production files touched", () => {
  for (const [file, before] of Object.entries(prodMtimes)) {
    assert.strictEqual(fs.statSync(file).mtimeMs, before, file);
  }
});

runTest("37. no secrets in reminder/list copy", () => {
  assert.ok(!/BOT_TOKEN|private key|seed/i.test(XP_WALLET_REMINDER_TEXT));
  assert.ok(!XP_WALLET_REMINDER_TEXT.includes("cryptographically verified"));
  assert.ok(XP_WALLET_REMINDER_TEXT.includes("🔒 XP locked"));
  assert.ok(XP_WALLET_TRIGGER_REMINDER_TEXT.includes("/wallet"));
  assert.ok(XP_WALLET_GAME_LOCKED_TEXT.includes("Game completed"));
});

runTest("membercheck XP earning lines", () => {
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

runTest("/points locked copy", () => {
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

runTest("slash commands do not claim daily XP", () => {
  const { pointsFile, walletFile } = files();
  registerManualWallet(51, generateSolanaWallet().address, walletFile, 18_000);
  const result = processCommunityMessage(groupCtx(51, "/points"), {
    pointsFile,
    walletFile,
  });
  assert.strictEqual(result.activityResult, null);
});

runTest("canEarnXp never uses verified-only", () => {
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
