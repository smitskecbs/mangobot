/**
 * ManGo Shop menu, callbacks, and security.
 * Run: node tests/mango-shop.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawn } = require("child_process");

const {
  MENU_LABELS,
  getPrivateMenuKeyboard,
  getGroupMenuExtra,
} = require("../utils/botMenu");
const { handleMenu } = require("../commands/menu");
const { handleStart } = require("../commands/start");
const { HELP_MESSAGE } = require("../commands/help");
const {
  handleShop,
  handleShopCallback,
  parseShopCallback,
  GROUP_SHOP_TEXT,
  buildHomeText,
  buildTitleDetailText,
  buildMyTitlesText,
  titlesKeyboard,
  titleDetailKeyboard,
  purchaseSuccessText,
  lockedBuyText,
} = require("../commands/shop");
const { setMangoShopFileForTests, loadShopStore } = require("../services/mangoShopStore");
const { awardLoot, getLootAccount, getLootBalance } = require("../services/mangoLoot");
const {
  titleProgress,
  purchaseTitle,
  setActiveTitle,
  getTitleById,
  setTitleLookupForTests,
} = require("../services/mangoShop");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-shop-"));
let n = 0;
const USER = "444";
const OTHER = "555";
const ADMIN_ID = "9001";
const originalAdmin = process.env.ADMIN_USER_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
  path.join(__dirname, "..", "data", "member-rewards.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function nextFiles() {
  n += 1;
  return {
    shopFile: path.join(tempDir, `shop-${n}.json`),
    pointsFile: path.join(tempDir, `points-${n}.json`),
    builderFile: path.join(tempDir, `builder-${n}.json`),
    walletFile: path.join(tempDir, `wallet-${n}.json`),
  };
}

function seedXp(pointsFile, userId, points) {
  fs.writeFileSync(
    pointsFile,
    JSON.stringify(
      {
        users: {
          [String(userId)]: {
            name: "Ada",
            points,
            weeklyPoints: 0,
            weekId: "2026-W34",
            streak: { current: 0, longest: 0, lastActiveDate: null },
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );
}

function seedBp(builderFile, userId, points) {
  fs.writeFileSync(
    builderFile,
    JSON.stringify(
      {
        version: 1,
        builders: {
          [String(userId)]: {
            points,
            referralIds: [],
            displayName: "Ada",
            createdAt: 1,
            activeInviteId: null,
          },
        },
        referrals: {},
        inviteLinks: {},
        builderEvents: {},
        welcomeOpportunities: {},
      },
      null,
      2
    ),
    "utf8"
  );
}

function filesFor(userId, { xp, bp, loot }) {
  const files = nextFiles();
  seedXp(files.pointsFile, userId, xp);
  seedBp(files.builderFile, userId, bp);
  fs.writeFileSync(files.walletFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  setMangoShopFileForTests(files.shopFile);
  if (loot > 0) {
    awardLoot(userId, loot, "admin-award", `shop-seed-${n}`, { shopFile: files.shopFile });
  }
  return files;
}

function shopOpts(files) {
  return {
    shopFile: files.shopFile,
    pointsFile: files.pointsFile,
    builderFile: files.builderFile,
    walletFile: files.walletFile,
  };
}

function buttonLabels(extra) {
  const rows =
    extra && extra.reply_markup && extra.reply_markup.inline_keyboard
      ? extra.reply_markup.inline_keyboard
      : [];
  return rows.flat().map((button) => button && button.text).filter(Boolean);
}

function callbackDataList(extra) {
  const rows =
    extra && extra.reply_markup && extra.reply_markup.inline_keyboard
      ? extra.reply_markup.inline_keyboard
      : [];
  return rows
    .flat()
    .map((button) => button && button.callback_data)
    .filter(Boolean);
}

function mockCtx({ userId = USER, chatType = "private", data, botUsername = "ManGoBot" } = {}) {
  const replies = [];
  const edits = [];
  const answered = [];
  return {
    from: { id: Number(userId), first_name: "Ada" },
    chat: {
      type: chatType,
      id: chatType === "private" ? Number(userId) : -1003916996602,
    },
    botInfo: { username: botUsername },
    callbackQuery: data ? { data } : undefined,
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
      answered.push(text === undefined ? "" : text);
      return Promise.resolve();
    },
  };
}

function spawnChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runTest(name, fn) {
  process.env.ADMIN_USER_ID = ADMIN_ID;
  setTitleLookupForTests(null);
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    setTitleLookupForTests(null);
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("33. normal member main menu shows ManGo Shop", () => {
    const kb = getPrivateMenuKeyboard({ from: { id: Number(USER) } });
    const labels = kb.reply_markup.keyboard.flat();
    assert.ok(labels.includes(MENU_LABELS.SHOP));
    const ctx = mockCtx({ userId: USER, chatType: "private" });
    handleMenu(ctx);
    assert.ok(ctx.replies[0].extra.reply_markup.keyboard.flat().includes(MENU_LABELS.SHOP));
  });

  await runTest("34. admin menu also shows shop", () => {
    const kb = getPrivateMenuKeyboard({ from: { id: Number(ADMIN_ID) } });
    const labels = kb.reply_markup.keyboard.flat();
    assert.ok(labels.includes(MENU_LABELS.SHOP));
    assert.ok(labels.includes(MENU_LABELS.PHASE2));
  });

  await runTest("35. group access redirects private", () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 84 });
    const ctx = mockCtx({ userId: USER, chatType: "supergroup" });
    handleShop(ctx, shopOpts(files));
    assert.strictEqual(ctx.replies[0].text, GROUP_SHOP_TEXT);
    assert.ok(!String(ctx.replies[0].text).includes("ManGo Loot: 84"));
    assert.ok(!JSON.stringify(ctx.replies[0]).includes(String(USER)));
  });

  await runTest("36. shop home balance correct", () => {
    const files = filesFor(USER, { xp: 172, bp: 21, loot: 84 });
    const text = buildHomeText(USER, shopOpts(files));
    assert.ok(text.includes("🏪 ManGo Shop"));
    assert.ok(text.includes("🥭 ManGo Loot: 84"));
    assert.ok(text.includes("⭐ XP: 172"));
    assert.ok(text.includes("🤝 BP: 21"));
    const ctx = mockCtx({ userId: USER });
    handleShop(ctx, shopOpts(files));
    assert.ok(ctx.replies[0].text.includes("🥭 ManGo Loot: 84"));
    assert.deepStrictEqual(buttonLabels(ctx.replies[0].extra), ["🏷️ Titles", "📦 My Titles", "⬅️ Back"]);
  });

  await runTest("37. titles list", () => {
    const labels = buttonLabels(titlesKeyboard());
    assert.deepStrictEqual(labels, [
      "🥭 ManGo Supporter",
      "🤝 ManGo Contributor",
      "🌟 ManGo Ambassador",
      "🏅 ManGo Advocate",
      "⬅️ Back",
    ]);
  });

  await runTest("38. my titles empty", () => {
    const files = filesFor(USER, { xp: 10, bp: 0, loot: 0 });
    const text = buildMyTitlesText(USER, shopOpts(files));
    assert.ok(text.includes("You haven't unlocked any titles yet."));
  });

  await runTest("39. my titles populated", () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    purchaseTitle(USER, "supporter", shopOpts(files));
    setActiveTitle(USER, "supporter", shopOpts(files));
    const text = buildMyTitlesText(USER, shopOpts(files));
    assert.ok(text.includes("Active:"));
    assert.ok(text.includes("🥭 ManGo Supporter"));
  });

  await runTest("40. buy button only when available", () => {
    const locked = filesFor(USER, { xp: 10, bp: 0, loot: 0 });
    const lockedProgress = titleProgress(USER, getTitleById("supporter"), shopOpts(locked));
    assert.ok(!buttonLabels(titleDetailKeyboard(lockedProgress)).includes("🛒 Buy Title"));
    const open = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    const openProgress = titleProgress(USER, getTitleById("supporter"), shopOpts(open));
    assert.ok(buttonLabels(titleDetailKeyboard(openProgress)).includes("🛒 Buy Title"));
  });

  await runTest("41. locked status shows missing requirements", () => {
    const files = filesFor(USER, { xp: 40, bp: 1, loot: 0 });
    const progress = titleProgress(USER, getTitleById("supporter"), shopOpts(files));
    const text = buildTitleDetailText(progress);
    assert.ok(text.includes("🔒 Not unlocked"));
    const locked = lockedBuyText({
      progress: {
        xpOk: false,
        bpOk: false,
        lootOk: false,
        xp: 40,
        bp: 1,
        loot: 0,
        requiredXp: 50,
        requiredBp: 5,
        price: 25,
      },
    });
    assert.ok(locked.includes("10 more XP"));
    assert.ok(locked.includes("4 more BP"));
    assert.ok(locked.includes("25 more ManGo Loot"));
  });

  await runTest("42. successful purchase UX", async () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 120 });
    const ctx = mockCtx({ userId: USER, data: "shop:buy:supporter" });
    await handleShopCallback(ctx, shopOpts(files));
    const text = ctx.edits[0].text;
    assert.ok(text.includes("🎉 Title unlocked!"));
    assert.ok(text.includes("🥭 ManGo Supporter"));
    assert.ok(text.includes("25 🥭 ManGo Loot spent."));
    assert.ok(text.includes("95 🥭 ManGo Loot"));
    assert.ok(buttonLabels(ctx.edits[0].extra).includes("🏷️ Use Title"));
    assert.strictEqual(purchaseSuccessText({
      title: getTitleById("supporter"),
      lootSpent: 25,
      balance: 95,
    }).includes("🎉 Title unlocked!"), true);
  });

  await runTest("43. callbacks no raw uid", () => {
    const parsed = parseShopCallback("shop:buy:supporter");
    assert.deepStrictEqual(parsed, { action: "buy", titleId: "supporter" });
    assert.strictEqual(parseShopCallback("shop:buy:supporter:444"), null);
    const extra = titlesKeyboard();
    const blob = JSON.stringify(extra);
    assert.ok(!blob.includes(USER));
    assert.ok(!blob.includes("uid="));
    for (const data of callbackDataList(extra)) {
      assert.ok(data.startsWith("shop:"));
      assert.ok(!/\d{5,}/.test(data));
    }
  });

  await runTest("44. stale/invalid callback safe", async () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    const stale = mockCtx({ userId: USER, data: "shop:buy:nope" });
    await handleShopCallback(stale, shopOpts(files));
    assert.ok(stale.answered.includes("This action is no longer available.") || stale.answered.includes("Could not buy this title."));
    assert.strictEqual(getLootBalance(USER, files.shopFile), 25);
    const junk = mockCtx({ userId: USER, data: "shop:wat" });
    await handleShopCallback(junk, shopOpts(files));
    assert.ok(junk.answered.includes("This action is no longer available."));
  });

  await runTest("45. cannot spoof another user", async () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    seedXp(files.pointsFile, OTHER, 10);
    const ctx = mockCtx({ userId: OTHER, data: "shop:buy:supporter" });
    await handleShopCallback(ctx, shopOpts(files));
    assert.strictEqual(getLootBalance(USER, files.shopFile), 25);
    assert.deepStrictEqual(loadShopStore(files.shopFile).users[USER].ownedTitles, {});
  });

  await runTest("46. cannot submit Loot price client-side", async () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    const ctx = mockCtx({ userId: USER, data: "shop:buy:supporter:1" });
    await handleShopCallback(ctx, shopOpts(files));
    assert.strictEqual(parseShopCallback("shop:buy:supporter:1"), null);
    assert.strictEqual(getLootBalance(USER, files.shopFile), 25);
  });

  await runTest("47. cannot purchase disabled title", () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    setTitleLookupForTests(() => ({
      id: "retired",
      name: "ManGo Retired",
      emoji: "📦",
      requiredXp: 1,
      requiredBp: 1,
      lootPrice: 1,
      purchasable: false,
      active: true,
    }));
    const result = purchaseTitle(USER, "retired", shopOpts(files));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "disabled");
    assert.strictEqual(getLootBalance(USER, files.shopFile), 25);
    setTitleLookupForTests(null);
  });

  await runTest("48. cannot purchase unavailable seasonal title", () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    setTitleLookupForTests(() => ({
      id: "seasonal",
      name: "ManGo Seasonal",
      emoji: "🎁",
      requiredXp: 1,
      requiredBp: 1,
      lootPrice: 1,
      purchasable: true,
      active: true,
      availableFrom: Date.now() + 86_400_000,
      availableUntil: null,
    }));
    const result = purchaseTitle(USER, "seasonal", shopOpts(files));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "unavailable");
    assert.strictEqual(getLootBalance(USER, files.shopFile), 25);
    setTitleLookupForTests(null);
  });

  await runTest("49-51. no wallet, XP, or BP mutation", () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    const pointsBefore = fs.readFileSync(files.pointsFile, "utf8");
    const builderBefore = fs.readFileSync(files.builderFile, "utf8");
    const walletBefore = fs.readFileSync(files.walletFile, "utf8");
    purchaseTitle(USER, "supporter", shopOpts(files));
    assert.strictEqual(fs.readFileSync(files.pointsFile, "utf8"), pointsBefore);
    assert.strictEqual(fs.readFileSync(files.builderFile, "utf8"), builderBefore);
    assert.strictEqual(fs.readFileSync(files.walletFile, "utf8"), walletBefore);
  });

  await runTest("52-53. no Telegram admin promotion or staff-role grant", () => {
    const shopSrc = fs.readFileSync(path.join(__dirname, "..", "services", "mangoShop.js"), "utf8");
    const cmdSrc = fs.readFileSync(path.join(__dirname, "..", "commands", "shop.js"), "utf8");
    for (const src of [shopSrc, cmdSrc]) {
      assert.ok(!src.includes("promoteChatMember"));
      assert.ok(!src.includes("setChatAdministratorCustomTitle"));
      assert.ok(!src.includes("setChatMemberTag"));
    }
    const catalog = fs.readFileSync(path.join(__dirname, "..", "services", "mangoTitles.js"), "utf8");
    assert.ok(!catalog.includes("ManGo Mod"));
    assert.ok(!catalog.includes("ManGo Admin"));
    assert.ok(!catalog.includes("ManGo Owner"));
    assert.ok(!HELP_MESSAGE.includes("/lootaward"));
    assert.ok(!HELP_MESSAGE.includes("/shop"));
  });

  await runTest("start payload opens shop privately", () => {
    const files = filesFor(USER, { xp: 12, bp: 2, loot: 3 });
    const ctx = mockCtx({ userId: USER, chatType: "private" });
    ctx.startPayload = "shop";
    handleStart(ctx, shopOpts(files));
    assert.ok(ctx.replies[0].text.includes("🏪 ManGo Shop"));
    assert.ok(ctx.replies[0].text.includes("🥭 ManGo Loot: 3"));
  });

  await runTest("group callback does not leak balances", async () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 99 });
    const ctx = mockCtx({ userId: USER, chatType: "supergroup", data: "shop:home" });
    await handleShopCallback(ctx, shopOpts(files));
    assert.strictEqual(ctx.replies[0].text, GROUP_SHOP_TEXT);
    assert.ok(!String(JSON.stringify(ctx.replies)).includes("99"));
  });

  await runTest("simultaneous Loot award and purchase stay coherent", async () => {
    const files = filesFor(USER, { xp: 80, bp: 20, loot: 25 });
    const [buy, award] = await Promise.all([
      spawnChild([
        path.join(__dirname, "helpers", "mango-shop-buy-worker.js"),
        files.shopFile,
        files.pointsFile,
        files.builderFile,
        USER,
        "supporter",
      ]),
      spawnChild([
        path.join(__dirname, "helpers", "mango-shop-award-worker.js"),
        files.shopFile,
        USER,
        "10",
        "special-event",
        "concurrent-award",
      ]),
    ]);
    assert.strictEqual(buy.status, 0, buy.stderr);
    assert.strictEqual(award.status, 0, award.stderr);
    const account = getLootAccount(USER, files.shopFile);
    assert.ok(account.balance >= 0);
    const store = loadShopStore(files.shopFile);
    const owned = Boolean(store.users[USER] && store.users[USER].ownedTitles.supporter);
    if (owned) {
      assert.strictEqual(account.lifetimeSpent, 25);
      assert.strictEqual(account.balance, account.lifetimeEarned - account.lifetimeSpent);
      assert.strictEqual(Object.keys(store.purchases).length, 1);
    } else {
      assert.strictEqual(account.lifetimeSpent, 0);
      assert.strictEqual(account.balance, account.lifetimeEarned);
    }
  });

  await runTest("54. no production file mutation", () => {
    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
    }
  });
}

main()
  .then(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    setTitleLookupForTests(null);
    setMangoShopFileForTests(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll mango-shop tests passed.");
  })
  .catch((err) => {
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    setTitleLookupForTests(null);
    console.error(err);
    process.exit(1);
  });
