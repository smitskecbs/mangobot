/**
 * Phase 2 Control Center — admin-only private dashboard.
 * Run: node tests/phase2-control-center.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const {
  MENU_LABELS,
  getPrivateMenuKeyboard,
  getGroupMenuExtra,
} = require("../utils/botMenu");
const { handleMenu } = require("../commands/menu");
const {
  handlePhase2Open,
  handlePhase2Callback,
  handlePhase2Menu,
} = require("../commands/phase2");
const { getPendingDeliverInput, pickerKeyboard } = require("../commands/deliver");
const {
  mutatePoints,
  loadPoints,
  getWeekId,
  getTodayDate,
  getRank,
  isAdmin,
} = require("../services/points");
const { getWeeklyTop, getWeeklyRanked } = require("../services/leaderboard");
const {
  configureCommunityBuilderForTests,
  getBuilderLeaderboard,
} = require("../services/communityBuilder");
const { mutateBuilderStore: mutateBuilder } = require("../services/communityBuilderStore");
const {
  createReward,
  mutateRewardsStore,
  listRewardsForUser,
  loadRewardsStore,
} = require("../services/memberRewards");
const { registerManualWallet, setWalletFileForTests } = require("../services/walletLinks");
const {
  PHASE2_CALLBACK,
  CANDIDATE_ORDER,
  REJECT_TEXT,
  PAGE_SIZE,
  resetPhase2Sessions,
  expirePhase2Sessions,
  collectCallbackData,
  collectXpLeaders,
  collectCandidates,
  collectActiveMembers,
  rewardStats,
  loadMemberDetail,
  weeklyPointsAt,
} = require("../services/phase2ControlCenter");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-phase2-"));
const ADMIN_ID = "9001";
const MEMBER_ID = "8001";
const ALICE = "1001";
const BOB = "1002";
const LOJAY = "1003";
const KEVIN = "1004";
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const WEEK_ID = getWeekId(new Date(NOW));
const TODAY = getTodayDate(new Date(NOW));

const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = ADMIN_ID;

const PROD_POINTS = path.resolve(__dirname, "..", "points.json");
const PROD_WALLETS = path.resolve(__dirname, "..", "data", "wallet-links.json");
const PROD_BUILDERS = path.resolve(__dirname, "..", "data", "community-builders.json");
const PROD_REWARDS = path.resolve(__dirname, "..", "data", "member-rewards.json");
const PROD_SHOP = path.resolve(__dirname, "..", "data", "mango-shop.json");

let n = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function generateSolanaWallet() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return encodeBase58(publicKeyRaw);
}

function putBuilderEvent(storeFile, event) {
  mutateBuilder((store) => {
    if (!store.builderEvents) {
      store.builderEvents = {};
    }
    store.builderEvents[event.eventId] = event;
    if (!store.builders[event.builderUserId]) {
      store.builders[event.builderUserId] = {
        points: 0,
        referralIds: [],
        displayName: event.displayName || "Member",
        createdAt: event.createdAt,
        activeInviteId: null,
      };
    }
    store.builders[event.builderUserId].points =
      (store.builders[event.builderUserId].points || 0) + (event.points || 0);
    if (event.displayName) {
      store.builders[event.builderUserId].displayName = event.displayName;
    }
  }, storeFile);
}

function seedUser(pointsFile, userId, spec) {
  mutatePoints((data) => {
    data.users[String(userId)] = {
      name: spec.name,
      points: spec.points || 0,
      weeklyPoints: spec.weeklyPoints || 0,
      weekId: spec.weekId === undefined ? WEEK_ID : spec.weekId,
      streak: {
        current: spec.streak || 0,
        longest: spec.streak || 0,
        lastActiveDate: spec.lastActiveDate || null,
      },
    };
  }, pointsFile);
}

function mockCtx({
  chatType = "private",
  userId = Number(ADMIN_ID),
  callbackData,
  chatId,
} = {}) {
  const replies = [];
  const edits = [];
  const answered = [];
  return {
    chat: {
      type: chatType,
      id: chatId !== undefined ? chatId : chatType === "private" ? userId : -1003916996602,
    },
    from: { id: userId, first_name: "Admin" },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    replies,
    edits,
    answered,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve();
    },
    answerCbQuery(text) {
      answered.push(text === undefined ? true : text);
      return Promise.resolve();
    },
  };
}

function viewText(ctx) {
  const last = ctx.edits[ctx.edits.length - 1] || ctx.replies[ctx.replies.length - 1];
  return last && last.text ? last.text : "";
}

function viewExtra(ctx) {
  const last = ctx.edits[ctx.edits.length - 1] || ctx.replies[ctx.replies.length - 1];
  return last && last.extra;
}

function allCallbackData(ctx) {
  return collectCallbackData(viewExtra(ctx));
}

function findButton(ctx, label) {
  const extra = viewExtra(ctx);
  const rows =
    extra && extra.reply_markup && extra.reply_markup.inline_keyboard
      ? extra.reply_markup.inline_keyboard
      : [];
  for (const row of rows) {
    for (const button of row) {
      if (button && button.text === label) {
        return button;
      }
    }
  }
  return null;
}

function assertNoSecrets(text, extra, wallets = []) {
  const blob = `${text}\n${JSON.stringify(extra || {})}`;
  assert.ok(!blob.includes(ALICE));
  assert.ok(!blob.includes(BOB));
  assert.ok(!blob.includes(LOJAY));
  assert.ok(!blob.includes(KEVIN));
  assert.ok(!blob.includes(ADMIN_ID));
  assert.ok(!blob.includes(MEMBER_ID));
  assert.ok(!/winner/i.test(blob));
  for (const wallet of wallets) {
    assert.ok(!blob.includes(wallet));
  }
  for (const data of collectCallbackData(extra)) {
    assert.ok(!data.includes(ALICE), data);
    assert.ok(!data.includes(BOB), data);
    assert.ok(!/^\d{5,}$/.test(data.replace(/^p2:[a-z]+:/, "")));
  }
}

function harness() {
  n += 1;
  resetPhase2Sessions();
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  const rewardsFile = path.join(tempDir, `rewards-${n}.json`);
  const storeFile = path.join(tempDir, `builder-${n}.json`);
  const shopFile = path.join(tempDir, `shop-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(walletFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(rewardsFile, JSON.stringify({ rewards: {}, byUser: {} }, null, 2), "utf8");
  configureCommunityBuilderForTests({ storeFile, now: NOW });
  setWalletFileForTests(walletFile);

  const aliceWallet = generateSolanaWallet();
  const bobWallet = generateSolanaWallet();
  const lojayWallet = generateSolanaWallet();

  seedUser(pointsFile, ALICE, {
    name: "Alice",
    points: 143,
    weeklyPoints: 18,
    streak: 5,
    lastActiveDate: TODAY,
  });
  seedUser(pointsFile, BOB, {
    name: "Bob",
    points: 40,
    weeklyPoints: 15,
    streak: 4,
    lastActiveDate: TODAY,
  });
  seedUser(pointsFile, LOJAY, {
    name: "Lojay",
    points: 30,
    weeklyPoints: 12,
    streak: 6,
    lastActiveDate: TODAY,
  });
  seedUser(pointsFile, KEVIN, {
    name: "Kevin",
    points: 10,
    weeklyPoints: 0,
  });
  seedUser(pointsFile, ADMIN_ID, {
    name: "Owner",
    points: 900,
    weeklyPoints: 50,
    streak: 7,
    lastActiveDate: TODAY,
  });

  registerManualWallet(ALICE, aliceWallet, walletFile, NOW);
  registerManualWallet(BOB, bobWallet, walletFile, NOW);
  registerManualWallet(LOJAY, lojayWallet, walletFile, NOW);

  putBuilderEvent(storeFile, {
    eventId: "alice-week",
    builderUserId: ALICE,
    points: 8,
    createdAt: NOW,
    displayName: "Alice",
  });
  putBuilderEvent(storeFile, {
    eventId: "kevin-week",
    builderUserId: KEVIN,
    points: 6,
    createdAt: NOW,
    displayName: "Kevin",
  });
  putBuilderEvent(storeFile, {
    eventId: "bob-week",
    builderUserId: BOB,
    points: 4,
    createdAt: NOW,
    displayName: "Bob",
  });
  mutateBuilder((store) => {
    store.referrals = store.referrals || {};
    store.referrals["r-alice"] = {
      inviterUserId: ALICE,
      displayName: "Ref",
      activeMilestoneAt: NOW,
    };
    if (store.builders[ALICE]) {
      store.builders[ALICE].points = 14;
    }
  }, storeFile);

  const opts = {
    pointsFile,
    walletFile,
    rewardsFile,
    storeFile,
    shopFile,
    now: NOW,
  };

  return {
    opts,
    pointsFile,
    walletFile,
    rewardsFile,
    storeFile,
    shopFile,
    wallets: [aliceWallet, bobWallet, lojayWallet],
  };
}

function assertHarnessIsolated(h) {
  assert.notStrictEqual(path.resolve(h.pointsFile), PROD_POINTS);
  assert.notStrictEqual(path.resolve(h.walletFile), PROD_WALLETS);
  assert.notStrictEqual(path.resolve(h.storeFile), PROD_BUILDERS);
  assert.notStrictEqual(path.resolve(h.rewardsFile), PROD_REWARDS);
  assert.notStrictEqual(path.resolve(h.shopFile), PROD_SHOP);
  for (const file of [h.pointsFile, h.walletFile, h.rewardsFile, h.storeFile, h.shopFile]) {
    assert.ok(file.startsWith(tempDir), file);
  }
}

async function main() {
  await runTest("1. admin sees menu button", () => {
  const kb = getPrivateMenuKeyboard({ from: { id: Number(ADMIN_ID) } });
  const rows = kb.reply_markup.keyboard;
  assert.ok(rows.some((row) => row.includes(MENU_LABELS.ADMIN)));
  assert.ok(rows.every((row) => !row.includes(MENU_LABELS.PHASE2)));
  const ctx = mockCtx({ chatType: "private", userId: Number(ADMIN_ID) });
  handleMenu(ctx);
  const menuRows = ctx.replies[0].extra.reply_markup.keyboard;
  assert.ok(menuRows.some((row) => row.includes(MENU_LABELS.ADMIN)));
});

  await runTest("2. normal member does not see button", () => {
  const kb = getPrivateMenuKeyboard({ from: { id: Number(MEMBER_ID) } });
  const rows = kb.reply_markup.keyboard;
  assert.ok(rows.every((row) => !row.includes(MENU_LABELS.ADMIN)));
  assert.ok(rows.every((row) => !row.includes(MENU_LABELS.PHASE2)));
  const ctx = mockCtx({ chatType: "private", userId: Number(MEMBER_ID) });
  handleMenu(ctx);
  const menuRows = ctx.replies[0].extra.reply_markup.keyboard;
  assert.ok(menuRows.every((row) => !row.includes(MENU_LABELS.ADMIN)));
  assert.ok(menuRows.every((row) => !row.includes(MENU_LABELS.PHASE2)));
  const group = getGroupMenuExtra(mockCtx({ chatType: "group" }));
  const labels = group.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(!labels.includes(MENU_LABELS.ADMIN));
  assert.ok(!labels.includes(MENU_LABELS.PHASE2));
});

  await runTest("3. non-admin crafted callback rejected", async () => {
  const h = harness();
  const ctx = mockCtx({
    chatType: "private",
    userId: Number(MEMBER_ID),
    callbackData: PHASE2_CALLBACK.HOME,
  });
  await handlePhase2Callback(ctx, h.opts);
  assert.ok(ctx.answered.includes(REJECT_TEXT));
  assert.strictEqual(ctx.edits.length, 0);
  assert.ok(ctx.replies.every((row) => !String(row.text).includes("Control Center")));
});

  await runTest("4. group invocation rejected", async () => {
  const h = harness();
  const open = mockCtx({ chatType: "supergroup", userId: Number(ADMIN_ID) });
  await handlePhase2Open(open, h.opts);
  assert.ok(open.replies.every((row) => !String(row.text).includes("XP Leaders")));
  const cb = mockCtx({
    chatType: "supergroup",
    userId: Number(ADMIN_ID),
    callbackData: PHASE2_CALLBACK.HOME,
  });
  await handlePhase2Callback(cb, h.opts);
  assert.ok(cb.edits.length === 0);
  assert.ok(cb.replies.every((row) => !String(row.text).includes("XP Leaders")));
});

  await runTest("5. private admin works", async () => {
  const h = harness();
  const ctx = mockCtx();
  await handlePhase2Open(ctx, h.opts);
  assert.ok(viewText(ctx).includes("🚀 Phase 2 Control Center"));
  assert.ok(findButton(ctx, "🏆 XP Leaders"));
  assert.ok(findButton(ctx, "➕ Create Reward"));
});

  await runTest("5b. leftover Phase 2 keyboard still opens", async () => {
  const h = harness();
  const ctx = mockCtx();
  await handlePhase2Menu(ctx, h.opts);
  assert.ok(viewText(ctx).includes("🚀 Phase 2 Control Center"));
});

  await runTest("6-9. home dashboard uses weekly sources", async () => {
  const h = harness();
  const ctx = mockCtx();
  await handlePhase2Open(ctx, h.opts);
  const text = viewText(ctx);
  assert.ok(text.includes("Owner — 50 XP"));
  assert.ok(text.includes("Alice — 18 XP"));
  assert.ok(text.includes("Bob — 15 XP"));
  assert.ok(!text.includes("Lojay — 12 XP"));
  assert.ok(text.includes("Alice — 8 BP"));
  assert.ok(text.includes("Kevin — 6 BP"));
  assert.ok(text.includes("Bob — 4 BP"));
  assert.ok(text.includes("4 active this week"));
  assert.ok(text.includes("Pending: 0"));
  assert.ok(text.includes("Sent this week: 0"));
  const ranked = getWeeklyRanked(loadPoints(h.pointsFile).users, (user) =>
    weeklyPointsAt(user, NOW)
  );
  assert.strictEqual(ranked[0].name, "Owner");
  assert.strictEqual(ranked[0].weeklyPoints, 50);
  const board = getBuilderLeaderboard({
    period: "weekly",
    now: NOW,
    storeFile: h.storeFile,
  });
  assert.strictEqual(board[0].displayName, "Alice");
  assert.strictEqual(board[0].points, 8);
  assertNoSecrets(text, viewExtra(ctx), h.wallets);
});

  await runTest("10-11. weekly XP view sorted, not all-time", async () => {
  const h = harness();
  const ctx = mockCtx({ callbackData: PHASE2_CALLBACK.XP });
  await handlePhase2Callback(ctx, h.opts);
  const text = viewText(ctx);
  assert.ok(text.includes("🏆 Weekly XP Leaders"));
  assert.ok(text.includes("1. Owner — 50 XP"));
  assert.ok(text.includes("2. Alice — 18 XP"));
  assert.ok(text.includes("3. Bob — 15 XP"));
  assert.ok(!text.includes("143"));
  assert.ok(text.includes("Owner"));
  const top = getWeeklyTop(
    loadPoints(h.pointsFile).users,
    (user) => weeklyPointsAt(user, NOW),
    10
  );
  assert.deepStrictEqual(
    top.map((row) => row.weeklyPoints),
    [50, 18, 15, 12]
  );
});

  await runTest("12-13. weekly BP uses existing helper, no mutation", async () => {
  const h = harness();
  const before = fs.readFileSync(h.storeFile, "utf8");
  const ctx = mockCtx({ callbackData: PHASE2_CALLBACK.BP });
  await handlePhase2Callback(ctx, h.opts);
  const text = viewText(ctx);
  assert.ok(text.includes("🤝 Weekly Builder Leaders"));
  assert.ok(text.includes("Alice — 8 BP"));
  assert.ok(text.includes("Kevin — 6 BP"));
  assert.strictEqual(fs.readFileSync(h.storeFile, "utf8"), before);
  const board = getBuilderLeaderboard({
    period: "weekly",
    now: NOW,
    storeFile: h.storeFile,
  });
  assert.strictEqual(board[1].displayName, "Kevin");
  assert.strictEqual(board[1].points, 6);
});

  await runTest("14-15. active members use reliable fields, no wallet leak", async () => {
  const h = harness();
  const ctx = mockCtx({ callbackData: PHASE2_CALLBACK.ACTIVE });
  await handlePhase2Callback(ctx, h.opts);
  const text = viewText(ctx);
  assert.ok(text.includes("🌱 Active Members"));
  assert.ok(text.includes("Alice"));
  assert.ok(text.includes("Active days: 5"));
  assert.ok(text.includes("Weekly XP: 18"));
  assert.ok(text.includes("Rank: Tree"));
  assert.ok(text.includes("Wallet:"));
  assert.ok(text.includes("Owner"));
  assertNoSecrets(text, viewExtra(ctx), h.wallets);
  const active = collectActiveMembers(h.opts);
  assert.strictEqual(active.length, 4);
  assert.strictEqual(active[0].displayName, "Owner");
});

  await runTest("16-18. candidates ordered, no winner/auto-reward", async () => {
  const h = harness();
  const beforeRewards = loadRewardsStore(h.rewardsFile);
  const ctx = mockCtx({ callbackData: PHASE2_CALLBACK.CANDIDATES });
  await handlePhase2Callback(ctx, h.opts);
  const text = viewText(ctx);
  assert.ok(text.includes("🎯 Weekly Reward Candidates"));
  assert.ok(!/winner/i.test(text));
  const aliceIdx = text.indexOf("Alice");
  const bobIdx = text.indexOf("Bob");
  const lojayIdx = text.indexOf("Lojay");
  assert.ok(aliceIdx < bobIdx && bobIdx < lojayIdx);
  assert.ok(text.includes("Builder BP: 8"));
  assert.ok(text.includes("Referrals active: 1"));
  assert.strictEqual(
    Object.keys(loadRewardsStore(h.rewardsFile).rewards).length,
    Object.keys(beforeRewards.rewards).length
  );
  const ordered = collectCandidates(h.opts);
  assert.deepStrictEqual(
    ordered.map((row) => row.displayName),
    ["Owner", "Alice", "Bob", "Lojay", "Kevin"]
  );
  assert.ok(CANDIDATE_ORDER.includes("weekly XP"));
});

  await runTest("19-23. member detail weekly/all-time, rank, wallet status, rewards", async () => {
  const h = harness();
  const list = mockCtx({ callbackData: PHASE2_CALLBACK.XP });
  await handlePhase2Callback(list, h.opts);
  const aliceBtn = findButton(list, "Alice");
  assert.ok(aliceBtn);
  const detailCtx = mockCtx({ callbackData: aliceBtn.callback_data });
  await handlePhase2Callback(detailCtx, h.opts);
  const text = viewText(detailCtx);
  assert.ok(text.includes("👤 Alice"));
  assert.ok(text.includes("Weekly XP: 18"));
  assert.ok(text.includes("All-time XP: 143"));
  assert.ok(text.includes("Rank: Tree"));
  assert.ok(text.includes("Builder BP this week: 8"));
  assert.ok(text.includes("Builder BP all-time: 14"));
  assert.ok(text.includes("ManGo Loot: 0"));
  assert.ok(text.includes("Active title: None"));
    assert.ok(text.includes("Owned titles: 0"));
    assert.ok(text.includes("Daily Quest: 0/3 today"));
    assert.ok(text.includes("Daily streak: 0"));
  assert.ok(text.includes("Active days this week: 5"));
  assert.ok(text.includes("Wallet: 🟡 Registered") || text.includes("Wallet: 🟢 Verified"));
  assert.ok(text.includes("Pending Mystery Gifts: 0"));
  assert.ok(text.includes("Sent Mystery Gifts: 0"));
  assert.strictEqual(getRank(143).title, "Tree");
  assertNoSecrets(text, viewExtra(detailCtx), h.wallets);
});

  await runTest("24-30. create reward token, stale reject, reuse, no duplicate, deliver", async () => {
  const h = harness();
  const create = mockCtx({ callbackData: PHASE2_CALLBACK.CREATE });
  await handlePhase2Callback(create, h.opts);
  const aliceBtn = findButton(create, "Alice");
  assert.ok(aliceBtn.callback_data.startsWith("p2:gift:"));
  assert.ok(!aliceBtn.callback_data.includes(ALICE));

  const confirm = mockCtx({ callbackData: aliceBtn.callback_data });
  await handlePhase2Callback(confirm, h.opts);
  assert.ok(viewText(confirm).includes("Mystery Gift for Alice"));
  const makeBtn = findButton(confirm, "🎲 Mystery Gift");
  assert.ok(makeBtn.callback_data.startsWith("p2:make:"));

  const made = mockCtx({ callbackData: makeBtn.callback_data });
  await handlePhase2Callback(made, h.opts);
  const createdText = viewText(made);
  assert.ok(createdText.includes("Reward ID:"));
  const rewardId = createdText.match(/Reward ID: ([A-Z0-9_-]+)/)[1];
  assert.ok(rewardId);
  assert.strictEqual(listRewardsForUser(ALICE, h.rewardsFile).length, 1);

  const replay = mockCtx({ callbackData: makeBtn.callback_data });
  await handlePhase2Callback(replay, h.opts);
  assert.strictEqual(listRewardsForUser(ALICE, h.rewardsFile).length, 1);
  assert.ok(viewText(replay).includes(rewardId));

  const deliverBtn = findButton(made, "🚚 Deliver Now");
  assert.ok(deliverBtn.callback_data.startsWith("p2:dlv:"));
  const deliver = mockCtx({ callbackData: deliverBtn.callback_data });
  await handlePhase2Callback(deliver, h.opts);
  assert.ok(viewText(deliver).includes("Choose Mystery Gift type:"));
  const pendingInput = getPendingDeliverInput(ADMIN_ID);
  assert.ok(pendingInput);
  assert.strictEqual(pendingInput.rewardId, rewardId);
  const expectedPicker = pickerKeyboard(rewardId);
  assert.ok(expectedPicker);

  expirePhase2Sessions(NOW + 1);
  const stale = mockCtx({ callbackData: aliceBtn.callback_data });
  await handlePhase2Callback(stale, h.opts);
  assert.ok(viewText(stale).includes("expired"));
  assert.strictEqual(listRewardsForUser(ALICE, h.rewardsFile).length, 1);
});

  await runTest("31-33. reward counts and no tx/wallet/mint leak", async () => {
  const h = harness();
  createReward({
    telegramUserId: ALICE,
    walletFile: h.walletFile,
    rewardsFile: h.rewardsFile,
    now: NOW,
    displayName: "Alice",
  });
  const second = createReward({
    telegramUserId: BOB,
    walletFile: h.walletFile,
    rewardsFile: h.rewardsFile,
    now: NOW,
    displayName: "Bob",
  });
  mutateRewardsStore((store) => {
    const id = second.reward.rewardId;
    store.rewards[id].status = "sent";
    store.rewards[id].sentAt = NOW;
    store.rewards[id].txSignature = "FakeTxSignature111111111111111111111111111111";
    store.rewards[id].mint = "Mint111111111111111111111111111111111111111";
  }, h.rewardsFile);
  const third = createReward({
    telegramUserId: LOJAY,
    walletFile: h.walletFile,
    rewardsFile: h.rewardsFile,
    now: NOW,
    displayName: "Lojay",
  });
  mutateRewardsStore((store) => {
    store.rewards[third.reward.rewardId].status = "delivery-ready";
    store.rewards[third.reward.rewardId].offchainDeliveredAt = NOW;
  }, h.rewardsFile);

  const stats = rewardStats(h.opts);
  assert.strictEqual(stats.pending, 2);
  assert.strictEqual(stats.deliveryReady, 1);
  assert.strictEqual(stats.sentThisWeek, 1);
  assert.strictEqual(stats.offchainThisWeek, 1);

  const ctx = mockCtx({ callbackData: PHASE2_CALLBACK.REWARDS });
  await handlePhase2Callback(ctx, h.opts);
  const text = viewText(ctx);
  assert.ok(text.includes("Pending: 2"));
  assert.ok(text.includes("Delivery-ready: 1"));
  assert.ok(text.includes("Sent this week: 1"));
  assert.ok(text.includes("Off-chain delivered this week: 1"));
  assert.ok(!text.includes("FakeTx"));
  assert.ok(!text.includes("Mint111"));
  assertNoSecrets(text, viewExtra(ctx), h.wallets);
});

  await runTest("34-36. pagination next/prev, no duplicates", async () => {
  const h = harness();
  for (let i = 0; i < 12; i += 1) {
    seedUser(h.pointsFile, String(3000 + i), {
      name: `Member${i}`,
      points: 25 + i,
      weeklyPoints: 20 - i,
      streak: 1,
      lastActiveDate: TODAY,
    });
  }
  const page0 = mockCtx({ callbackData: PHASE2_CALLBACK.XP });
  await handlePhase2Callback(page0, h.opts);
  const names0 = viewText(page0)
    .split("\n")
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => line.replace(/^\d+\. /, "").replace(/ — .*$/, ""));
  assert.strictEqual(names0.length, PAGE_SIZE);
  const next = findButton(page0, "Next ➡️");
  assert.ok(next);
  const page1 = mockCtx({ callbackData: next.callback_data });
  await handlePhase2Callback(page1, h.opts);
  const names1 = viewText(page1)
    .split("\n")
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => line.replace(/^\d+\. /, "").replace(/ — .*$/, ""));
  assert.ok(names1.length > 0);
  const overlap = names0.filter((name) => names1.includes(name));
  assert.deepStrictEqual(overlap, []);
  const prev = findButton(page1, "⬅️ Previous");
  assert.ok(prev);
});

  await runTest("37-40. callback security, no xp/bp browse mutation, no prod files", async () => {
  const h = harness();
  assertHarnessIsolated(h);
  const pointsBefore = fs.readFileSync(h.pointsFile, "utf8");
  const builderBefore = fs.readFileSync(h.storeFile, "utf8");
  const ctx = mockCtx();
  await handlePhase2Open(ctx, h.opts);
  await handlePhase2Callback(
    mockCtx({ callbackData: PHASE2_CALLBACK.XP }),
    h.opts
  );
  await handlePhase2Callback(
    mockCtx({ callbackData: PHASE2_CALLBACK.ACTIVE }),
    h.opts
  );
  await handlePhase2Callback(
    mockCtx({ callbackData: PHASE2_CALLBACK.CANDIDATES }),
    h.opts
  );
  assert.strictEqual(fs.readFileSync(h.pointsFile, "utf8"), pointsBefore);
  assert.strictEqual(fs.readFileSync(h.storeFile, "utf8"), builderBefore);
  for (const data of allCallbackData(ctx)) {
    assert.ok(!data.includes(ALICE));
    assert.ok(data.startsWith("p2:"));
  }
  const memberMenu = mockCtx({ chatType: "private", userId: Number(MEMBER_ID) });
  await handlePhase2Menu(memberMenu, h.opts);
  assert.strictEqual(memberMenu.replies.length, 0);
});

  await runTest("41-45. regressions: existing flows untouched by browse", async () => {
  const h = harness();
  const created = createReward({
    telegramUserId: ALICE,
    walletFile: h.walletFile,
    rewardsFile: h.rewardsFile,
    now: NOW,
    displayName: "Alice",
  });
  assert.strictEqual(created.ok, true);
  const board = getBuilderLeaderboard({
    period: "weekly",
    now: NOW,
    storeFile: h.storeFile,
  });
  assert.strictEqual(board[0].points, 8);
  const weekly = getWeeklyTop(
    loadPoints(h.pointsFile).users,
    (user) => weeklyPointsAt(user, NOW)
  );
  assert.strictEqual(weekly[0].name, "Owner");
  const detail = loadMemberDetail(ALICE, h.opts);
  assert.strictEqual(detail.weeklyXp, 18);
  assert.strictEqual(detail.lifetimeXp, 143);
});

  await runTest("isAdmin policy is ADMIN_USER_ID only", () => {
    assert.strictEqual(isAdmin(ADMIN_ID), true);
    assert.strictEqual(isAdmin(MEMBER_ID), false);
    assert.strictEqual(isAdmin(ALICE), false);
  });

  console.log("\nAll phase2-control-center tests passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (originalAdmin === undefined) {
      delete process.env.ADMIN_USER_ID;
    } else {
      process.env.ADMIN_USER_ID = originalAdmin;
    }
    setWalletFileForTests(null);
    configureCommunityBuilderForTests({});
  });
