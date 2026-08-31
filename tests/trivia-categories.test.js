/**
 * Trivia Hub category menu + /trivia chooser.
 * Run: node tests/trivia-categories.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  createTriviaService,
  TRIVIA_HUB_ACTION,
  buildCategoryCallbackData,
  parseTriviaHubCallback,
  buildTriviaChooserKeyboard,
} = require("../services/trivia");
const {
  TRIVIA_HUB_CATEGORIES,
  TRIVIA_QUESTIONS,
  isHubCategoryId,
} = require("../services/triviaQuestions");
const {
  handleTrivia,
  handleTriviaHubCallback,
} = require("../commands/trivia");
const { handleGroupMenuCallback } = require("../commands/menu");
const { bindGroupMenuOwnerFromCtx } = require("../utils/menuOwnership");
const { GROUP_MENU_CALLBACK, GROUP_GAMES_TEXT } = require("../utils/botMenu");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-trivia-cat-"));
const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const OWNER_ID = 999001;

const originalAdmin = process.env.ADMIN_USER_ID;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

function resetEnv() {
  process.env.ADMIN_USER_ID = String(OWNER_ID);
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
}

function restoreEnv() {
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalGamesTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalGamesTopic;
}

function createFakeTimers() {
  let nowMs = 1_700_000_000_000;
  const timers = [];
  let nextId = 1;
  return {
    now: () => nowMs,
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

function createService() {
  const timers = createFakeTimers();
  const service = createTriviaService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    random: () => 0,
    randomIdFn: () => "abc123",
    questions: TRIVIA_QUESTIONS,
  });
  return { service, timers };
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Alice",
  text = "/trivia",
  isBot = false,
  memberStatus = "member",
  callbackData,
  messageThreadId,
} = {}) {
  const replies = [];
  const replyExtras = [];
  const cbAnswers = [];
  const edited = [];
  const message = { text };
  if (messageThreadId != null) {
    message.message_thread_id = messageThreadId;
  }
  const callbackQuery = callbackData
    ? {
        data: callbackData,
        from: { id: userId, is_bot: isBot },
        message: {
          message_id: 9001,
          chat: { id: chatId, type: chatType },
          ...(messageThreadId != null
            ? { message_thread_id: messageThreadId }
            : {}),
        },
      }
    : undefined;
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName, is_bot: isBot },
    message,
    callbackQuery,
    replies,
    replyExtras,
    cbAnswers,
    edited,
    telegram: {
      getChatMember() {
        return Promise.resolve({ status: memberStatus, user: { id: userId } });
      },
    },
    reply(msg, extra) {
      replies.push(msg);
      replyExtras.push(extra);
      return Promise.resolve({ message_id: 9001, extra });
    },
    answerCbQuery(msg) {
      cbAnswers.push(msg || "");
      return Promise.resolve();
    },
    editMessageText(msg, extra) {
      edited.push({ text: msg, extra });
      return Promise.resolve({ message_id: 9001, extra });
    },
  };
}

function viewText(ctx) {
  if (ctx.edited.length) {
    return ctx.edited[ctx.edited.length - 1].text;
  }
  return ctx.replies[ctx.replies.length - 1] || "";
}

function viewExtra(ctx) {
  if (ctx.edited.length) {
    return ctx.edited[ctx.edited.length - 1].extra;
  }
  return ctx.replyExtras[ctx.replyExtras.length - 1];
}

function keyboardButtons(extra) {
  const rows =
    extra && extra.reply_markup && extra.reply_markup.inline_keyboard
      ? extra.reply_markup.inline_keyboard
      : [];
  return rows.flat();
}

async function runTest(name, fn) {
  resetEnv();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  resetEnv();

  await runTest("1. Games → Trivia opens category chooser", async () => {
    const ctx = createMockCtx({ callbackData: GROUP_MENU_CALLBACK.TRIVIA });
    bindGroupMenuOwnerFromCtx(ctx);
    await handleGroupMenuCallback(ctx, { isBusyFn: () => false });
    const text = viewText(ctx);
    assert.ok(text.includes("🧠 ManGo Trivia"));
    assert.ok(text.includes("Choose a category"));
    assert.ok(text.includes("🎯 XP-eligible plays: 0 / 5"));
    const buttons = keyboardButtons(viewExtra(ctx));
    for (const row of TRIVIA_HUB_CATEGORIES) {
      assert.ok(
        buttons.some((b) => b.callback_data === buildCategoryCallbackData(row.id)),
        `missing ${row.id}`
      );
      assert.ok(buttons.some((b) => b.text.includes(row.label)));
    }
    assert.ok(buttons.some((b) => b.callback_data === TRIVIA_HUB_ACTION.GAMES));
    assert.ok(buttons.some((b) => /Back/.test(b.text)));
  });

  const categoryCases = [
    ["2. Geography button", "geography", "Geography"],
    ["3. History button", "history", "History"],
    ["4. Math button", "math", "Math"],
    ["5. Science button", "science", "Science"],
    ["6. General button", "general", "General Knowledge"],
    ["7. Entertainment button", "entertainment", "Entertainment"],
    ["8. Random button", "random", "Random"],
  ];

  for (const [name, category, label] of categoryCases) {
    await runTest(name, async () => {
      const { service } = createService();
      const ctx = createMockCtx({
        callbackData: buildCategoryCallbackData(category),
      });
      await handleTriviaHubCallback(ctx, {
        runtime: service,
        startTriviaFn: (p) => service.startTrivia(p),
        setMessageIdFn: (id, mid) => service.setMessageId(id, mid),
        isBusyFn: () => false,
      });
      assert.strictEqual(service.isTriviaOpen(), true);
      const snap = service.getSnapshot();
      assert.strictEqual(snap.hubMode, true);
      assert.strictEqual(snap.category, category);
      const text = viewText(ctx);
      assert.ok(text.includes("Question 1"));
      assert.ok(!text.includes("Question 1 / 5"));
      if (category === "random") {
        assert.ok(/Trivia/.test(text));
      } else {
        assert.ok(text.includes(label));
      }
      const buttons = keyboardButtons(viewExtra(ctx));
      assert.ok(buttons.some((b) => b.callback_data === "trivia:abc123:0"));
      assert.ok(isHubCategoryId(category));
      service.reset();
    });
  }

  await runTest("9. Back works", async () => {
    const { service } = createService();
    const ctx = createMockCtx({ callbackData: TRIVIA_HUB_ACTION.GAMES });
    await handleTriviaHubCallback(ctx, {
      runtime: service,
      isBusyFn: () => false,
    });
    assert.ok(viewText(ctx).includes("Games") || viewText(ctx) === GROUP_GAMES_TEXT);
    const buttons = keyboardButtons(viewExtra(ctx));
    assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.TRIVIA));
    assert.ok(buttons.some((b) => b.callback_data === GROUP_MENU_CALLBACK.BACK));
  });

  await runTest("10. /trivia backward compatible opens chooser", async () => {
    const { service } = createService();
    const ctx = createMockCtx({ text: "/trivia" });
    await handleTrivia(ctx, {
      startTriviaFn: (p) => service.startTrivia(p),
      isBusyFn: () => false,
    });
    assert.strictEqual(service.isTriviaOpen(), false);
    assert.ok(viewText(ctx).includes("Choose a category"));
    assert.ok(parseTriviaHubCallback("trivia:cat:math").category === "math");
    assert.strictEqual(parseTriviaHubCallback("trivia:hub").action, "hub");
    assert.deepStrictEqual(parseTriviaHubCallback("trivia:next:abc123"), {
      action: "next",
      sessionId: "abc123",
    });
    assert.deepStrictEqual(parseTriviaHubCallback("trivia:change"), {
      action: "change",
      sessionId: null,
    });
    const chooser = buildTriviaChooserKeyboard();
    assert.ok(chooser.reply_markup.inline_keyboard.length >= 8);
  });

  for (const [file, mtime] of Object.entries(prodMtimes)) {
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime, `mutated ${file}`);
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  console.log("\nAll trivia-categories tests passed.");
}

main().catch((err) => {
  console.error(err);
  restoreEnv();
  process.exitCode = 1;
});
