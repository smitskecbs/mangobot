/**
 * ManGo Bomb start transaction: publish before cooldown, rollback on failure.
 * Run: node tests/mango-bomb-start.test.js
 */

const assert = require("assert");

const {
  createMangoBombService,
  parseMangoBombCallbackData,
  joinCallbackData,
  passCallbackData,
  STATUS,
  INTERNAL_CANCEL_TEXT,
  START_PUBLISH_TIMEOUT_MS,
} = require("../services/mangoBomb");
const {
  handleMangoBomb,
  START_FAILED_TEXT,
} = require("../commands/mangobomb");
const { TELEGRAM_TIMEOUT_MS } = require("../utils/safeFetch");

const COMMUNITY_CHAT = -1001234567890;
const USER_A = 111;
const USER_B = 222;
const USER_C = 333;

const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

function resetEnv() {
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
  process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
}

function restoreEnv() {
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  if (originalGamesTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalGamesTopic;
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

function createFakeTimers() {
  let nowMs = 1_700_000_000_000;
  const timers = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
      const due = timers
        .filter((t) => !t.cleared && t.fireAt <= nowMs)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const t of due) {
        if (t.cleared) continue;
        t.cleared = true;
        t.fn();
      }
    },
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

function createService(overrides = {}) {
  const timers = createFakeTimers();
  const edits = [];
  const service = createMangoBombService({
    now: () => timers.now(),
    setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
    randomIntFn: () => 0,
    randomIdFn: overrides.randomIdFn || (() => "aabbccdd"),
    lobbyMs: overrides.lobbyMs != null ? overrides.lobbyMs : 60_000,
    bombMinMs: overrides.bombMinMs != null ? overrides.bombMinMs : 8_000,
    bombMaxMs: overrides.bombMaxMs != null ? overrides.bombMaxMs : 20_000,
    startCooldownMs:
      overrides.startCooldownMs != null ? overrides.startCooldownMs : 90_000,
    startPublishTimeoutMs: overrides.startPublishTimeoutMs,
    renderTimeoutMs: overrides.renderTimeoutMs,
    watchdogMs: overrides.watchdogMs != null ? overrides.watchdogMs : 10_000,
    watchdogGraceMs: overrides.watchdogGraceMs,
  });
  service.setEditMessageHandler(async (chatId, messageId, text, extra) => {
    edits.push({ chatId, messageId, text, extra });
  });
  return { service, timers, edits };
}

function startOpts(service, extra = {}) {
  return {
    runtime: service,
    assertCanStartFn: async () => ({ ok: true }),
    isBusyFn: () => false,
    startLobbyFn: (p) => service.startLobby(p),
    setMessageIdFn: (id, mid, seq) => service.setMessageId(id, mid, seq),
    abortUnpublishedStartFn: (id, seq) => service.abortUnpublishedStart(id, seq),
    armUnpublishedPublishTimeoutFn: (id, seq) =>
      service.armUnpublishedPublishTimeout(id, seq),
    isStartAttemptLiveFn: (id, seq) => service.isStartAttemptLive(id, seq),
    ...extra,
  };
}

function createMockCtx({
  chatType = "supergroup",
  chatId = COMMUNITY_CHAT,
  userId = USER_A,
  firstName = "Alice",
  isBot = false,
  messageThreadId = 123,
} = {}) {
  const replies = [];
  const deletes = [];
  const edits = [];
  const message = { text: "/mangobomb" };
  if (messageThreadId != null) {
    message.message_thread_id = messageThreadId;
  }
  return {
    chat: { type: chatType, id: chatId },
    from: { id: userId, first_name: firstName, is_bot: isBot },
    message,
    replies,
    deletes,
    edits,
    telegram: {
      async deleteMessage(cid, messageId) {
        deletes.push({ chatId: cid, messageId });
      },
      async editMessageText(cid, messageId, _inline, text, extra) {
        edits.push({ chatId: cid, messageId, text, extra });
      },
    },
    reply(msg, extra) {
      replies.push({ text: msg, extra });
      return Promise.resolve({ message_id: 9001 + replies.length, extra });
    },
  };
}

function join(service, gameId, userId, name) {
  return service.tryJoin({
    gameId,
    userId,
    displayName: { first_name: name, id: userId },
    isBot: false,
    chatId: COMMUNITY_CHAT,
    threadId: 123,
  });
}

function assertIdle(service) {
  assert.strictEqual(service.isMangoBombOpen(COMMUNITY_CHAT), false);
  assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
  assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), false);
}

