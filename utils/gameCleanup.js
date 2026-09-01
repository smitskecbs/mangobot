/**
 * Shared final-message + stale-button cleanup for Telegram group games.
 * Rendering is output-only; callers must already have closed gameplay state.
 *
 * Message deletion is best-effort, keyed by gameType+sessionId, and only
 * deletes Telegram IDs that were explicitly registered for that session.
 * Community/scheduler open-question posts must never be registered here.
 */

const { emptyInlineKeyboardExtra } = require("./expiredMessageCleanup");
const { log, error: logError } = require("./logger");

/** Wait after a game has definitively ended before deleting bot game messages. */
const GAME_MESSAGE_CLEANUP_DELAY_MS = 5 * 60 * 1000;

const GAME_OVER_TOAST = "This game is over.";

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

function buildFinalGameText(gameType, state) {
  return [titleFor(gameType), "", bodyFor(state)].join("\n");
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

/**
 * Best-effort: if the callback's own message still shows controls, replace
 * it with a final text + empty keyboard. Always edits the callback message,
 * never the current game in another message.
 */
async function stripStaleCallbackButtons(ctx, options = {}) {
  const gameType = options.gameType || "game";
  if (!callbackMessageHasButtons(ctx)) {
    return { edited: false };
  }
  if (!ctx || typeof ctx.editMessageText !== "function") {
    return { edited: false };
  }
  const text =
    typeof options.text === "string" && options.text
      ? options.text
      : buildFinalGameText(gameType, FINAL_STATE.EXPIRED);
  try {
    await ctx.editMessageText(text, emptyGameKeyboardExtra());
    logButtonsRemoved(gameType);
    return { edited: true };
  } catch (err) {
    if (isMessageNotModifiedError(err)) {
      return { edited: false };
    }
    logCleanupRenderFailed(gameType);
    return { edited: false, failed: true };
  }
}

async function answerGameOver(ctx, toast = GAME_OVER_TOAST) {
  if (ctx && typeof ctx.answerCbQuery === "function") {
    await ctx.answerCbQuery(toast || GAME_OVER_TOAST).catch(() => {});
  }
}

function gameCleanupKey(gameType, sessionId) {
  return `${String(gameType)}:${String(sessionId)}`;
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

/** @type {Map<string, { handle: *, clear: Function, chatId: *, messageIds: Map<string, *>, gameType: string, sessionId: * }>} */
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

/**
 * After a game is already closed, delete only that session's registered
 * bot message IDs. Delete failures are logged once and never retried.
 * Cleanup timers are unref'd so they cannot keep the Node process open.
 *
 * @returns {{ scheduled: boolean, key: string|null, merged?: boolean, clear: Function }}
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
  const existing = pendingGameCleanups.get(key);
  if (existing) {
    existing.chatId = chatId;
    rememberMessageIds(existing.messageIds, ids);
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

  const messageIds = new Map();
  rememberMessageIds(messageIds, ids);

  const handle = setTimeoutFn(() => {
    const row = pendingGameCleanups.get(key);
    pendingGameCleanups.delete(key);
    const toDelete = row
      ? Array.from(row.messageIds.values())
      : Array.from(messageIds.values());
    const targetChatId = row && row.chatId != null ? row.chatId : chatId;
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

module.exports = {
  GAME_OVER_TOAST,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  FINAL_STATE,
  GAME_TYPE,
  emptyGameKeyboardExtra,
  buildFinalGameText,
  logGameCleanup,
  logButtonsRemoved,
  logCleanupRenderFailed,
  callbackMessageHasButtons,
  stripStaleCallbackButtons,
  answerGameOver,
  isMessageNotModifiedError,
  scheduleGameMessageCleanup,
  addGameMessageIds,
  getScheduledGameCleanupIds,
  clearGameMessageCleanup,
  clearAllGameMessageCleanups,
  getPendingGameMessageCleanupCount,
};
