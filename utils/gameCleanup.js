/**
 * Shared final-message + stale-button cleanup for Telegram group games.
 * Rendering is output-only; callers must already have closed gameplay state.
 *
 * Gameplay/session/reservation release is independent of Telegram deletion.
 * Message deletion is best-effort, keyed by gameType+sessionId, and only
 * deletes Telegram IDs that were explicitly registered for that session.
 * Community/scheduler open-question posts must never be registered here.
 *
 * Restart drops in-memory timers. A later stale tap strips buttons and
 * re-schedules deletion of that one known callback message.
 */

const { emptyInlineKeyboardExtra } = require("./expiredMessageCleanup");
const { log, error: logError } = require("./logger");

/** Wait after a game has definitively ended before deleting bot game messages. */
const GAME_MESSAGE_CLEANUP_DELAY_MS = 60 * 1000;

const GAME_OVER_TOAST = "This game is over.";
const GAME_ENDED_TOAST = "This game has ended.";
const GAME_CLEANUP_FOOTER =
  "🧹 This game message will be cleaned up automatically.";

const FINAL_STATE = Object.freeze({
  EMPTY: "empty",
  NOT_ENOUGH: "not-enough",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  FINISHED: "finished",
});

const GAME_TYPE = Object.freeze({
  MANGOBOMB: "mangobomb",
  TRIVIA: "trivia",
  TICTACTOE: "tictactoe",
  CONNECT4: "connect4",
  CHECKERS: "checkers",
  CHATFIGHT: "chatfight",
  BLACKJACK: "blackjack",
  RPS: "rps",
  HOL: "hol",
  MOM: "mom",
});

function isMessageNotModifiedError(err) {
  const desc = err && (err.description || err.message || "");
  return String(desc).toLowerCase().includes("message is not modified");
}

function emptyGameKeyboardExtra() {
  return emptyInlineKeyboardExtra();
}

function titleFor(gameType) {
  if (gameType === GAME_TYPE.MANGOBOMB) {
    return "🥭💣 ManGo Bomb cancelled";
  }
  if (gameType === GAME_TYPE.TRIVIA) {
    return "🧠 Trivia cancelled";
  }
  if (gameType === GAME_TYPE.TICTACTOE) {
    return "🎮 Tic-Tac-Toe cancelled";
  }
  if (gameType === GAME_TYPE.CONNECT4) {
    return "🟡 Connect Four cancelled";
  }
  if (gameType === GAME_TYPE.CHECKERS) {
    return "🏁 Checkers cancelled";
  }
  if (gameType === GAME_TYPE.CHATFIGHT) {
    return "⚔️ ChatFight ended";
  }
  if (gameType === GAME_TYPE.BLACKJACK) {
    return "🃏 Blackjack cancelled";
  }
  if (gameType === GAME_TYPE.RPS) {
    return "✊✋✌️ Rock Paper Scissors cancelled";
  }
  if (gameType === GAME_TYPE.HOL) {
    return "📈 Higher or Lower cancelled";
  }
  if (gameType === GAME_TYPE.MOM) {
    return "🥭 ManGo or Moon cancelled";
  }
  return "🎮 Game cancelled";
}

function bodyFor(state) {
  if (state === FINAL_STATE.EMPTY) {
    return "No one joined this round.";
  }
  if (state === FINAL_STATE.NOT_ENOUGH) {
    return "Not enough players joined.";
  }
  if (state === FINAL_STATE.EXPIRED) {
    return "This game has ended.";
  }
  if (state === FINAL_STATE.CANCELLED) {
    return "This round was cancelled.";
  }
  return "This game has ended.";
}

function hasGameCleanupFooter(text) {
  return typeof text === "string" && text.includes(GAME_CLEANUP_FOOTER);
}

function withGameCleanupFooter(text) {
  const body = typeof text === "string" ? text.trimEnd() : "";
  if (!body) {
    return GAME_CLEANUP_FOOTER;
  }
  if (hasGameCleanupFooter(body)) {
    return body;
  }
  return `${body}\n\n${GAME_CLEANUP_FOOTER}`;
}

function buildFinalGameText(gameType, state) {
  return withGameCleanupFooter([titleFor(gameType), "", bodyFor(state)].join("\n"));
}

