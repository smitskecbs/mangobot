/**
 * Native Telegram member tags for community titles.
 * Run: node tests/native-title-tag.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { setMangoShopFileForTests, loadShopStore } = require("../services/mangoShopStore");
const { awardLoot, getLootBalance } = require("../services/mangoLoot");
const {
  NATIVE_TAG_MAX,
  isValidNativeTag,
  getNativeTagForTitle,
  getTitleById,
} = require("../services/mangoTitles");
const {
  purchaseTitle,
  setActiveTitle,
  getActiveTitle,
  getOwnedTitleIds,
} = require("../services/mangoShop");
const {
  SET_CHAT_MEMBER_TAG,
  setNativeTitleTagTelegram,
  setNativeTitleTagChatIdForTests,
  syncActiveTitleTag,
  clearNativeTitleTag,
  getTagSyncState,
} = require("../services/nativeTitleTag");
const {
  handleShopCallback,
  parseShopCallback,
  titleDetailKeyboard,
  myTitlesKeyboard,
  buildActivateText,
} = require("../commands/shop");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-native-tag-"));
let n = 0;
const USER = "444";
const OTHER = "555";
const CHAT = "-1003916996602";

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

const originalChatId = process.env.TELEGRAM_CHAT_ID;
process.env.TELEGRAM_CHAT_ID = CHAT;

function nextFiles() {
  n += 1;
  return {
    shopFile: path.join(tempDir, `shop-${n}.json`),
    pointsFile: path.join(tempDir, `points-${n}.json`),
    builderFile: path.join(tempDir, `builder-${n}.json`),
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
  setMangoShopFileForTests(files.shopFile);
  if (loot > 0) {
    awardLoot(userId, loot, "admin-award", `tag-seed-${n}`, { shopFile: files.shopFile });
  }
  return files;
}

function opts(files) {
  return {
    shopFile: files.shopFile,
    pointsFile: files.pointsFile,
    builderFile: files.builderFile,
  };
}

function mockTelegram() {
  const calls = [];
  return {
    calls,
    telegram: {
      async callApi(method, payload) {
        calls.push({ method, payload });
        return true;
      },
    },
  };
}

function mockTelegramThrow(err) {
  const calls = [];
  return {
    calls,
    telegram: {
      async callApi(method, payload) {
        calls.push({ method, payload });
        throw err;
      },
    },
  };
}

function mockCtx({ userId = USER, data, chatType = "private" } = {}) {
  const replies = [];
  const edits = [];
  const answered = [];
  return {
    from: { id: Number(userId), first_name: "Ada" },
    chat: {
      type: chatType,
      id: chatType === "private" ? Number(userId) : Number(CHAT),
    },
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
      answered.push(text || "");
      return Promise.resolve();
    },
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

async function runTest(name, fn) {
  setNativeTitleTagChatIdForTests(CHAT);
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("6-11. native tag mapping valid, <=16, no emoji", () => {
    const expected = {
      supporter: "ManGo Supporter",
      contributor: "Contributor",
      ambassador: "ManGo Ambassador",
      guard: "ManGo Guard",
      elite: "ManGo Elite",
      advocate: "ManGo Advocate",
    };
    for (const [id, tag] of Object.entries(expected)) {
      assert.strictEqual(getNativeTagForTitle(id), tag);
      assert.ok(isValidNativeTag(tag));
      assert.ok(tag.length <= NATIVE_TAG_MAX);
      assert.ok(!/[^\x20-\x7E]/.test(tag));
      assert.ok(!/\p{Extended_Pictographic}/u.test(tag));
    }
    assert.strictEqual(isValidNativeTag(""), false);
    assert.strictEqual(isValidNativeTag("ManGo Contributor"), false);
    assert.strictEqual(isValidNativeTag("🥭 ManGo"), false);
  });

  await runTest("12-15. activating owned title calls setChatMemberTag", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const mock = mockTelegram();
    setNativeTitleTagTelegram(mock.telegram);
    purchaseTitle(USER, "supporter", opts(files));
    const ctx = mockCtx({ data: "shop:use:supporter" });
    await handleShopCallback(ctx, opts(files));
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].method, SET_CHAT_MEMBER_TAG);
    assert.strictEqual(String(mock.calls[0].payload.chat_id), CHAT);
    assert.strictEqual(mock.calls[0].payload.user_id, Number(USER));
    assert.strictEqual(mock.calls[0].payload.tag, "ManGo Supporter");
    assert.ok((ctx.edits[0] || ctx.replies[0]).text.includes("🎉 Community Title active!"));
    assert.strictEqual(getActiveTitle(USER, files.shopFile).id, "supporter");
  });

  await runTest("16. switching title updates tag", async () => {
    const files = filesFor(USER, { xp: 600, bp: 80, loot: 400 });
    const mock = mockTelegram();
    setNativeTitleTagTelegram(mock.telegram);
    purchaseTitle(USER, "supporter", opts(files));
    purchaseTitle(USER, "contributor", opts(files));
    await handleShopCallback(mockCtx({ data: "shop:use:supporter" }), opts(files));
    await handleShopCallback(mockCtx({ data: "shop:use:contributor" }), opts(files));
    assert.strictEqual(mock.calls.length, 2);
    assert.strictEqual(mock.calls[1].payload.tag, "Contributor");
    assert.strictEqual(getActiveTitle(USER, files.shopFile).id, "contributor");
  });

  await runTest("17. remove active clears tag", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const mock = mockTelegram();
    setNativeTitleTagTelegram(mock.telegram);
    purchaseTitle(USER, "supporter", opts(files));
    setActiveTitle(USER, "supporter", opts(files));
    await handleShopCallback(mockCtx({ data: "shop:clear" }), opts(files));
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].method, SET_CHAT_MEMBER_TAG);
    assert.strictEqual(mock.calls[0].payload.tag, "");
    assert.strictEqual(getActiveTitle(USER, files.shopFile), null);
    assert.deepStrictEqual(getOwnedTitleIds(USER, files.shopFile), ["supporter"]);
  });

  await runTest("18-20. re-sync active title costs 0 Loot", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const mock = mockTelegram();
    setNativeTitleTagTelegram(mock.telegram);
    purchaseTitle(USER, "supporter", opts(files));
    const afterBuy = getLootBalance(USER, files.shopFile);
    setActiveTitle(USER, "supporter", opts(files));
    await handleShopCallback(mockCtx({ data: "shop:sync" }), opts(files));
    await handleShopCallback(mockCtx({ data: "shop:use:supporter" }), opts(files));
    assert.strictEqual(mock.calls.length, 2);
    assert.strictEqual(mock.calls[0].payload.tag, "ManGo Supporter");
    assert.strictEqual(getLootBalance(USER, files.shopFile), afterBuy);
    assert.deepStrictEqual(getOwnedTitleIds(USER, files.shopFile), ["supporter"]);
    const purchases = Object.keys(loadShopStore(files.shopFile).purchases);
    assert.strictEqual(purchases.length, 1);
  });

  await runTest("21. permission error does not rollback activeTitle", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const err = new Error("Forbidden: not enough rights");
    err.error_code = 403;
    err.description = "Forbidden: not enough rights";
    const mock = mockTelegramThrow(err);
    setNativeTitleTagTelegram(mock.telegram);
    purchaseTitle(USER, "supporter", opts(files));
    const ctx = mockCtx({ data: "shop:use:supporter" });
    await handleShopCallback(ctx, opts(files));
    assert.strictEqual(getActiveTitle(USER, files.shopFile).id, "supporter");
    assert.strictEqual(getTagSyncState(USER, files.shopFile).status, "failed");
    assert.ok((ctx.edits[0] || ctx.replies[0]).text.includes("Telegram tag could not be updated"));
    assert.ok((ctx.edits[0] || ctx.replies[0]).text.includes("still active"));
  });

  await runTest("22-24. network failure keeps ownership; no extra Loot", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const mock = mockTelegramThrow(new Error("ECONNRESET"));
    setNativeTitleTagTelegram(mock.telegram);
    purchaseTitle(USER, "supporter", opts(files));
    const afterBuy = getLootBalance(USER, files.shopFile);
    await handleShopCallback(mockCtx({ data: "shop:use:supporter" }), opts(files));
    assert.strictEqual(getActiveTitle(USER, files.shopFile).id, "supporter");
    assert.deepStrictEqual(getOwnedTitleIds(USER, files.shopFile), ["supporter"]);
    assert.strictEqual(getLootBalance(USER, files.shopFile), afterBuy);
  });

  await runTest("25-27. no promote/admin/moderation APIs", () => {
    const tagSrc = fs.readFileSync(
      path.join(__dirname, "..", "services", "nativeTitleTag.js"),
      "utf8"
    );
    const shopSrc = fs.readFileSync(
      path.join(__dirname, "..", "services", "mangoShop.js"),
      "utf8"
    );
    const cmdSrc = fs.readFileSync(path.join(__dirname, "..", "commands", "shop.js"), "utf8");
    for (const src of [tagSrc, shopSrc, cmdSrc]) {
      assert.ok(!src.includes("promoteChatMember"));
      assert.ok(!src.includes("setChatAdministratorCustomTitle"));
      assert.ok(!src.includes("restrictChatMember"));
      assert.ok(!src.includes("banChatMember"));
    }
    assert.ok(tagSrc.includes('callApi(SET_CHAT_MEMBER_TAG'));
    assert.ok(!cmdSrc.includes("setChatMemberTag"));
  });

  await runTest("28-29. cannot set another user's tag; no raw uid callback", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const mock = mockTelegram();
    setNativeTitleTagTelegram(mock.telegram);
    purchaseTitle(USER, "supporter", opts(files));
    await handleShopCallback(mockCtx({ userId: OTHER, data: "shop:use:supporter" }), opts(files));
    assert.strictEqual(mock.calls.length, 0);
    assert.strictEqual(getActiveTitle(USER, files.shopFile), null);
    assert.deepStrictEqual(parseShopCallback("shop:sync"), { action: "sync" });
    assert.strictEqual(parseShopCallback("shop:sync:555"), null);
    assert.strictEqual(parseShopCallback("shop:use:supporter:444"), null);
    const extra = titleDetailKeyboard({
      title: getTitleById("supporter"),
      owned: true,
      active: true,
      available: false,
    });
    const blob = JSON.stringify(extra);
    assert.ok(!blob.includes(USER));
    for (const data of callbackDataList(extra)) {
      assert.ok(!/\d{5,}/.test(data));
    }
    const mine = myTitlesKeyboard(["supporter"], true);
    assert.ok(buttonLabels(mine).includes("🔄 Sync Telegram Tag"));
    assert.ok(!JSON.stringify(mine).includes(USER));
  });

  await runTest("30. invalid catalog tag rejected without API call", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const mock = mockTelegram();
    setNativeTitleTagTelegram(mock.telegram);
    const { mutateShopStore, ensureUser } = require("../services/mangoShopStore");
    mutateShopStore((store) => {
      const user = ensureUser(store, USER);
      user.ownedTitles.bogus = { purchasedAt: 1, purchaseId: "x" };
      user.activeTitle = "bogus";
    }, files.shopFile);
    const result = await syncActiveTitleTag(USER, opts(files));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "invalid-tag");
    assert.strictEqual(mock.calls.length, 0);
  });

  await runTest("activate copy distinguishes success vs failure", () => {
    const title = getTitleById("ambassador");
    assert.ok(buildActivateText(title, { ok: true }).includes("now visible in the ManGo group"));
    assert.ok(buildActivateText(title, { ok: false }).includes("could not be updated"));
  });

  await runTest("clearNativeTitleTag helper uses empty tag", async () => {
    const files = filesFor(USER, { xp: 120, bp: 20, loot: 40 });
    const mock = mockTelegram();
    setNativeTitleTagTelegram(mock.telegram);
    purchaseTitle(USER, "supporter", opts(files));
    setActiveTitle(USER, "supporter", opts(files));
    await clearNativeTitleTag(USER, opts(files));
    assert.strictEqual(mock.calls[0].payload.tag, "");
    assert.strictEqual(mock.calls[0].payload.user_id, Number(USER));
  });

  await runTest("no production files touched", () => {
    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
    }
  });
}

main()
  .then(() => {
    setMangoShopFileForTests(null);
    setNativeTitleTagTelegram(null);
    setNativeTitleTagChatIdForTests(null);
    if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChatId;
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll native-title-tag tests passed.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
