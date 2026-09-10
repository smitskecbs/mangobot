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

let defaultCleanupTelegram = null;

function setGameCleanupTelegram(telegram) {
  defaultCleanupTelegram =
    telegram && typeof telegram.deleteMessage === "function" ? telegram : null;
}

function resolveDeleteMessageFn(options) {
  if (typeof options.deleteMessageFn === "function") {
    return options.deleteMessageFn;
  }
  if (options.telegram && typeof options.telegram.deleteMessage === "function") {
    return (chatId, messageId) => options.telegram.deleteMessage(chatId, messageId);
  }
  if (defaultCleanupTelegram) {
    return (chatId, messageId) =>
      defaultCleanupTelegram.deleteMessage(chatId, messageId);
  }
  return null;
}

const MAX_GAME_CLEANUP_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 120 * 1000;
const DEFAULT_RETRY_DELAY_MS = 8 * 1000;

function shortSessionId(sessionId) {
  const value = String(sessionId == null ? "" : sessionId);
  if (value.length <= 12) {
    return value;
  }
  return value.slice(0, 12);
}

function readRetryAfterMs(err) {
  const params = err && (err.parameters || err.params);
  const fromParams =
    params && (params.retry_after != null ? params.retry_after : params.retryAfter);
  const fromResponse =
    err &&
    err.response &&
    err.response.parameters &&
    err.response.parameters.retry_after;
  const raw = fromParams != null ? fromParams : fromResponse;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, seconds * 1000));
}

function classifyTelegramDeleteError(err) {
  const msg = String(
    (err && (err.description || err.message)) || err || ""
  ).toLowerCase();
  const code = Number(
    (err && (err.error_code || err.code)) ||
      (err && err.response && err.response.error_code) ||
      0
  );
  if (
    msg.includes("message to delete not found") ||
    msg.includes("message to be deleted not found") ||
    msg.includes("message can't be deleted") ||
    msg.includes("message can't be found") ||
    msg.includes("message identifier is not specified")
  ) {
    return { kind: "gone", code, retryAfterMs: null };
  }
  if (code === 429 || msg.includes("too many requests") || msg.includes("retry after")) {
    return {
      kind: "transient",
      code: code || 429,
      retryAfterMs: readRetryAfterMs(err) || DEFAULT_RETRY_DELAY_MS,
    };
  }
  if (
    code >= 500 ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("eai_again") ||
    msg.includes("network")
  ) {
    return { kind: "transient", code, retryAfterMs: DEFAULT_RETRY_DELAY_MS };
  }
  return { kind: "permanent", code, retryAfterMs: null };
}