function logGameCleanup(gameType, state) {
  log(`[game-cleanup] game=${gameType} state=${state}`);
}

function logButtonsRemoved(gameType) {
  log(`[game-cleanup] buttons removed game=${gameType}`);
}

function logCleanupRenderFailed(gameType) {
  log(`[game-cleanup] render failed game=${gameType}`);
}

function callbackMessageHasButtons(ctx) {
  const message =
    ctx && ctx.callbackQuery && ctx.callbackQuery.message
      ? ctx.callbackQuery.message
      : null;
  const keyboard =
    message &&
    message.reply_markup &&
    Array.isArray(message.reply_markup.inline_keyboard)
      ? message.reply_markup.inline_keyboard
      : null;
  if (!keyboard || !keyboard.length) {
    return false;
  }
  return keyboard.some((row) => Array.isArray(row) && row.length > 0);
}

function callbackMessageId(ctx) {
  const message =
    ctx && ctx.callbackQuery && ctx.callbackQuery.message
      ? ctx.callbackQuery.message
      : null;
  return message && message.message_id != null ? message.message_id : null;
}

function callbackChatId(ctx) {
  if (ctx && ctx.chat && ctx.chat.id != null) {
    return ctx.chat.id;
  }
  const message =
    ctx && ctx.callbackQuery && ctx.callbackQuery.message
      ? ctx.callbackQuery.message
      : null;
  if (message && message.chat && message.chat.id != null) {
    return message.chat.id;
  }
  return null;
}

/**
 * Best-effort: if the callback's own message still shows controls, replace
 * it with a final text + empty keyboard. Always edits the callback message,
 * never the current game in another message.
 */
async function stripStaleCallbackButtons(ctx, options = {}) {
  const gameType = options.gameType || "game";
  const skipFooter = options.cleanupFooter === false;
  if (!callbackMessageHasButtons(ctx) && options.forceEdit !== true) {
    return { edited: false };
  }
  if (!ctx || typeof ctx.editMessageText !== "function") {
    return { edited: false };
  }
  const raw =
    typeof options.text === "string" && options.text
      ? options.text
      : buildFinalGameText(gameType, FINAL_STATE.EXPIRED);
  const text = skipFooter ? raw : withGameCleanupFooter(raw);
  try {
    await ctx.editMessageText(text, emptyGameKeyboardExtra());
    logButtonsRemoved(gameType);
    return { edited: true, text };
  } catch (err) {
    if (isMessageNotModifiedError(err)) {
      return { edited: false };
    }
    logCleanupRenderFailed(gameType);
    return { edited: false, failed: true };
  }
}

async function answerGameOver(ctx, toast = GAME_ENDED_TOAST) {
  if (ctx && typeof ctx.answerCbQuery === "function") {
    await ctx.answerCbQuery(toast || GAME_ENDED_TOAST).catch(() => {});
  }
}

function gameCleanupKey(gameType, sessionId) {
  return `${String(gameType)}:${String(sessionId)}`;
}

