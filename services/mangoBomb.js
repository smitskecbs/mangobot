/**
 * ManGo Bomb — join-only group hot-potato. In-memory; restart cancels.
 * Callbacks: mb:join:<id> / mb:pass:<id>. Server uses ctx.from.id.
 */

const crypto = require("crypto");
const { Markup } = require("telegraf");
const { sanitizePvpDisplayName } = require("./pvpSessionManager");
const { XP_WALLET_GAME_LOCKED_LINE } = require("./xpWalletGate");
const { log, error: logError } = require("../utils/logger");
const { emptyInlineKeyboardExtra } = require("../utils/expiredMessageCleanup");

const STATUS = Object.freeze({
  IDLE: "idle",
  LOBBY: "lobby",
  RUNNING: "running",
  BETWEEN_ROUNDS: "between-rounds",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

const LOBBY_MS = 60 * 1000;
const LOBBY_COUNTDOWN_MS = 5 * 1000;
const BOMB_MIN_MS = 8 * 1000;
const BOMB_MAX_MS = 20 * 1000;
const PASS_COOLDOWN_MS = 400;
const BETWEEN_ROUNDS_MS = 2500;
const START_COOLDOWN_MS = 90 * 1000;
const MIN_PLAYERS = 2;
const XP_PARTICIPATE = 1;
const XP_SURVIVE = 1;
const XP_WIN = 5;
const DAILY_ROUND_CAP = 1;
const STALE_CALLBACK = "This ManGo Bomb round is over.";
const RENDER_TIMEOUT_MS = 5_000;
const INTERNAL_CANCEL_TEXT = [
  "🥭💣 ManGo Bomb round cancelled.",
  "",
  "The game hit an unexpected error.",
  "Start a new round with /mangobomb.",
].join("\n");

function defaultRandomInt(n) {
  const max = Number(n);
  if (!Number.isInteger(max) || max <= 0) {
    return 0;
  }
  return crypto.randomInt(0, max);
}

function parseMangoBombCallbackData(data) {
  if (typeof data !== "string") {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "mb") {
    return null;
  }
  if (parts[1] !== "join" && parts[1] !== "pass") {
    return null;
  }
  const gameId = parts[2];
  if (!gameId || !/^[a-f0-9]{8,16}$/i.test(gameId)) {
    return null;
  }
  return { action: parts[1], gameId };
}

function joinCallbackData(gameId) {
  return `mb:join:${gameId}`;
}

function passCallbackData(gameId) {
  return `mb:pass:${gameId}`;
}

function joinKeyboard(gameId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💣 JOIN BOMB", joinCallbackData(gameId))],
  ]);
}

function passKeyboard(gameId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💣 PASS", passCallbackData(gameId))],
  ]);
}

function playerCountLine(count) {
  const n = Number(count) || 0;
  return `Players: ${n}`;
}

function isMessageNotModifiedError(err) {
  const desc = err && (err.description || err.message || "");
  return String(desc).toLowerCase().includes("message is not modified");
}

function buildLobbyText(playerCount, lobbySeconds) {
  const seconds = Number.isFinite(lobbySeconds) ? lobbySeconds : 60;
  return [
    "🥭💣 MANGO BOMB!",
    "",
    "The bomb has been armed...",
    "",
    `You have ${seconds} seconds to join.`,
    "",
    playerCountLine(playerCount),
  ].join("\n");
}

function holderName(game) {
  const player = game.players.get(game.currentHolder);
  return (player && player.displayName) || "Player";
}

function buildBombText(game) {
  return [
    `💣 The bomb is with ${holderName(game)}!`,
    "",
    "Pass it before it explodes...",
  ].join("\n");
}

function buildBoomText(name, remaining) {
  return [
    "💥 BOOM!",
    "",
    `${name} got MANGO'D. 😂🥭`,
    "",
    `${remaining} player${remaining === 1 ? "" : "s"} remain.`,
  ].join("\n");
}