function logCleanupEvent(parts) {
  const bits = ["[game-cleanup]"];
  if (parts.event) bits.push(`event=${parts.event}`);
  if (parts.gameType) bits.push(`game=${parts.gameType}`);
  if (parts.sessionId != null) bits.push(`session=${shortSessionId(parts.sessionId)}`);
  if (parts.chatId != null) bits.push(`chat=${parts.chatId}`);
  if (parts.messageId != null) bits.push(`msg=${parts.messageId}`);
  if (parts.attempt != null) bits.push(`attempt=${parts.attempt}`);
  if (parts.shouldDelete != null) bits.push(`shouldDelete=${parts.shouldDelete}`);
  if (parts.detail) bits.push(parts.detail);
  log(bits.join(" "));
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

function getScheduledGameCleanupSnapshot(gameType, sessionId) {
  const existing = pendingGameCleanups.get(gameCleanupKey(gameType, sessionId));
  if (!existing) {
    return null;
  }
  return {
    gameType: existing.gameType,
    sessionId: existing.sessionId,
    chatId: existing.chatId,
    messageIds: Array.from(existing.messageIds.values()),
    generation: existing.generation,
  };
}

function hasScheduledGameCleanup(gameType, sessionId) {
  return pendingGameCleanups.has(gameCleanupKey(gameType, sessionId));
}

function withCleanupFooterIfScheduled(text, gameType, sessionId) {
  if (!hasScheduledGameCleanup(gameType, sessionId)) {
    return typeof text === "string" ? text : "";
  }
  return withGameCleanupFooter(text);
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

function unrefHandle(handle) {
  if (
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
}

function clearCleanupEntry(entry) {
  if (!entry) {
    return;
  }
  if (entry.handle != null && typeof entry.clearTimeoutFn === "function") {
    try {
      entry.clearTimeoutFn(entry.handle);
    } catch (_err) {
      /* ignore */
    }
  }
  pendingGameCleanups.delete(entry.key);
}

function armCleanupTimer(entry, delayMs) {
  if (entry.handle != null && typeof entry.clearTimeoutFn === "function") {
    try {
      entry.clearTimeoutFn(entry.handle);
    } catch (_err) {
      /* ignore */
    }
  }
  const handle = entry.setTimeoutFn(() => {
    runCleanupAttempt(entry.key);
  }, delayMs);
  entry.handle = handle;
  if (entry.shouldUnref) {
    unrefHandle(handle);
  }
}

function finishCleanupEntry(entry, event, extra = {}) {
  if (!entry) {
    return;
  }
  const ids = Array.from(entry.messageIds.values());
  logCleanupEvent({
    event,
    gameType: entry.gameType,
    sessionId: entry.sessionId,
    chatId: extra.chatId != null ? extra.chatId : entry.chatId,
    messageId: extra.messageId != null ? extra.messageId : ids[0],
    attempt: extra.attempt,
    shouldDelete: extra.shouldDelete,
    detail: extra.detail,
  });
  clearCleanupEntry(entry);
}

function runCleanupAttempt(key) {
  const entry = pendingGameCleanups.get(key);
  if (!entry) {
    return;
  }
  entry.attempts += 1;
  const toDelete = Array.from(entry.messageIds.values());
  const targetChatId = entry.chatId;
  logCleanupEvent({
    event: "timer-fired",
    gameType: entry.gameType,
    sessionId: entry.sessionId,
    chatId: targetChatId,
    messageId: toDelete[0],
    attempt: entry.attempts,
  });
  if (!runShouldDelete(entry, toDelete, targetChatId)) {
    finishCleanupEntry(entry, "skipped-guard", {
      shouldDelete: false,
      attempt: entry.attempts,
    });
    return;
  }
  if (typeof entry.deleteMessageFn !== "function") {
    finishCleanupEntry(entry, "skipped-no-delete", {
      shouldDelete: true,
      attempt: entry.attempts,
    });
    return;
  }

  const work = toDelete.map((messageId) =>
    Promise.resolve(entry.deleteMessageFn(targetChatId, messageId))
      .then(() => ({ messageId, ok: true }))
      .catch((err) => ({ messageId, ok: false, err }))
  );

  Promise.all(work)
    .then((results) => {
      if (pendingGameCleanups.get(key) !== entry) {
        return;
      }
      let retryMs = null;
      for (const row of results) {
        if (row.ok) {
          logCleanupEvent({
            event: "delete-ok",
            gameType: entry.gameType,
            sessionId: entry.sessionId,
            chatId: targetChatId,
            messageId: row.messageId,
            attempt: entry.attempts,
            shouldDelete: true,
          });
          continue;
        }
        const classified = classifyTelegramDeleteError(row.err);
        if (classified.kind === "gone") {
          logCleanupEvent({
            event: "already-gone",
            gameType: entry.gameType,
            sessionId: entry.sessionId,
            chatId: targetChatId,
            messageId: row.messageId,
            attempt: entry.attempts,
            shouldDelete: true,
          });
          continue;
        }
        if (
          classified.kind === "transient" &&
          entry.attempts < MAX_GAME_CLEANUP_ATTEMPTS
        ) {
          retryMs = Math.max(
            retryMs || 0,
            classified.retryAfterMs || DEFAULT_RETRY_DELAY_MS
          );
          logCleanupEvent({
            event: "retry",
            gameType: entry.gameType,
            sessionId: entry.sessionId,
            chatId: targetChatId,
            messageId: row.messageId,
            attempt: entry.attempts,
            detail: `code=${classified.code || "-"}`,
          });
          continue;
        }
        const formatted =
          row.err && row.err.message ? String(row.err.message).slice(0, 180) : "error";
        try {
          entry.logErrorFn(
            `[game-cleanup] delete-failed game=${entry.gameType} session=${shortSessionId(
              entry.sessionId
            )} msg=${row.messageId}:`,
            formatted
          );
        } catch (_err) {
          /* ignore logging failures */
        }
      }
      if (retryMs != null && pendingGameCleanups.get(key) === entry) {
        armCleanupTimer(entry, retryMs);
        return;
      }
      if (pendingGameCleanups.get(key) === entry) {
        finishCleanupEntry(entry, "complete", {
          shouldDelete: true,
          attempt: entry.attempts,
        });
      }
    })
    .catch(() => {
      if (pendingGameCleanups.get(key) === entry) {
        finishCleanupEntry(entry, "complete", {
          shouldDelete: true,
          attempt: entry.attempts,
        });
      }
    });
}

/**
 * After a game is already closed, delete only that session's registered
 * bot message IDs. Requires a delete function (explicit, telegram, or the
 * process-wide default set via setGameCleanupTelegram). Failures retry at
 * most twice. Cleanup timers are unref'd so they cannot keep Node open.
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
    return { scheduled: false, key: null, skipped: "missing-ids", clear: () => {} };
  }

  const key = gameCleanupKey(gameType, sessionId);
  const generation = normalizeGeneration(options.generation);
  const deleteMessageFn = resolveDeleteMessageFn(options);
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
    if (typeof deleteMessageFn === "function") {
      existing.deleteMessageFn = deleteMessageFn;
    }
    if (typeof options.logErrorFn === "function") {
      existing.logErrorFn = options.logErrorFn;
    }
    return { scheduled: true, key, merged: true, clear: existing.clear };
  }

  if (typeof deleteMessageFn !== "function") {
    logCleanupEvent({
      event: "not-scheduled",
      gameType,
      sessionId,
      chatId,
      messageId: ids[0],
      detail: "no-delete",
    });
    return { scheduled: false, key, skipped: "no-delete", clear: () => {} };
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
  const shouldDeleteFn =
    typeof options.shouldDeleteFn === "function" ? options.shouldDeleteFn : null;

  const messageIds = new Map();
  rememberMessageIds(messageIds, ids);

  const entry = {
    key,
    handle: null,
    chatId,
    messageIds,
    gameType,
    sessionId,
    generation,
    shouldDeleteFn,
    deleteMessageFn,
    logErrorFn,
    setTimeoutFn,
    clearTimeoutFn,
    shouldUnref,
    attempts: 0,
  };
  entry.clear = () => clearCleanupEntry(entry);
  pendingGameCleanups.set(key, entry);
  armCleanupTimer(entry, delayMs);
  logCleanupEvent({
    event: "scheduled",
    gameType,
    sessionId,
    chatId,
    messageId: ids[0],
  });
  return { scheduled: true, key, clear: entry.clear };
}

function clearGameMessageCleanup(gameType, sessionId) {
  const existing = pendingGameCleanups.get(gameCleanupKey(gameType, sessionId));
  if (existing) {
    clearCleanupEntry(existing);
  }
}

function clearAllGameMessageCleanups() {
  const entries = Array.from(pendingGameCleanups.values());
  for (const entry of entries) {
    clearCleanupEntry(entry);
  }
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
  const sessionId = options.sessionId;
  const chatId = options.chatId != null ? options.chatId : callbackChatId(ctx);
  const messageId =
    options.messageId != null ? options.messageId : callbackMessageId(ctx);
  let scheduled = { scheduled: false, key: null };
  if (sessionId != null && sessionId !== "" && chatId != null && messageId != null) {
    scheduled = scheduleGameMessageCleanup({
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
  }
  const wantFooter =
    options.cleanupFooter === false ? false : scheduled.scheduled;
  const stripped = await stripStaleCallbackButtons(ctx, {
    gameType,
    text: options.text,
    cleanupFooter: wantFooter,
    forceEdit: options.forceEdit,
  });
  return { ...stripped, scheduled: scheduled.scheduled, key: scheduled.key };
}

module.exports = {
  GAME_OVER_TOAST,
  GAME_ENDED_TOAST,
  GAME_CLEANUP_FOOTER,
  GAME_MESSAGE_CLEANUP_DELAY_MS,
  GAME_CLEANUP_MAX_ATTEMPTS: MAX_GAME_CLEANUP_ATTEMPTS,
  GAME_CLEANUP_DEFAULT_RETRY_MS: DEFAULT_RETRY_DELAY_MS,
  FINAL_STATE,
  GAME_TYPE,
  emptyGameKeyboardExtra,
  hasGameCleanupFooter,
  withGameCleanupFooter,
  withCleanupFooterIfScheduled,
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
  setGameCleanupTelegram,
  scheduleGameMessageCleanup,
  addGameMessageIds,
  getScheduledGameCleanupIds,
  getScheduledGameCleanupGeneration,
  getScheduledGameCleanupSnapshot,
  hasScheduledGameCleanup,
  clearGameMessageCleanup,
  clearAllGameMessageCleanups,
  getPendingGameMessageCleanupCount,
};