function normalizeGeneration(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function normalizeMessageIds(messageIds) {
  const raw = Array.isArray(messageIds)
    ? messageIds
    : messageIds != null
      ? [messageIds]
      : [];
  const ids = [];
  const seen = new Set();
  for (const id of raw) {
    if (id == null || id === "") {
      continue;
    }
    const key = String(id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

function resolveDeleteMessageFn(options) {
  if (typeof options.deleteMessageFn === "function") {
    return options.deleteMessageFn;
  }
  if (options.telegram && typeof options.telegram.deleteMessage === "function") {
    return (chatId, messageId) => options.telegram.deleteMessage(chatId, messageId);
  }
  return null;
}

/** @type {Map<string, { handle: *, clear: Function, chatId: *, messageIds: Map<string, *>, gameType: string, sessionId: *, generation: string|null, shouldDeleteFn: Function|null }>} */
const pendingGameCleanups = new Map();

function rememberMessageIds(store, ids) {
  for (const id of ids) {
    store.set(String(id), id);
  }
}

function addGameMessageIds(gameType, sessionId, chatId, messageIds) {
  const key = gameCleanupKey(gameType, sessionId);
  const existing = pendingGameCleanups.get(key);
  const ids = normalizeMessageIds(messageIds);
  if (!existing || !ids.length) {
    return { added: false, key };
  }
  if (chatId != null) {
    existing.chatId = chatId;
  }
  rememberMessageIds(existing.messageIds, ids);
  return { added: true, key };
}

function getScheduledGameCleanupIds(gameType, sessionId) {
  const existing = pendingGameCleanups.get(gameCleanupKey(gameType, sessionId));
  if (!existing) {
    return [];
  }
  return Array.from(existing.messageIds.keys());
}

function getScheduledGameCleanupGeneration(gameType, sessionId) {
  const existing = pendingGameCleanups.get(gameCleanupKey(gameType, sessionId));
  return existing && existing.generation != null ? existing.generation : null;
}

function runShouldDelete(entry, toDelete, targetChatId) {
  if (!entry || typeof entry.shouldDeleteFn !== "function") {
    return true;
  }
  try {
    return entry.shouldDeleteFn({
      gameType: entry.gameType,
      sessionId: entry.sessionId,
      chatId: targetChatId,
      messageIds: toDelete,
      generation: entry.generation,
    }) !== false;
  } catch (_err) {
    return false;
  }
}

function fireGameCleanup(entry, fallback) {
  const toDelete = entry
    ? Array.from(entry.messageIds.values())
    : Array.from(fallback.messageIds.values());
  const targetChatId =
    entry && entry.chatId != null ? entry.chatId : fallback.chatId;
  const deleteMessageFn = fallback.deleteMessageFn;
  const logErrorFn = fallback.logErrorFn;
  const gameType = (entry && entry.gameType) || fallback.gameType;
  const sessionId = (entry && entry.sessionId) || fallback.sessionId;
  if (!runShouldDelete(entry, toDelete, targetChatId)) {
    return;
  }
  if (typeof deleteMessageFn !== "function") {
    return;
  }
  for (const messageId of toDelete) {
    Promise.resolve(deleteMessageFn(targetChatId, messageId)).catch((err) => {
      try {
        logErrorFn(
          `[game-cleanup] deleteMessage failed game=${gameType} session=${sessionId}:`,
          err && err.message ? err.message : err
        );
      } catch (_err) {
        /* ignore logging failures */
      }
    });
  }
}

/**
 * After a game is already closed, delete only that session's registered
 * bot message IDs. Delete failures are logged once and never retried.
 * Cleanup timers are unref'd so they cannot keep the Node process open.
 *
 * Optional generation / shouldDeleteFn prevent an old timer from deleting
 * a replay that reused the same Telegram message id.
 *
 * @returns {{ scheduled: boolean, key: string|null, merged?: boolean, skipped?: string, clear: Function }}
 */
function scheduleGameMessageCleanup(options = {}) {
  const gameType = options.gameType || "game";
  const sessionId = options.sessionId;
  const chatId = options.chatId;
  const ids = normalizeMessageIds(options.messageIds);
  if (sessionId == null || sessionId === "" || chatId == null || ids.length === 0) {
    return { scheduled: false, key: null, clear: () => {} };
  }

  const key = gameCleanupKey(gameType, sessionId);
  const generation = normalizeGeneration(options.generation);
  const existing = pendingGameCleanups.get(key);
  if (existing) {
    if (
      generation != null &&
      existing.generation != null &&
      existing.generation !== generation
    ) {
      return {
        scheduled: false,
        key,
        skipped: "generation-mismatch",
        clear: existing.clear,
      };
    }
    existing.chatId = chatId;
    rememberMessageIds(existing.messageIds, ids);
    if (generation != null) {
      existing.generation = generation;
    }
    if (typeof options.shouldDeleteFn === "function") {
      existing.shouldDeleteFn = options.shouldDeleteFn;
    }
    return { scheduled: true, key, merged: true, clear: existing.clear };
  }

  const delayMs =
    typeof options.delayMs === "number" && options.delayMs >= 0
      ? options.delayMs
      : GAME_MESSAGE_CLEANUP_DELAY_MS;
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function"
      ? options.setTimeoutFn
      : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn =
    typeof options.clearTimeoutFn === "function"
      ? options.clearTimeoutFn
      : (id) => clearTimeout(id);
  const logErrorFn =
    typeof options.logErrorFn === "function" ? options.logErrorFn : logError;
  const shouldUnref = options.unref !== false;
  const deleteMessageFn = resolveDeleteMessageFn(options);
  const shouldDeleteFn =
    typeof options.shouldDeleteFn === "function" ? options.shouldDeleteFn : null;

  const messageIds = new Map();
  rememberMessageIds(messageIds, ids);

  const fallback = {
    chatId,
    messageIds,
    deleteMessageFn,
    logErrorFn,
    gameType,
    sessionId,
  };

  const handle = setTimeoutFn(() => {
    const row = pendingGameCleanups.get(key);
    pendingGameCleanups.delete(key);
    fireGameCleanup(row, fallback);
  }, delayMs);

  if (
    shouldUnref &&
    handle &&
    typeof handle === "object" &&
    typeof handle.unref === "function"
  ) {
    try {
      handle.unref();
    } catch (_err) {
      /* ignore */
    }
  }

  const clear = () => {
    clearTimeoutFn(handle);
    pendingGameCleanups.delete(key);
  };

  pendingGameCleanups.set(key, {
    handle,
    clear,
    chatId,
    messageIds,
    gameType,
    sessionId,
    generation,
    shouldDeleteFn,
  });
  return { scheduled: true, key, clear };
}

function clearGameMessageCleanup(gameType, sessionId) {
  const existing = pendingGameCleanups.get(gameCleanupKey(gameType, sessionId));
  if (existing && typeof existing.clear === "function") {
    existing.clear();
  }
}

function clearAllGameMessageCleanups() {
  for (const entry of pendingGameCleanups.values()) {
    if (entry && typeof entry.clear === "function") {
      entry.clear();
    }
  }
  pendingGameCleanups.clear();
}

function getPendingGameMessageCleanupCount() {
  return pendingGameCleanups.size;
}

function resolveTelegramFromCtx(ctx) {
  if (ctx && ctx.telegram) {
    return ctx.telegram;
  }
  return null;
}

/**
 * Stale/expired game callback: toast, strip buttons, then schedule deletion
 * of this one callback message. Never used for new game starts.
 */
async function handleStaleGameCallback(ctx, options = {}) {
  const gameType = options.gameType || "game";
  const toast = options.toast || GAME_ENDED_TOAST;
  await answerGameOver(ctx, toast);
  const stripped = await stripStaleCallbackButtons(ctx, {
    gameType,
    text: options.text,
    cleanupFooter: options.cleanupFooter,
    forceEdit: options.forceEdit,
  });
  const sessionId = options.sessionId;
  const chatId = options.chatId != null ? options.chatId : callbackChatId(ctx);
  const messageId =
    options.messageId != null ? options.messageId : callbackMessageId(ctx);
  if (sessionId == null || sessionId === "" || chatId == null || messageId == null) {
    return { ...stripped, scheduled: false };
  }
  const scheduled = scheduleGameMessageCleanup({
    gameType,
    sessionId,
    chatId,
    messageIds: [messageId],
    generation: options.generation,
    shouldDeleteFn: options.shouldDeleteFn,
    delayMs: options.delayMs,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
    deleteMessageFn: options.deleteMessageFn,
    telegram: options.telegram || resolveTelegramFromCtx(ctx),
  });
  return { ...stripped, scheduled: scheduled.scheduled, key: scheduled.key };
}

module.exports = {
  GAME_OVER_TOAST,
  GAME_ENDED_TOAST,
  GAME_CLEANUP_FOOTER,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  FINAL_STATE,
  GAME_TYPE,
  emptyGameKeyboardExtra,
  hasGameCleanupFooter,
  withGameCleanupFooter,
  buildFinalGameText,
  logGameCleanup,
  logButtonsRemoved,
  logCleanupRenderFailed,
  callbackMessageHasButtons,
  callbackMessageId,
  callbackChatId,
  stripStaleCallbackButtons,
  answerGameOver,
  handleStaleGameCallback,
  isMessageNotModifiedError,
  scheduleGameMessageCleanup,
  addGameMessageIds,
  getScheduledGameCleanupIds,
  getScheduledGameCleanupGeneration,
  clearGameMessageCleanup,
  clearAllGameMessageCleanups,
  getPendingGameMessageCleanupCount,
};
