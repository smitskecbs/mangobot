/**
 * Group /menu ownership: LRU, expired vs other-player copy.
 * Run: node tests/menu-ownership.test.js
 */

const assert = require("assert");
const {
  rememberGroupMenuOwner,
  getGroupMenuOwner,
  forgetGroupMenuOwner,
  resetGroupMenuOwnersForTests,
  setMaxGroupMenusForTests,
  listGroupMenuKeysForTests,
  MENU_EXPIRED_GENERIC,
  MENU_UNAUTHORIZED_GENERIC,
  formatMenuUnauthorizedToast,
} = require("../utils/menuOwnership");
const {
  handleMenu,
  handleGroupMenuCallback,
} = require("../commands/menu");
const { GROUP_MENU_CALLBACK } = require("../utils/botMenu");

const USER_A = 111111111;
const USER_B = 222222222;
const USER_C = 333333333;

function createMockCtx({
  userId = USER_A,
  firstName = "Kevin",
  chatId = -3001,
  messageId,
  callbackData,
} = {}) {
  const replies = [];
  const answered = [];
  const edits = [];
  let nextId = 1;
  return {
    chat: { type: "supergroup", id: chatId },
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
    reply(text, extra) {
      const payload = {
        text,
        extra,
        message_id: messageId != null ? messageId : nextId++,
      };
      replies.push(payload);
      return Promise.resolve(payload);
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve({ text, extra });
    },
    answerCbQuery(text) {
      answered.push(text || true);
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
  await runTest("owner can use their own menu", async () => {
    resetGroupMenuOwnersForTests();
    const menu = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3001 });
    await handleMenu(menu);
    const cb = createMockCtx({
      userId: USER_A,
      firstName: "Kevin",
      chatId: -3001,
      messageId: menu.replies[0].message_id,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
    });
    await handleGroupMenuCallback(cb);
    assert.strictEqual(cb.edits.length, 1);
    assert.ok(cb.answered.includes(true));
  });

  await runTest("successful owner use refreshes LRU timestamp and order", async () => {
    resetGroupMenuOwnersForTests();
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

  await runTest("wrong user is rejected as another player's menu", async () => {
    resetGroupMenuOwnersForTests();
    const menu = createMockCtx({ userId: USER_A, firstName: "Kevin", chatId: -3003 });
    await handleMenu(menu);
    const outsider = createMockCtx({
      userId: USER_B,
      firstName: "Piet",
      chatId: -3003,
      messageId: menu.replies[0].message_id,
      callbackData: GROUP_MENU_CALLBACK.GAMES,
    });
    await handleGroupMenuCallback(outsider);
    assert.deepStrictEqual(outsider.edits, []);
    assert.deepStrictEqual(outsider.answered, [
      formatMenuUnauthorizedToast("Kevin"),
    ]);
    assert.ok(outsider.answered[0].includes("another player") === false);
    assert.ok(outsider.answered[0].includes("Kevin"));
  });

  await runTest("missing ownership returns expired copy, not another player", async () => {
    resetGroupMenuOwnersForTests();
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
  });

  await runTest("forgotten ownership is expired, not another player", async () => {
    resetGroupMenuOwnersForTests();
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
  });

  await runTest("capacity pruning keeps a recently refreshed menu", async () => {
    resetGroupMenuOwnersForTests();
    setMaxGroupMenusForTests(2);
    rememberGroupMenuOwner(-3006, 1, USER_A, "Kevin");
    rememberGroupMenuOwner(-3006, 2, USER_B, "Piet");
    rememberGroupMenuOwner(-3006, 1, USER_A, "Kevin");
    rememberGroupMenuOwner(-3006, 3, USER_C, "Cara");
    assert.ok(getGroupMenuOwner(-3006, 1), "refreshed menu must survive");
    assert.strictEqual(getGroupMenuOwner(-3006, 2), null);
    assert.ok(getGroupMenuOwner(-3006, 3));
    resetGroupMenuOwnersForTests();
  });

  console.log("\nAll menu-ownership tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