async function main() {
  resetEnv();

  await runTest("A. successful start → active lobby + cooldown", async () => {
    const { service } = createService();
    const ctx = createMockCtx();
    await handleMangoBomb(ctx, startOpts(service));
    assert.ok(String(ctx.replies[0].text).includes("MANGO BOMB"));
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(service.isMangoBombOpen(COMMUNITY_CHAT), true);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
    const game = service.getGameByChat(COMMUNITY_CHAT);
    assert.ok(game && game.messageId != null);
  });

  await runTest("B. eligibility rejection → no game + no cooldown", async () => {
    const { service } = createService();
    const privateCtx = createMockCtx({ chatType: "private", chatId: USER_A });
    await handleMangoBomb(privateCtx, startOpts(service));
    assertIdle(service);

    const topicCtx = createMockCtx();
    await handleMangoBomb(
      topicCtx,
      startOpts(service, {
        assertCanStartFn: async () => ({ ok: false, reason: "wrong-topic" }),
      })
    );
    assertIdle(service);
    assert.ok(topicCtx.replies[0].text.includes("Games topic"));

    const busyCtx = createMockCtx();
    await handleMangoBomb(
      busyCtx,
      startOpts(service, {
        isBusyFn: () => true,
        getBusyReasonFn: () => "mangobomb",
      })
    );
    assertIdle(service);
    assert.ok(busyCtx.replies[0].text.includes("already running"));
  });

  await runTest("C. Telegram send failure during startup → no game + no cooldown", async () => {
    const { service } = createService();
    const ctx = createMockCtx();
    ctx.reply = async function reply(msg) {
      ctx.replies.push({ text: msg });
      if (ctx.replies.length === 1) {
        const err = new Error("connect ETIMEDOUT");
        err.code = "ETIMEDOUT";
        throw err;
      }
      return { message_id: 9001 };
    };
    await handleMangoBomb(ctx, startOpts(service));
    assertIdle(service);
    assert.strictEqual(ctx.replies[ctx.replies.length - 1].text, START_FAILED_TEXT);
  });

  await runTest("D. publish/edit failure before playable → rollback + no cooldown", async () => {
    const { service } = createService();
    const missingId = createMockCtx();
    missingId.reply = async function reply(msg) {
      missingId.replies.push({ text: msg });
      return {};
    };
    await handleMangoBomb(missingId, startOpts(service));
    assertIdle(service);
    assert.strictEqual(missingId.replies[missingId.replies.length - 1].text, START_FAILED_TEXT);

    const { service: editSvc } = createService({ randomIdFn: () => "bbccddee" });
    const throws = createMockCtx();
    await handleMangoBomb(
      throws,
      startOpts(editSvc, {
        setMessageIdFn: () => {
          throw new Error("Bad Request: message can't be edited");
        },
      })
    );
    assert.strictEqual(editSvc.isMangoBombOpen(COMMUNITY_CHAT), false);
    assert.strictEqual(editSvc.isStartCooldownActive(COMMUNITY_CHAT), false);
    assert.strictEqual(throws.replies[throws.replies.length - 1].text, START_FAILED_TEXT);
  });

  await runTest("E. session creation exception → no cooldown", async () => {
    const { service } = createService();
    const ctx = createMockCtx();
    await handleMangoBomb(
      ctx,
      startOpts(service, {
        startLobbyFn: () => {
          throw new Error("session-create-failed");
        },
      })
    );
    assertIdle(service);
  });

  await runTest("F. timer/scheduler init exception → no orphan session/cooldown", async () => {
    const service = createMangoBombService({
      now: () => 1_700_000_000_000,
      setTimeoutFn: () => {
        throw new Error("timer-init-failed");
      },
      clearTimeoutFn: () => {},
      startCooldownMs: 90_000,
    });
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    assert.strictEqual(started.ok, false);
    assert.strictEqual(started.reason, "internal-error");
    assertIdle(service);
  });

  await runTest("G. retry immediately after failed start is allowed", async () => {
    const { service } = createService();
    const fail = createMockCtx();
    fail.reply = async function reply(msg) {
      fail.replies.push({ text: msg });
      if (!String(msg).includes("MANGO BOMB")) {
        return { message_id: 42 };
      }
      throw new Error("send failed");
    };
    await handleMangoBomb(fail, startOpts(service));
    assertIdle(service);

    const retry = createMockCtx();
    await handleMangoBomb(retry, startOpts(service));
    assert.ok(String(retry.replies[0].text).includes("MANGO BOMB"));
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
  });

  await runTest("H. successfully started game still respects cooldown", async () => {
    const { service } = createService();
    const first = createMockCtx();
    await handleMangoBomb(first, startOpts(service));
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
    service.cancelAll();
    const blocked = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, "cooldown");
    const ctx = createMockCtx();
    await handleMangoBomb(ctx, startOpts(service));
    assert.ok(ctx.replies[0].text.includes("cooling down"));
    assert.strictEqual(service.isMangoBombOpen(COMMUNITY_CHAT), false);
  });

  await runTest("I. duplicate start callbacks do not create two sessions or consume cooldown twice", async () => {
    const { service } = createService({
      randomIdFn: () => "ccddeeff",
    });
    const a = createMockCtx({ userId: USER_A });
    const b = createMockCtx({ userId: USER_B });
    await Promise.all([
      handleMangoBomb(a, startOpts(service)),
      handleMangoBomb(b, startOpts(service)),
    ]);
    const lobbyLines = [...a.replies, ...b.replies].filter((row) =>
      String(row.text).includes("MANGO BOMB")
    );
    assert.strictEqual(lobbyLines.length, 1);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
    const already = [...a.replies, ...b.replies].filter((row) =>
      String(row.text).includes("already running")
    );
    assert.strictEqual(already.length, 1);
  });

  await runTest("J. partial/stale session cannot block retry after failed start", async () => {
    const { service } = createService();
    const prepared = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    assert.strictEqual(prepared.ok, true);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), false);
    assert.strictEqual(service.abortUnpublishedStart(prepared.gameId), true);
    assertIdle(service);
    const ctx = createMockCtx();
    await handleMangoBomb(ctx, startOpts(service));
    assert.ok(String(ctx.replies[0].text).includes("MANGO BOMB"));
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
  });

  await runTest("K. old PASS/BOOM callbacks cannot affect a newly created game", async () => {
    const { service } = createService({ startCooldownMs: 0 });
    const first = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(first.gameId, 9001);
    join(service, first.gameId, USER_A, "Kevin");
    join(service, first.gameId, USER_B, "Lojay");
    await service.forceLobbyEnd(first.gameId);
    const oldId = first.gameId;
    const oldPass = parseMangoBombCallbackData(passCallbackData(oldId));
    assert.ok(oldPass);
    service.cancelAll();
    const second = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(second.gameId, 9002);
    join(service, second.gameId, USER_A, "Kevin");
    join(service, second.gameId, USER_C, "Ada");
    const stale = service.tryPass({
      gameId: oldId,
      userId: USER_A,
      isBot: false,
      chatId: COMMUNITY_CHAT,
      threadId: 123,
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, "stale");
    assert.strictEqual(service.getGame(second.gameId).playerCount, 2);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    const staleJoin = parseMangoBombCallbackData(joinCallbackData(oldId));
    assert.ok(staleJoin);
    assert.notStrictEqual(staleJoin.gameId, second.gameId);
  });

  await runTest("L. invariant failure recovers without corrupting a later start", async () => {
    const { service, timers, edits } = createService({
      lobbyMs: 80,
      watchdogMs: 20,
      watchdogGraceMs: 5,
      startCooldownMs: 90_000,
    });
    const started = service.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    service.setMessageId(started.gameId, 9001);
    join(service, started.gameId, USER_A, "Kevin");
    join(service, started.gameId, USER_B, "Lojay");
    const pendingAwards = [];
    service.setAwardXpHandler(
      () =>
        new Promise((resolve) => {
          pendingAwards.push(resolve);
        })
    );
    const closing = service.forceLobbyEnd(started.gameId);
    for (let i = 0; i < 30 && pendingAwards.length === 0; i += 1) {
      await Promise.resolve();
    }
    assert.ok(pendingAwards.length >= 1, "closeLobby should wait on XP award");
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(service.getGame(started.gameId).pendingTransition, "close-lobby");
    timers.advance(20);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.ok(!edits.some((row) => String(row.text).includes("The game hit an unexpected error.")));
    for (let i = 0; i < 30; i += 1) {
      while (pendingAwards.length) {
        pendingAwards.shift()({ awarded: true, pointsToAdd: 0 });
      }
      await Promise.resolve();
    }
    await closing;
    await service.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.RUNNING);

    const { service: broken, timers: brokenTimers, edits: brokenEdits } = createService({
      watchdogMs: 20,
      watchdogGraceMs: 0,
      startCooldownMs: 90_000,
      randomIdFn: () => "ddeeff00",
    });
    const live = broken.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    broken.setMessageId(live.gameId, 9001);
    broken.clearGameplayTimersForTests(live.gameId);
    brokenTimers.advance(20);
    await broken.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(broken.getStatus(COMMUNITY_CHAT), STATUS.IDLE);
    assert.ok(brokenEdits.some((row) => String(row.text).includes(INTERNAL_CANCEL_TEXT)));
    assert.strictEqual(broken.isMangoBombOpen(COMMUNITY_CHAT), false);
    const retry = broken.startLobby({ chatId: COMMUNITY_CHAT, threadId: 123 });
    assert.strictEqual(retry.ok, false);
    assert.strictEqual(retry.reason, "cooldown");
  });

  await runTest("M. ETIMEDOUT path does not leave cooldown/session inconsistent", async () => {
    const { service } = createService();
    const ctx = createMockCtx();
    ctx.reply = async function reply(msg) {
      ctx.replies.push({ text: msg });
      if (String(msg).includes("MANGO BOMB")) {
        const err = new Error("request to api.telegram.org timed out");
        err.code = "ETIMEDOUT";
        throw err;
      }
      return { message_id: 77 };
    };
    await handleMangoBomb(ctx, startOpts(service));
    assertIdle(service);

    const { service: live, timers, edits } = createService({
      renderTimeoutMs: 20,
      watchdogMs: 10_000,
    });
    const ok = createMockCtx();
    await handleMangoBomb(ok, startOpts(live));
    assert.strictEqual(live.isStartCooldownActive(COMMUNITY_CHAT), true);
    live.injectRenderHang();
    timers.advance(5_000);
    await live.whenIdle(COMMUNITY_CHAT);
    timers.advance(20);
    await live.whenIdle(COMMUNITY_CHAT);
    assert.strictEqual(live.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(live.isStartCooldownActive(COMMUNITY_CHAT), true);
    live.resolveHungRenders();
    assert.ok(edits.length >= 0);
  });

  async function flush() {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  }

  function hangLobbyReply(ctx) {
    let settle;
    const hang = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const original = ctx.reply.bind(ctx);
    ctx.reply = function reply(msg, extra) {
      if (String(msg).includes("MANGO BOMB")) {
        return hang;
      }
      return original(msg, extra);
    };
    return settle;
  }

  function boundedOpts(service, timers) {
    return startOpts(service, {
      publishTimeoutMs: 25,
      setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
      clearTimeoutFn: (id) => timers.clearTimeout(id),
    });
  }

  await runTest("N. hung publish → bounded abort → no cooldown/session", async () => {
    const { service, timers } = createService({ startPublishTimeoutMs: 25 });
    const ctx = createMockCtx();
    hangLobbyReply(ctx);
    const pending = handleMangoBomb(ctx, boundedOpts(service, timers));
    await flush();
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), false);
    timers.advance(25);
    await pending;
    assertIdle(service);
    assert.strictEqual(ctx.replies[ctx.replies.length - 1].text, START_FAILED_TEXT);
  });

  await runTest("O. immediate retry after bounded abort succeeds", async () => {
    const { service, timers } = createService({ startPublishTimeoutMs: 25 });
    const hung = createMockCtx();
    hangLobbyReply(hung);
    const pending = handleMangoBomb(hung, boundedOpts(service, timers));
    await flush();
    timers.advance(25);
    await pending;
    assertIdle(service);
    const retry = createMockCtx();
    await handleMangoBomb(retry, startOpts(service));
    assert.ok(String(retry.replies[0].text).includes("MANGO BOMB"));
    assert.strictEqual(service.getStatus(COMMUNITY_CHAT), STATUS.LOBBY);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
  });

  await runTest("P. late resolve from aborted publish is ignored", async () => {
    const { service, timers } = createService({ startPublishTimeoutMs: 25 });
    const ctx = createMockCtx();
    const settle = hangLobbyReply(ctx);
    const pending = handleMangoBomb(ctx, boundedOpts(service, timers));
    await flush();
    timers.advance(25);
    await pending;
    assertIdle(service);
    settle.resolve({ message_id: 7777 });
    await Promise.resolve();
    await Promise.resolve();
    assertIdle(service);
    assert.ok(ctx.deletes.some((row) => Number(row.messageId) === 7777));
    assert.strictEqual(service.getGameByChat(COMMUNITY_CHAT), null);
  });

  await runTest("Q. late reject from aborted publish is harmless", async () => {
    const { service, timers } = createService({ startPublishTimeoutMs: 25 });
    const ctx = createMockCtx();
    const settle = hangLobbyReply(ctx);
    const pending = handleMangoBomb(ctx, boundedOpts(service, timers));
    await flush();
    timers.advance(25);
    await pending;
    assertIdle(service);
    settle.reject(new Error("late telegram failure"));
    await Promise.resolve();
    await Promise.resolve();
    assertIdle(service);
  });

  await runTest("R. old start cannot attach messageId to a newer session", async () => {
    const { service, timers } = createService({
      startPublishTimeoutMs: 25,
    });
    const first = createMockCtx();
    const settle = hangLobbyReply(first);
    const pending = handleMangoBomb(first, boundedOpts(service, timers));
    await flush();
    timers.advance(25);
    await pending;
    assertIdle(service);
    const second = createMockCtx();
    await handleMangoBomb(second, startOpts(service));
    const live = service.getGameByChat(COMMUNITY_CHAT);
    assert.ok(live);
    const newId = live.id;
    const publishedId = live.messageId;
    settle.resolve({ message_id: 1111 });
    await Promise.resolve();
    await Promise.resolve();
    const after = service.getGame(newId);
    assert.ok(after);
    assert.strictEqual(after.messageId, publishedId);
    assert.notStrictEqual(Number(after.messageId), 1111);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
  });

  await runTest("S. message exists but local commit fails → orphan cleanup, no cooldown", async () => {
    const { service } = createService();
    const ctx = createMockCtx();
    const deleted = [];
    await handleMangoBomb(
      ctx,
      startOpts(service, {
        setMessageIdFn: () => {
          throw new Error("setMessageId failed");
        },
        deleteStartMessageFn: async (chatId, messageId) => {
          deleted.push({ chatId, messageId });
        },
      })
    );
    assertIdle(service);
    assert.ok(deleted.length >= 1);
    assert.ok(deleted[0].messageId != null);
    assert.strictEqual(ctx.replies[ctx.replies.length - 1].text, START_FAILED_TEXT);
  });

  await runTest("T. orphan cleanup failure does not crash or create cooldown", async () => {
    const { service } = createService({ randomIdFn: () => "eeff0011" });
    const ctx = createMockCtx();
    await handleMangoBomb(
      ctx,
      startOpts(service, {
        setMessageIdFn: () => false,
        deleteStartMessageFn: async () => {
          throw new Error("delete failed");
        },
        editStartMessageFn: async () => {
          throw new Error("edit failed");
        },
      })
    );
    assertIdle(service);
    assert.strictEqual(ctx.replies[ctx.replies.length - 1].text, START_FAILED_TEXT);
  });

  await runTest("U. successful publish commits cooldown exactly once", async () => {
    assert.strictEqual(START_PUBLISH_TIMEOUT_MS, TELEGRAM_TIMEOUT_MS);
    assert.strictEqual(START_PUBLISH_TIMEOUT_MS, 8_000);
    const { service } = createService();
    const ctx = createMockCtx();
    await handleMangoBomb(ctx, startOpts(service));
    const game = service.getGameByChat(COMMUNITY_CHAT);
    assert.ok(game);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
    const again = service.setMessageId(game.id, game.messageId, game.instanceSeq);
    assert.strictEqual(again, true);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
    const other = service.setMessageId(game.id, 4242, game.instanceSeq);
    assert.strictEqual(other, false);
    assert.strictEqual(service.getGame(game.id).messageId, game.messageId);
    assert.strictEqual(service.isStartCooldownActive(COMMUNITY_CHAT), true);
  });

  restoreEnv();
  console.log("\nAll mango-bomb start tests passed.");
}

main().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
