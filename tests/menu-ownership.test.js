/**
 * Group /menu ownership: LRU, expired vs other-player, one-active-menu, stale strip.
 * Run: node tests/menu-ownership.test.js
 */

const assert = require("assert");
const {
  rememberGroupMenuOwner,
  getGroupMenuOwner,
  getActiveGroupMenuMessageId,
  forgetGroupMenuOwner,
  resetGroupMenuOwnersForTests,
  setMaxGroupMenusForTests,
  listGroupMenuKeysForTests,
  listActiveGroupMenuKeysForTests,
  pruneGroupMenusForTests,
  setActiveGroupMenuPointerForTests,
  MAX_AGE_MS,
  MENU_EXPIRED_GENERIC,
  MENU_UNAUTHORIZED_GENERIC,
  formatMenuUnauthorizedToast,
} = require("../utils/menuOwnership");
const {
  handleMenu,
  handleGroupMenuCallback,
  handlePrivateHubCallback,
} = require("../commands/menu");
const {
  GROUP_MENU_CALLBACK,
  PRIVATE_HUB_CALLBACK,
  PRIVATE_MENU_HINT,
} = require("../utils/botMenu");

const USER_A = 111111111;
const USER_B = 222222222;
const USER_C = 333333333;
let nextTestMessageId = 1;

function emptyKeyboardExtra(extra) {
  const markup = extra && extra.reply_markup ? extra.reply_markup : extra;
  const rows = markup && markup.inline_keyboard;
  return Array.isArray(rows) && rows.length === 0;
}

