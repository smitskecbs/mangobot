/**
 * Schedule deletion of abandoned/expired challenge messages.
 * Delete failures must never crash the bot.
 *
 * Cleanup timers are unref'd when the handle supports it so a pending
 * 30s delete cannot hold the Node process / systemd stop open. This is
 * safe because cleanup is best-effort UX only — not core scheduling.
 * The community scheduler interval stays referenced.
 */

const { error: logError } = require("./logger");

const EXPIRED_MESSAGE_CLEANUP_MS = 30_000;

/** Empty inline keyboard — Telegram keeps old markup if omitted. */
function emptyInlineKeyboardExtra() {
  return { reply_markup: { inline_keyboard: [] } };
}

/** @type {Map<string, *>} */
const pendingCleanups = new Map();

function cleanupKey(chatId, messageId) {
  return `${String(chatId)}:${String(messageId)}`;
}

/**
 * @param {object} options
 * @param {object} [options.telegram]
 * @param {*} options.chatId
 * @param {*} options.messageId
 * @param {number} [options.delayMs]
 * @param {Function} [options.setTimeoutFn]
 * @param {Function} [options.clearTimeoutFn]
 * @param {Function} [options.deleteMessageFn]
 * @param {Function} [options.logErrorFn]
 * @param {boolean} [options.unref] default true for native timers
 * @returns {{ scheduled: boolean, key: string|null, clear: Function }}
 */
function scheduleExpiredMessageCleanup(options = {}) {
  const chatId = options.chatId;
  const messageId = options.messageId;
  if (chatId == null || messageId == null) {
    return { scheduled: false, key: null, clear: () => {} };
  }

  const delayMs =
    typeof options.delayMs === "number" && options.delayMs >= 0
      ? options.delayMs
      : EXPIRED_MESSAGE_CLEANUP_MS;
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
  const deleteMessageFn =
    typeof options.deleteMessageFn === "function"
      ? options.deleteMessageFn
      : options.telegram &&
          typeof options.telegram.deleteMessage === "function"
        ? (c, m) => options.telegram.deleteMessage(c, m)
        : null;
  const shouldUnref = options.unref !== false;

  const key = cleanupKey(chatId, messageId);
  const existing = pendingCleanups.get(key);
  if (existing && typeof existing.clear === "function") {
    existing.clear();
  }

  const handle = setTimeoutFn(() => {
    pendingCleanups.delete(key);
    if (typeof deleteMessageFn !== "function") {
      return;
    }
    Promise.resolve(deleteMessageFn(chatId, messageId)).catch((err) => {
      try {
        logErrorFn(
          "[cleanup] deleteMessage failed:",
          err && err.message ? err.message : err
        );
      } catch (_err) {
        /* ignore logging failures */
      }
    });
  }, delayMs);

  // Best-effort UX cleanup must not delay systemd stop / process exit.
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
    pendingCleanups.delete(key);
  };

  const entry = { handle, clear };
  pendingCleanups.set(key, entry);
  return { scheduled: true, key, clear };
}

function clearAllExpiredMessageCleanups() {
  for (const entry of pendingCleanups.values()) {
    if (entry && typeof entry.clear === "function") {
      entry.clear();
    }
  }
  pendingCleanups.clear();
}

function getPendingExpiredCleanupCount() {
  return pendingCleanups.size;
}

module.exports = {
  EXPIRED_MESSAGE_CLEANUP_MS,
  emptyInlineKeyboardExtra,
  scheduleExpiredMessageCleanup,
  clearAllExpiredMessageCleanups,
  getPendingExpiredCleanupCount,
};
