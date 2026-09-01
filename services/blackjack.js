/**
 * ManGo Blackjack — heads-up lobby + PvP/bot. In-memory; restart cancels.
 * Callbacks: bj:join|play|pass|hit|stand:<id>. Server uses ctx.from.id.
 * Telegram rendering is output-only and never owns game progression.
 */

const crypto = require("crypto");
const { Markup } = require("telegraf");
const { sanitizePvpDisplayName } = require("./pvpSessionManager");
const {
  createPvpMatchReservation,
  getSharedPvpMatchReservation,
  PLAYER_BUSY_TEXT,
} = require("./pvpMatchReservation");
const { XP_WALLET_GAME_LOCKED_LINE } = require("./xpWalletGate");
const { log, error: logError } = require("../utils/logger");
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
const {
  createDeck,
  shuffleDeck,
  drawCard,
  defaultRandomInt,
  handValue,
  isBust,
  isNaturalBlackjack,
  botShouldHit,
  compareHands,
  formatHandWithTotal,
} = require("./blackjackRules");

const STATUS = Object.freeze({
  IDLE: "idle",
  LOBBY: "lobby",
  DECISION: "decision",
  DEALING: "dealing",
  PLAYER_TURN: "player-turn",
  BOT_TURN: "bot-turn",
  RESOLVING: "resolving",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

const PENDING = Object.freeze({
  CLOSE_LOBBY: "close-lobby",
  DECISION_TIMEOUT: "decision-timeout",
  TURN_TIMEOUT: "turn-timeout",
  BOT_ACT: "bot-act",
});

const BOT_ID = "bot";
const BOT_DISPLAY_NAME = "🤖 ManGo Bot";
const LOBBY_MS = 60 * 1000;
const LOBBY_COUNTDOWN_MS = 5 * 1000;
const DECISION_MS = 30 * 1000;
const TURN_MS = 30 * 1000;
const BOT_THINK_MS = 900;
const MAX_HUMAN_PLAYERS = 2;
const STALE_CALLBACK = GAME_OVER_TOAST;
const LATE_JOIN_TOAST = "This Blackjack round has already started.";
const STALE_TURN_TOAST = "This Blackjack turn is over.";
const RENDER_TIMEOUT_MS = 5_000;
const QUEUE_TIMEOUT_MS = 5_000;
const WATCHDOG_MS = 5_000;
const WATCHDOG_GRACE_MS = 1_500;
const CALLBACK_RE = /^bj:(join|play|pass|hit|stand):([a-f0-9]{8,16})$/i;
const INTERNAL_CANCEL_TEXT = [
  "🃏 ManGo Blackjack cancelled.",
  "",
  "The game hit an unexpected error.",
  "Start a new round from Games.",
].join("\n");

function parseBlackjackCallbackData(data) {
  if (typeof data !== "string") {
    return null;
  }
  const match = data.trim().match(CALLBACK_RE);
  if (!match) {
    return null;
  }
  return { action: match[1].toLowerCase(), gameId: match[2].toLowerCase() };
}

function callbackData(action, gameId) {
  return `bj:${action}:${gameId}`;
}

function joinKeyboard(gameId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🃏 Join Blackjack", callbackData("join", gameId))],
  ]);
}

function decisionKeyboard(gameId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎲 Play — Risk 10 XP", callbackData("play", gameId))],
    [Markup.button.callback("🛡 Pass — Take 2 XP", callbackData("pass", gameId))],
  ]);
}

function turnKeyboard(gameId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Hit", callbackData("hit", gameId)),
      Markup.button.callback("✋ Stand", callbackData("stand", gameId)),
    ],
  ]);
}

function isMessageNotModifiedError(err) {
  const desc = err && (err.description || err.message || "");
  return String(desc).toLowerCase().includes("message is not modified");
}

function playerNames(players) {
  return players.map((p) => p.displayName).join("\n");
}

function buildLobbyText(players, lobbySeconds) {
  const seconds = Number.isFinite(lobbySeconds) ? lobbySeconds : 60;
  const humans = (players || []).filter((p) => !p.isBot);
  const lines = ["🃏 ManGo Blackjack", ""];
  if (humans.length <= 1) {
    lines.push("Player 1:");
    lines.push(humans[0] ? humans[0].displayName : "—");
    lines.push("", "Waiting for an opponent...");
  } else {
    lines.push("Players:");
    lines.push(playerNames(humans));
  }
  lines.push("", `⏳ Starts in: ${seconds}s`);
  return lines.join("\n");
}

function rewardsLine(status) {
  if (!status) {
    return "🃏 Blackjack rewards today:\n0 / 2 rounds used";
  }
  if (status.limitReached || status.funOnly) {
    return [
      "🎮 Daily Blackjack XP limit reached.",
      "",
      "You can keep playing for fun. 🥭",
    ].join("\n");
  }
  return `🃏 Blackjack rewards today:\n${status.rewardedRoundsUsed} / ${status.dailyCap} rounds used`;
}

function xpLineFor(result, fallback) {
  if (result && result.awarded && result.pointsToAdd > 0) {
    return `+${result.pointsToAdd} XP`;
  }
  if (result && result.reason === "wallet-required") {
    return XP_WALLET_GAME_LOCKED_LINE;
  }
  if (result && (result.funOnly || result.reason === "daily-cap" || result.reason === "pair-cap")) {
    return "🎮 Playing for fun\nNo XP awarded — daily Blackjack limit reached.";
  }
  return fallback || "+0 XP";
}

