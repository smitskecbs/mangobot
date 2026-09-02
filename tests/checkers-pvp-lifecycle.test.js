/**
 * Human vs human Checkers lifecycle: lobby timers must not cancel ACTIVE PvP.
 * Run: node tests/checkers-pvp-lifecycle.test.js
 */

const assert = require("assert");

const {
  createCheckersService,
  parsePvpCallbackData,
  buildSelectCallbackData,
  JOIN_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  STATUS,
} = require("../services/checkers");
const { legalMoves } = require("../services/checkersRules");
const { handlePvpCallback, registerPvpCallbacks } = require("../events/pvp-callbacks");
const {
  GAME_TYPE,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  buildFinalGameText,
  FINAL_STATE,
  getPendingGameMessageCleanupCount,
  clearAllGameMessageCleanups,
} = require("../utils/gameCleanup");

const COMMUNITY_CHAT = -1001234567890;
const KEVIN = 111;
const PIPPI = 222;
const originalChatId = process.env.TELEGRAM_CHAT_ID;

function resetEnv() {
  process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
}

function restoreEnv() {
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
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
  const service = createCheckersService({
    now: timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    joinTimeoutMs:
      overrides.joinTimeoutMs != null ? overrides.joinTimeoutMs : JOIN_TIMEOUT_MS,
    turnTimeoutMs:
      overrides.turnTimeoutMs != null ? overrides.turnTimeoutMs : TURN_TIMEOUT_MS,
    botThinkMinMs: 0,
    botThinkMaxMs: 0,
  });
  return { service, timers };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function startKevinLobby(service) {
  const started = service.startChallenge({
    chatId: COMMUNITY_CHAT,
    starter: { userId: KEVIN, displayName: "Kevin", isBot: false },
  });
  assert.strictEqual(started.ok, true);
  service.setMessageId(started.session.id, 8001);
  return started;
}

function pippiJoins(service, sessionId) {
  const joined = service.join({
    sessionId,
    userId: PIPPI,
    displayName: "Pippi",
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(joined.ok, true);
  assert.strictEqual(joined.session.status, STATUS.ACTIVE);
  assert.strictEqual(joined.session.opponentType, "human");
  return joined;
}

function currentUserId(session) {
  return session.currentPlayer === "w" ? PIPPI : KEVIN;
}

async function playOneLegalMove(service, sessionId) {
  const session = service.getSession(sessionId);
  assert.strictEqual(session.status, STATUS.ACTIVE);
  const moves = legalMoves({
    board: session.board,
    current: session.currentPlayer,
    pendingFrom: session.pendingFrom,
  });
  assert.ok(moves.length > 0, "expected legal moves in an active match");
  const spec = moves[0];
  const moved = await service.move({
    sessionId,
    userId: currentUserId(session),
    from: spec.from,
    to: spec.to,
    chatId: COMMUNITY_CHAT,
  });
  assert.strictEqual(moved.ok, true);
  return moved;
}

function createMockCtx({
  userId,
  firstName,
  callbackData,
  messageId = 8001,
  withButtons = true,
}) {
  const ctx = {
    chat: { id: COMMUNITY_CHAT, type: "supergroup" },
    from: { id: userId, first_name: firstName, is_bot: false },
    callbackQuery: {
      id: "cb1",
      data: callbackData,
      message: {
        message_id: messageId,
        chat: { id: COMMUNITY_CHAT },
        reply_markup: withButtons
          ? {
              inline_keyboard: [[{ text: "🟠", callback_data: callbackData }]],
            }
          : undefined,
      },
    },
    answered: [],
    edits: [],
    async answerCbQuery(text) {
      ctx.answered.push(text || "");
    },
    async editMessageText(text, extra) {
      ctx.edits.push({ text, extra });
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
    restoreEnv();
    throw err;
  }
}

async function main() {
  resetEnv();
  clearAllGameMessageCleanups();

  await runTest("production lobby is 60s and human turn is 120s", async () => {
    assert.strictEqual(JOIN_TIMEOUT_MS, 60 * 1000);
    assert.strictEqual(TURN_TIMEOUT_MS, 120 * 1000);
    assert.strictEqual(GAME_MESSAGE_CLEANUP_DELAY_MS, 5 * 60 * 1000);
    const { service } = createService();
    assert.strictEqual(service.joinTimeoutMs, JOIN_TIMEOUT_MS);
    assert.strictEqual(service.turnTimeoutMs, TURN_TIMEOUT_MS);
  });

  await runTest("Kevin vs Pippi stays ACTIVE past lobby timeout and 5-minute cleanup bound", async () => {
    const { service, timers } = createService();
    const started = startKevinLobby(service);
    const raw = service.manager.getSession(started.session.id);
    assert.ok(raw.timers.joinTimeoutId != null);
    assert.ok(raw.timers.countdownTimeoutId != null);
    const lobbyGen = raw.turnGeneration;

    pippiJoins(service, started.session.id);
    assert.strictEqual(raw.status, STATUS.ACTIVE);
    assert.strictEqual(raw.timers.joinTimeoutId, null);
    assert.strictEqual(raw.timers.countdownTimeoutId, null);
    assert.ok(raw.turnGeneration > lobbyGen);

    const leftover = service.expireJoin(started.session.id);
    assert.strictEqual(leftover.ok, false);
    assert.strictEqual(leftover.reason, "not-waiting");
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);

    timers.advance(JOIN_TIMEOUT_MS + 1000);
    await flushMicrotasks();
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
    assert.strictEqual(service.getSession(started.session.id).opponentType, "human");
    assert.strictEqual(service.getSession(started.session.id).players.w.isBot, false);

    const generations = [];
    let elapsed = 0;
    while (elapsed <= GAME_MESSAGE_CLEANUP_DELAY_MS) {
      const before = service.manager.getSession(started.session.id).turnGeneration;
      const moved = await playOneLegalMove(service, started.session.id);
      assert.notStrictEqual(moved.session.status, STATUS.EXPIRED);
      assert.ok(
        moved.session.status === STATUS.ACTIVE || moved.session.status === STATUS.WON
      );
      if (moved.session.status === STATUS.WON) {
        assert.ok(
          moved.session.endReason === "win" || moved.session.endReason === "timeout"
        );
        return;
      }
      const after = service.manager.getSession(started.session.id).turnGeneration;
      assert.ok(after > before);
      generations.push(after);
      timers.advance(90_000);
      elapsed += 90_000;
      await flushMicrotasks();
      assert.strictEqual(
        service.getSession(started.session.id).status,
        STATUS.ACTIVE,
        "lobby/cleanup time must not cancel an active human PvP match"
      );
    }

    assert.ok(generations.length >= 4);
    const unique = new Set(generations);
    assert.strictEqual(unique.size, generations.length);
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);

    const still = service.getSession(started.session.id);
    assert.strictEqual(still.status, STATUS.ACTIVE);
    assert.strictEqual(still.opponentType, "human");
    const cancelledCopy = buildFinalGameText(
      GAME_TYPE.CHECKERS,
      FINAL_STATE.EXPIRED
    );
    const rendered = service.renderMessage(still);
    assert.ok(!rendered.text.includes("Checkers cancelled"));
    assert.ok(!rendered.text.includes("This game has ended."));
    assert.ok(cancelledCopy.includes("Checkers cancelled"));
    assert.ok(cancelledCopy.includes("This game has ended."));
  });

  await runTest("stale lobby countdown edit cannot cancel ACTIVE Kevin vs Pippi", async () => {
    const { service, timers } = createService();
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    let holding = true;
    const applied = [];
    const bot = {
      telegram: {
        async editMessageText(_chatId, _messageId, _inline, text) {
          if (holding) {
            await hold;
          }
          applied.push(String(text || ""));
        },
        async deleteMessage() {},
      },
      action() {},
    };
    registerPvpCallbacks(bot, {
      checkersRuntime: service,
      awardPvpWinXpFn: async () => ({ awarded: false, pointsToAdd: 0 }),
    });

    const started = startKevinLobby(service);
    timers.advance(5000);
    await flushMicrotasks();
    pippiJoins(service, started.session.id);
    holding = false;
    release();
    await flushMicrotasks();
    await flushMicrotasks();

    const live = service.getSession(started.session.id);
    assert.strictEqual(live.status, STATUS.ACTIVE);
    assert.strictEqual(live.opponentType, "human");
    assert.ok(!applied.some((text) => text.includes("Checkers cancelled")));
    assert.ok(!applied.some((text) => text.includes("This game has ended.")));
    const last = applied[applied.length - 1];
    if (last) {
      assert.ok(last.includes("CHECKERS"));
      assert.ok(!last.includes("looking for an opponent"));
    }
  });

  await runTest("missing session stale tap paints Checkers cancelled + This game has ended", async () => {
    const { service } = createService();
    const started = startKevinLobby(service);
    pippiJoins(service, started.session.id);
    service.manager.removeSession(started.session.id);
    assert.strictEqual(service.getSession(started.session.id), null);

    const ctx = createMockCtx({
      userId: KEVIN,
      firstName: "Kevin",
      callbackData: buildSelectCallbackData(started.session.id, 20),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.deepStrictEqual(ctx.answered, ["This game is over."]);
    assert.strictEqual(ctx.edits.length, 1);
    assert.ok(ctx.edits[0].text.includes("Checkers cancelled"));
    assert.ok(ctx.edits[0].text.includes("This game has ended."));
  });

  await runTest("ended WON session stale tap uses timeout/win text, not cancelled default", async () => {
    const { service, timers } = createService();
    const started = startKevinLobby(service);
    pippiJoins(service, started.session.id);
    timers.advance(TURN_TIMEOUT_MS);
    await flushMicrotasks();
    const ended = service.getSession(started.session.id);
    assert.strictEqual(ended.status, STATUS.WON);
    assert.strictEqual(ended.endReason, "timeout");

    const ctx = createMockCtx({
      userId: KEVIN,
      firstName: "Kevin",
      callbackData: buildSelectCallbackData(started.session.id, 20),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.ok(ctx.edits[0].text.includes("ran out of time"));
    assert.ok(!ctx.edits[0].text.includes("Checkers cancelled"));
  });

  await runTest("consecutive human turns mint new generations; stale gen cannot end the match", async () => {
    const { service } = createService();
    const started = startKevinLobby(service);
    pippiJoins(service, started.session.id);
    const raw = service.manager.getSession(started.session.id);
    const gens = [];
    for (let i = 0; i < 6; i += 1) {
      const before = raw.turnGeneration;
      gens.push(before);
      const moved = await playOneLegalMove(service, started.session.id);
      assert.strictEqual(moved.ok, true);
      assert.strictEqual(moved.session.status, STATUS.ACTIVE);
      assert.ok(raw.turnGeneration > before);
      const stale = await service.resolveTurnTimeout(started.session.id, before);
      assert.strictEqual(stale.ok, false);
      assert.strictEqual(stale.reason, "stale-timer");
      assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
    }
    assert.strictEqual(new Set(gens).size, gens.length);
  });

  await runTest("game-cleanup is not registered while Kevin vs Pippi is ACTIVE", async () => {
    clearAllGameMessageCleanups();
    const { service } = createService();
    const started = startKevinLobby(service);
    const applied = [];
    const bot = {
      telegram: {
        async editMessageText(_c, _m, _i, text) {
          applied.push(String(text || ""));
        },
        async deleteMessage() {
          throw new Error("must not delete an active Checkers match");
        },
      },
      action() {},
    };
    registerPvpCallbacks(bot, {
      checkersRuntime: service,
      awardPvpWinXpFn: async () => ({ awarded: false, pointsToAdd: 0 }),
    });
    pippiJoins(service, started.session.id);
    const live = service.getSession(started.session.id);
    const spec = legalMoves({
      board: live.board,
      current: live.currentPlayer,
      pendingFrom: live.pendingFrom,
    })[0];
    const ctx = createMockCtx({
      userId: KEVIN,
      firstName: "Kevin",
      callbackData: require("../services/checkers").buildMoveCallbackData(
        started.session.id,
        spec.from,
        spec.to
      ),
    });
    await handlePvpCallback(ctx, {
      runtime: service,
      parseCallbackData: parsePvpCallbackData,
    });
    assert.strictEqual(service.getSession(started.session.id).status, STATUS.ACTIVE);
    assert.strictEqual(getPendingGameMessageCleanupCount(), 0);
  });

  clearAllGameMessageCleanups();
  restoreEnv();
  console.log("\nAll checkers PvP lifecycle tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