function createMockCtx({
  userId = USER_A,
  firstName = "Kevin",
  chatId = -3001,
  messageId,
  callbackData,
  chatType = "supergroup",
  throwOnStrip = false,
} = {}) {
  const replies = [];
  const answered = [];
  const edits = [];
  const markupEdits = [];
  const ctx = {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName },
    callbackQuery: callbackData
      ? {
          data: callbackData,
          message: { message_id: messageId != null ? messageId : 1 },
        }
      : undefined,
    replies,
    answered,
    edits,
    markupEdits,
    reply(text, extra) {
      const payload = {
        text,
        extra,
        message_id: messageId != null ? messageId : nextTestMessageId++,
      };
      replies.push(payload);
      return Promise.resolve(payload);
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve({
        text,
        extra,
        message_id:
          ctx.callbackQuery && ctx.callbackQuery.message
            ? ctx.callbackQuery.message.message_id
            : messageId,
      });
    },
    editMessageReplyMarkup(markup) {
      markupEdits.push({
        via: "ctx",
        chatId,
        messageId:
          ctx.callbackQuery && ctx.callbackQuery.message
            ? ctx.callbackQuery.message.message_id
            : messageId,
        markup,
      });
      return Promise.resolve();
    },
    answerCbQuery(text) {
      answered.push(text || true);
      return Promise.resolve();
    },
    telegram: {
      editMessageReplyMarkup(chat, mid, _inline, extra) {
        if (throwOnStrip) {
          return Promise.reject(new Error("message can't be edited"));
        }
        markupEdits.push({ via: "telegram", chat, mid, extra });
        return Promise.resolve();
      },
    },
  };
  return ctx;
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
  await runTest("A. fresh group /menu is registered and works", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const menu = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3001 });
    await handleMenu(menu);
    const mid = menu.replies[0].message_id;
    assert.ok(getGroupMenuOwner(-3001, mid));
    assert.strictEqual(getActiveGroupMenuMessageId(-3001, USER_A), mid);
    const cb = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3001,
      messageId: mid,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
    });
    await handleGroupMenuCallback(cb);
    assert.strictEqual(cb.edits.length, 1);
    assert.ok(cb.answered.includes(true));
    assert.strictEqual(getActiveGroupMenuMessageId(-3001, USER_A), mid);
  });

  await runTest("B-C-D-O. second /menu retires previous keyboard and ownership", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const first = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3100 });
    await handleMenu(first);
    const oldId = first.replies[0].message_id;
    const second = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3100 });
    await handleMenu(second);
    const newId = second.replies[0].message_id;
    assert.notStrictEqual(oldId, newId);
    assert.strictEqual(getGroupMenuOwner(-3100, oldId), null);
    assert.ok(getGroupMenuOwner(-3100, newId));
    assert.strictEqual(getActiveGroupMenuMessageId(-3100, USER_A), newId);
    assert.strictEqual(second.markupEdits.length, 1);
    assert.strictEqual(second.markupEdits[0].mid, oldId);
    assert.ok(emptyKeyboardExtra(second.markupEdits[0].extra));
    const third = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3100 });
    await handleMenu(third);
    assert.strictEqual(third.markupEdits.length, 1);
    assert.strictEqual(third.markupEdits[0].mid, newId);
    assert.strictEqual(getGroupMenuOwner(-3100, newId), null);
  });

  await runTest("E. stale callback gets expired toast and strips keyboard", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3004,
      messageId: 99,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
    });
    await handleGroupMenuCallback(ctx);
    assert.deepStrictEqual(ctx.answered, [MENU_EXPIRED_GENERIC]);
    assert.ok(!String(ctx.answered[0]).includes("another player"));
    assert.notStrictEqual(ctx.answered[0], MENU_UNAUTHORIZED_GENERIC);
    assert.deepStrictEqual(ctx.edits, []);
    assert.strictEqual(ctx.markupEdits.length, 1);
    assert.strictEqual(ctx.markupEdits[0].mid, 99);
    assert.ok(emptyKeyboardExtra(ctx.markupEdits[0].extra));
  });

  await runTest("F. stale keyboard cleanup failure does not throw; toast still occurs", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3004,
      messageId: 99,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
      throwOnStrip: true,
    });
    await handleGroupMenuCallback(ctx);
    assert.deepStrictEqual(ctx.answered, [MENU_EXPIRED_GENERIC]);
    assert.deepStrictEqual(ctx.edits, []);
  });

  await runTest("G. another user cannot strip an active owned menu", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const menu = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3003 });
    await handleMenu(menu);
    const mid = menu.replies[0].message_id;
    const outsider = createMockCtx({
      userId: USER_B,
      firstName: "Piet",
      chatId: -3003,
      messageId: mid,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
    });
    await handleGroupMenuCallback(outsider);
    assert.deepStrictEqual(outsider.edits, []);
    assert.deepStrictEqual(outsider.markupEdits, []);
    assert.deepStrictEqual(outsider.answered, [
      formatMenuUnauthorizedToast("Kevin"),
    ]);
    assert.ok(outsider.answered[0].includes("Kevin"));
    assert.ok(getGroupMenuOwner(-3003, mid));
    const owner = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3003,
      messageId: mid,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
    });
    await handleGroupMenuCallback(owner);
    assert.strictEqual(owner.edits.length, 1);
  });

  await runTest("H. User A new menu does not retire User B", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const menuB = createMockCtx({
      userId: USER_B,
      firstName: "Piet",
      chatId: -3200,
    });
    await handleMenu(menuB);
    const bId = menuB.replies[0].message_id;
    const menuA1 = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3200,
    });
    await handleMenu(menuA1);
    const menuA2 = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3200,
    });
    await handleMenu(menuA2);
    assert.ok(getGroupMenuOwner(-3200, bId));
    assert.strictEqual(getActiveGroupMenuMessageId(-3200, USER_B), bId);
    assert.ok(!menuA2.markupEdits.some((row) => String(row.mid) === String(bId)));
  });

  await runTest("I. same user Chat A does not affect Chat B", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const chatA = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3301 });
    await handleMenu(chatA);
    const aId = chatA.replies[0].message_id;
    const chatB = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3302 });
    await handleMenu(chatB);
    const bId = chatB.replies[0].message_id;
    const againA = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3301 });
    await handleMenu(againA);
    assert.ok(getGroupMenuOwner(-3302, bId));
    assert.strictEqual(getActiveGroupMenuMessageId(-3302, USER_A), bId);
    assert.strictEqual(getGroupMenuOwner(-3301, aId), null);
  });

  await runTest("J. navigation inside existing menu does not retire itself", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const menu = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3400 });
    await handleMenu(menu);
    const mid = menu.replies[0].message_id;
    const games = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3400,
      messageId: mid,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
    });
    await handleGroupMenuCallback(games);
    assert.strictEqual(games.edits.length, 1);
    assert.deepStrictEqual(games.markupEdits, []);
    assert.ok(getGroupMenuOwner(-3400, mid));
    assert.strictEqual(getActiveGroupMenuMessageId(-3400, USER_A), mid);
    const back = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3400,
      messageId: mid,
      callbackData: GROUP_MENU_CALLBACK.BACK,
    });
    await handleGroupMenuCallback(back);
    assert.strictEqual(back.edits.length, 1);
    assert.deepStrictEqual(back.markupEdits, []);
    assert.strictEqual(getActiveGroupMenuMessageId(-3400, USER_A), mid);
  });

  await runTest("K. simulated restart: empty maps, old callback expires and strips", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const menu = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3500 });
    await handleMenu(menu);
    const mid = menu.replies[0].message_id;
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    assert.strictEqual(getGroupMenuOwner(-3500, mid), null);
    assert.strictEqual(getActiveGroupMenuMessageId(-3500, USER_A), null);
    const stale = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3500,
      messageId: mid,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
    });
    await handleGroupMenuCallback(stale);
    assert.deepStrictEqual(stale.answered, [MENU_EXPIRED_GENERIC]);
    assert.strictEqual(stale.markupEdits.length, 1);
    assert.ok(emptyKeyboardExtra(stale.markupEdits[0].extra));
  });

  await runTest("L. prune removes matching reverse-index entry", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    rememberGroupMenuOwner(-3600, 7, USER_A, "Kevin");
    assert.strictEqual(getActiveGroupMenuMessageId(-3600, USER_A), 7);
    pruneGroupMenusForTests(Date.now() + MAX_AGE_MS + 1);
    assert.strictEqual(getGroupMenuOwner(-3600, 7), null);
    assert.strictEqual(getActiveGroupMenuMessageId(-3600, USER_A), null);
    assert.ok(!listActiveGroupMenuKeysForTests().includes("-3600:111111111"));
  });

  await runTest("M. cap eviction removes matching reverse-index entry", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    setMaxGroupMenusForTests(2);
    rememberGroupMenuOwner(-3006, 1, USER_A, "Kevin");
    rememberGroupMenuOwner(-3006, 2, USER_B, "Piet");
    rememberGroupMenuOwner(-3006, 1, USER_A, "Kevin");
    rememberGroupMenuOwner(-3006, 3, USER_C, "Cara");
    assert.ok(getGroupMenuOwner(-3006, 1), "refreshed menu must survive");
    assert.strictEqual(getGroupMenuOwner(-3006, 2), null);
    assert.ok(getGroupMenuOwner(-3006, 3));
    assert.strictEqual(getActiveGroupMenuMessageId(-3006, USER_B), null);
    assert.strictEqual(getActiveGroupMenuMessageId(-3006, USER_A), 1);
    assert.strictEqual(getActiveGroupMenuMessageId(-3006, USER_C), 3);
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
  });

  await runTest("N. stale reverse-index pointer is repaired safely", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    setActiveGroupMenuPointerForTests(-3700, USER_A, 42);
    assert.strictEqual(getActiveGroupMenuMessageId(-3700, USER_A), null);
    assert.ok(!listActiveGroupMenuKeysForTests().includes("-3700:111111111"));
    const menu = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3700 });
    await handleMenu(menu);
    assert.strictEqual(getActiveGroupMenuMessageId(-3700, USER_A), menu.replies[0].message_id);
    assert.deepStrictEqual(menu.markupEdits, []);
  });

  await runTest("P. private hubs remain unaffected", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const priv = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: USER_A,
      chatType: "private",
    });
    await handleMenu(priv);
    assert.ok(priv.replies[0].text.includes(PRIVATE_MENU_HINT.split("\n")[0]));
    assert.strictEqual(listGroupMenuKeysForTests().length, 0);
    const hub = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: USER_A,
      chatType: "private",
      callbackData: PRIVATE_HUB_CALLBACK.GAMES,
    });
    await handlePrivateHubCallback(hub);
    assert.ok(hub.replies.length >= 1);
    assert.deepStrictEqual(hub.markupEdits, []);
    assert.strictEqual(listGroupMenuKeysForTests().length, 0);
  });

  await runTest("successful owner use refreshes LRU timestamp and order", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    const chatId = -3002;
    rememberGroupMenuOwner(chatId, 10, USER_A, "Kevin");
    rememberGroupMenuOwner(chatId, 11, USER_B, "Piet");
    const first = getGroupMenuOwner(chatId, 10);
    const cb = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId,
      messageId: 10,
      callbackData: GROUP_MENU_CALLBACK.PROFILE,
    });
    await handleGroupMenuCallback(cb);
    const refreshed = getGroupMenuOwner(chatId, 10);
    assert.ok(refreshed.rememberedAt >= first.rememberedAt);
    const keys = listGroupMenuKeysForTests();
    assert.strictEqual(keys[keys.length - 1], `${chatId}:10`);
  });

  await runTest("forgotten ownership is expired, not another player", async () => {
    resetGroupMenuOwnersForTests();
    nextTestMessageId = 1;
    rememberGroupMenuOwner(-3005, 5, USER_A, "Kevin");
    forgetGroupMenuOwner(-3005, 5);
    const ctx = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3005,
      messageId: 5,
      callbackData: GROUP_MENU_CALLBACK.BACK,
    });
    await handleGroupMenuCallback(ctx);
    assert.deepStrictEqual(ctx.answered, [MENU_EXPIRED_GENERIC]);
    assert.strictEqual(ctx.markupEdits.length, 1);
  });

  console.log("\nAll menu-ownership tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
