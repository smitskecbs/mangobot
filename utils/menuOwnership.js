/**
 * In-memory ownership for group /menu messages.
 * Keyed by chatId + messageId so parallel menus stay independent.
 * Callback_data stays short; stale/unknown menus fail closed.
 */

const { sanitizePvpDisplayName } = require("../services/pvpSessionManager");

const MENU_UNAUTHORIZED_GENERIC =
  "This menu belongs to another player. Open your own with /menu.";

const MAX_MENUS = 2000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, { ownerUserId: string, displayName: string, rememberedAt: number }>} */
const menus = new Map();

function menuKey(chatId, messageId) {
  if (chatId == null || messageId == null) {
    return null;
  }
  return `${chatId}:${messageId}`;
}

function pruneMenus(now = Date.now()) {
  const ts = Number(now) || Date.now();
  for (const [key, record] of menus.entries()) {
    if (!record || ts - record.rememberedAt > MAX_AGE_MS) {
      menus.delete(key);
    }
  }
  while (menus.size > MAX_MENUS) {
    const oldest = menus.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    menus.delete(oldest);
  }
}

function rememberGroupMenuOwner(chatId, messageId, userId, displayName) {
  const key = menuKey(chatId, messageId);
  if (!key || userId == null || userId === "") {
    return null;
  }
  pruneMenus();
  const record = {
    ownerUserId: String(userId),
    displayName: sanitizePvpDisplayName(displayName),
    rememberedAt: Date.now(),
  };
  menus.set(key, record);
  return record;
}

function getGroupMenuOwner(chatId, messageId) {
  const key = menuKey(chatId, messageId);
  if (!key) {
    return null;
  }
  return menus.get(key) || null;
}

function forgetGroupMenuOwner(chatId, messageId) {
  const key = menuKey(chatId, messageId);
  if (!key) {
    return false;
  }
  return menus.delete(key);
}

function resetGroupMenuOwnersForTests() {
  menus.clear();
}

function formatMenuUnauthorizedToast(displayName) {
  const name =
    typeof displayName === "string" ? displayName.replace(/\s+/g, " ").trim() : "";
  if (name) {
    return `This menu belongs to ${name}. Open your own with /menu.`;
  }
  return MENU_UNAUTHORIZED_GENERIC;
}

function callbackMenuMessageId(ctx) {
  const message =
    ctx && ctx.callbackQuery && ctx.callbackQuery.message
      ? ctx.callbackQuery.message
      : null;
  if (!message || message.message_id == null) {
    return null;
  }
  return message.message_id;
}

/**
 * Remember the owner of a sent group menu message.
 * @param {object} ctx
 * @param {object|null|undefined} sent
 */
function rememberSentGroupMenu(ctx, sent) {
  if (!ctx || !ctx.from || !ctx.chat) {
    return null;
  }
  const messageId = sent && sent.message_id != null ? sent.message_id : null;
  if (messageId == null) {
    return null;
  }
  return rememberGroupMenuOwner(
    ctx.chat.id,
    messageId,
    ctx.from.id,
    ctx.from
  );
}

/**
 * Test helper: mark this callback's message as owned by ctx.from.
 * Creates message_id 1 when the mock omitted callbackQuery.message.
 */
function bindGroupMenuOwnerFromCtx(ctx) {
  if (!ctx || !ctx.from || !ctx.chat || !ctx.callbackQuery) {
    return null;
  }
  let messageId = callbackMenuMessageId(ctx);
  if (messageId == null) {
    messageId = 1;
    ctx.callbackQuery.message = {
      ...(ctx.callbackQuery.message || {}),
      message_id: messageId,
    };
  }
  return rememberGroupMenuOwner(
    ctx.chat.id,
    messageId,
    ctx.from.id,
    ctx.from
  );
}

module.exports = {
  MENU_UNAUTHORIZED_GENERIC,
  formatMenuUnauthorizedToast,
  rememberGroupMenuOwner,
  getGroupMenuOwner,
  forgetGroupMenuOwner,
  resetGroupMenuOwnersForTests,
  rememberSentGroupMenu,
  bindGroupMenuOwnerFromCtx,
  callbackMenuMessageId,
};
