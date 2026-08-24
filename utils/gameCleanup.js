/**
 * Shared final-message + stale-button cleanup for Telegram group games.
 * Rendering is output-only; callers must already have closed gameplay state.
 */

const { emptyInlineKeyboardExtra } = require("./expiredMessageCleanup");
const { log } = require("./logger");

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
  CHATFIGHT: "chatfight",
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
  if (gameType === GAME_TYPE.CHATFIGHT) {
    return "⚔️ ChatFight ended";
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

module.exports = {
  GAME_OVER_TOAST,
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
};