function createBlackjackService(options = {}) {
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
  const decisionMs = Number.isFinite(options.decisionMs) ? options.decisionMs : DECISION_MS;
  const turnMs = Number.isFinite(options.turnMs) ? options.turnMs : TURN_MS;
  const botThinkMs = Number.isFinite(options.botThinkMs) ? options.botThinkMs : BOT_THINK_MS;
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
  const reservation =
    options.reservation || createPvpMatchReservation();

  const gamesById = new Map();
  const gamesByChat = new Map();
  const queues = new Map();
  const queueMeta = new Map();
  const timedOutTokens = new Set();
  const gameplayHandles = new Set();
  const utilityHandles = new Set();
  const retiredGames = new Map();
  const finalUiByGameId = new Map();
  let queueSeq = 0;
  let instanceSeq = 0;
  let renderWait = Promise.resolve();
  let winnerUiWait = Promise.resolve();
  let watchdogHandle = null;
  let editMessage = null;
  let sendMessage = null;
  let deleteMessageFn = null;
  let injectedRenderMode = null;
  let hungRender = null;
  let injectedSendMode = null;
  let injectedQueueStage = null;
  let awards = {
    reserve: null,
    pass: null,
    bot: null,
    pvp: null,
    status: null,
    markPair: null,
  };
  let walletReminderFn = null;

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
    const scheduledGeneration = game.roundGeneration;
    const scheduledInstance = game.instanceSeq;
    const handle = setTimeoutFn(() => {
      gameplayHandles.delete(handle);
      const current = gamesById.get(gameId);
      if (
        !current ||
        current.instanceSeq !== scheduledInstance ||
        current.roundGeneration !== scheduledGeneration ||
        !current.timers ||
        current.timers[type] !== handle
      ) {
        return;
      }
      current.timers[type] = null;
      onFire(current);
    }, delay);
    gameplayHandles.add(handle);
    game.timers[type] = handle;
    return handle;
  }

  function bumpRevision(game) {
    if (!game) {
      return 0;
    }
    game.renderRevision += 1;
    return game.renderRevision;
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
      log(`[blackjack] state from=${game.status} to=${next}`);
    }
    game.status = next;
    noteProgress(game, stage || next);
  }

  function setPending(game, type, generation) {
    if (!game) {
      return;
    }
    game.pendingTransition = {
      type,
      generation: generation == null ? game.roundGeneration : generation,
    };
  }

  function clearPending(game, type) {
    if (!game || !game.pendingTransition) {
      return;
    }
    if (type && game.pendingTransition.type !== type) {
      return;
    }
    game.pendingTransition = null;
  }

  function pendingMatches(game, type, generation) {
    if (!game || !game.pendingTransition) {
      return false;
    }
    if (game.pendingTransition.type !== type) {
      return false;
    }
    if (generation != null && game.pendingTransition.generation !== generation) {
      return false;
    }
    return true;
  }

  function humanPlayers(game) {
    return Array.from(game.players.values()).filter((p) => !p.isBot);
  }

  function snapshotPlayers(game) {
    return Array.from(game.players.values()).map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      isBot: Boolean(p.isBot),
      decision: p.decision,
      funOnly: Boolean(p.funOnly),
      eligible: Boolean(p.eligible),
      hand: (p.hand || []).slice(),
      resolved: Boolean(p.resolved),
      bust: Boolean(p.bust),
    }));
  }

  function snapshot(game) {
    if (!game) {
      return null;
    }
    return {
      id: game.id,
      chatId: game.chatId,
      threadId: game.threadId,
      messageId: game.messageId,
      startedAt: game.startedAt,
      lobbyEndsAt: game.lobbyEndsAt,
      status: game.status,
      opponentType: game.opponentType,
      currentTurn: game.currentTurn,
      turnDeadline: game.turnDeadline,
      roundGeneration: game.roundGeneration,
      renderRevision: game.renderRevision,
      pendingTransition: game.pendingTransition && game.pendingTransition.type,
      awardsSettled: Boolean(game.awardsSettled),
      deckIndex: game.deckIndex,
      players: snapshotPlayers(game),
      lastStage: game.lastStage,
      lastProgressAt: game.lastProgressAt,
    };
  }

  function chatGameMap(chatId) {
    return gamesByChat.get(String(chatId)) || null;
  }

  function liveGamesForChat(chatId) {
    const map = chatGameMap(chatId);
    if (!map) {
      return [];
    }
    return Array.from(map.values()).filter(
      (game) => game.status !== STATUS.FINISHED && game.status !== STATUS.CANCELLED
    );
  }

  function addGameToChat(game) {
    const key = String(game.chatId);
    let map = gamesByChat.get(key);
    if (!map) {
      map = new Map();
      gamesByChat.set(key, map);
    }
    map.set(game.id, game);
  }

  function removeGameFromChat(game) {
    const key = String(game.chatId);
    const map = gamesByChat.get(key);
    if (!map) {
      return;
    }
    map.delete(game.id);
    if (map.size === 0) {
      gamesByChat.delete(key);
    }
  }

  function activeGameForChat(chatId) {
    const live = liveGamesForChat(chatId);
    return live.length ? live[0] : null;
  }

  function isBlackjackOpen(chatId) {
    if (chatId == null) {
      for (const map of gamesByChat.values()) {
        for (const game of map.values()) {
          if (game.status !== STATUS.FINISHED && game.status !== STATUS.CANCELLED) {
            return true;
          }
        }
      }
      return false;
    }
    return liveGamesForChat(chatId).length > 0;
  }

  function isRevisionCurrent(gameId, revision) {
    const game = gamesById.get(gameId);
    if (game) {
      return game.renderRevision === revision;
    }
    const retired = retiredGames.get(gameId);
    return Boolean(retired && retired.renderRevision === revision);
  }

  function isLiveTask(token) {
    return !timedOutTokens.has(token);
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

  async function runQueuedTask(fn, stage, chatKey, token) {
    const startedAt = nowFn();
    queueMeta.set(chatKey, { stage, startedAt, token });
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = utilityTimeout(() => {
        timedOutTokens.add(token);
        const err = new Error("queue-timeout");
        err.code = "QUEUE_TIMEOUT";
        reject(err);
      }, queueTimeoutMs);
    });
    try {
      if (injectedQueueStage && injectedQueueStage === stage) {
        injectedQueueStage = null;
        throw new Error("injected-queue-failure");
      }
      const result = await Promise.race([
        Promise.resolve().then(() => fn(token)),
        timeoutPromise,
      ]);
      if (!isLiveTask(token)) {
        return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
      }
      return result;
    } catch (err) {
      const timedOut = err && err.code === "QUEUE_TIMEOUT";
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

  function hasActiveTimer(game, type) {
    return Boolean(game && hasGameplayHandle(game.timers && game.timers[type]));
  }

  function invariantsHold(game) {
    if (!game) {
      return true;
    }
    if (game.status === STATUS.LOBBY) {
      return hasActiveTimer(game, "lobby") || pendingMatches(game, PENDING.CLOSE_LOBBY);
    }
    if (game.status === STATUS.DECISION) {
      return hasActiveTimer(game, "decision") || pendingMatches(game, PENDING.DECISION_TIMEOUT);
    }
    if (game.status === STATUS.PLAYER_TURN) {
      return hasActiveTimer(game, "turn") || pendingMatches(game, PENDING.TURN_TIMEOUT);
    }
    if (game.status === STATUS.BOT_TURN) {
      return hasActiveTimer(game, "bot") || pendingMatches(game, PENDING.BOT_ACT);
    }
    if (
      game.status === STATUS.FINISHED ||
      game.status === STATUS.CANCELLED ||
      game.status === STATUS.RESOLVING ||
      game.status === STATUS.DEALING
    ) {
      return true;
    }
    return false;
  }

  async function cancelDueToInternalError(game) {
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return;
    }
    logError("[blackjack] invariant fail — cancelling");
    logGameCleanup(GAME_TYPE.BLACKJACK, FINAL_STATE.CANCELLED);
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

  async function recoverAfterQueueError(gameKey, stage) {
    const game = gamesById.get(String(gameKey));
    if (!game) {
      return;
    }
    if (stage === "lobby-close") {
      clearPending(game, PENDING.CLOSE_LOBBY);
    } else if (stage === "decision-timeout") {
      clearPending(game, PENDING.DECISION_TIMEOUT);
    } else if (stage === "turn-timeout") {
      clearPending(game, PENDING.TURN_TIMEOUT);
    } else if (stage === "bot-act") {
      clearPending(game, PENDING.BOT_ACT);
    }
    if (invariantsHold(game)) {
      if (game.status === STATUS.LOBBY) {
        scheduleLobbyCountdown(game);
      }
      return;
    }
    await cancelDueToInternalError(game);
  }

  function clearGameTimers(game) {
    if (!game) {
      return;
    }
    clearGameTimer(game, "lobby");
    clearGameTimer(game, "countdown");
    clearGameTimer(game, "decision");
    clearGameTimer(game, "turn");
    clearGameTimer(game, "bot");
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
    removeGameFromChat(game);
    reservation.releaseMatch(game.id);
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
      gameType: GAME_TYPE.BLACKJACK,
      sessionId: game.id,
      chatId: game.chatId,
      messageIds: [game.messageId],
      setTimeoutFn,
      clearTimeoutFn,
      deleteMessageFn,
    });
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
      (stage === "lobby-close" || stage === "cancel" || stage === "finish")
    ) {
      logCleanupRenderFailed(GAME_TYPE.BLACKJACK);
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
      return { ok: false, stale: true };
    }
    if (injectedRenderMode === "throw") {
      injectedRenderMode = null;
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
      if (stage === "finish" || stage === "winner") {
        const ui = finalUiByGameId.get(gameId);
        if (!shouldApplyLateWinnerEdit(ui, revision)) {
          return { stale: true };
        }
      } else if (!isRevisionCurrent(gameId, revision)) {
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
      if (stage === "finish" || stage === "winner") {
        const ui = finalUiByGameId.get(gameId);
        if (!shouldApplyLateWinnerEdit(ui, revision) && ui && ui.winnerUiState === "visible") {
          return { ok: true, duplicate: true };
        }
      } else if (!isRevisionCurrent(gameId, revision)) {
        return { ok: false, stale: true };
      }
      return { ok: true };
    } catch (err) {
      if (err && err.code === "ETIMEDOUT") {
        work.then(
          () => undefined,
          () => undefined
        );
        return { ok: false, timedOut: true };
      }
      if (!isMessageNotModifiedError(err)) {
        logError(`[blackjack] render failed stage=${stage}`);
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
    if (typeof sendMessage !== "function") {
      ui.winnerUiState = "failed";
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
        addGameMessageIds(GAME_TYPE.BLACKJACK, ui.gameId, ui.chatId, [mid]);
      }
      ui.winnerUiState = "visible";
    } catch (_err) {
      ui.winnerUiState = "failed";
    }
  }

  async function deliverFinalUi(ui) {
    if (!ui) {
      return;
    }
    ui.winnerUiState = "edit-attempt";
    const editResult = await attemptBoundedEdit({
      gameId: ui.gameId,
      chatId: ui.chatId,
      messageId: ui.messageId,
      text: ui.text,
      extra: ui.extra,
      stage: ui.kind === "winner" || ui.kind === "finish" ? "finish" : ui.kind,
      revision: ui.renderRevision,
    });
    if (editResult.ok) {
      ui.winnerUiState = "visible";
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
      enqueue(game.id, (token) => {
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

  function renderLobbyMessage(game) {
    if (!game || game.status !== STATUS.LOBBY) {
      return Promise.resolve(false);
    }
    bumpRevision(game);
    queueRender(
      game,
      buildLobbyText(snapshotPlayers(game), lobbyDisplaySeconds(game)),
      joinKeyboard(game.id),
      "lobby"
    );
    return Promise.resolve(true);
  }

  async function callAward(kind, userId, displayName, payload) {
    const fn = awards[kind];
    if (typeof fn !== "function") {
      return { awarded: false, pointsToAdd: 0, reason: "no-handler" };
    }
    try {
      const result = await Promise.resolve(
        fn(userId, displayName, payload || {})
      );
      return result || { awarded: false, pointsToAdd: 0 };
    } catch (_err) {
      return { awarded: false, pointsToAdd: 0, reason: "award-error" };
    }
  }

  function statusFor(userId) {
    if (typeof awards.status !== "function") {
      return {
        rewardedRoundsUsed: 0,
        dailyCap: 2,
        remaining: 2,
        limitReached: false,
      };
    }
    try {
      return awards.status(userId) || {};
    } catch (_err) {
      return {
        rewardedRoundsUsed: 0,
        dailyCap: 2,
        remaining: 2,
        limitReached: false,
      };
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

  function versusLine(game) {
    const humans = humanPlayers(game);
    if (game.opponentType === "bot" || humans.length < 2) {
      const name = humans[0] ? humans[0].displayName : "Player";
      return `${name} vs ${BOT_DISPLAY_NAME}`;
    }
    return `${humans[0].displayName} vs ${humans[1].displayName}`;
  }

  function rewardsBlock(game) {
    const humans = humanPlayers(game);
    const lines = [];
    for (const p of humans) {
      const st = p.statusSnapshot || statusFor(p.userId);
      if (st.limitReached || p.funOnly) {
        lines.push(`${p.displayName} — fun mode`);
      } else {
        lines.push(
          `${p.displayName} — ${st.rewardedRoundsUsed || 0} / ${st.dailyCap || 2} rounds used`
        );
      }
    }
    const anyFun = humans.some((p) => p.funOnly || (p.statusSnapshot && p.statusSnapshot.limitReached));
    if (anyFun && humans.length === 1) {
      return rewardsLine(humans[0].statusSnapshot || statusFor(humans[0].userId));
    }
    return ["🃏 Blackjack rewards today:", ...lines].join("\n");
  }

  function buildDecisionText(game, introLines) {
    const lines = ["🃏 ManGo Blackjack", "", versusLine(game), ""];
    if (introLines && introLines.length) {
      lines.push(...introLines, "");
    }
    lines.push(rewardsBlock(game), "");
    lines.push("Each player chooses:", "");
    lines.push("🎲 Play — risk your 10 XP reward");
    lines.push("🛡 Pass — take 2 XP");
    return lines.join("\n");
  }

  function handLines(game) {
    const lines = [];
    for (const p of game.players.values()) {
      const label = p.isBot ? BOT_DISPLAY_NAME : p.displayName;
      if (!p.hand || !p.hand.length) {
        lines.push(`${label} — hidden`);
      } else {
        lines.push(`${label} — ${formatHandWithTotal(p.hand)}`);
      }
    }
    return lines;
  }

  function buildTableText(game, banner) {
    const lines = ["🃏 ManGo Blackjack", "", versusLine(game), ""];
    if (banner) {
      lines.push(banner, "");
    }
    lines.push(...handLines(game));
    if (game.status === STATUS.PLAYER_TURN && game.currentTurn) {
      const actor = game.players.get(String(game.currentTurn));
      const name = actor ? actor.displayName : "Player";
      lines.push("", `Turn: ${name}`);
    }
    if (game.status === STATUS.BOT_TURN) {
      lines.push("", `${BOT_DISPLAY_NAME} is playing...`);
    }
    return lines.join("\n");
  }

  function makeBotPlayer() {
    return {
      userId: BOT_ID,
      displayName: BOT_DISPLAY_NAME,
      isBot: true,
      decision: "play",
      funOnly: true,
      eligible: false,
      slotConsumed: false,
      hand: [],
      resolved: false,
      bust: false,
    };
  }

  function dealTwo(game, player) {
    const first = drawCard(game.deck, game.deckIndex);
    const second = drawCard(game.deck, first.nextIndex);
    player.hand = [first.card, second.card].filter(Boolean);
    game.deckIndex = second.nextIndex;
  }

  function drawOne(game, player) {
    const drawn = drawCard(game.deck, game.deckIndex);
    if (drawn.card) {
      player.hand.push(drawn.card);
    }
    game.deckIndex = drawn.nextIndex;
    return drawn.card;
  }

  function afterHit(player) {
    if (isBust(player.hand)) {
      player.bust = true;
      player.resolved = true;
      return "bust";
    }
    if (handValue(player.hand) >= 21) {
      player.resolved = true;
      return "auto-stand";
    }
    return "continue";
  }

  function nextUnresolvedHuman(game, afterUserId) {
    const humans = humanPlayers(game).filter((p) => p.decision === "play" && !p.resolved);
    if (!humans.length) {
      return null;
    }
    if (!afterUserId) {
      return humans[0];
    }
    const idx = humans.findIndex((p) => p.userId === String(afterUserId));
    return humans[idx + 1] || null;
  }

  function startPlayerTurn(game, player) {
    if (!player) {
      return beginBotOrResolve(game);
    }
    if (isNaturalBlackjack(player.hand) || handValue(player.hand) >= 21) {
      player.resolved = true;
      if (isBust(player.hand)) {
        player.bust = true;
      }
      return startPlayerTurn(game, nextUnresolvedHuman(game, player.userId));
    }
    game.currentTurn = player.userId;
    game.roundGeneration += 1;
    setStatus(game, STATUS.PLAYER_TURN, "player-turn");
    const instance = game.instanceSeq;
    const generation = game.roundGeneration;
    game.turnDeadline = nowFn() + turnMs;
    setGameTimer(game, "turn", turnMs, () => {
      const current = gamesById.get(game.id);
      if (
        !current ||
        current.instanceSeq !== instance ||
        current.roundGeneration !== generation
      ) {
        return;
      }
      setPending(current, PENDING.TURN_TIMEOUT, generation);
      enqueue(
        current.id,
        (token) => autoStand(current.id, token, instance, generation),
        "turn-timeout"
      );
    });
    bumpRevision(game);
    queueRender(game, buildTableText(game), turnKeyboard(game.id), "turn");
    return { ok: true, status: STATUS.PLAYER_TURN };
  }

  function scheduleBotAct(game) {
    game.currentTurn = BOT_ID;
    game.roundGeneration += 1;
    setStatus(game, STATUS.BOT_TURN, "bot-turn");
    const instance = game.instanceSeq;
    const generation = game.roundGeneration;
    const delay = Math.max(0, botThinkMs);
    const fire = () => {
      const current = gamesById.get(game.id);
      if (
        !current ||
        current.instanceSeq !== instance ||
        current.roundGeneration !== generation
      ) {
        return;
      }
      setPending(current, PENDING.BOT_ACT, generation);
      enqueue(
        current.id,
        (token) => botAct(current.id, token, instance, generation),
        "bot-act"
      );
    };
    if (delay <= 0) {
      fire();
      return { ok: true, status: STATUS.BOT_TURN };
    }
    setGameTimer(game, "bot", delay, fire);
    bumpRevision(game);
    const bot = game.players.get(BOT_ID);
    const banner = botShouldHit(bot && bot.hand) ? "🤖 ManGo Bot draws..." : null;
    queueRender(
      game,
      buildTableText(game, banner),
      emptyGameKeyboardExtra(),
      "bot-turn"
    );
    return { ok: true, status: STATUS.BOT_TURN };
  }

  function beginBotOrResolve(game) {
    const bot = game.players.get(BOT_ID);
    if (bot && bot.decision === "play" && !bot.resolved) {
      return scheduleBotAct(game);
    }
    return finishGame(game);
  }

  function botAct(gameId, token, instanceSeqExpected, generation) {
    if (token != null && !isLiveTask(token)) {
      return { ok: false, reason: "queue-timeout" };
    }
    const game = gamesById.get(gameId);
    if (
      !game ||
      game.status !== STATUS.BOT_TURN ||
      (instanceSeqExpected != null && game.instanceSeq !== instanceSeqExpected) ||
      (generation != null && game.roundGeneration !== generation)
    ) {
      return { ok: false, reason: "stale-timer" };
    }
    clearPending(game, PENDING.BOT_ACT);
    const bot = game.players.get(BOT_ID);
    if (!bot) {
      return finishGame(game);
    }
    while (!bot.resolved && botShouldHit(bot.hand)) {
      const drawn = drawOne(game, bot);
      if (!drawn) {
        bot.resolved = true;
        noteProgress(game, "bot-stand");
        break;
      }
      const hitResult = afterHit(bot);
      noteProgress(game, "bot-hit");
      if (hitResult === "continue" && botThinkMs > 0) {
        return scheduleBotAct(game);
      }
    }
    if (!bot.resolved) {
      bot.resolved = true;
      noteProgress(game, "bot-stand");
    }
    bumpRevision(game);
    const total = handValue(bot.hand);
    const banner = bot.bust
      ? "🤖 ManGo Bot busts."
      : `🤖 ManGo Bot stands on ${total}.`;
    queueRender(game, buildTableText(game, banner), emptyGameKeyboardExtra(), "bot-stand");
    return finishGame(game);
  }

  function autoStand(gameId, token, instanceSeqExpected, generation) {
    if (token != null && !isLiveTask(token)) {
      return { ok: false, reason: "queue-timeout" };
    }
    const game = gamesById.get(gameId);
    if (
      !game ||
      game.status !== STATUS.PLAYER_TURN ||
      (instanceSeqExpected != null && game.instanceSeq !== instanceSeqExpected) ||
      (generation != null && game.roundGeneration !== generation)
    ) {
      return { ok: false, reason: "stale-timer" };
    }
    clearPending(game, PENDING.TURN_TIMEOUT);
    const player = game.players.get(String(game.currentTurn));
    if (player && !player.resolved) {
      player.resolved = true;
      noteProgress(game, "turn-timeout");
    }
    clearGameTimer(game, "turn");
    return startPlayerTurn(game, nextUnresolvedHuman(game, game.currentTurn));
  }

  function dealIfNeeded(game) {
    const playing = Array.from(game.players.values()).filter((p) => p.decision === "play");
    if (!playing.length) {
      return finishGame(game);
    }
    setStatus(game, STATUS.DEALING, "dealing");
    if (!game.deck) {
      game.deck = shuffleDeck(createDeck(), randomIntFn);
      game.deckIndex = 0;
    }
    for (const p of playing) {
      if (!p.hand || !p.hand.length) {
        dealTwo(game, p);
      }
    }
    return startPlayerTurn(game, nextUnresolvedHuman(game, null));
  }

  function finishFromDecisions(game) {
    const humans = humanPlayers(game);
    const plays = humans.filter((p) => p.decision === "play");
    const passes = humans.filter((p) => p.decision === "pass");
    if (plays.length === 0) {
      return finishGame(game);
    }
    if (game.opponentType === "human" && passes.length && plays.length === 1) {
      return finishGame(game);
    }
    if (game.opponentType === "bot" && humans[0] && humans[0].decision === "pass") {
      return finishGame(game);
    }
    return dealIfNeeded(game);
  }

  function xpPayload(player) {
    return {
      eligible: Boolean(player.eligible),
      funOnly: Boolean(player.funOnly),
      pairBlocked: Boolean(player.pairBlocked),
      slotConsumed: Boolean(player.slotConsumed),
      walletOk: player.walletOk !== false,
    };
  }

  async function settleAwards(game) {
    if (game.awardsSettled) {
      return game.xpResults || {};
    }
    game.awardsSettled = true;
    const results = {};
    const humans = humanPlayers(game);
    const plays = humans.filter((p) => p.decision === "play");
    const passes = humans.filter((p) => p.decision === "pass");

    function store(player, result) {
      results[player.userId] = result || { awarded: false, pointsToAdd: 0 };
      player.xpResult = results[player.userId];
      if (result && result.reason === "wallet-required") {
        maybeRemind(player.userId, result, game);
      }
    }

    if (game.opponentType === "bot") {
      const human = humans[0];
      if (!human) {
        game.xpResults = results;
        return results;
      }
      if (human.decision === "pass") {
        store(human, await callAward("pass", human.userId, human.displayName, xpPayload(human)));
      } else {
        const bot = game.players.get(BOT_ID);
        const cmp = compareHands(human.hand, bot ? bot.hand : []);
        const outcome = cmp === "a" ? "win" : cmp === "push" ? "tie" : "loss";
        game.handResult = outcome;
        store(
          human,
          await callAward("bot", human.userId, human.displayName, {
            ...xpPayload(human),
            result: outcome,
          })
        );
      }
      game.xpResults = results;
      return results;
    }

    if (plays.length === 2) {
      const [a, b] = plays;
      const cmp = compareHands(a.hand, b.hand);
      game.handResult = cmp === "a" ? a.userId : cmp === "b" ? b.userId : "push";
      store(
        a,
        await callAward("pvp", a.userId, a.displayName, {
          ...xpPayload(a),
          result: cmp === "a" ? "win" : cmp === "push" ? "tie" : "loss",
        })
      );
      store(
        b,
        await callAward("pvp", b.userId, b.displayName, {
          ...xpPayload(b),
          result: cmp === "b" ? "win" : cmp === "push" ? "tie" : "loss",
        })
      );
    } else if (plays.length === 1 && passes.length) {
      const winner = plays[0];
      game.handResult = "pass-win";
      store(
        winner,
        await callAward("pvp", winner.userId, winner.displayName, {
          ...xpPayload(winner),
          result: "pass-win",
        })
      );
      for (const passer of passes) {
        store(passer, await callAward("pass", passer.userId, passer.displayName, xpPayload(passer)));
      }
    } else {
      game.handResult = "both-pass";
      for (const passer of humans) {
        store(passer, await callAward("pass", passer.userId, passer.displayName, xpPayload(passer)));
      }
    }

    if (humans.length === 2 && typeof awards.markPair === "function") {
      try {
        await Promise.resolve(awards.markPair(humans[0].userId, humans[1].userId));
      } catch (_err) {
        /* ignore */
      }
    }

    game.xpResults = results;
    await noteHumanPvpIfNeeded(game);
    return results;
  }

  async function noteHumanPvpIfNeeded(game) {
    if (!game || game.pvpProgressNoted) {
      return;
    }
    if (game.opponentType !== "human") {
      return;
    }
    game.pvpProgressNoted = true;
    const humans = humanPlayers(game);
    if (humans.length < 2) {
      return;
    }
    let noteFn = options.noteHumanPvpMatchFn;
    if (typeof noteFn !== "function") {
      try {
        noteFn = require("./pvpProgress").noteHumanPvpMatch;
      } catch (_err) {
        return;
      }
    }
    for (const player of humans) {
      try {
        await Promise.resolve(
          noteFn(
          player.userId,
          {
            game: "blackjack",
            matchId: game.id,
            opponentType: "human",
            userName: player.displayName,
            shopFile: options.shopFile,
            walletFile: options.walletFile,
            pointsFile: options.pointsFile,
          },
          options.pointsFile
        )
        );
      } catch (err) {
        logError(
          "[blackjack] pvp progress failed:",
          err && err.message ? err.message : err
        );
      }
    }
  }

  function buildResultText(game) {
    const humans = humanPlayers(game);
    const results = game.xpResults || {};
    const lines = [];

    function xpFor(p) {
      return xpLineFor(results[p.userId], "+0 XP");
    }

    if (game.opponentType === "bot") {
      const human = humans[0];
      const bot = game.players.get(BOT_ID);
      if (human && human.decision === "pass") {
        lines.push("🛡 " + human.displayName + " took the safe exit.", "", xpFor(human));
        return lines.join("\n");
      }
      const cmp = compareHands(human ? human.hand : [], bot ? bot.hand : []);
      if (cmp === "a") {
        lines.push("🏆 You beat the ManGo Bot!", "");
      } else if (cmp === "push") {
        lines.push("🤝 Push vs the ManGo Bot.", "");
      } else {
        lines.push("🤖 The ManGo Bot wins this round.", "");
      }
      if (human) {
        lines.push(`${human.displayName} — ${formatHandWithTotal(human.hand)}`);
      }
      if (bot) {
        lines.push(`${BOT_DISPLAY_NAME} — ${formatHandWithTotal(bot.hand)}`);
      }
      if (human) {
        lines.push("", xpFor(human));
      }
      return lines.join("\n");
    }

    const plays = humans.filter((p) => p.decision === "play");
    const passes = humans.filter((p) => p.decision === "pass");
    if (plays.length === 0) {
      for (const p of humans) {
        lines.push(`🛡 ${p.displayName} took the safe exit.`);
        lines.push(xpFor(p), "");
      }
      return lines.join("\n").trim();
    }
    if (plays.length === 1 && passes.length) {
      const winner = plays[0];
      lines.push("🏆 BLACKJACK WINNER!", "", `${winner.displayName} wins the duel. 🥭`);
      for (const p of passes) {
        lines.push("", `🛡 ${p.displayName} took the safe exit.`);
      }
      lines.push("", `${winner.displayName} ${xpFor(winner)}`);
      for (const p of passes) {
        lines.push(`${p.displayName} ${xpFor(p)}`);
      }
      return lines.join("\n");
    }

    const [a, b] = plays;
    const cmp = compareHands(a.hand, b.hand);
    const aTotal = isBust(a.hand) ? "Bust" : String(handValue(a.hand));
    const bTotal = isBust(b.hand) ? "Bust" : String(handValue(b.hand));
    if (cmp === "push") {
      lines.push("🤝 BLACKJACK PUSH!", "");
    } else {
      const winner = cmp === "a" ? a : b;
      lines.push("🏆 BLACKJACK WINNER!", "");
      lines.push(`${winner.displayName} wins the duel. 🥭`, "");
    }
    lines.push(`${a.displayName} — ${aTotal} 🃏`);
    lines.push(`${b.displayName} — ${bTotal}`);
    lines.push("", "XP:");
    lines.push(`${a.displayName} ${xpFor(a)}`);
    lines.push(`${b.displayName} ${xpFor(b)}`);
    return lines.join("\n");
  }

  async function finishGame(game) {
    if (game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return { ok: true, status: game.status };
    }
    setStatus(game, STATUS.RESOLVING, "resolving");
    clearGameTimers(game);
    clearPending(game);
    await settleAwards(game);
    setStatus(game, STATUS.FINISHED, "finished");
    bumpRevision(game);
    const text = buildResultText(game);
    const extra = emptyGameKeyboardExtra();
    const ui = retainFinalUi(game, { kind: "finish", text, extra });
    dropGame(game);
    trackWinnerUi(deliverFinalUi(ui));
    log("[blackjack] finished");
    return { ok: true, status: STATUS.FINISHED, text, snapshot: snapshot(game) };
  }

  function allHumansDecided(game) {
    return humanPlayers(game).every((p) => p.decision === "play" || p.decision === "pass");
  }

  async function applyDecision(game, player, choice) {
    player.decision = choice;
    const opponent = humanPlayers(game).find((p) => p.userId !== player.userId);
    const reserved = await callAward("reserve", player.userId, player.displayName, {
      opponentUserId: opponent ? opponent.userId : undefined,
    });
    player.slotConsumed = Boolean(reserved && reserved.slotConsumed);
    player.funOnly = Boolean(reserved && reserved.funOnly);
    player.eligible = Boolean(reserved && reserved.eligible);
    player.pairBlocked = Boolean(reserved && reserved.pairBlocked);
    player.walletOk = !reserved || reserved.walletOk !== false;
    player.statusSnapshot = {
      rewardedRoundsUsed: reserved && reserved.rewardedRoundsUsed,
      dailyCap: reserved && reserved.dailyCap,
      remaining: reserved && reserved.remaining,
      limitReached: Boolean(reserved && (reserved.limitReached || reserved.funOnly)),
    };
    noteProgress(game, choice);
  }

  async function closeDecisions(gameId, token, instanceSeqExpected) {
    if (token != null && !isLiveTask(token)) {
      return { ok: false, reason: "queue-timeout" };
    }
    const game = gamesById.get(gameId);
    if (
      !game ||
      game.status !== STATUS.DECISION ||
      (instanceSeqExpected != null && game.instanceSeq !== instanceSeqExpected)
    ) {
      return { ok: false, reason: "inactive" };
    }
    clearGameTimer(game, "decision");
    clearPending(game, PENDING.DECISION_TIMEOUT);
    for (const player of humanPlayers(game)) {
      if (!player.decision) {
        await applyDecision(game, player, "pass");
      }
    }
    return finishFromDecisions(game);
  }

  function enterDecision(game, introLines) {
    game.roundGeneration += 1;
    setStatus(game, STATUS.DECISION, "decision");
    const instance = game.instanceSeq;
    game.decisionEndsAt = nowFn() + decisionMs;
    setGameTimer(game, "decision", decisionMs, () => {
      const current = gamesById.get(game.id);
      if (!current || current.instanceSeq !== instance || current.status !== STATUS.DECISION) {
        return;
      }
      setPending(current, PENDING.DECISION_TIMEOUT);
      enqueue(
        current.id,
        (token) => closeDecisions(current.id, token, instance),
        "decision-timeout"
      );
    });
    for (const p of humanPlayers(game)) {
      p.statusSnapshot = statusFor(p.userId);
      if (p.statusSnapshot && p.statusSnapshot.limitReached) {
        p.funOnlyPreview = true;
      }
    }
    bumpRevision(game);
    queueRender(
      game,
      buildDecisionText(game, introLines),
      decisionKeyboard(game.id),
      "decision"
    );
    return { ok: true, status: STATUS.DECISION };
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
    const humans = humanPlayers(game);
    if (!humans.length) {
      const text = buildFinalGameText(GAME_TYPE.BLACKJACK, FINAL_STATE.EMPTY);
      setStatus(game, STATUS.CANCELLED, "empty");
      logGameCleanup(GAME_TYPE.BLACKJACK, FINAL_STATE.EMPTY);
      bumpRevision(game);
      retainFinalUi(game, { kind: "cancel", text, extra: emptyGameKeyboardExtra() });
      queueRender(game, text, emptyGameKeyboardExtra(), "lobby-close");
      dropGame(game);
      return { ok: true, status: STATUS.CANCELLED, empty: true };
    }
    if (humans.length === 1) {
      game.opponentType = "bot";
      game.players.set(BOT_ID, makeBotPlayer());
      const intro = [
        "🤖 No opponent joined.",
        "",
        `${humans[0].displayName} will play against the ManGo Bot.`,
      ];
      return enterDecision(game, intro);
    }
    game.opponentType = "human";
    return enterDecision(game, []);
  }

  function makePlayer(userId, displayName) {
    return {
      userId: String(userId),
      displayName: sanitizePvpDisplayName(displayName),
      isBot: false,
      decision: null,
      funOnly: false,
      eligible: false,
      slotConsumed: false,
      hand: [],
      resolved: false,
      bust: false,
    };
  }

  function startLobby({ chatId, threadId = null, starter = null, source = "manual" } = {}) {
    if (chatId == null) {
      return { ok: false, reason: "wrong-chat" };
    }
    if (!starter || starter.isBot) {
      return { ok: false, reason: starter && starter.isBot ? "bot" : "no-starter" };
    }
    let id = "";
    for (let i = 0; i < 8; i += 1) {
      const raw = i === 0 ? randomIdFn() : crypto.randomBytes(4).toString("hex");
      const candidate = String(raw).replace(/[^a-f0-9]/gi, "").slice(0, 16);
      if (candidate && !gamesById.has(candidate) && !retiredGames.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) {
      id = crypto.randomBytes(8).toString("hex");
    }
    const reserved = reservation.tryReserve(starter.userId, "blackjack", id);
    if (!reserved.ok) {
      return { ok: false, reason: "player-busy", toast: PLAYER_BUSY_TEXT };
    }
    const now = nowFn();
    const game = {
      id,
      chatId,
      threadId,
      messageId: null,
      startedAt: now,
      lobbyEndsAt: now + lobbyMs,
      status: STATUS.LOBBY,
      players: new Map(),
      opponentType: null,
      deck: null,
      deckIndex: 0,
      currentTurn: null,
      turnDeadline: null,
      decisionEndsAt: null,
      roundGeneration: 0,
      renderRevision: 1,
      pendingTransition: null,
      lastStage: "lobby",
      lastProgressAt: now,
      instanceSeq: (instanceSeq += 1),
      source,
      awardsSettled: false,
      pvpProgressNoted: false,
      xpResults: null,
      handResult: null,
      timers: { lobby: null, countdown: null, decision: null, turn: null, bot: null },
    };
    const player = makePlayer(starter.userId, starter.displayName);
    game.players.set(player.userId, player);
    gamesById.set(id, game);
    addGameToChat(game);
    const lobbyInstance = game.instanceSeq;
    setGameTimer(game, "lobby", lobbyMs, () => {
      const current = gamesById.get(id);
      if (!current || current.instanceSeq !== lobbyInstance || current.status !== STATUS.LOBBY) {
        return;
      }
      setPending(current, PENDING.CLOSE_LOBBY);
      enqueue(
        current.id,
        (token) => closeLobby(id, token, lobbyInstance),
        "lobby-close"
      );
    });
    scheduleLobbyCountdown(game);
    startWatchdog();
    log("[blackjack] lobby started");
    const lobbySeconds = Math.max(1, Math.round(lobbyMs / 1000));
    return {
      ok: true,
      gameId: id,
      text: buildLobbyText(snapshotPlayers(game), lobbySeconds),
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
    if (game.status === STATUS.LOBBY && !hasActiveTimer(game, "countdown")) {
      scheduleLobbyCountdown(game);
    }
    return true;
  }

  function sameLocation(game, chatId, threadId) {
    if (chatId != null && String(chatId) !== String(game.chatId)) {
      return { ok: false, reason: "wrong-chat", toast: STALE_CALLBACK };
    }
    if (
      game.threadId != null &&
      (threadId == null || String(threadId) !== String(game.threadId))
    ) {
      return { ok: false, reason: "wrong-topic", toast: STALE_CALLBACK };
    }
    return { ok: true };
  }

  function liveGame(gameId) {
    const game = gamesById.get(gameId);
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return null;
    }
    return game;
  }

  function tryJoin({ gameId, userId, displayName, isBot, chatId, threadId } = {}) {
    const game = gamesById.get(gameId);
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return { ok: false, reason: "stale", toast: STALE_CALLBACK };
    }
    const loc = sameLocation(game, chatId, threadId);
    if (!loc.ok) {
      return loc;
    }
    if (isBot) {
      return { ok: false, reason: "bot", toast: "Bots cannot join." };
    }
    if (game.status !== STATUS.LOBBY) {
      return { ok: false, reason: "late", toast: LATE_JOIN_TOAST };
    }
    const uid = String(userId);
    if (game.players.has(uid)) {
      return { ok: false, reason: "duplicate", toast: "You already joined." };
    }
    if (humanPlayers(game).length >= MAX_HUMAN_PLAYERS) {
      return { ok: false, reason: "full", toast: "This Blackjack table is full." };
    }
    const reserved = reservation.tryReserve(uid, "blackjack", game.id);
    if (!reserved.ok) {
      return { ok: false, reason: "player-busy", toast: PLAYER_BUSY_TEXT };
    }
    game.players.set(uid, makePlayer(uid, displayName));
    noteProgress(game, "join");
    if (humanPlayers(game).length >= MAX_HUMAN_PLAYERS) {
      const closed = closeLobby(game.id, null, game.instanceSeq);
      return {
        ok: Boolean(closed && closed.ok),
        started: true,
        status: closed && closed.status,
        text: closed && closed.ok ? buildDecisionText(game, []) : undefined,
        extra: closed && closed.ok ? decisionKeyboard(game.id) : undefined,
        snapshot: snapshot(game),
      };
    }
    bumpRevision(game);
    const text = buildLobbyText(snapshotPlayers(game), lobbyDisplaySeconds(game));
    queueRender(game, text, joinKeyboard(game.id), "join");
    return { ok: true, text, extra: joinKeyboard(game.id), snapshot: snapshot(game) };
  }

  async function tryDecide({ gameId, userId, isBot, chatId, threadId, choice } = {}) {
    const game = gamesById.get(gameId);
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return { ok: false, reason: "stale", toast: STALE_CALLBACK };
    }
    const loc = sameLocation(game, chatId, threadId);
    if (!loc.ok) {
      return loc;
    }
    if (isBot) {
      return { ok: false, reason: "bot", toast: "Bots cannot play." };
    }
    if (game.status !== STATUS.DECISION) {
      return { ok: false, reason: "not-decision", toast: STALE_CALLBACK };
    }
    const player = game.players.get(String(userId));
    if (!player || player.isBot) {
      return { ok: false, reason: "not-seat", toast: "That's not your seat." };
    }
    if (player.decision) {
      return { ok: false, reason: "already", toast: "You already chose." };
    }
    if (choice !== "play" && choice !== "pass") {
      return { ok: false, reason: "invalid", toast: STALE_CALLBACK };
    }
    await applyDecision(game, player, choice);
    if (allHumansDecided(game)) {
      clearGameTimer(game, "decision");
      return finishFromDecisions(game);
    }
    bumpRevision(game);
    queueRender(
      game,
      buildDecisionText(game, [`${player.displayName} chose ${choice === "play" ? "Play" : "Pass"}.`]),
      decisionKeyboard(game.id),
      "decision"
    );
    return { ok: true, snapshot: snapshot(game) };
  }

  function tryHit({ gameId, userId, isBot, chatId, threadId } = {}) {
    const game = gamesById.get(gameId);
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return { ok: false, reason: "stale", toast: STALE_CALLBACK };
    }
    const loc = sameLocation(game, chatId, threadId);
    if (!loc.ok) {
      return loc;
    }
    if (isBot) {
      return { ok: false, reason: "bot", toast: "Bots cannot play." };
    }
    if (game.status !== STATUS.PLAYER_TURN) {
      return { ok: false, reason: "stale-turn", toast: STALE_TURN_TOAST };
    }
    if (String(userId) !== String(game.currentTurn)) {
      return { ok: false, reason: "not-turn", toast: STALE_TURN_TOAST };
    }
    const player = game.players.get(String(userId));
    if (!player || player.resolved) {
      return { ok: false, reason: "stale-turn", toast: STALE_TURN_TOAST };
    }
    drawOne(game, player);
    noteProgress(game, "hit");
    const hitResult = afterHit(player);
    if (hitResult === "continue") {
      bumpRevision(game);
      queueRender(game, buildTableText(game), turnKeyboard(game.id), "hit");
      return { ok: true, snapshot: snapshot(game) };
    }
    clearGameTimer(game, "turn");
    return startPlayerTurn(game, nextUnresolvedHuman(game, player.userId));
  }

  function tryStand({ gameId, userId, isBot, chatId, threadId } = {}) {
    const game = gamesById.get(gameId);
    if (!game || game.status === STATUS.FINISHED || game.status === STATUS.CANCELLED) {
      return { ok: false, reason: "stale", toast: STALE_CALLBACK };
    }
    const loc = sameLocation(game, chatId, threadId);
    if (!loc.ok) {
      return loc;
    }
    if (isBot) {
      return { ok: false, reason: "bot", toast: "Bots cannot play." };
    }
    if (game.status !== STATUS.PLAYER_TURN) {
      return { ok: false, reason: "stale-turn", toast: STALE_TURN_TOAST };
    }
    if (String(userId) !== String(game.currentTurn)) {
      return { ok: false, reason: "not-turn", toast: STALE_TURN_TOAST };
    }
    const player = game.players.get(String(userId));
    if (!player || player.resolved) {
      return { ok: false, reason: "stale-turn", toast: STALE_TURN_TOAST };
    }
    player.resolved = true;
    noteProgress(game, "stand");
    clearGameTimer(game, "turn");
    return startPlayerTurn(game, nextUnresolvedHuman(game, player.userId));
  }

  function enqueueJoin(input) {
    return enqueue(input.gameId, (token) => {
      if (!isLiveTask(token)) {
        return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
      }
      return tryJoin(input);
    }, "join");
  }

  function enqueuePlay(input) {
    return enqueue(input.gameId, (token) => {
      if (!isLiveTask(token)) {
        return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
      }
      return tryDecide({ ...input, choice: "play" });
    }, "play");
  }

  function enqueuePass(input) {
    return enqueue(input.gameId, (token) => {
      if (!isLiveTask(token)) {
        return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
      }
      return tryDecide({ ...input, choice: "pass" });
    }, "pass");
  }

  function enqueueHit(input) {
    return enqueue(input.gameId, (token) => {
      if (!isLiveTask(token)) {
        return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
      }
      return tryHit(input);
    }, "hit");
  }

  function enqueueStand(input) {
    return enqueue(input.gameId, (token) => {
      if (!isLiveTask(token)) {
        return { ok: false, reason: "queue-timeout", toast: STALE_CALLBACK };
      }
      return tryStand(input);
    }, "stand");
  }

  function forceLobbyEnd(gameId) {
    const game = gamesById.get(gameId);
    if (!game) {
      return Promise.resolve({ ok: false, reason: "inactive" });
    }
    setPending(game, PENDING.CLOSE_LOBBY);
    const instance = game.instanceSeq;
    return enqueue(
      game.id,
      (token) => closeLobby(gameId, token, instance),
      "lobby-close"
    );
  }

  function forceDecisionTimeout(gameId) {
    const game = gamesById.get(gameId);
    if (!game) {
      return Promise.resolve({ ok: false, reason: "inactive" });
    }
    setPending(game, PENDING.DECISION_TIMEOUT);
    const instance = game.instanceSeq;
    return enqueue(
      game.id,
      (token) => closeDecisions(gameId, token, instance),
      "decision-timeout"
    );
  }

  function forceTurnTimeout(gameId) {
    const game = gamesById.get(gameId);
    if (!game) {
      return Promise.resolve({ ok: false, reason: "inactive" });
    }
    setPending(game, PENDING.TURN_TIMEOUT, game.roundGeneration);
    const instance = game.instanceSeq;
    const generation = game.roundGeneration;
    return enqueue(
      game.id,
      (token) => autoStand(gameId, token, instance, generation),
      "turn-timeout"
    );
  }

  function watchdogStuck(game) {
    const now = nowFn();
    if (game.status === STATUS.LOBBY) {
      return (
        now >= game.lobbyEndsAt + watchdogGraceMs &&
        !hasActiveTimer(game, "lobby") &&
        !pendingMatches(game, PENDING.CLOSE_LOBBY)
      );
    }
    if (game.status === STATUS.DECISION) {
      return (
        Number.isFinite(game.decisionEndsAt) &&
        now >= game.decisionEndsAt + watchdogGraceMs &&
        !hasActiveTimer(game, "decision") &&
        !pendingMatches(game, PENDING.DECISION_TIMEOUT)
      );
    }
    if (game.status === STATUS.PLAYER_TURN) {
      return (
        Number.isFinite(game.turnDeadline) &&
        now >= game.turnDeadline + watchdogGraceMs &&
        !hasActiveTimer(game, "turn") &&
        !pendingMatches(game, PENDING.TURN_TIMEOUT)
      );
    }
    return false;
  }

  function runWatchdog() {
    for (const game of Array.from(gamesById.values())) {
      if (!watchdogStuck(game)) {
        continue;
      }
      if (game.status === STATUS.LOBBY) {
        setPending(game, PENDING.CLOSE_LOBBY);
        enqueue(game.id, (token) => closeLobby(game.id, token, game.instanceSeq), "lobby-close");
      } else if (game.status === STATUS.DECISION) {
        setPending(game, PENDING.DECISION_TIMEOUT);
        enqueue(
          game.id,
          (token) => closeDecisions(game.id, token, game.instanceSeq),
          "decision-timeout"
        );
      } else if (game.status === STATUS.PLAYER_TURN) {
        setPending(game, PENDING.TURN_TIMEOUT, game.roundGeneration);
        enqueue(
          game.id,
          (token) => autoStand(game.id, token, game.instanceSeq, game.roundGeneration),
          "turn-timeout"
        );
      }
    }
  }

  function startWatchdog() {
    if (watchdogHandle != null) {
      return;
    }
    watchdogHandle = utilityTimeout(function tick() {
      watchdogHandle = null;
      runWatchdog();
      if (gamesById.size > 0) {
        startWatchdog();
      }
    }, watchdogMs);
  }

  function stopWatchdogIfIdle() {
    if (gamesById.size > 0) {
      return;
    }
    clearUtility(watchdogHandle);
    watchdogHandle = null;
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
      log("[blackjack] cancelled");
    }
  }

  function clearAllTimers() {
    cancelAll("clear-timers");
  }

  function reset() {
    cancelAll("reset");
    queues.clear();
    queueMeta.clear();
    timedOutTokens.clear();
    retiredGames.clear();
    finalUiByGameId.clear();
    renderWait = Promise.resolve();
    winnerUiWait = Promise.resolve();
    hungRender = null;
    injectedQueueStage = null;
    injectedRenderMode = null;
    injectedSendMode = null;
    editMessage = null;
    sendMessage = null;
    walletReminderFn = null;
    awards = { reserve: null, pass: null, bot: null, pvp: null, status: null, markPair: null };
    reservation.reset();
  }

  function whenQueueIdle(_chatId) {
    if (!queues.size) {
      return Promise.resolve();
    }
    return Promise.all(Array.from(queues.values()));
  }

  function whenIdle(chatId) {
    return Promise.all([whenQueueIdle(chatId), renderWait, winnerUiWait]);
  }

  return {
    STATUS,
    startLobby,
    tryJoin,
    tryDecide,
    tryHit,
    tryStand,
    enqueueJoin,
    enqueuePlay,
    enqueuePass,
    enqueueHit,
    enqueueStand,
    setMessageId,
    forceLobbyEnd,
    forceDecisionTimeout,
    forceTurnTimeout,
    isBlackjackOpen,
    getGame: (id) => snapshot(gamesById.get(id) || liveGame(id)),
    getGameByChat: (chatId) => snapshot(activeGameForChat(chatId)),
    getFinalUi: (gameId) => finalUiByGameId.get(gameId) || null,
    getPendingTimerCount: () => gameplayHandles.size,
    hasActiveLobbyTimer: (gameId) => hasActiveTimer(gamesById.get(gameId), "lobby"),
    hasActiveCountdownTimer: (gameId) => hasActiveTimer(gamesById.get(gameId), "countdown"),
    hasActiveDecisionTimer: (gameId) => hasActiveTimer(gamesById.get(gameId), "decision"),
    hasActiveTurnTimer: (gameId) => hasActiveTimer(gamesById.get(gameId), "turn"),
    whenIdle,
    reservation,
    whenQueueIdle,
    whenWinnerUiIdle: () => winnerUiWait,
    setEditMessageHandler: (fn) => {
      editMessage = typeof fn === "function" ? fn : null;
    },
    setDeleteMessageHandler: (fn) => {
      deleteMessageFn = typeof fn === "function" ? fn : null;
    },
    setSendMessageHandler: (fn) => {
      sendMessage = typeof fn === "function" ? fn : null;
    },
    setAwardHandlers: (next) => {
      awards = { ...awards, ...(next || {}) };
    },
    setWalletReminderHandler: (fn) => {
      walletReminderFn = typeof fn === "function" ? fn : null;
    },
    injectRenderFailureForTests: (mode) => {
      injectedRenderMode = mode || "throw";
    },
    injectSendFailureForTests: (mode) => {
      injectedSendMode = mode || "throw";
    },
    injectQueueFailureForTests: (stage) => {
      injectedQueueStage = stage;
    },
    seedDeckForTests: (gameId, deck) => {
      const game = gamesById.get(gameId);
      if (!game || !Array.isArray(deck)) {
        return false;
      }
      game.deck = deck.slice();
      game.deckIndex = 0;
      return true;
    },
    resolveHungRenderForTests: () => {
      if (hungRender && typeof hungRender.resolve === "function") {
        hungRender.resolve();
      }
    },
    reset,
    clearAllTimers,
    cancelAll,
    buildLobbyText,
  };
}

const defaultService = createBlackjackService({
  reservation: getSharedPvpMatchReservation(),
});

module.exports = {
  STATUS,
  PENDING,
  BOT_ID,
  BOT_DISPLAY_NAME,
  LOBBY_MS,
  LOBBY_COUNTDOWN_MS,
  DECISION_MS,
  TURN_MS,
  BOT_THINK_MS,
  MAX_HUMAN_PLAYERS,
  STALE_CALLBACK,
  LATE_JOIN_TOAST,
  STALE_TURN_TOAST,
  RENDER_TIMEOUT_MS,
  QUEUE_TIMEOUT_MS,
  INTERNAL_CANCEL_TEXT,
  PLAYER_BUSY_TEXT,
  parseBlackjackCallbackData,
  callbackData,
  joinKeyboard,
  decisionKeyboard,
  turnKeyboard,
  buildLobbyText,
  rewardsLine,
  createBlackjackService,
  getBlackjackRuntime: () => defaultService,
  startLobby: (input) => defaultService.startLobby(input),
  isBlackjackOpen: (chatId) => defaultService.isBlackjackOpen(chatId),
};
