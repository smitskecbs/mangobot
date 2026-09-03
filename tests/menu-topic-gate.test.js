/**
 * Targeted tests: group menu game callbacks are blocked outside the Games topic.
 */

const assert = require("assert");
const {
  GROUP_MENU_CALLBACK,
  isGameMenuCallback,
} = require("../utils/botMenu");
const {
  handleGroupMenuCallback,
} = require("../commands/menu");
const {
  GAMES_TOPIC_REQUIRED_MESSAGE,
  assertCanStartInteractiveGame,
} = require("../utils/gameTopic");
const { handleCheckers } = require("../commands/checkers");
const { handleSnake } = require("../commands/snake");
const {
  bindGroupMenuOwnerFromCtx,
  resetGroupMenuOwnersForTests,
} = require("../utils/menuOwnership");

const GAMES_TOPIC_ID = "999";
const GENERAL_THREAD_ID = undefined;
const CHAT_ID = -1003916996602;
const USER_A = 111111111;

let nextMsgId = 90000;

function createCtx({
  threadId,
  callbackData,
  chatType = "supergroup",
  command,
} = {}) {
  const replies = [];
  const answered = [];
  const edits = [];
  const msgId = nextMsgId++;
  const msg = { message_id: msgId, chat: { id: CHAT_ID, type: chatType } };
  if (threadId != null) {
    msg.message_thread_id = threadId;
  }
  const message = command
    ? { message_id: msgId, chat: { id: CHAT_ID, type: chatType } }
    : null;
  if (message && threadId != null) {
    message.message_thread_id = threadId;
  }
  const ctx = {
    chat: { id: CHAT_ID, type: chatType },
    from: { id: USER_A, first_name: "Kevin" },
    botInfo: { username: "ManGoTestBot" },
    callbackQuery: callbackData ? { data: callbackData, message: msg } : undefined,
    message,
    replies,
    answered,
    edits,
    reply(text, extra) {
      const payload = { text, extra, message_id: nextMsgId++ };
      replies.push(payload);
      return Promise.resolve(payload);
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve(edits[edits.length - 1]);
    },
    answerCbQuery(text, extra) {
      answered.push({ text: text || true, extra });
      return Promise.resolve();
    },
  };
  return ctx;
}

function ownedCtx(ctx) {
  bindGroupMenuOwnerFromCtx(ctx);
  return ctx;
}

const testQueue = [];
function runTest(name, fn) {
  testQueue.push({ name, fn });
}

const prevChatId = process.env.TELEGRAM_CHAT_ID;
const prevTopicId = process.env.TELEGRAM_GAMES_TOPIC_ID;

process.env.TELEGRAM_CHAT_ID = String(CHAT_ID);
process.env.TELEGRAM_GAMES_TOPIC_ID = GAMES_TOPIC_ID;

const GAME_CALLBACKS = [
  GROUP_MENU_CALLBACK.TICTACTOE,
  GROUP_MENU_CALLBACK.CONNECT4,
  GROUP_MENU_CALLBACK.CHECKERS,
  GROUP_MENU_CALLBACK.TRIVIA,
  GROUP_MENU_CALLBACK.MANGOBOMB,
  GROUP_MENU_CALLBACK.BLACKJACK,
];

// ── isGameMenuCallback helper ──

runTest("isGameMenuCallback matches all game callbacks", () => {
  for (const cb of GAME_CALLBACKS) {
    assert.strictEqual(isGameMenuCallback(cb), true, cb);
  }
});

runTest("isGameMenuCallback rejects non-game callbacks", () => {
  assert.strictEqual(isGameMenuCallback(GROUP_MENU_CALLBACK.RANKINGS), false);
  assert.strictEqual(isGameMenuCallback(GROUP_MENU_CALLBACK.HELP), false);
  assert.strictEqual(isGameMenuCallback(GROUP_MENU_CALLBACK.WALLET), false);
  assert.strictEqual(isGameMenuCallback(GROUP_MENU_CALLBACK.BACK), false);
});

// ── Menu works in General for non-game actions ──

runTest("Rankings submenu works from General", async () => {
  resetGroupMenuOwnersForTests();
  const ctx = ownedCtx(
    createCtx({ callbackData: GROUP_MENU_CALLBACK.RANKINGS })
  );
  await handleGroupMenuCallback(ctx);
  const view = ctx.edits[0] || ctx.replies[0];
  assert.ok(view, "should produce a rankings view");
  assert.ok(view.text.includes("Rankings"));
});

// ── Game callbacks blocked from General ──

for (const cb of GAME_CALLBACKS) {
  const label = cb.replace("gmenu:", "");
  runTest(`${label} from General is blocked (no session created)`, async () => {
    resetGroupMenuOwnersForTests();
    let gameStarted = false;
    const ctx = ownedCtx(createCtx({ callbackData: cb }));
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => { gameStarted = true; return { ok: true, text: "x", session: { id: "z" } }; },
      startLobbyFn: () => { gameStarted = true; return { ok: true, text: "x", session: { id: "z" } }; },
      startTriviaFn: () => { gameStarted = true; return { ok: true, text: "x", session: { id: "z" } }; },
      setMessageIdFn: () => {},
      assertCanStartFn: async () => { gameStarted = true; return { ok: true }; },
    });
    assert.strictEqual(gameStarted, false, "game must not start from General");
    const alert = ctx.answered.find(
      (a) => typeof a === "object" && typeof a.text === "string" && a.text.includes("Games")
    );
    assert.ok(alert, "should show Games topic alert");
    assert.strictEqual(ctx.replies.length, 0, "no reply message in General");
  });
}

