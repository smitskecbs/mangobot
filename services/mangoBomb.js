/**
 * ManGo Bomb — join-only group hot-potato. In-memory; restart cancels.
 * Callbacks: mb:join:<id> / mb:pass:<id>. Server uses ctx.from.id.
 * Telegram rendering is output-only and never owns game progression.
 */

const crypto = require("crypto");
const { Markup } = require("telegraf");
const { sanitizePvpDisplayName } = require("./pvpSessionManager");
const { XP_WALLET_GAME_LOCKED_LINE } = require("./xpWalletGate");
const { log, error: logError } = require("../utils/logger");
const { emptyInlineKeyboardExtra } = require("../utils/expiredMessageCleanup");
const {
  GAME_OVER_TOAST,
  FINAL_STATE,
  GAME_TYPE,
  buildFinalGameText,
  logGameCleanup,
  logCleanupRenderFailed,
  emptyGameKeyboardExtra,
  scheduleGameMessageCleanup,
  addGameMessageIds,
} = require("../utils/gameCleanup");

const STATUS = Object.freeze({
  IDLE: "idle",
  LOBBY: "lobby",
  RUNNING: "running",
  BETWEEN_ROUNDS: "between-rounds",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

const PENDING = Object.freeze({
  EXPLODE: "explode",
  CLOSE_LOBBY: "close-lobby",
  NEXT_ROUND: "next-round",
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
const STALE_CALLBACK = GAME_OVER_TOAST;
const RENDER_TIMEOUT_MS = 5_000;
const QUEUE_TIMEOUT_MS = 5_000;
const WATCHDOG_MS = 5_000;
const WATCHDOG_GRACE_MS = 1_500;
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
  return buildFinalGameText(GAME_TYPE.MANGOBOMB, FINAL_STATE.NOT_ENOUGH);
}

function buildEmptyLobbyText() {
  return buildFinalGameText(GAME_TYPE.MANGOBOMB, FINAL_STATE.EMPTY);
}

function buildNotEnoughPlayersText() {
  return buildFinalGameText(GAME_TYPE.MANGOBOMB, FINAL_STATE.NOT_ENOUGH);
}

function yn(value) {
  return value ? "yes" : "no";
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
  const queueTimeoutMs =
    Number.isFinite(options.queueTimeoutMs) && options.queueTimeoutMs > 0
      ? options.queueTimeoutMs
      : QUEUE_TIMEOUT_MS;
  const watchdogMs =
    Number.isFinite(options.watchdogMs) && options.watchdogMs > 0
      ? options.watchdogMs
      : WATCHDOG_MS;
  const watchdogGraceMs =
    Number.isFinite(options.watchdogGraceMs) && options.watchdogGraceMs >= 0
      ? options.watchdogGraceMs
      : WATCHDOG_GRACE_MS;

  const gamesById = new Map();
  const gamesByChat = new Map();
  const lastStartByChat = new Map();
  const queues = new Map();
  const queueMeta = new Map();
  const timedOutTokens = new Set();
  const gameplayHandles = new Set();
  const utilityHandles = new Set();
  let queueSeq = 0;
  let instanceSeq = 0;
  let renderWait = Promise.resolve();
  let watchdogHandle = null;
  let editMessage = null;
  let awardXpFn = null;
  let walletReminderFn = null;
  let deleteMessageFn = null;
  let injectedQueueStage = null;
  let injectedQueueHangStage = null;
  let queueHang = null;
  let injectedRenderMode = null;
  let hungRender = null;
  const retiredGames = new Map();
  const finalUiByGameId = new Map();
  let sendMessage = null;
  let winnerUiWait = Promise.resolve();
  let injectedSendMode = null;

  function utilityTimeout(fn, delay) {
    const handle = setTimeoutFn(() => {
      utilityHandles.delete(handle);
      fn();
    }, delay);
    utilityHandles.add(handle);
    return handle;
  }

  function clearUtility(handle) {
    if (handle == null) {
      return;
    }
    utilityHandles.delete(handle);
    clearTimeoutFn(handle);
  }

  function hasGameplayHandle(handle) {
    return handle != null && gameplayHandles.has(handle);
  }

  function hasActiveLobbyTimer(game) {
    return Boolean(game && hasGameplayHandle(game.timers && game.timers.lobby));
  }

  function hasActiveCountdownTimer(game) {
    return Boolean(game && hasGameplayHandle(game.timers && game.timers.countdown));
  }

  function hasActiveBombTimer(game) {
    return Boolean(game && hasGameplayHandle(game.timers && game.timers.bomb));
  }

  function hasActivePauseTimer(game) {
    return Boolean(game && hasGameplayHandle(game.timers && game.timers.pause));
  }

  function clearGameplayHandle(handle) {
    if (handle == null) {
      return;
    }
    gameplayHandles.delete(handle);
    clearTimeoutFn(handle);
  }

  function clearGameTimer(game, type) {
    if (!game || !game.timers) {
      return;
    }
    clearGameplayHandle(game.timers[type]);
    game.timers[type] = null;
  }

  function setGameTimer(game, type, delay, onFire) {
    clearGameTimer(game, type);
    const gameId = game.id;
    const scheduledGeneration = game.bombGeneration;
    const scheduledInstance = game.instanceSeq;
    log(
      `[mango-bomb] timer scheduled type=${type} generation=${scheduledGeneration}`
    );
    const handle = setTimeoutFn(() => {
      gameplayHandles.delete(handle);
      const current = gamesById.get(gameId);
      if (
        !current ||
        current.instanceSeq !== scheduledInstance ||
        !current.timers ||
        current.timers[type] !== handle
      ) {
        return;
      }
      current.timers[type] = null;
      log(
        `[mango-bomb] timer fired type=${type} generation=${scheduledGeneration}`
      );
      onFire(current);
    }, delay);
    gameplayHandles.add(handle);
    game.timers[type] = handle;
    return handle;
  }

  function noteProgress(game, stage) {
    if (!game) {
      return;
    }
    game.lastStage = stage;
    game.lastProgressAt = nowFn();
  }

  function setStatus(game, next, stage) {
    if (!game) {
      return;
    }
    if (game.status !== next) {
      log(
        `[mango-bomb] state from=${game.status} to=${next} round=${game.roundNumber || 0}`
      );
    }
    game.status = next;
    noteProgress(game, stage || next);
  }

  function bumpRevision(game) {
    if (!game) {
      return 0;
    }
    game.renderRevision = (game.renderRevision || 0) + 1;
    return game.renderRevision;
  }

  function setPending(game, type, generation) {
    if (!game) {
      return;
    }
    game.pendingTransition = {
      type,
      generation: generation == null ? game.bombGeneration : generation,
      queuedAt: nowFn(),
    };
    noteProgress(game, `pending-${type}`);
  }

  function clearPending(game, type) {
    if (!game || !game.pendingTransition) {
      return;
    }
    if (!type || game.pendingTransition.type === type) {
      game.pendingTransition = null;
    }
  }

  function pendingType(game) {
    return game && game.pendingTransition && game.pendingTransition.type
      ? game.pendingTransition.type
      : null;
  }

  function pendingMatches(game, type, generation) {
    const pending = game && game.pendingTransition;
    if (!pending || pending.type !== type) {
      return false;
    }
    if (generation != null && pending.generation !== generation) {
      return false;
    }
    return true;
  }

  function trackRender(promise) {
    const settled = Promise.resolve(promise).then(
      () => undefined,
      () => undefined
    );
    renderWait = renderWait.then(
      () => settled,
      () => settled
    );
    return settled;
  }

  function isRevisionCurrent(gameId, revision) {
    const game = gamesById.get(gameId);
    if (game) {
      return game.renderRevision === revision;
    }
    const retired = retiredGames.get(gameId);
    return Boolean(retired && retired.renderRevision === revision);
  }

  function enqueue(chatId, fn, stage = "task") {
    const key = String(chatId);
    const token = (queueSeq += 1);
    const prev = queues.get(key) || Promise.resolve();
    const run = () => runQueuedTask(fn, stage, key, token);
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

  function isLiveTask(token) {
    return !timedOutTokens.has(token);
  }

  async function runQueuedTask(fn, stage, chatKey, token) {
    const startedAt = nowFn();
    queueMeta.set(chatKey, { stage, startedAt, token });
    log(`[mango-bomb] queue start stage=${stage}`);
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = utilityTimeout(() => {
        timedOutTokens.add(token);
        const err = new Error("queue-timeout");
        err.code = "QUEUE_TIMEOUT";
        reject(err);
      }, queueTimeoutMs);
    });
    const executeTask = async () => {
      if (injectedQueueHangStage && injectedQueueHangStage === stage) {
        injectedQueueHangStage = null;
        if (!queueHang) {
          queueHang = {};
          queueHang.promise = new Promise((resolve) => {
            queueHang.resolve = resolve;
          });
        }
        await queueHang.promise;
      }
      if (!isLiveTask(token)) {
        return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
      }
      if (injectedQueueStage && injectedQueueStage === stage) {
        injectedQueueStage = null;
        throw new Error("injected-queue-failure");
      }
      return fn(token);
    };
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => executeTask()),
        timeoutPromise,
      ]);
      if (!isLiveTask(token)) {
        return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
      }
      log(
        `[mango-bomb] queue finish stage=${stage} durationMs=${Math.max(0, nowFn() - startedAt)}`
      );
      return result;
    } catch (err) {
      const timedOut = err && err.code === "QUEUE_TIMEOUT";
      if (timedOut) {
        log(
          `[mango-bomb] queue timeout stage=${stage} ageMs=${Math.max(0, nowFn() - startedAt)}`
        );
      } else {
        logError(`[mango-bomb] queue task failed stage=${stage}`);
      }
      await recoverAfterQueueError(chatKey, stage);
      return {
        ok: false,
        reason: timedOut ? "queue-timeout" : "internal-error",
        toast: STALE_CALLBACK,
      };
    } finally {
      clearUtility(timeoutHandle);
      const meta = queueMeta.get(chatKey);
      if (meta && meta.token === token) {
        queueMeta.delete(chatKey);
      }
    }
  }

  function invariantsHold(game) {
    if (!game) {
      return true;
    }
    if (game.status === STATUS.LOBBY) {
      return hasActiveLobbyTimer(game) || pendingMatches(game, PENDING.CLOSE_LOBBY);
    }
    if (game.status === STATUS.RUNNING) {
      const holderOk = Boolean(
        game.currentHolder && game.alive.has(String(game.currentHolder))
      );
      const deadlineOk =
        Number.isFinite(game.bombDeadline) &&
        game.bombDeadline > (game.bombStartedAt || 0);
      const progressOk =
        hasActiveBombTimer(game) ||
        pendingMatches(game, PENDING.EXPLODE, game.bombGeneration);
      return holderOk && deadlineOk && progressOk;
    }
    if (game.status === STATUS.BETWEEN_ROUNDS) {
      return (
        hasActivePauseTimer(game) || pendingMatches(game, PENDING.NEXT_ROUND)
      );
    }
    if (game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return (
        !hasActiveLobbyTimer(game) &&
        !hasActiveCountdownTimer(game) &&
        !hasActiveBombTimer(game) &&
        !hasActivePauseTimer(game) &&
        !game.pendingTransition
      );
    }
    return false;
  }

  async function cancelDueToInternalError(game, stage, reason) {
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return;
    }
    logError(
      `[mango-bomb] invariant fail status=${game.status} reason=${reason || stage || "unknown"}`
    );
    log("[mango-bomb] recovery action=cancel");
    logGameCleanup(GAME_TYPE.MANGOBOMB, FINAL_STATE.CANCELLED);
    setStatus(game, STATUS.CANCELLED, "recovery");
    clearPending(game);
    clearGameTimers(game);
    bumpRevision(game);
    retainFinalUi(game, {
      kind: "cancel",
      text: INTERNAL_CANCEL_TEXT,
      extra: emptyGameKeyboardExtra(),
    });
    queueRender(game, INTERNAL_CANCEL_TEXT, emptyGameKeyboardExtra(), "cancel");
    dropGame(game);
  }

  async function recoverAfterQueueError(chatKey, stage) {
    const game = activeGameForChat(chatKey);
    if (!game) {
      return;
    }
    if (stage === "explode") {
      clearPending(game, PENDING.EXPLODE);
    } else if (stage === "lobby-close") {
      clearPending(game, PENDING.CLOSE_LOBBY);
    } else if (stage === "between-rounds") {
      clearPending(game, PENDING.NEXT_ROUND);
    }
    if (invariantsHold(game)) {
      if (game.status === STATUS.LOBBY) {
        scheduleLobbyCountdown(game);
      }
      return;
    }
    await cancelDueToInternalError(game, stage, "queue-recovery");
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
    return gameplayHandles.size;
  }

  function getActiveBombTimerCount() {
    let n = 0;
    for (const game of gamesById.values()) {
      if (hasActiveBombTimer(game)) {
        n += 1;
      }
    }
    return n;
  }

  function getActiveCountdownTimerCount() {
    let n = 0;
    for (const game of gamesById.values()) {
      if (hasActiveCountdownTimer(game)) {
        n += 1;
      }
    }
    return n;
  }

  function whenQueueIdle(chatId) {
    if (chatId != null) {
      return queues.get(String(chatId)) || Promise.resolve();
    }
    return Promise.all(Array.from(queues.values()));
  }

  function whenIdle(chatId) {
    return Promise.all([whenQueueIdle(chatId), renderWait, winnerUiWait]);
  }

  function whenWinnerUiIdle() {
    return winnerUiWait;
  }

  function snapshot(game, includeInternal = false) {
    if (!game) {
      return null;
    }
    const players = [];
    for (const [userId, row] of game.players.entries()) {
      players.push({ userId, displayName: row.displayName });
    }
    return {
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
      bombGeneration: game.bombGeneration,
      renderRevision: game.renderRevision,
      pendingTransition: pendingType(game),
      players,
      alivePlayers: Array.from(game.alive),
      eliminatedPlayers: game.eliminated.slice(),
    };
  }

  function clearGameTimers(game) {
    if (!game) {
      return;
    }
    clearGameTimer(game, "lobby");
    clearGameTimer(game, "countdown");
    clearGameTimer(game, "bomb");
    clearGameTimer(game, "pause");
  }

  function dropGame(game) {
    if (!game) {
      return;
    }
    clearGameTimers(game);
    clearPending(game);
    retiredGames.set(game.id, {
      renderRevision: game.renderRevision,
      instanceSeq: game.instanceSeq,
      status: game.status,
    });
    gamesById.delete(game.id);
    const current = gamesByChat.get(String(game.chatId));
    if (current && current.id === game.id) {
      gamesByChat.delete(String(game.chatId));
    }
    stopWatchdogIfIdle();
  }

  function retainFinalUi(game, payload) {
    const ui = {
      gameId: game.id,
      instanceSeq: game.instanceSeq,
      chatId: game.chatId,
      threadId: game.threadId,
      messageId: game.messageId,
      text: payload.text,
      extra: payload.extra || emptyGameKeyboardExtra(),
      renderRevision: game.renderRevision,
      kind: payload.kind || "cancel",
      winnerUiState: "pending",
      fallbackSent: false,
    };
    finalUiByGameId.set(game.id, ui);
    scheduleClosedGameMessages(game);
    return ui;
  }

  function scheduleClosedGameMessages(game) {
    if (!game || game.chatId == null || game.messageId == null) {
      return;
    }
    scheduleGameMessageCleanup({
      gameType: GAME_TYPE.MANGOBOMB,
      sessionId: game.id,
      chatId: game.chatId,
      messageIds: [game.messageId],
      setTimeoutFn,
      clearTimeoutFn,
      deleteMessageFn,
    });
  }

  function trackWinnerUi(promise) {
    const settled = Promise.resolve(promise).then(
      () => undefined,
      () => undefined
    );
    winnerUiWait = winnerUiWait.then(
      () => settled,
      () => settled
    );
    return settled;
  }

  function shouldApplyLateWinnerEdit(ui, revision) {
    if (!ui || ui.renderRevision !== revision) {
      return false;
    }
    if (ui.winnerUiState === "visible") {
      return false;
    }
    if (ui.fallbackSent && ui.winnerUiState !== "failed") {
      return false;
    }
    return true;
  }

  function queueRender(game, text, extra, stage) {
    if (!game) {
      return Promise.resolve();
    }
    const revision = game.renderRevision;
    const promise = renderRevision(game, text, extra, stage, revision);
    trackRender(promise);
    return promise;
  }

  async function renderRevision(game, text, extra, stage, revision) {
    const result = await attemptBoundedEdit({
      gameId: game && game.id,
      chatId: game && game.chatId,
      messageId: game && game.messageId,
      text,
      extra,
      stage,
      revision,
    });
    if (
      !result.ok &&
      !result.stale &&
      !result.skipped &&
      (stage === "lobby-close" || stage === "cancel")
    ) {
      logCleanupRenderFailed(GAME_TYPE.MANGOBOMB);
    }
    return result;
  }

  async function attemptBoundedEdit({
    gameId,
    chatId,
    messageId,
    text,
    extra,
    stage,
    revision,
  }) {
    if (gameId == null || messageId == null || typeof editMessage !== "function") {
      return { ok: false, skipped: true };
    }
    if (!isRevisionCurrent(gameId, revision)) {
      log(`[mango-bomb] stale render skipped revision=${revision}`);
      return { ok: false, stale: true };
    }
    if (injectedRenderMode === "throw") {
      injectedRenderMode = null;
      if (stage === "winner") {
        logError("[mango-bomb] render failed stage=winner");
      } else {
        logError(`[mango-bomb] render failed stage=${stage}`);
      }
      return { ok: false, thrown: true };
    }
    const shouldHang = injectedRenderMode === "hang";
    if (shouldHang) {
      injectedRenderMode = null;
    }
    const work = Promise.resolve().then(async () => {
      if (shouldHang) {
        if (!hungRender) {
          hungRender = {};
          hungRender.promise = new Promise((resolve) => {
            hungRender.resolve = resolve;
          });
        }
        await hungRender.promise;
      }
      if (stage === "winner") {
        const ui = finalUiByGameId.get(gameId);
        if (!shouldApplyLateWinnerEdit(ui, revision)) {
          log(`[mango-bomb] stale render skipped revision=${revision}`);
          return { stale: true };
        }
      } else if (!isRevisionCurrent(gameId, revision)) {
        log(`[mango-bomb] stale render skipped revision=${revision}`);
        return { stale: true };
      }
      return editMessage(
        chatId,
        messageId,
        text,
        extra || emptyGameKeyboardExtra()
      );
    });
    try {
      const timeout = new Promise((_, reject) => {
        const handle = utilityTimeout(() => {
          const err = new Error("render-timeout");
          err.code = "ETIMEDOUT";
          reject(err);
        }, renderTimeoutMs);
        work.then(
          () => clearUtility(handle),
          () => clearUtility(handle)
        );
      });
      const result = await Promise.race([work, timeout]);
      if (result && result.stale) {
        return { ok: false, stale: true };
      }
      if (stage === "winner") {
        const ui = finalUiByGameId.get(gameId);
        if (!shouldApplyLateWinnerEdit(ui, revision) && ui && ui.winnerUiState === "visible") {
          return { ok: true, duplicate: true };
        }
      } else if (!isRevisionCurrent(gameId, revision)) {
        log(`[mango-bomb] stale render skipped revision=${revision}`);
        return { ok: false, stale: true };
      }
      return { ok: true };
    } catch (err) {
      if (err && err.code === "ETIMEDOUT") {
        log(`[mango-bomb] render timeout stage=${stage}`);
        work.then(
          () => undefined,
          () => undefined
        );
        return { ok: false, timedOut: true };
      }
      if (!isMessageNotModifiedError(err)) {
        logError(`[mango-bomb] render failed stage=${stage}`);
        return { ok: false, thrown: true };
      }
      return { ok: true };
    }
  }

  async function sendWinnerFallback(ui) {
    if (!ui || ui.fallbackSent) {
      return;
    }
    ui.fallbackSent = true;
    ui.winnerUiState = "fallback-sending";
    log("[mango-bomb] winner edit failed fallback=send");
    if (typeof sendMessage !== "function") {
      ui.winnerUiState = "failed";
      log("[mango-bomb] winner fallback failed");
      return;
    }
    try {
      if (injectedSendMode === "throw") {
        injectedSendMode = null;
        throw new Error("winner-fallback-failed");
      }
      const extra = emptyGameKeyboardExtra();
      if (ui.threadId != null) {
        extra.message_thread_id = ui.threadId;
      }
      const sent = await sendMessage(ui.chatId, ui.text, extra);
      const mid =
        sent && (sent.message_id != null ? sent.message_id : sent.messageId);
      if (mid != null) {
        addGameMessageIds(GAME_TYPE.MANGOBOMB, ui.gameId, ui.chatId, [mid]);
      }
      ui.winnerUiState = "visible";
      log("[mango-bomb] winner fallback sent");
    } catch (_err) {
      ui.winnerUiState = "failed";
      log("[mango-bomb] winner fallback failed");
    }
  }

  async function deliverWinnerUi(ui) {
    if (!ui || ui.kind !== "winner") {
      return;
    }
    ui.winnerUiState = "edit-attempt";
    const editResult = await attemptBoundedEdit({
      gameId: ui.gameId,
      chatId: ui.chatId,
      messageId: ui.messageId,
      text: ui.text,
      extra: ui.extra,
      stage: "winner",
      revision: ui.renderRevision,
    });
    if (editResult.ok) {
      ui.winnerUiState = "visible";
      log("[mango-bomb] winner edit succeeded");
      return;
    }
    if (ui.winnerUiState === "visible" || ui.fallbackSent) {
      return;
    }
    await sendWinnerFallback(ui);
  }

  function lobbyRemainingSeconds(game) {
    const ms = game.lobbyEndsAt - nowFn();
    return Math.max(0, Math.ceil(ms / 1000));
  }

  function lobbyDisplaySeconds(game) {
    return Math.max(1, lobbyRemainingSeconds(game));
  }

  function renderLobbyMessage(game) {
    if (!game || game.status !== STATUS.LOBBY) {
      return Promise.resolve(false);
    }
    bumpRevision(game);
    queueRender(
      game,
      buildLobbyText(game.players.size, lobbyDisplaySeconds(game)),
      joinKeyboard(game.id),
      "lobby"
    );
    return Promise.resolve(true);
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
    if (!game || game.status !== STATUS.LOBBY) {
      clearGameTimer(game, "countdown");
      return;
    }
    const wait = msUntilNextCountdown(game);
    if (wait == null) {
      clearGameTimer(game, "countdown");
      return;
    }
    const countdownGameId = game.id;
    const countdownInstance = game.instanceSeq;
    setGameTimer(game, "countdown", wait, () => {
      enqueue(game.chatId, (token) => {
        if (!isLiveTask(token)) {
          return;
        }
        const current = gamesById.get(countdownGameId);
        if (
          !current ||
          current.instanceSeq !== countdownInstance ||
          current.status !== STATUS.LOBBY
        ) {
          return;
        }
        renderLobbyMessage(current);
        scheduleLobbyCountdown(current);
      }, "lobby-countdown");
    });
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
    setStatus(game, STATUS.RUNNING, "arm");
    clearPending(game);
    const instance = game.instanceSeq;
    setGameTimer(game, "bomb", lifetime, () => {
      const current = gamesById.get(game.id);
      if (
        !current ||
        current.instanceSeq !== instance ||
        current.bombGeneration !== generation
      ) {
        return;
      }
      setPending(current, PENDING.EXPLODE, generation);
      enqueue(
        current.chatId,
        (token) => explode(current.id, generation, token, instance),
        "explode"
      );
    });
    return holder;
  }

  function finishWinner(game) {
    const winnerId = Array.from(game.alive)[0];
    const winner = winnerId ? game.players.get(winnerId) : null;
    const name = (winner && winner.displayName) || "Player";
    setStatus(game, STATUS.FINISHED, "winner");
    game.currentHolder = winnerId || null;
    clearPending(game);
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
    bumpRevision(game);
    const text = buildWinnerText(name, xpLine);
    const extra = emptyGameKeyboardExtra();
    const ui = retainFinalUi(game, { kind: "winner", text, extra });
    const winnerRef = winnerId;
    dropGame(game);
    trackWinnerUi(deliverWinnerUi(ui));
    return { ok: true, status: STATUS.FINISHED, winnerId: winnerRef };
  }

  function explode(gameId, generation, token, instanceSeqExpected) {
    if (token != null && !isLiveTask(token)) {
      return { ok: false, reason: "queue-timeout" };
    }
    const game = gamesById.get(gameId);
    if (
      !game ||
      game.status !== STATUS.RUNNING ||
      (instanceSeqExpected != null && game.instanceSeq !== instanceSeqExpected)
    ) {
      return { ok: false, reason: "inactive" };
    }
    if (generation != null && generation !== game.bombGeneration) {
      if (pendingMatches(game, PENDING.EXPLODE, generation)) {
        clearPending(game, PENDING.EXPLODE);
      }
      return { ok: false, reason: "stale-timer" };
    }
    const victimId = game.currentHolder;
    const victim = victimId ? game.players.get(victimId) : null;
    const name = (victim && victim.displayName) || "Player";
    game.alive.delete(victimId);
    game.eliminated.push(victimId);
    game.currentHolder = null;
    game.roundNumber += 1;
    clearGameTimer(game, "bomb");
    clearPending(game, PENDING.EXPLODE);

    const survivors = Array.from(game.alive);
    for (const uid of survivors) {
      const row = game.players.get(uid);
      award(uid, row && row.displayName, XP_SURVIVE, game.id);
    }
    log("[mango-bomb] eliminated");

    if (survivors.length <= 1) {
      if (survivors.length === 1) {
        return finishWinner(game);
      }
      setStatus(game, STATUS.CANCELLED, "empty");
      bumpRevision(game);
      const endedText = "🥭💣 ManGo Bomb ended.";
      retainFinalUi(game, {
        kind: "cancel",
        text: endedText,
        extra: emptyGameKeyboardExtra(),
      });
      queueRender(game, endedText, emptyGameKeyboardExtra(), "explode");
      dropGame(game);
      return { ok: true, status: STATUS.CANCELLED };
    }

    setStatus(game, STATUS.BETWEEN_ROUNDS, "explode");
    const pauseInstance = game.instanceSeq;
    setGameTimer(game, "pause", betweenRoundsMs, () => {
      const current = gamesById.get(gameId);
      if (
        !current ||
        current.instanceSeq !== pauseInstance ||
        current.status !== STATUS.BETWEEN_ROUNDS
      ) {
        return;
      }
      setPending(current, PENDING.NEXT_ROUND);
      enqueue(
        current.chatId,
        (taskToken) => startNextRound(gameId, taskToken, pauseInstance),
        "between-rounds"
      );
    });
    bumpRevision(game);
    queueRender(
      game,
      buildBoomText(name, survivors.length),
      emptyInlineKeyboardExtra(),
      "explode"
    );
    return { ok: true, status: STATUS.BETWEEN_ROUNDS, eliminated: victimId };
  }

  function startNextRound(gameId, token, instanceSeqExpected) {
    if (token != null && !isLiveTask(token)) {
      return { ok: false, reason: "queue-timeout" };
    }
    const live = gamesById.get(gameId);
    if (
      !live ||
      live.status !== STATUS.BETWEEN_ROUNDS ||
      (instanceSeqExpected != null && live.instanceSeq !== instanceSeqExpected)
    ) {
      return { ok: false, reason: "inactive" };
    }
    clearPending(live, PENDING.NEXT_ROUND);
    const holder = armBomb(live, null);
    if (!holder) {
      cancelDueToInternalError(live, "between-rounds", "no-holder");
      return { ok: false, reason: "no-holder" };
    }
    bumpRevision(live);
    queueRender(live, buildBombText(live), passKeyboard(live.id), "between-rounds");
    return { ok: true, status: STATUS.RUNNING };
  }

  function closeLobby(gameId, token, instanceSeqExpected) {
    if (token != null && !isLiveTask(token)) {
      return { ok: false, reason: "queue-timeout" };
    }
    const game = gamesById.get(gameId);
    if (
      !game ||
      game.status !== STATUS.LOBBY ||
      (instanceSeqExpected != null && game.instanceSeq !== instanceSeqExpected)
    ) {
      return { ok: false, reason: "inactive" };
    }
    clearGameTimer(game, "lobby");
    clearGameTimer(game, "countdown");
    clearPending(game, PENDING.CLOSE_LOBBY);
    if (game.players.size < MIN_PLAYERS) {
      const empty = game.players.size === 0;
      const state = empty ? FINAL_STATE.EMPTY : FINAL_STATE.NOT_ENOUGH;
      const text = empty ? buildEmptyLobbyText() : buildNotEnoughPlayersText();
      setStatus(game, STATUS.CANCELLED, "lobby-cancel");
      log("[mango-bomb] cancelled");
      logGameCleanup(GAME_TYPE.MANGOBOMB, state);
      bumpRevision(game);
      retainFinalUi(game, { kind: "cancel", text, extra: emptyGameKeyboardExtra() });
      queueRender(game, text, emptyGameKeyboardExtra(), "lobby-close");
      dropGame(game);
      return { ok: true, status: STATUS.CANCELLED, empty };
    }
    for (const [userId, row] of game.players.entries()) {
      const result = award(userId, row.displayName, XP_PARTICIPATE, game.id);
      if (result && result.reason === "wallet-required") {
        maybeRemind(userId, result, game);
      }
    }
    log("[mango-bomb] round started");
    game.roundNumber = 1;
    armBomb(game, null);
    bumpRevision(game);
    queueRender(game, buildBombText(game), passKeyboard(game.id), "lobby-close");
    return { ok: true, status: STATUS.RUNNING, snapshot: snapshot(game, true) };
  }

  function startWatchdog() {
    if (watchdogHandle != null) {
      return;
    }
    const tick = () => {
      watchdogHandle = null;
      runWatchdog();
      if (hasActiveGames()) {
        watchdogHandle = utilityTimeout(tick, watchdogMs);
      }
    };
    watchdogHandle = utilityTimeout(tick, watchdogMs);
  }

  function stopWatchdogIfIdle() {
    if (hasActiveGames()) {
      return;
    }
    clearUtility(watchdogHandle);
    watchdogHandle = null;
  }

  function hasActiveGames() {
    for (const game of gamesById.values()) {
      if (game.status !== STATUS.FINISHED && game.status !== STATUS.CANCELLED) {
        return true;
      }
    }
    return false;
  }

  function runWatchdog() {
    for (const game of Array.from(gamesById.values())) {
      if (game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
        continue;
      }
      const meta = queueMeta.get(String(game.chatId));
      if (meta && nowFn() - meta.startedAt > queueTimeoutMs + watchdogGraceMs) {
        cancelDueToInternalError(game, "watchdog", "queue-stalled");
        continue;
      }
      if (invariantsHold(game) && !watchdogBroken(game)) {
        continue;
      }
      if (watchdogBroken(game) || !invariantsHold(game)) {
        cancelDueToInternalError(game, "watchdog", "invariant");
      }
    }
  }

  function watchdogBroken(game) {
    const now = nowFn();
    if (game.status === STATUS.RUNNING) {
      const expired =
        Number.isFinite(game.bombDeadline) &&
        now >= game.bombDeadline + watchdogGraceMs;
      return (
        expired &&
        !hasActiveBombTimer(game) &&
        !pendingMatches(game, PENDING.EXPLODE, game.bombGeneration)
      );
    }
    if (game.status === STATUS.BETWEEN_ROUNDS) {
      return !hasActivePauseTimer(game) && !pendingMatches(game, PENDING.NEXT_ROUND);
    }
    if (game.status === STATUS.LOBBY) {
      const expired = now >= game.lobbyEndsAt + watchdogGraceMs;
      return (
        expired &&
        !hasActiveLobbyTimer(game) &&
        !pendingMatches(game, PENDING.CLOSE_LOBBY)
      );
    }
    return false;
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
    let id = "";
    for (let i = 0; i < 8; i += 1) {
      const raw = i === 0 ? randomIdFn() : crypto.randomBytes(4).toString("hex");
      const candidate = String(raw).replace(/[^a-f0-9]/gi, "").slice(0, 16);
      if (
        candidate &&
        !gamesById.has(candidate) &&
        !retiredGames.has(candidate) &&
        !finalUiByGameId.has(candidate)
      ) {
        id = candidate;
        break;
      }
    }
    if (!id) {
      id = crypto.randomBytes(8).toString("hex");
    }
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
      renderRevision: 1,
      pendingTransition: null,
      lastPassAt: 0,
      lastPassUser: null,
      lastStage: "lobby",
      lastProgressAt: now,
      roundNumber: 0,
      instanceSeq: (instanceSeq += 1),
      source,
      timers: { lobby: null, countdown: null, bomb: null, pause: null },
    };
    gamesById.set(id, game);
    gamesByChat.set(String(chatId), game);
    lastStartByChat.set(String(chatId), now);
    const lobbyInstance = game.instanceSeq;
    setGameTimer(game, "lobby", lobbyMs, () => {
      const current = gamesById.get(id);
      if (
        !current ||
        current.instanceSeq !== lobbyInstance ||
        current.status !== STATUS.LOBBY
      ) {
        return;
      }
      setPending(current, PENDING.CLOSE_LOBBY);
      enqueue(
        current.chatId,
        (token) => closeLobby(id, token, lobbyInstance),
        "lobby-close"
      );
    });
    scheduleLobbyCountdown(game);
    startWatchdog();
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
    if (game.status === STATUS.LOBBY && !hasActiveCountdownTimer(game)) {
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
    noteProgress(game, "join");
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
    if (game.lastPassUser === uid && now - game.lastPassAt < passCooldownMs) {
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
    noteProgress(game, "pass");
    const instance = game.instanceSeq;
    setGameTimer(game, "bomb", remaining, () => {
      const current = gamesById.get(game.id);
      if (
        !current ||
        current.instanceSeq !== instance ||
        current.bombGeneration !== generation
      ) {
        return;
      }
      setPending(current, PENDING.EXPLODE, generation);
      enqueue(
        current.chatId,
        (taskToken) => explode(current.id, generation, taskToken, instance),
        "explode"
      );
    });
    log("[mango-bomb] pass");
    bumpRevision(game);
    return {
      ok: true,
      text: buildBombText(game),
      extra: passKeyboard(game.id),
      snapshot: snapshot(game, true),
      renderRevision: game.renderRevision,
    };
  }

  function forceLobbyEnd(gameId) {
    const game = gamesById.get(gameId);
    if (!game) {
      return Promise.resolve({ ok: false, reason: "inactive" });
    }
    setPending(game, PENDING.CLOSE_LOBBY);
    const instance = game.instanceSeq;
    return enqueue(
      game.chatId,
      (token) => closeLobby(gameId, token, instance),
      "lobby-close"
    );
  }

  function forceExplode(gameId) {
    const game = gamesById.get(gameId);
    if (!game) {
      return Promise.resolve({ ok: false, reason: "inactive" });
    }
    setPending(game, PENDING.EXPLODE, game.bombGeneration);
    const instance = game.instanceSeq;
    const generation = game.bombGeneration;
    return enqueue(
      game.chatId,
      (token) => explode(game.id, generation, token, instance),
      "explode"
    );
  }

  function cancelAll(_reason = "shutdown") {
    const had = gamesById.size > 0;
    for (const game of Array.from(gamesById.values())) {
      setStatus(game, STATUS.CANCELLED, "shutdown");
      dropGame(game);
    }
    for (const handle of Array.from(gameplayHandles)) {
      clearGameplayHandle(handle);
    }
    for (const handle of Array.from(utilityHandles)) {
      clearUtility(handle);
    }
    watchdogHandle = null;
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
    queueMeta.clear();
    timedOutTokens.clear();
    retiredGames.clear();
    finalUiByGameId.clear();
    renderWait = Promise.resolve();
    winnerUiWait = Promise.resolve();
    hungRender = null;
    queueHang = null;
    injectedQueueStage = null;
    injectedQueueHangStage = null;
    injectedRenderMode = null;
    injectedSendMode = null;
    editMessage = null;
    sendMessage = null;
    awardXpFn = null;
    walletReminderFn = null;
  }

  function deadlineLabel(game) {
    if (!game || !Number.isFinite(game.bombDeadline)) {
      return "none";
    }
    return nowFn() >= game.bombDeadline ? "expired" : "future";
  }

  function holderLabel(game) {
    if (!game || game.status !== STATUS.RUNNING) {
      return "ABSENT";
    }
    return game.currentHolder && game.alive.has(String(game.currentHolder))
      ? "PRESENT"
      : "ABSENT";
  }

  function getDebugSnapshot(chatId) {
    const game =
      chatId != null
        ? activeGameForChat(chatId)
        : Array.from(gamesByChat.values()).find(
            (row) =>
              row.status !== STATUS.FINISHED && row.status !== STATUS.CANCELLED
          ) || null;
    const meta = game ? queueMeta.get(String(game.chatId)) : null;
    const now = nowFn();
    if (!game) {
      return {
        status: STATUS.IDLE,
        communityBusy: isMangoBombOpen(),
      };
    }
    return {
      status: game.status,
      round: game.roundNumber,
      players: game.players.size,
      alive: game.alive.size,
      holder: holderLabel(game),
      deadline: deadlineLabel(game),
      lobbyTimer: hasActiveLobbyTimer(game),
      countdownTimer: hasActiveCountdownTimer(game),
      bombTimer: hasActiveBombTimer(game),
      pauseTimer: hasActivePauseTimer(game),
      pendingTransition: pendingType(game) || "none",
      queuePending: Boolean(meta),
      queueStage: meta ? meta.stage : "none",
      queueAgeMs: meta ? Math.max(0, now - meta.startedAt) : 0,
      generation: game.bombGeneration,
      renderRevision: game.renderRevision,
      lastStage: game.lastStage || "none",
      lastProgressMsAgo: Math.max(0, now - (game.lastProgressAt || now)),
      communityBusy: true,
    };
  }

  function formatBombDebug(snapshot) {
    if (!snapshot || snapshot.status === STATUS.IDLE) {
      return [
        "🥭💣 Bomb debug",
        "",
        "status: idle",
        `communityBusy: ${yn(Boolean(snapshot && snapshot.communityBusy))}`,
      ].join("\n");
    }
    return [
      "🥭💣 Bomb debug",
      "",
      `status: ${snapshot.status}`,
      `round: ${snapshot.round}`,
      `players: ${snapshot.players}`,
      `alive: ${snapshot.alive}`,
      `holder: ${snapshot.holder}`,
      `deadline: ${snapshot.deadline}`,
      "",
      `lobbyTimer: ${yn(snapshot.lobbyTimer)}`,
      `countdownTimer: ${yn(snapshot.countdownTimer)}`,
      `bombTimer: ${yn(snapshot.bombTimer)}`,
      `pauseTimer: ${yn(snapshot.pauseTimer)}`,
      "",
      `pendingTransition: ${snapshot.pendingTransition}`,
      "",
      `queuePending: ${yn(snapshot.queuePending)}`,
      `queueStage: ${snapshot.queueStage}`,
      `queueAgeMs: ${snapshot.queueAgeMs}`,
      "",
      `generation: ${snapshot.generation}`,
      `renderRevision: ${snapshot.renderRevision}`,
      "",
      `lastStage: ${snapshot.lastStage}`,
      `lastProgressMsAgo: ${snapshot.lastProgressMsAgo}`,
      "",
      `communityBusy: ${yn(snapshot.communityBusy)}`,
    ].join("\n");
  }

  return {
    STATUS,
    PENDING,
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
    RENDER_TIMEOUT_MS: renderTimeoutMs,
    QUEUE_TIMEOUT_MS: queueTimeoutMs,
    WATCHDOG_MS: watchdogMs,
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
    hasActiveLobbyTimer: (gameId) => hasActiveLobbyTimer(gamesById.get(gameId)),
    hasActiveCountdownTimer: (gameId) =>
      hasActiveCountdownTimer(gamesById.get(gameId)),
    hasActiveBombTimer: (gameId) => hasActiveBombTimer(gamesById.get(gameId)),
    hasActivePauseTimer: (gameId) => hasActivePauseTimer(gamesById.get(gameId)),
    whenIdle,
    whenQueueIdle,
    whenWinnerUiIdle,
    getDebugSnapshot,
    formatBombDebug,
    getFinalUi(gameId) {
      const ui = finalUiByGameId.get(gameId);
      if (!ui) {
        return null;
      }
      return {
        kind: ui.kind,
        text: ui.text,
        extra: ui.extra,
        winnerUiState: ui.winnerUiState,
        fallbackSent: ui.fallbackSent,
        renderRevision: ui.renderRevision,
        threadId: ui.threadId,
        messageId: ui.messageId,
      };
    },
    setEditMessageHandler(fn) {
      editMessage = typeof fn === "function" ? fn : null;
    },
    setDeleteMessageHandler(fn) {
      deleteMessageFn = typeof fn === "function" ? fn : null;
    },
    setSendMessageHandler(fn) {
      sendMessage = typeof fn === "function" ? fn : null;
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
      return enqueue(game.chatId, (token) => {
        if (!isLiveTask(token)) {
          return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
        }
        const result = tryJoin(input);
        if (result.ok) {
          const live = gamesById.get(input.gameId);
          result.rendered = Boolean(live && live.messageId != null);
          if (live) {
            renderLobbyMessage(live);
          }
        }
        return result;
      }, "join");
    },
    enqueuePass(input) {
      const game = gamesById.get(input && input.gameId);
      if (!game) {
        return Promise.resolve({ ok: false, reason: "stale", toast: STALE_CALLBACK });
      }
      return enqueue(game.chatId, (token) => {
        if (!isLiveTask(token)) {
          return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
        }
        const result = tryPass(input);
        if (result.ok) {
          const live = gamesById.get(input.gameId);
          if (live) {
            queueRender(live, result.text, result.extra, "pass");
          }
        }
        return result;
      }, "pass");
    },
    injectQueueThrow(stage) {
      injectedQueueStage = stage;
    },
    injectQueueHang(stage) {
      injectedQueueHangStage = stage;
      queueHang = null;
    },
    resolveQueueHang() {
      if (queueHang && typeof queueHang.resolve === "function") {
        queueHang.resolve();
      }
      queueHang = null;
      injectedQueueHangStage = null;
    },
    injectRenderThrow() {
      injectedRenderMode = "throw";
    },
    injectRenderHang() {
      injectedRenderMode = "hang";
      hungRender = null;
    },
    injectSendThrow() {
      injectedSendMode = "throw";
    },
    resolveHungRenders() {
      if (hungRender && typeof hungRender.resolve === "function") {
        hungRender.resolve();
      }
      hungRender = null;
      injectedRenderMode = null;
    },
    clearGameplayTimersForTests(gameId) {
      const game = gamesById.get(gameId);
      if (!game) {
        return false;
      }
      clearGameTimers(game);
      clearPending(game);
      return true;
    },
    masqueradeStaleTimerFieldForTests(gameId, type = "bomb") {
      const game = gamesById.get(gameId);
      if (!game || !game.timers) {
        return false;
      }
      game.timers[type] = { fake: true };
      return true;
    },
    invariantsHoldForTests(gameId) {
      return invariantsHold(gamesById.get(gameId));
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
  PENDING: {
    EXPLODE: "explode",
    CLOSE_LOBBY: "close-lobby",
    NEXT_ROUND: "next-round",
  },
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
  QUEUE_TIMEOUT_MS,
  WATCHDOG_MS,
  WATCHDOG_GRACE_MS,
  INTERNAL_CANCEL_TEXT,
  parseMangoBombCallbackData,
  joinCallbackData,
  passCallbackData,
  joinKeyboard,
  passKeyboard,
  buildLobbyText,
  buildCancelledText,
  buildEmptyLobbyText,
  buildNotEnoughPlayersText,
  createMangoBombService,
  getMangoBombRuntime: () => defaultService,
  startLobby: (input) => defaultService.startLobby(input),
  isMangoBombOpen: (chatId) => defaultService.isMangoBombOpen(chatId),
};
