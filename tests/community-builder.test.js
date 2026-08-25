/**
 * Community Builder / Telegram referral tests.
 * Run: node tests/community-builder.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  configureCommunityBuilderForTests,
  getOrCreateInviteLink,
  handleChatMemberUpdate,
  applyJoinAttribution,
  builderSummary,
  paginateReferrals,
  getBuilderLeaderboard,
  getBuilderStats,
  tryWalletMilestone,
  tryActiveMilestone,
  onLifetimeXpMutated,
  inviteIdentity,
  builderRankInsertionPoint,
  BUILDER_RANK_THRESHOLDS,
  REFERRALS_PAGE_SIZE,
  ACTIVE_LIFETIME_XP,
  JOIN_EVENT,
} = require("../services/communityBuilder");
const {
  setCommunityBuilderFileForTests,
  loadBuilderStore,
  mutateBuilderStore,
} = require("../services/communityBuilderStore");
const {
  referralsText,
  leaderboardText,
  handleCommunityBuilder,
  handleBuilderStats,
  handleBuilderCallback,
  BUILDER_CALLBACK,
  GROUP_BUILDER_TEXT,
} = require("../commands/communitybuilder");
const { handleStart } = require("../commands/start");
const { handleGroupMenuCallback } = require("../commands/menu");
const {
  MENU_LABELS,
  GROUP_MENU_CALLBACK,
  getPrivateMenuKeyboard,
  getGroupMenuExtra,
} = require("../utils/botMenu");
const { TELEGRAM_ALLOWED_UPDATES } = require("../utils/botLifecycle");
const {
  registerManualWallet,
  setWalletFileForTests,
  disconnectWallet,
} = require("../services/walletLinks");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const {
  mutatePoints,
  loadPoints,
  awardMangoBombXp,
  awardDailyActivityPoint,
  canEarnXp,
} = require("../services/points");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const { getLifetimeTop: getLbTop, formatLifetimeLines } = require("../services/leaderboard");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-community-builder-"));
const COMMUNITY_CHAT = "-1003916996602";
const OTHER_CHAT = "-1001111111111";
const INVITER = "1001";
const REFERRED = "2002";
const OTHER = "3003";
const ADMIN_ID = "9001";
const GROUP_ADMIN = "8008";

const originalChat = process.env.TELEGRAM_CHAT_ID;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.TELEGRAM_CHAT_ID = COMMUNITY_CHAT;
process.env.ADMIN_USER_ID = ADMIN_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
  path.join(__dirname, "..", "data", "member-rewards.json"),
  path.join(__dirname, "..", "data", "reward-delivery.json"),
  path.join(__dirname, "..", "data", "presale-participation.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

let n = 0;
function harness() {
  n += 1;
  const storeFile = path.join(tempDir, `builder-${n}.json`);
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  const notifications = [];
  let createCalls = 0;
  const createChatInviteLink = async () => {
    createCalls += 1;
    return { invite_link: `https://t.me/+hash${n}abc` };
  };
  configureCommunityBuilderForTests({
    storeFile,
    pointsFile,
    walletFile,
    chatId: COMMUNITY_CHAT,
    notify: (kind, payload) => {
      notifications.push({ kind, payload });
      return Promise.resolve({ sent: true });
    },
    createChatInviteLink,
    botId: 55,
  });
  setWalletFileForTests(walletFile);
  return {
    storeFile,
    pointsFile,
    walletFile,
    notifications,
    createCalls: () => createCalls,
    opts: { storeFile, pointsFile, walletFile, chatId: COMMUNITY_CHAT },
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

function verifyUser(file, userId, wallet, now) {
  const created = createLinkToken(userId, { walletFile: file, now });
  const limiter = createMemoryRateLimiter();
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile: file, now: now + 1, rateLimiter: limiter }
  );
  const verified = verifyWalletSignature(
    {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    },
    { walletFile: file, now: now + 2, rateLimiter: limiter }
  );
  assert.strictEqual(verified.ok, true, verified.error);
  return verified;
}

function pointsOf(file, userId) {
  const user = loadPoints(file).users[String(userId)];
  return user && typeof user.points === "number" ? user.points : 0;
}

function joinUpdate(options) {
  const userId = options.userId;
  return {
    chat: { id: options.chatId == null ? Number(COMMUNITY_CHAT) : options.chatId },
    from: { id: Number(userId), is_bot: Boolean(options.isBot), first_name: options.name || "Bob" },
    old_chat_member: {
      status: options.oldStatus || "left",
      user: { id: Number(userId), is_bot: Boolean(options.isBot), first_name: options.name || "Bob" },
    },
    new_chat_member: {
      status: options.newStatus || "member",
      user: {
        id: Number(userId),
        is_bot: Boolean(options.isBot),
        first_name: options.name || "Bob",
        username: options.username,
      },
    },
    invite_link: options.inviteLink
      ? { invite_link: options.inviteLink }
      : options.inviteLink === null
        ? undefined
        : undefined,
  };
}

async function seedInvite(h, user = { id: INVITER, first_name: "Alice" }) {
  const created = await getOrCreateInviteLink(user, h.opts);
  assert.strictEqual(created.ok, true, created.message);
  return created;
}

function mockCtx(extra = {}) {
  const replies = [];
  const edits = [];
  return {
    chat: { type: extra.chatType || "private", id: extra.chatId || 1 },
    from: {
      id: extra.userId || Number(INVITER),
      first_name: extra.name || "Alice",
      is_bot: false,
    },
    botInfo: { username: "ManGoTestBot", id: 55 },
    telegram: extra.telegram || {},
    startPayload: extra.startPayload,
    callbackQuery: extra.callbackData ? { data: extra.callbackData } : undefined,
    replies,
    edits,
    reply(text, extraArg) {
      replies.push({ text, extra: extraArg });
      return Promise.resolve();
    },
    editMessageText(text, extraArg) {
      edits.push({ text, extra: extraArg });
      return Promise.resolve();
    },
    answerCbQuery() {
      return Promise.resolve();
    },
  };
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

async function main() {
  await runTest("1. member requests personal invite", async () => {
    const h = harness();
    const created = await seedInvite(h);
    assert.ok(created.inviteUrl.startsWith("https://t.me/+"));
    assert.ok(!created.inviteUrl.includes(INVITER));
  });

  await runTest("2. link belongs to member", async () => {
    const h = harness();
    const created = await seedInvite(h);
    const store = loadBuilderStore(h.storeFile);
    const id = inviteIdentity(created.inviteUrl);
    assert.strictEqual(store.inviteLinks[id].inviterUserId, INVITER);
  });

  await runTest("3. repeat request reuses active link", async () => {
    const h = harness();
    const first = await seedInvite(h);
    const second = await getOrCreateInviteLink({ id: INVITER, first_name: "Alice" }, h.opts);
    assert.strictEqual(second.reused, true);
    assert.strictEqual(second.inviteUrl, first.inviteUrl);
    assert.strictEqual(h.createCalls(), 1);
  });

  await runTest("4. bot lacks invite permission → clean error", async () => {
    const h = harness();
    const result = await getOrCreateInviteLink(
      { id: INVITER, first_name: "Alice" },
      {
        ...h.opts,
        botId: 55,
        getChatMember: async () => ({
          status: "administrator",
          can_invite_users: false,
        }),
      }
    );
    assert.strictEqual(result.ok, false);
    assert.ok(String(result.message).includes("invite"));
    assert.ok(!String(result.message).toLowerCase().includes("crash"));
  });

  await runTest("5-8. valid invite join awards BP and gated XP", async () => {
    const h = harness();
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    const joined = handleChatMemberUpdate(
      joinUpdate({
        userId: REFERRED,
        name: "Bob",
        inviteLink: created.inviteUrl,
      }),
      h.opts
    );
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(joined.builderPointsAwarded, 1);
    assert.strictEqual(joined.xpAwarded, true);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 1);
    assert.strictEqual(pointsOf(h.pointsFile, INVITER), 1);

    const h2 = harness();
    const created2 = await seedInvite(h2);
    const locked = handleChatMemberUpdate(
      joinUpdate({
        userId: REFERRED,
        name: "Bob",
        inviteLink: created2.inviteUrl,
      }),
      h2.opts
    );
    assert.strictEqual(locked.ok, true);
    assert.strictEqual(builderSummary(INVITER, h2.opts).builderPoints, 1);
    assert.strictEqual(pointsOf(h2.pointsFile, INVITER), 0);
    assert.strictEqual(locked.xpAwarded, false);
    assert.ok(h2.notifications.some((row) => row.payload.walletLocked));
  });

  await runTest("9. self-referral reject", async () => {
    const h = harness();
    const created = await seedInvite(h);
    const result = handleChatMemberUpdate(
      joinUpdate({
        userId: INVITER,
        name: "Alice",
        inviteLink: created.inviteUrl,
      }),
      h.opts
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, JOIN_EVENT.SELF_REFERRAL);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 0);
  });

  await runTest("10. bot join reject", async () => {
    const h = harness();
    const created = await seedInvite(h);
    const result = handleChatMemberUpdate(
      joinUpdate({
        userId: "777",
        isBot: true,
        inviteLink: created.inviteUrl,
      }),
      h.opts
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "bot");
  });

  await runTest("11. public/non-referral join no attribution", async () => {
    const h = harness();
    await seedInvite(h);
    const result = handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, name: "Bob", inviteLink: null }),
      h.opts
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "public-join");
    assert.strictEqual(builderSummary(INVITER, h.opts).validReferrals, 0);
  });

  await runTest("12-13. duplicate update and leave/rejoin no extra points", async () => {
    const h = harness();
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    const first = handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created.inviteUrl }),
      h.opts
    );
    const dup = handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created.inviteUrl }),
      h.opts
    );
    const rejoin = handleChatMemberUpdate(
      joinUpdate({
        userId: REFERRED,
        oldStatus: "left",
        inviteLink: created.inviteUrl,
      }),
      h.opts
    );
    assert.strictEqual(first.ok, true);
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.reason, JOIN_EVENT.ALREADY_REFERRED);
    assert.strictEqual(rejoin.ok, false);
    assert.strictEqual(rejoin.reason, JOIN_EVENT.ALREADY_REFERRED);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 1);
    assert.strictEqual(pointsOf(h.pointsFile, INVITER), 1);
  });

  await runTest("14. second inviter cannot steal referral", async () => {
    const h = harness();
    const a = await seedInvite(h, { id: INVITER, first_name: "Alice" });
    const b = await getOrCreateInviteLink({ id: OTHER, first_name: "Lojay" }, {
      ...h.opts,
      createChatInviteLink: async () => ({ invite_link: "https://t.me/+otherhash" }),
    });
    handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: a.inviteUrl }),
      h.opts
    );
    const steal = handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: b.inviteUrl }),
      h.opts
    );
    assert.strictEqual(steal.ok, false);
    assert.strictEqual(steal.reason, JOIN_EVENT.ALREADY_REFERRED);
    const store = loadBuilderStore(h.storeFile);
    assert.strictEqual(store.referrals[REFERRED].inviterUserId, INVITER);
    assert.strictEqual(builderSummary(OTHER, h.opts).builderPoints, 0);
  });

  await runTest("admin/dev inviter earns BP, 0 XP, appears on leaderboard", async () => {
    const h = harness();
    assert.strictEqual(isCommunityCompetitionExcluded(ADMIN_ID), true);
    registerManualWallet(ADMIN_ID, generateSolanaWallet().address, h.walletFile);
    const created = await getOrCreateInviteLink(
      { id: ADMIN_ID, first_name: "Kevin" },
      h.opts
    );
    const joined = handleChatMemberUpdate(
      joinUpdate({
        userId: REFERRED,
        name: "Bob",
        inviteLink: created.inviteUrl,
      }),
      h.opts
    );
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(joined.reason, JOIN_EVENT.ATTRIBUTED);
    assert.strictEqual(joined.builderPointsAwarded, 1);
    assert.strictEqual(joined.xpAwarded, false);
    assert.strictEqual(joined.xpReason, "excluded");
    assert.strictEqual(builderSummary(ADMIN_ID, h.opts).builderPoints, 1);
    assert.strictEqual(pointsOf(h.pointsFile, ADMIN_ID), 0);
    const board = getBuilderLeaderboard(h.opts);
    assert.ok(board.some((row) => row.displayName === "Kevin" && row.points === 1));
    assert.ok(!leaderboardText(board).includes(ADMIN_ID));
  });

  await runTest("Telegram group-admin inviter earns BP", async () => {
    const h = harness();
    const created = await getOrCreateInviteLink(
      { id: GROUP_ADMIN, first_name: "Mod" },
      h.opts
    );
    const joined = handleChatMemberUpdate(
      joinUpdate({
        userId: "5005",
        name: "NewMember",
        inviteLink: created.inviteUrl,
      }),
      h.opts
    );
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(builderSummary(GROUP_ADMIN, h.opts).builderPoints, 1);
    assert.ok(
      getBuilderLeaderboard(h.opts).some((row) => row.displayName === "Mod")
    );
  });

  await runTest("prior group member never attributed: invite rejoin awards BP", async () => {
    const h = harness();
    const created = await seedInvite(h);
    const firstSeen = handleChatMemberUpdate(
      joinUpdate({ userId: "6006", name: "Returning", inviteLink: null }),
      h.opts
    );
    assert.strictEqual(firstSeen.reason, JOIN_EVENT.PUBLIC_JOIN);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 0);
    const viaInvite = handleChatMemberUpdate(
      joinUpdate({
        userId: "6006",
        name: "Returning",
        oldStatus: "left",
        inviteLink: created.inviteUrl,
      }),
      h.opts
    );
    assert.strictEqual(viaInvite.ok, true);
    assert.strictEqual(viaInvite.reason, JOIN_EVENT.ATTRIBUTED);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 1);
  });

  await runTest("game XP admin exclusion unchanged", async () => {
    const h = harness();
    registerManualWallet(ADMIN_ID, generateSolanaWallet().address, h.walletFile);
    const bomb = awardMangoBombXp(
      ADMIN_ID,
      "Kevin",
      1,
      "round-admin",
      h.pointsFile,
      h.walletFile
    );
    assert.strictEqual(bomb.awarded, false);
    assert.strictEqual(bomb.reason, "excluded");
    const daily = awardDailyActivityPoint(
      ADMIN_ID,
      "Kevin",
      h.pointsFile,
      undefined,
      h.walletFile
    );
    assert.strictEqual(daily.awarded, false);
    assert.strictEqual(daily.reason, "excluded");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "services", "communityBuilder.js"),
      "utf8"
    );
    assert.ok(!src.includes("isCommunityCompetitionExcluded"));
  });

  await runTest("15-18. wallet milestone once across manual/verify/reconnect", async () => {
    const h = harness();
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created.inviteUrl }),
      h.opts
    );
    const beforeBp = builderSummary(INVITER, h.opts).builderPoints;
    const beforeXp = pointsOf(h.pointsFile, INVITER);
    const wallet = generateSolanaWallet();
    const manual = registerManualWallet(REFERRED, wallet.address, h.walletFile);
    assert.strictEqual(manual.ok, true);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, beforeBp + 1);
    assert.strictEqual(pointsOf(h.pointsFile, INVITER), beforeXp + 1);

    verifyUser(h.walletFile, REFERRED, wallet, 5000);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, beforeBp + 1);

    disconnectWallet(REFERRED, h.walletFile);
    registerManualWallet(REFERRED, generateSolanaWallet().address, h.walletFile);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, beforeBp + 1);
    assert.strictEqual(tryWalletMilestone(REFERRED, h.opts).reason, "already-claimed");
  });

  await runTest("19-21. active milestone +2 BP exactly once, concurrent safe", async () => {
    const h = harness();
    const created = await seedInvite(h);
    handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created.inviteUrl }),
      h.opts
    );
    mutatePoints((data) => {
      data.users[REFERRED] = {
        name: "Bob",
        points: 4,
        weeklyPoints: 0,
        weekId: "2026-08-17",
        triggerDate: null,
        triggersUsed: [],
        activityDate: null,
      };
    }, h.pointsFile);
    const before = builderSummary(INVITER, h.opts).builderPoints;
    mutatePoints((data) => {
      data.users[REFERRED].points = 5;
    }, h.pointsFile);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, before + 2);
    assert.strictEqual(pointsOf(h.pointsFile, INVITER), 0);

    mutatePoints((data) => {
      data.users[REFERRED].points = 9;
    }, h.pointsFile);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, before + 2);

    const h2 = harness();
    const created2 = await seedInvite(h2);
    handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created2.inviteUrl }),
      h2.opts
    );
    const [a, b] = await Promise.all([
      Promise.resolve(tryActiveMilestone(REFERRED, h2.opts)),
      Promise.resolve(tryActiveMilestone(REFERRED, h2.opts)),
    ]);
    const wins = [a, b].filter((row) => row.ok).length;
    const misses = [a, b].filter((row) => row.reason === "already-claimed").length;
    assert.strictEqual(wins, 1);
    assert.strictEqual(misses, 1);
    assert.strictEqual(ACTIVE_LIFETIME_XP, 5);
  });

  await runTest("22-25. builderboard sorted, ties deterministic, XP board unchanged", async () => {
    const h = harness();
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 10,
        referralIds: ["1", "2"],
        displayName: "Kevin",
        createdAt: 20,
        activeInviteId: null,
      };
      store.builders[OTHER] = {
        points: 10,
        referralIds: ["3"],
        displayName: "Alice",
        createdAt: 10,
        activeInviteId: null,
      };
      store.builders[REFERRED] = {
        points: 8,
        referralIds: [],
        displayName: "Lojay",
        createdAt: 5,
        activeInviteId: null,
      };
      store.referrals["1"] = {
        inviterUserId: INVITER,
        joinedAt: 1,
        inviteId: "x",
        displayName: "a",
        walletMilestoneAt: 1,
        activeMilestoneAt: 1,
      };
      store.referrals["2"] = {
        inviterUserId: INVITER,
        joinedAt: 1,
        inviteId: "x",
        displayName: "b",
        walletMilestoneAt: null,
        activeMilestoneAt: null,
      };
      store.referrals["3"] = {
        inviterUserId: OTHER,
        joinedAt: 1,
        inviteId: "y",
        displayName: "c",
        walletMilestoneAt: null,
        activeMilestoneAt: null,
      };
    }, h.storeFile);
    const board = getBuilderLeaderboard(h.opts);
    assert.strictEqual(board[0].displayName, "Kevin");
    assert.strictEqual(board[1].displayName, "Alice");
    assert.strictEqual(board[2].displayName, "Lojay");
    const text = leaderboardText(board);
    assert.ok(text.includes("BP"));
    assert.ok(!text.includes("pts"));
    assert.ok(!text.includes(INVITER));
    assert.ok(!/wallet/i.test(text));

    mutatePoints((data) => {
      data.users[INVITER] = { name: "Kevin", points: 3, weeklyPoints: 0 };
      data.users[OTHER] = { name: "Alice", points: 9, weeklyPoints: 0 };
    }, h.pointsFile);
    const xpTop = getLbTop(loadPoints(h.pointsFile).users);
    assert.strictEqual(xpTop[0].name, "Alice");
    assert.strictEqual(xpTop[0].points, 9);
    const xpText = formatLifetimeLines(xpTop, () => ({ emoji: "🌱", title: "Seed" })).join("\n");
    assert.ok(!xpText.includes("BP"));
  });

  await runTest("26-28. my referrals milestones, no leak, pagination", async () => {
    const h = harness();
    mutateBuilderStore((store) => {
      store.builders[INVITER] = {
        points: 4,
        referralIds: [],
        displayName: "Alice",
        createdAt: 1,
        activeInviteId: null,
      };
      for (let i = 0; i < 21; i += 1) {
        const id = String(4000 + i);
        store.referrals[id] = {
          inviterUserId: INVITER,
          joinedAt: i + 1,
          inviteId: "h",
          displayName: `User${i}`,
          walletMilestoneAt: i === 0 ? 2 : null,
          activeMilestoneAt: i === 0 ? 3 : null,
        };
      }
    }, h.storeFile);
    const page0 = paginateReferrals(INVITER, 0, h.opts);
    const page1 = paginateReferrals(INVITER, 1, h.opts);
    assert.strictEqual(REFERRALS_PAGE_SIZE, 20);
    assert.strictEqual(page0.rows.length, 20);
    assert.strictEqual(page1.rows.length, 1);
    assert.strictEqual(page0.rows[0].wallet, true);
    assert.strictEqual(page0.rows[0].active, true);
    const text = referralsText(page0);
    assert.ok(text.includes("Joined"));
    assert.ok(text.includes("Wallet"));
    assert.ok(text.includes("Active"));
    assert.ok(!text.includes("4000"));
    assert.ok(!/wallet address|So[1-9A-HJ-NP-Za-km-z]{20,}/.test(text));
  });

  await runTest("29-32. security: no client inviter, fake invite, wrong chat, bots", async () => {
    const h = harness();
    const created = await seedInvite(h);
    const fake = handleChatMemberUpdate(
      joinUpdate({
        userId: REFERRED,
        inviteLink: "https://t.me/+not-a-real-hash",
      }),
      h.opts
    );
    assert.strictEqual(fake.reason, "unknown-invite");
    const wrong = handleChatMemberUpdate(
      joinUpdate({
        userId: REFERRED,
        chatId: Number(OTHER_CHAT),
        inviteLink: created.inviteUrl,
      }),
      h.opts
    );
    assert.strictEqual(wrong.reason, "wrong-chat");
    const supplied = applyJoinAttribution(
      {
        userId: REFERRED,
        chatId: COMMUNITY_CHAT,
        isBot: false,
        oldStatus: "left",
        newStatus: "member",
        inviteLink: created.inviteUrl,
        inviterUserId: OTHER,
        displayName: "Bob",
      },
      h.opts
    );
    assert.strictEqual(supplied.ok, true);
    assert.strictEqual(supplied.inviterUserId, INVITER);
    assert.notStrictEqual(supplied.inviterUserId, OTHER);
    const bot = handleChatMemberUpdate(
      joinUpdate({ userId: "8", isBot: true, inviteLink: created.inviteUrl }),
      h.opts
    );
    assert.strictEqual(bot.reason, "bot");
  });

  await runTest("33. production files untouched", () => {
    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
    }
  });

  await runTest("34-36. XP gate, wallet linking, games XP unchanged", async () => {
    const h = harness();
    assert.strictEqual(canEarnXp(INVITER, h.walletFile), false);
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    assert.strictEqual(canEarnXp(INVITER, h.walletFile), true);
    const bomb = awardMangoBombXp(INVITER, "Alice", 1, "round-1", h.pointsFile, h.walletFile);
    assert.strictEqual(bomb.awarded, true);
    assert.strictEqual(bomb.pointsToAdd, 1);
  });

  await runTest("37-38. Mystery Gift / presale files not used by builder store", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "services", "communityBuilder.js"),
      "utf8"
    );
    assert.ok(!src.includes("member-rewards"));
    assert.ok(!src.includes("presale"));
    assert.ok(!src.includes("mysteryGift"));
    assert.deepStrictEqual(BUILDER_RANK_THRESHOLDS, [5, 10, 25, 50, 100]);
    assert.deepStrictEqual(builderRankInsertionPoint(4, 5), [5]);
    assert.deepStrictEqual(builderRankInsertionPoint(5, 9), []);
  });

  await runTest("full 4 BP / 2 XP model for active referral", async () => {
    const h = harness();
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created.inviteUrl }),
      h.opts
    );
    registerManualWallet(REFERRED, generateSolanaWallet().address, h.walletFile);
    mutatePoints((data) => {
      if (!data.users[REFERRED]) {
        data.users[REFERRED] = { name: "Bob", points: 0, weeklyPoints: 0 };
      }
      data.users[REFERRED].points = 5;
    }, h.pointsFile);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 4);
    assert.strictEqual(pointsOf(h.pointsFile, INVITER), 2);
  });

  await runTest("menu private hub + group redirect + start payload", async () => {
    const h = harness();
    const privateCtx = mockCtx({ chatType: "private", userId: Number(INVITER) });
    handleCommunityBuilder(privateCtx, h.opts);
    assert.ok(privateCtx.replies[0].text.includes("Community Builder"));
    assert.ok(privateCtx.replies[0].text.includes("Builder Points:"));
    const homeButtons = JSON.stringify(privateCtx.replies[0].extra);
    assert.ok(homeButtons.includes("🏆 Open Builder Board"));
    assert.ok(homeButtons.includes(BUILDER_CALLBACK.OPEN_BOARD));
    assert.ok(homeButtons.includes("🏆 Builder Leaderboard"));
    assert.ok(homeButtons.includes(BUILDER_CALLBACK.BOARD));
    const groupCtx = mockCtx({ chatType: "supergroup", chatId: Number(COMMUNITY_CHAT) });
    handleCommunityBuilder(groupCtx, h.opts);
    assert.strictEqual(groupCtx.replies[0].text, GROUP_BUILDER_TEXT);
    const startCtx = mockCtx({ chatType: "private", startPayload: "builder" });
    handleStart(startCtx, h.opts);
    assert.ok(startCtx.replies[0].text.includes("Community Builder"));
    const rows = getPrivateMenuKeyboard().reply_markup.keyboard;
    assert.ok(rows.some((row) => row.includes(MENU_LABELS.COMMUNITY_BUILDER)));
    const groupMenu = getGroupMenuExtra(mockCtx({ chatType: "group" }));
    const labels = groupMenu.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.includes("🤝 Community Builder"));
    assert.ok(labels.includes("🎯 Daily Quest"));
    assert.ok(labels.includes("🏪 ManGo Shop"));
    assert.ok(TELEGRAM_ALLOWED_UPDATES.includes("chat_member"));
  });

  await runTest("builderstats admin private; invite URLs not shown", async () => {
    const h = harness();
    const created = await seedInvite(h);
    handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created.inviteUrl, name: "Bob" }),
      h.opts
    );
    const admin = mockCtx({ chatType: "private", userId: Number(ADMIN_ID) });
    handleBuilderStats(admin, h.opts);
    const text = admin.replies[0].text;
    assert.ok(text.includes("Unique referrals: 1"));
    assert.ok(!text.includes("t.me/+"));
    const other = mockCtx({ chatType: "private", userId: Number(INVITER) });
    handleBuilderStats(other, h.opts);
    assert.strictEqual(other.replies.length, 0);
  });

  await runTest("restart persistence: no duplicate rewards", async () => {
    const h = harness();
    registerManualWallet(INVITER, generateSolanaWallet().address, h.walletFile);
    const created = await seedInvite(h);
    handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created.inviteUrl }),
      h.opts
    );
    const store = loadBuilderStore(h.storeFile);
    assert.ok(store.referrals[REFERRED]);
    const again = handleChatMemberUpdate(
      joinUpdate({ userId: REFERRED, inviteLink: created.inviteUrl }),
      h.opts
    );
    assert.strictEqual(again.ok, false);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 1);
  });

  await runTest("invite identity never embeds telegram uid", () => {
    assert.strictEqual(inviteIdentity("https://t.me/+AbC_12"), "AbC_12");
    assert.ok(!inviteIdentity("https://t.me/+AbC_12").includes("1001"));
  });

  await runTest("corrupt builder JSON fails closed on mutate", () => {
    const file = path.join(tempDir, "corrupt.json");
    fs.writeFileSync(file, "{not-json", "utf8");
    assert.throws(() => {
      mutateBuilderStore((store) => {
        store.builders.x = { points: 1 };
      }, file);
    });
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{not-json");
  });

  await runTest("onLifetimeXpMutated ignores non-referrals", () => {
    const h = harness();
    onLifetimeXpMutated({ 1: 0 }, { 1: 9 }, h.opts);
    assert.strictEqual(builderSummary(INVITER, h.opts).builderPoints, 0);
  });

  await runTest("group menu builder callback redirects privately", async () => {
    const ctx = mockCtx({
      chatType: "group",
      chatId: Number(COMMUNITY_CHAT),
      callbackData: GROUP_MENU_CALLBACK.BUILDER,
    });
    await handleGroupMenuCallback(ctx);
    assert.ok(ctx.replies[0].text.includes("privately"));
  });

  await runTest("builder callback invite does not log URL", async () => {
    const h = harness();
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const ctx = mockCtx({ chatType: "private", userId: Number(INVITER) });
      ctx.callbackQuery = { data: BUILDER_CALLBACK.INVITE };
      await handleBuilderCallback(ctx, {
        ...h.opts,
        createChatInviteLink: async () => ({ invite_link: "https://t.me/+secretLink" }),
      });
      assert.ok(ctx.edits[0].text.includes("https://t.me/+secretLink"));
      assert.ok(logs.every((line) => !line.includes("secretLink")));
    } finally {
      console.log = originalLog;
    }
  });

  for (const file of prodRoots) {
    if (!fs.existsSync(file)) continue;
    assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
  }
}

main()
  .then(() => {
    configureCommunityBuilderForTests({});
    setCommunityBuilderFileForTests(null);
    setWalletFileForTests(null);
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll community-builder tests passed.");
  })
  .catch((err) => {
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    console.error(err);
    process.exit(1);
  });