function buildWinnerText(name, xpLine) {
  const lines = [
    "🏆 MANGO BOMB WINNER!",
    "",
    `${name} survived the chaos. 🥭💣`,
  ];
  if (xpLine) {
    lines.push("", xpLine);
  }
  return lines.join("\n");
}

function buildCancelledText() {
  return [
    "🥭💣 ManGo Bomb cancelled.",
    "",
    "Need at least 2 players to start.",
  ].join("\n");
}

function createMangoBombService(options = {}) {
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function" ? options.setTimeoutFn : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn =
    typeof options.clearTimeoutFn === "function" ? options.clearTimeoutFn : (id) => clearTimeout(id);
  const randomIntFn =
    typeof options.randomIntFn === "function" ? options.randomIntFn : defaultRandomInt;
  const randomIdFn =
    typeof options.randomIdFn === "function"
      ? options.randomIdFn
      : () => crypto.randomBytes(4).toString("hex");
  const lobbyMs = Number.isFinite(options.lobbyMs) ? options.lobbyMs : LOBBY_MS;
  const countdownMs =
    Number.isFinite(options.countdownMs) && options.countdownMs > 0
      ? options.countdownMs
      : LOBBY_COUNTDOWN_MS;
  const bombMinMs = Number.isFinite(options.bombMinMs) ? options.bombMinMs : BOMB_MIN_MS;
  const bombMaxMs = Number.isFinite(options.bombMaxMs) ? options.bombMaxMs : BOMB_MAX_MS;
  const passCooldownMs =
    Number.isFinite(options.passCooldownMs) ? options.passCooldownMs : PASS_COOLDOWN_MS;
  const betweenRoundsMs =
    Number.isFinite(options.betweenRoundsMs) ? options.betweenRoundsMs : BETWEEN_ROUNDS_MS;
  const startCooldownMs =
    Number.isFinite(options.startCooldownMs) ? options.startCooldownMs : START_COOLDOWN_MS;
  const renderTimeoutMs =
    Number.isFinite(options.renderTimeoutMs) && options.renderTimeoutMs > 0
      ? options.renderTimeoutMs
      : RENDER_TIMEOUT_MS;

  const gamesById = new Map();
  const gamesByChat = new Map();
  const lastStartByChat = new Map();
  const queues = new Map();
  const timerHandles = new Set();
  let editMessage = null;
  let awardXpFn = null;
  let walletReminderFn = null;
  let injectedQueueStage = null;
  let injectedRenderMode = null;

  function wrapTimeout(fn, delay) {
    const handle = setTimeoutFn(() => {
      timerHandles.delete(handle);
      fn();
    }, delay);
    timerHandles.add(handle);
    return handle;
  }

  function clearHandle(handle) {
    if (handle == null) {
      return;
    }
    timerHandles.delete(handle);
    clearTimeoutFn(handle);
  }

  function enqueue(chatId, fn, stage = "task") {
    const key = String(chatId);
    const prev = queues.get(key) || Promise.resolve();
    const run = () => runQueuedTask(fn, stage, key);
    const next = prev.then(run, run);
    queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next.then(
      (value) => value,
      () => ({ ok: false, reason: "internal-error", toast: STALE_CALLBACK })
    );
  }

  async function runQueuedTask(fn, stage, chatKey) {
    try {
      if (injectedQueueStage && injectedQueueStage === stage) {
        injectedQueueStage = null;
        throw new Error("injected-queue-failure");
      }
      return await fn();
    } catch (err) {
      logError(`[mango-bomb] queue task failed stage=${stage}`);
      await recoverAfterQueueError(chatKey, stage);
      return { ok: false, reason: "internal-error", toast: STALE_CALLBACK };
    }
  }

  function invariantsHold(game) {
    if (!game) {
      return true;
    }
    if (game.status === STATUS.LOBBY) {
      return game.lobbyTimer != null;
    }
    if (game.status === STATUS.RUNNING) {
      return Boolean(
        game.currentHolder &&
          game.alive.has(String(game.currentHolder)) &&
          Number.isFinite(game.bombDeadline) &&
          game.bombDeadline > (game.bombStartedAt || 0) &&
          game.bombTimer != null
      );
    }
    if (game.status === STATUS.BETWEEN_ROUNDS) {
      return game.pauseTimer != null;
    }
    if (game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return (
        game.lobbyTimer == null &&
        game.countdownTimer == null &&
        game.bombTimer == null &&
        game.pauseTimer == null
      );
    }
    return false;
  }

  async function cancelDueToInternalError(game, stage) {
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return;
    }
    logError(`[mango-bomb] invariant failed state=${game.status}`);
    log("[mango-bomb] round cancelled reason=internal-error");
    game.status = STATUS.CANCELLED;
    clearGameTimers(game);
    await render(game, INTERNAL_CANCEL_TEXT, emptyInlineKeyboardExtra(), stage || "cancel");
    dropGame(game);
  }

  async function recoverAfterQueueError(chatKey, stage) {
    const game = activeGameForChat(chatKey);
    if (!game) {
      return;
    }
    if (invariantsHold(game)) {
      if (game.status === STATUS.LOBBY) {
        scheduleLobbyCountdown(game);
      }
      return;
    }
    await cancelDueToInternalError(game, stage);
  }

  function activeGameForChat(chatId) {
    const game = gamesByChat.get(String(chatId));
    if (!game) {
      return null;
    }
    if (game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return null;
    }
    return game;
  }

  function isMangoBombOpen(chatId) {
    if (chatId == null) {
      for (const game of gamesByChat.values()) {
        if (game.status !== STATUS.FINISHED && game.status !== STATUS.CANCELLED) {
          return true;
        }
      }
      return false;
    }
    return Boolean(activeGameForChat(chatId));
  }

  function getStatus(chatId) {
    const game = activeGameForChat(chatId);
    return game ? game.status : STATUS.IDLE;
  }

  function getPendingTimerCount() {
    return timerHandles.size;
  }

  function getActiveBombTimerCount() {
    let n = 0;
    for (const game of gamesById.values()) {
      if (game.bombTimer != null) {
        n += 1;
      }
    }
    return n;
  }

  function getActiveCountdownTimerCount() {
    let n = 0;
    for (const game of gamesById.values()) {
      if (game.countdownTimer != null) {
        n += 1;
      }
    }
    return n;
  }

  function whenIdle(chatId) {
    if (chatId != null) {
      return queues.get(String(chatId)) || Promise.resolve();
    }
    return Promise.all(Array.from(queues.values()));
  }

  function snapshot(game, includeInternal = false) {
    if (!game) {
      return null;
    }
    const players = [];
    for (const [userId, row] of game.players.entries()) {
      players.push({ userId, displayName: row.displayName });
    }
    const base = {
      id: game.id,
      chatId: game.chatId,
      threadId: game.threadId,
      messageId: game.messageId,
      startedAt: game.startedAt,
      lobbyEndsAt: game.lobbyEndsAt,
      status: game.status,
      roundNumber: game.roundNumber,
      playerCount: game.players.size,
      aliveCount: game.alive.size,
      eliminatedCount: game.eliminated.length,
      currentHolder: includeInternal ? game.currentHolder : undefined,
      bombStartedAt: game.bombStartedAt,
      bombDeadline: includeInternal ? game.bombDeadline : undefined,
      players,
      alivePlayers: Array.from(game.alive),
      eliminatedPlayers: game.eliminated.slice(),
    };
    return base;
  }

  function clearGameTimers(game) {
    if (!game) {
      return;
    }
    clearHandle(game.lobbyTimer);
    clearHandle(game.countdownTimer);
    clearHandle(game.bombTimer);
    clearHandle(game.pauseTimer);
    game.lobbyTimer = null;
    game.countdownTimer = null;
    game.bombTimer = null;
    game.pauseTimer = null;
  }

  function dropGame(game) {
    if (!game) {
      return;
    }
    clearGameTimers(game);
    gamesById.delete(game.id);
    const current = gamesByChat.get(String(game.chatId));
    if (current && current.id === game.id) {
      gamesByChat.delete(String(game.chatId));
    }
  }

  async function render(game, text, extra, stage = "render") {
    if (!game || game.messageId == null || typeof editMessage !== "function") {
      return;
    }
    if (injectedRenderMode === "throw") {
      injectedRenderMode = null;
      logError(`[mango-bomb] render failed stage=${stage}`);
      return;
    }
    try {
      const editPromise =
        injectedRenderMode === "hang"
          ? new Promise(() => {})
          : Promise.resolve(
              editMessage(
                game.chatId,
                game.messageId,
                text,
                extra || emptyInlineKeyboardExtra()
              )
            );
      if (injectedRenderMode === "hang") {
        injectedRenderMode = null;
      }
      await Promise.race([
        editPromise,
        new Promise((_, reject) => {
          const handle = wrapTimeout(() => {
            const err = new Error("render-timeout");
            err.code = "ETIMEDOUT";
            reject(err);
          }, renderTimeoutMs);
          editPromise.then(
            () => clearHandle(handle),
            () => clearHandle(handle)
          );
        }),
      ]);
    } catch (err) {
      if (!isMessageNotModifiedError(err)) {
        logError(`[mango-bomb] render failed stage=${stage}`);
      }
    }
  }

  function lobbyRemainingSeconds(game) {
    const ms = game.lobbyEndsAt - nowFn();
    return Math.max(0, Math.ceil(ms / 1000));
  }

  function lobbyDisplaySeconds(game) {
    return Math.max(1, lobbyRemainingSeconds(game));
  }

  async function renderLobbyMessage(game) {
    if (!game || game.status !== STATUS.LOBBY) {
      return false;
    }
    if (game.messageId == null || typeof editMessage !== "function") {
      return false;
    }
    await render(
      game,
      buildLobbyText(game.players.size, lobbyDisplaySeconds(game)),
      joinKeyboard(game.id),
      "lobby"
    );
    return true;
  }

  function msUntilNextCountdown(game) {
    const now = nowFn();
    if (game.lobbyEndsAt - now <= 0) {
      return null;
    }
    const elapsed = Math.max(0, now - game.startedAt);
    const nextOffset = (Math.floor(elapsed / countdownMs) + 1) * countdownMs;
    const nextAt = game.startedAt + nextOffset;
    if (nextAt >= game.lobbyEndsAt) {
      return null;
    }
    return Math.max(1, nextAt - now);
  }

  function scheduleLobbyCountdown(game) {
    if (!game) {
      return;
    }
    clearHandle(game.countdownTimer);
    game.countdownTimer = null;
    if (game.status !== STATUS.LOBBY) {
      return;
    }
    const wait = msUntilNextCountdown(game);
    if (wait == null) {
      return;
    }
    const gameId = game.id;
    game.countdownTimer = wrapTimeout(() => {
      enqueue(game.chatId, async () => {
        const current = gamesById.get(gameId);
        if (!current || current.status !== STATUS.LOBBY) {
          return;
        }
        await renderLobbyMessage(current);
        scheduleLobbyCountdown(current);
      }, "lobby-countdown");
    }, wait);
  }

  function award(userId, displayName, amount, roundId) {
    if (typeof awardXpFn !== "function" || !amount) {
      return { awarded: false, pointsToAdd: 0 };
    }
    try {
      return awardXpFn(userId, displayName, amount, roundId) || { awarded: false, pointsToAdd: 0 };
    } catch (_err) {
      return { awarded: false, pointsToAdd: 0 };
    }
  }

  function maybeRemind(userId, result, game) {
    if (typeof walletReminderFn !== "function") {
      return null;
    }
    try {
      return walletReminderFn(userId, result, game && game.chatId, game && game.threadId);
    } catch (_err) {
      return null;
    }
  }

  function pickHolder(aliveIds, excludeId) {
    const pool = aliveIds.filter((id) => id !== excludeId);
    const list = pool.length ? pool : aliveIds;
    if (!list.length) {
      return null;
    }
    return list[randomIntFn(list.length)];
  }

  function bombLifetimeMs() {
    const span = Math.max(0, bombMaxMs - bombMinMs);
    return bombMinMs + randomIntFn(span + 1);
  }

  function armBomb(game, excludeId) {
    const aliveIds = Array.from(game.alive);
    const holder = pickHolder(aliveIds, excludeId);
    if (!holder) {
      return null;
    }
    game.currentHolder = holder;
    game.bombGeneration += 1;
    const generation = game.bombGeneration;
    const lifetime = bombLifetimeMs();
    const now = nowFn();
    game.bombStartedAt = now;
    game.bombDeadline = now + lifetime;
    game.lastPassAt = 0;
    game.status = STATUS.RUNNING;
    clearHandle(game.bombTimer);
    game.bombTimer = wrapTimeout(() => {
      const current = gamesById.get(game.id);
      if (current && current.bombGeneration === generation) {
        current.bombTimer = null;
      }
      enqueue(game.chatId, () => explode(game.id, generation), "explode");
    }, lifetime);
    return holder;
  }

  async function finishWinner(game) {
    const winnerId = Array.from(game.alive)[0];
    const winner = winnerId ? game.players.get(winnerId) : null;
    const name = (winner && winner.displayName) || "Player";
    game.status = STATUS.FINISHED;
    game.currentHolder = winnerId || null;
    clearGameTimers(game);
    let xpLine = "";
    if (winnerId) {
      const result = award(winnerId, name, XP_WIN, game.id);
      if (result && result.awarded && result.pointsToAdd > 0) {
        xpLine = `+${result.pointsToAdd} XP`;
      } else if (result && result.reason === "wallet-required") {
        xpLine = XP_WALLET_GAME_LOCKED_LINE;
        maybeRemind(winnerId, result, game);
      }
    }
    log("[mango-bomb] winner");
    await render(game, buildWinnerText(name, xpLine), emptyInlineKeyboardExtra(), "winner");
    dropGame(game);
    return { ok: true, status: STATUS.FINISHED, winnerId };
  }

  async function explode(gameId, generation) {
    const game = gamesById.get(gameId);
    if (!game || game.status !== STATUS.RUNNING) {
      return { ok: false, reason: "inactive" };
    }
    if (generation != null && generation !== game.bombGeneration) {
      return { ok: false, reason: "stale-timer" };
    }
    const victimId = game.currentHolder;
    const victim = victimId ? game.players.get(victimId) : null;
    const name = (victim && victim.displayName) || "Player";
    game.alive.delete(victimId);
    game.eliminated.push(victimId);
    game.currentHolder = null;
    game.roundNumber += 1;
    clearHandle(game.bombTimer);
    game.bombTimer = null;

    const survivors = Array.from(game.alive);
    for (const uid of survivors) {
      const row = game.players.get(uid);
      award(uid, row && row.displayName, XP_SURVIVE, game.id);
    }
    log("[mango-bomb] eliminated");

    if (survivors.length <= 1) {
      if (survivors.length === 1) {
        await render(game, buildBoomText(name, 1), emptyInlineKeyboardExtra(), "explode");
        return finishWinner(game);
      }
      game.status = STATUS.CANCELLED;
      await render(game, "🥭💣 ManGo Bomb ended.", emptyInlineKeyboardExtra(), "explode");
      dropGame(game);
      return { ok: true, status: STATUS.CANCELLED };
    }

    game.status = STATUS.BETWEEN_ROUNDS;
    await render(game, buildBoomText(name, survivors.length), emptyInlineKeyboardExtra(), "explode");
    clearHandle(game.pauseTimer);
    game.pauseTimer = wrapTimeout(() => {
      const current = gamesById.get(gameId);
      if (current) {
        current.pauseTimer = null;
      }
      enqueue(game.chatId, async () => {
        const live = gamesById.get(gameId);
        if (!live || live.status !== STATUS.BETWEEN_ROUNDS) {
          return;
        }
        armBomb(live, null);
        await render(live, buildBombText(live), passKeyboard(live.id), "between-rounds");
      }, "between-rounds");
    }, betweenRoundsMs);
    return { ok: true, status: STATUS.BETWEEN_ROUNDS, eliminated: victimId };
  }

  async function closeLobby(gameId) {
    const game = gamesById.get(gameId);
    if (!game || game.status !== STATUS.LOBBY) {
      return { ok: false, reason: "inactive" };
    }
    clearHandle(game.lobbyTimer);
    clearHandle(game.countdownTimer);
    game.lobbyTimer = null;
    game.countdownTimer = null;
    if (game.players.size < MIN_PLAYERS) {
      game.status = STATUS.CANCELLED;
      log("[mango-bomb] cancelled");
      await render(game, buildCancelledText(), emptyInlineKeyboardExtra(), "lobby-close");
      dropGame(game);
      return { ok: true, status: STATUS.CANCELLED };
    }
    for (const [userId, row] of game.players.entries()) {
      const result = award(userId, row.displayName, XP_PARTICIPATE, game.id);
      if (result && result.reason === "wallet-required") {
        maybeRemind(userId, result, game);
      }
    }
    log(`[mango-bomb] round started players=${game.players.size}`);
    game.roundNumber = 1;
    armBomb(game, null);
    await render(game, buildBombText(game), passKeyboard(game.id), "lobby-close");
    return { ok: true, status: STATUS.RUNNING, snapshot: snapshot(game, true) };
  }

  function startLobby({ chatId, threadId = null, source = "manual" } = {}) {
    if (chatId == null) {
      return { ok: false, reason: "wrong-chat" };
    }
    const existing = activeGameForChat(chatId);
    if (existing) {
      return { ok: false, reason: "already-active" };
    }
    const now = nowFn();
    const last = lastStartByChat.get(String(chatId)) || 0;
    if (now - last < startCooldownMs) {
      return { ok: false, reason: "cooldown" };
    }
    const id = String(randomIdFn()).replace(/[^a-f0-9]/gi, "").slice(0, 16) || crypto.randomBytes(4).toString("hex");
    const game = {
      id,
      chatId,
      threadId,
      messageId: null,
      startedAt: now,
      lobbyEndsAt: now + lobbyMs,
      status: STATUS.LOBBY,
      players: new Map(),
      alive: new Set(),
      eliminated: [],
      currentHolder: null,
      bombStartedAt: null,
      bombDeadline: null,
      bombGeneration: 0,
      lastPassAt: 0,
      lastPassUser: null,
      roundNumber: 0,
      source,
      lobbyTimer: null,
      countdownTimer: null,
      bombTimer: null,
      pauseTimer: null,
    };
    gamesById.set(id, game);
    gamesByChat.set(String(chatId), game);
    lastStartByChat.set(String(chatId), now);
    game.lobbyTimer = wrapTimeout(() => {
      const current = gamesById.get(id);
      if (current) {
        current.lobbyTimer = null;
      }
      enqueue(chatId, () => closeLobby(id), "lobby-close");
    }, lobbyMs);
    scheduleLobbyCountdown(game);
    log("[mango-bomb] lobby started");
    const lobbySeconds = Math.max(1, Math.round(lobbyMs / 1000));
    return {
      ok: true,
      gameId: id,
      text: buildLobbyText(0, lobbySeconds),
      extra: joinKeyboard(id),
      snapshot: snapshot(game),
    };
  }

  function setMessageId(gameId, messageId) {
    const game = gamesById.get(gameId);
    if (!game) {
      return false;
    }
    game.messageId = messageId;
    if (game.status === STATUS.LOBBY && game.countdownTimer == null) {
      scheduleLobbyCountdown(game);
    }
    return true;
  }

  function tryJoin({ gameId, userId, displayName, isBot, chatId, threadId } = {}) {
    const game = gamesById.get(gameId);
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return { ok: false, reason: "stale", toast: STALE_CALLBACK };
    }
    if (chatId != null && String(chatId) !== String(game.chatId)) {
      return { ok: false, reason: "wrong-chat", toast: STALE_CALLBACK };
    }
    if (
      game.threadId != null &&
      (threadId == null || String(threadId) !== String(game.threadId))
    ) {
      return { ok: false, reason: "wrong-topic", toast: STALE_CALLBACK };
    }
    if (isBot) {
      return { ok: false, reason: "bot", toast: "Bots cannot join." };
    }
    if (game.status !== STATUS.LOBBY) {
      return { ok: false, reason: "late", toast: "Joining is closed." };
    }
    const uid = String(userId);
    if (game.players.has(uid)) {
      return { ok: false, reason: "duplicate", toast: "You already joined." };
    }
    const name = sanitizePvpDisplayName(displayName);
    game.players.set(uid, { displayName: name });
    game.alive.add(uid);
    log("[mango-bomb] player joined");
    const lobbySeconds = lobbyDisplaySeconds(game);
    return {
      ok: true,
      text: buildLobbyText(game.players.size, lobbySeconds),
      extra: joinKeyboard(game.id),
      snapshot: snapshot(game),
    };
  }

  function tryPass({ gameId, userId, isBot, chatId, threadId } = {}) {
    const game = gamesById.get(gameId);
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return { ok: false, reason: "stale", toast: STALE_CALLBACK };
    }
    if (chatId != null && String(chatId) !== String(game.chatId)) {
      return { ok: false, reason: "wrong-chat", toast: STALE_CALLBACK };
    }
    if (
      game.threadId != null &&
      (threadId == null || String(threadId) !== String(game.threadId))
    ) {
      return { ok: false, reason: "wrong-topic", toast: STALE_CALLBACK };
    }
    if (isBot) {
      return { ok: false, reason: "bot", toast: "Bots cannot play." };
    }
    if (game.status !== STATUS.RUNNING) {
      return { ok: false, reason: "not-running", toast: STALE_CALLBACK };
    }
    const uid = String(userId);
    if (uid !== String(game.currentHolder)) {
      return { ok: false, reason: "not-holder", toast: "The bomb is not with you." };
    }
    if (!game.alive.has(uid)) {
      return { ok: false, reason: "eliminated", toast: STALE_CALLBACK };
    }
    const now = nowFn();
    if (game.bombDeadline != null && now >= game.bombDeadline) {
      return { ok: false, reason: "exploded", toast: STALE_CALLBACK };
    }
    if (
      game.lastPassUser === uid &&
      now - game.lastPassAt < passCooldownMs
    ) {
      return { ok: false, reason: "cooldown", toast: "Easy..." };
    }
    const next = pickHolder(Array.from(game.alive), uid);
    if (!next || next === uid) {
      return { ok: false, reason: "no-target", toast: STALE_CALLBACK };
    }
    game.lastPassAt = now;
    game.lastPassUser = uid;
    game.currentHolder = next;
    game.bombGeneration += 1;
    const generation = game.bombGeneration;
    const remaining = Math.max(1, game.bombDeadline - now);
    clearHandle(game.bombTimer);
    game.bombTimer = wrapTimeout(() => {
      const current = gamesById.get(game.id);
      if (current && current.bombGeneration === generation) {
        current.bombTimer = null;
      }
      enqueue(game.chatId, () => explode(game.id, generation), "explode");
    }, remaining);
    log("[mango-bomb] pass");
    return {
      ok: true,
      text: buildBombText(game),
      extra: passKeyboard(game.id),
      snapshot: snapshot(game, true),
    };
  }

  function forceLobbyEnd(gameId) {
    const game = gamesById.get(gameId);
    if (!game) {
      return Promise.resolve({ ok: false, reason: "inactive" });
    }
    return enqueue(game.chatId, () => closeLobby(gameId), "lobby-close");
  }

  function forceExplode(gameId) {
    const game = gamesById.get(gameId);
    if (!game) {
      return Promise.resolve({ ok: false, reason: "inactive" });
    }
    return enqueue(game.chatId, () => explode(game.id, game.bombGeneration), "explode");
  }

  function cancelAll(_reason = "shutdown") {
    const had = gamesById.size > 0;
    for (const game of Array.from(gamesById.values())) {
      game.status = STATUS.CANCELLED;
      dropGame(game);
    }
    for (const handle of Array.from(timerHandles)) {
      clearHandle(handle);
    }
    if (had) {
      log("[mango-bomb] cancelled");
    }
  }

  function clearAllTimers() {
    cancelAll("clear-timers");
  }

  function reset() {
    cancelAll("reset");
    lastStartByChat.clear();
    queues.clear();
    editMessage = null;
    awardXpFn = null;
    walletReminderFn = null;
  }

  return {
    STATUS,
    LOBBY_MS: lobbyMs,
    LOBBY_COUNTDOWN_MS: countdownMs,
    BOMB_MIN_MS: bombMinMs,
    BOMB_MAX_MS: bombMaxMs,
    PASS_COOLDOWN_MS: passCooldownMs,
    BETWEEN_ROUNDS_MS: betweenRoundsMs,
    START_COOLDOWN_MS: startCooldownMs,
    MIN_PLAYERS,
    XP_PARTICIPATE,
    XP_SURVIVE,
    XP_WIN,
    DAILY_ROUND_CAP,
    STALE_CALLBACK,
    startLobby,
    tryJoin,
    tryPass,
    setMessageId,
    forceLobbyEnd,
    forceExplode,
    isMangoBombOpen,
    getStatus,
    getGame: (id) => snapshot(gamesById.get(id), true),
    getGameByChat: (chatId) => snapshot(activeGameForChat(chatId), true),
    getPendingTimerCount,
    getActiveBombTimerCount,
    getActiveCountdownTimerCount,
    whenIdle,
    setEditMessageHandler(fn) {
      editMessage = typeof fn === "function" ? fn : null;
    },
    setAwardXpHandler(fn) {
      awardXpFn = typeof fn === "function" ? fn : null;
    },
    setWalletReminderHandler(fn) {
      walletReminderFn = typeof fn === "function" ? fn : null;
    },
    enqueueJoin(input) {
      const game = gamesById.get(input && input.gameId);
      if (!game) {
        return Promise.resolve({ ok: false, reason: "stale", toast: STALE_CALLBACK });
      }
      return enqueue(game.chatId, async () => {
        const result = tryJoin(input);
        if (result.ok) {
          result.rendered = await renderLobbyMessage(gamesById.get(input.gameId));
        }
        return result;
      }, "join");
    },
    enqueuePass(input) {
      const game = gamesById.get(input && input.gameId);
      if (!game) {
        return Promise.resolve({ ok: false, reason: "stale", toast: STALE_CALLBACK });
      }
      return enqueue(game.chatId, () => tryPass(input), "pass");
    },
    injectQueueThrow(stage) {
      injectedQueueStage = stage;
    },
    injectRenderThrow() {
      injectedRenderMode = "throw";
    },
    injectRenderHang() {
      injectedRenderMode = "hang";
    },
    reset,
    clearAllTimers,
    cancelAll,
    buildLobbyText,
    buildBombText,
    buildBoomText,
    buildWinnerText,
  };
}

const defaultService = createMangoBombService();

module.exports = {
  STATUS,
  LOBBY_MS,
  LOBBY_COUNTDOWN_MS,
  BOMB_MIN_MS,
  BOMB_MAX_MS,
  PASS_COOLDOWN_MS,
  BETWEEN_ROUNDS_MS,
  START_COOLDOWN_MS,
  MIN_PLAYERS,
  XP_PARTICIPATE,
  XP_SURVIVE,
  XP_WIN,
  DAILY_ROUND_CAP,
  STALE_CALLBACK,
  RENDER_TIMEOUT_MS,
  INTERNAL_CANCEL_TEXT,
  parseMangoBombCallbackData,
  joinCallbackData,
  passCallbackData,
  joinKeyboard,
  passKeyboard,
  buildLobbyText,
  buildCancelledText,
  createMangoBombService,
  getMangoBombRuntime: () => defaultService,
  startLobby: (input) => defaultService.startLobby(input),
  isMangoBombOpen: (chatId) => defaultService.isMangoBombOpen(chatId),
};