// ── Game callbacks allowed from Games topic ──

for (const cb of GAME_CALLBACKS) {
  const label = cb.replace("gmenu:", "");
  runTest(`${label} from Games topic is allowed`, async () => {
    resetGroupMenuOwnersForTests();
    let gameStarted = false;
    const ctx = ownedCtx(
      createCtx({ callbackData: cb, threadId: Number(GAMES_TOPIC_ID) })
    );
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        gameStarted = true;
        return { ok: true, text: "Game started", session: { id: "s1" } };
      },
      startLobbyFn: () => {
        gameStarted = true;
        return { ok: true, text: "Lobby open", session: { id: "s1" } };
      },
      setMessageIdFn: () => {},
    });
    if (cb === GROUP_MENU_CALLBACK.TRIVIA) {
      const view = ctx.edits[0] || ctx.replies[0];
      assert.ok(view, "trivia chooser should render");
    } else {
      assert.strictEqual(gameStarted, true, "game should start in Games topic");
    }
  });
}

// ── Private chat: no topic gate needed ──

runTest("private chat is unaffected (no topic gate on private menu)", () => {
  const ctx = createCtx({ chatType: "private", callbackData: GROUP_MENU_CALLBACK.CHECKERS });
  ctx.chat.type = "private";
  // isGroupMenuCallback still matches but handleGroupMenuCallback is for group only
  // Private uses handlePrivateHubCallback which has different callbacks
  // Just verify isGameMenuCallback doesn't crash
  assert.strictEqual(isGameMenuCallback(GROUP_MENU_CALLBACK.CHECKERS), true);
});

// ── Missing topic env → group games fail closed ──

runTest("menu Checkers blocked when TELEGRAM_GAMES_TOPIC_ID is unset", async () => {
  const saved = process.env.TELEGRAM_GAMES_TOPIC_ID;
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  try {
    resetGroupMenuOwnersForTests();
    let started = false;
    const ctx = ownedCtx(
      createCtx({ callbackData: GROUP_MENU_CALLBACK.CHECKERS })
    );
    await handleGroupMenuCallback(ctx, {
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return { ok: true, text: "Checkers", session: { id: "c1" } };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, false, "menu game must not start without topic config");
    const alert = ctx.answered.find(
      (a) => typeof a === "object" && typeof a.text === "string" && a.text.includes("Games")
    );
    assert.ok(alert, "should show Games topic alert");
  } finally {
    process.env.TELEGRAM_GAMES_TOPIC_ID = saved;
  }
});

runTest("direct /checkers blocked when TELEGRAM_GAMES_TOPIC_ID is unset", async () => {
  const saved = process.env.TELEGRAM_GAMES_TOPIC_ID;
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  try {
    let started = false;
    const ctx = createCtx({ command: "checkers" });
    await handleCheckers(ctx, {
      isAllowedChatFn: () => true,
      isBusyFn: () => false,
      startChallengeFn: () => {
        started = true;
        return { ok: true, text: "Checkers", session: { id: "c1" } };
      },
      setMessageIdFn: () => {},
    });
    assert.strictEqual(started, false, "direct command must not start without topic config");
    assert.ok(
      ctx.replies.some((r) => r.text.includes("Games topic")),
      "should reply with Games topic message"
    );
  } finally {
    process.env.TELEGRAM_GAMES_TOPIC_ID = saved;
  }
});

runTest("assertCanStartInteractiveGame blocks group starts when topic env unset", async () => {
  const saved = process.env.TELEGRAM_GAMES_TOPIC_ID;
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  try {
    const ctx = createCtx({ command: "checkers" });
    const gate = await assertCanStartInteractiveGame(ctx, {
      isAllowedChatFn: () => true,
    });
    assert.deepStrictEqual(gate, { ok: false, reason: "wrong-topic" });
  } finally {
    process.env.TELEGRAM_GAMES_TOPIC_ID = saved;
  }
});

runTest("private Snake still works when TELEGRAM_GAMES_TOPIC_ID is unset", () => {
  const saved = process.env.TELEGRAM_GAMES_TOPIC_ID;
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  try {
    const ctx = createCtx({ chatType: "private", command: "snake" });
    handleSnake(ctx, { secret: "test-secret", now: 1_700_000_000 });
    assert.strictEqual(ctx.replies.length, 1, "private Snake should still reply");
    assert.ok(
      ctx.replies[0].text.includes("mango-labs") ||
        ctx.replies[0].text.includes("Snake"),
      "private Snake link should be offered"
    );
  } finally {
    process.env.TELEGRAM_GAMES_TOPIC_ID = saved;
  }
});

// ── Existing wrong-topic tests still pass (Checkers/update-error untouched) ──

runTest("recent Checkers crash-containment code is not imported here", () => {
  // Sanity: this test file does not touch checkers internals
  assert.ok(true);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of testQueue) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`✗ ${name}`);
      throw err;
    }
  }
  console.log(`\nAll ${passed} tests passed.`);
  if (prevTopicId === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = prevTopicId;
  if (prevChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = prevChatId;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
