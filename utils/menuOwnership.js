/**
 * In-memory ownership for group /menu messages.
 * Keyed by chatId + messageId so parallel menus stay independent.
 * Reverse index: chatId + userId → current menu messageId (one active menu).
 * Callback_data stays short. Missing records are stale, not "another player".
 */

const { sanitizePvpDisplayName } = require("../services/pvpSessionManager");
const { emptyInlineKeyboardExtra } = require("./expiredMessageCleanup");
const { error: logError } = require("./logger");

const MENU_UNAUTHORIZED_GENERIC =
  "This menu belongs to another player. Open your own with /menu.";
const MENU_EXPIRED_GENERIC =
  "This menu has expired. Open a fresh one with /menu.";

const MAX_MENUS = 2000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let maxMenusCap = MAX_MENUS;

/** @type {Map<string, { ownerUserId: string, displayName: string, rememberedAt: number }>} */
const menus = new Map();

/** @type {Map<string, string|number>} chatId:userId → messageId */
const activeByOwner = new Map();

function menuKey(chatId, messageId) {
  if (chatId == null || messageId == null) {
    return null;
  }
  return `${chatId}:${messageId}`;
}

function ownerKey(chatId, userId) {
  if (chatId == null || userId == null || userId === "") {
    return null;
  }
  return `${chatId}:${userId}`;
}

function parseMenuKey(key) {
  const raw = String(key || "");
  const idx = raw.lastIndexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    return null;
  }
  return {
    chatId: raw.slice(0, idx),
    messageId: raw.slice(idx + 1),
  };
}

function isBenignMarkupError(err) {
  const desc = String((err && (err.description || err.message)) || "").toLowerCase();
  return (
    desc.includes("message is not modified") ||
    desc.includes("message to edit not found") ||
    desc.includes("message can't be edited") ||
    desc.includes("message is too old") ||
    desc.includes("too many requests")
  );
}

function clearActiveIfMatches(chatId, userId, messageId) {
  const okey = ownerKey(chatId, userId);
  if (!okey || messageId == null) {
    return;
  }
  if (
    activeByOwner.has(okey) &&
    String(activeByOwner.get(okey)) === String(messageId)
  ) {
    activeByOwner.delete(okey);
  }
}

function dropMenuKey(key) {
  if (!key || !menus.has(key)) {
    return false;
  }
  const record = menus.get(key);
  const parsed = parseMenuKey(key);
  menus.delete(key);
  if (parsed && record) {
    clearActiveIfMatches(parsed.chatId, record.ownerUserId, parsed.messageId);
  }
  return true;
}

function repairActivePointer(chatId, userId) {
  const okey = ownerKey(chatId, userId);
  if (!okey) {
    return null;
  }
  if (!activeByOwner.has(okey)) {
    return null;
  }
  const messageId = activeByOwner.get(okey);
  const rec = getGroupMenuOwner(chatId, messageId);
  if (!rec || String(rec.ownerUserId) !== String(userId)) {
    activeByOwner.delete(okey);
    return null;
  }
  return messageId;
}

function pruneMenus(now = Date.now()) {
  const ts = Number(now) || Date.now();
  for (const [key, record] of menus.entries()) {
    if (!record || ts - record.rememberedAt > MAX_AGE_MS) {
      dropMenuKey(key);
    }
  }
  while (menus.size > maxMenusCap) {
    const oldest = menus.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    dropMenuKey(oldest);
  }
  for (const [okey, messageId] of Array.from(activeByOwner.entries())) {
    const idx = String(okey).lastIndexOf(":");
    if (idx <= 0) {
      activeByOwner.delete(okey);
      continue;
    }
    const chatId = okey.slice(0, idx);
    const userId = okey.slice(idx + 1);
    const rec = getGroupMenuOwner(chatId, messageId);
    if (!rec || String(rec.ownerUserId) !== String(userId)) {
      activeByOwner.delete(okey);
    }
  }
  while (activeByOwner.size > maxMenusCap) {
    const oldest = activeByOwner.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    activeByOwner.delete(oldest);
  }
}

function rememberGroupMenuOwner(chatId, messageId, userId, displayName) {
  const key = menuKey(chatId, messageId);
  if (!key || userId == null || userId === "") {
    return null;
  }
  const uid = String(userId);
  const prevId = repairActivePointer(chatId, uid);
  if (prevId != null && String(prevId) !== String(messageId)) {
    dropMenuKey(menuKey(chatId, prevId));
  }
  if (menus.has(key)) {
    menus.delete(key);
  }
  const record = {
    ownerUserId: uid,
    displayName: sanitizePvpDisplayName(displayName),
    rememberedAt: Date.now(),
  };
  menus.set(key, record);
  const okey = ownerKey(chatId, uid);
  if (okey) {
    if (activeByOwner.has(okey)) {
      activeByOwner.delete(okey);
    }
    activeByOwner.set(okey, messageId);
  }
  pruneMenus();
  return menus.get(key) || record;
}

function getGroupMenuOwner(chatId, messageId) {
  const key = menuKey(chatId, messageId);
  if (!key) {
    return null;
  }
  return menus.get(key) || null;
}

function getActiveGroupMenuMessageId(chatId, userId) {
  return repairActivePointer(chatId, userId);
}

function forgetGroupMenuOwner(chatId, messageId) {
  const key = menuKey(chatId, messageId);
  if (!key) {
    return false;
  }
  return dropMenuKey(key);
}

function setMaxGroupMenusForTests(limit) {
  maxMenusCap =
    Number.isInteger(limit) && limit > 0 ? limit : MAX_MENUS;
}

function listGroupMenuKeysForTests() {
  return Array.from(menus.keys());
}

function listActiveGroupMenuKeysForTests() {
  return Array.from(activeByOwner.keys());
}

function pruneGroupMenusForTests(now) {
  pruneMenus(now);
}

function setActiveGroupMenuPointerForTests(chatId, userId, messageId) {
  const okey = ownerKey(chatId, userId);
  if (!okey) {
    return false;
  }
  if (messageId == null) {
    activeByOwner.delete(okey);
    return true;
  }
  activeByOwner.set(okey, messageId);
  return true;
}

function resetGroupMenuOwnersForTests() {
  menus.clear();
  activeByOwner.clear();
  maxMenusCap = MAX_MENUS;
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
 * Best-effort: remove inline keyboard from one bot message. Never throws.
 * Does not change message text. Does not retry.
 */
async function stripGroupMenuKeyboard(ctx, chatId, messageId) {
  if (chatId == null || messageId == null) {
    return { stripped: false };
  }
  const extra = emptyInlineKeyboardExtra();
  try {
    const telegram = ctx && ctx.telegram;
    if (telegram && typeof telegram.editMessageReplyMarkup === "function") {
      await telegram.editMessageReplyMarkup(
        chatId,
        messageId,
        undefined,
        extra
      );
      return { stripped: true };
    }
    const cbMid = callbackMenuMessageId(ctx);
    if (
      cbMid != null &&
      String(cbMid) === String(messageId) &&
      ctx &&
      typeof ctx.editMessageReplyMarkup === "function"
    ) {
      await ctx.editMessageReplyMarkup(extra.reply_markup);
      return { stripped: true };
    }
    return { stripped: false };
  } catch (err) {
    if (!isBenignMarkupError(err)) {
      try {
        logError(
          "[menu] strip keyboard failed:",
          err && err.message ? err.message : err
        );
      } catch (_err) {
        /* ignore logging failures */
      }
    }
    return { stripped: false, failed: true };
  }
}

/**
 * Remember the owner of a sent group menu message.
 * If this user already had a different active menu in this chat, forget it
 * and best-effort strip that previous keyboard (exactly one previous message).
 * @param {object} ctx
 * @param {object|null|undefined} sent
 */
async function rememberSentGroupMenu(ctx, sent) {
  if (!ctx || !ctx.from || !ctx.chat) {
    return null;
  }
  const messageId = sent && sent.message_id != null ? sent.message_id : null;
  if (messageId == null) {
    return null;
  }
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const prevId = getActiveGroupMenuMessageId(chatId, userId);
  const toStrip =
    prevId != null && String(prevId) !== String(messageId)
      ? { chatId, messageId: prevId }
      : null;
  const record = rememberGroupMenuOwner(chatId, messageId, userId, ctx.from);
  if (toStrip) {
    await stripGroupMenuKeyboard(ctx, toStrip.chatId, toStrip.messageId);
  }
  return record;
}

/**
 * Register/refresh ownership for the callback's own message (in-place edits).
 * Same message stays active; does not retire itself.
 */
function rememberCallbackGroupMenu(ctx) {
  if (!ctx || !ctx.from || !ctx.chat) {
    return null;
  }
  const messageId = callbackMenuMessageId(ctx);
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
  MENU_EXPIRED_GENERIC,
  MAX_MENUS,
  MAX_AGE_MS,
  formatMenuUnauthorizedToast,
  rememberGroupMenuOwner,
  rememberCallbackGroupMenu,
  getGroupMenuOwner,
  getActiveGroupMenuMessageId,
  forgetGroupMenuOwner,
  stripGroupMenuKeyboard,
  resetGroupMenuOwnersForTests,
  setMaxGroupMenusForTests,
  listGroupMenuKeysForTests,
  listActiveGroupMenuKeysForTests,
  pruneGroupMenusForTests,
  setActiveGroupMenuPointerForTests,
  rememberSentGroupMenu,
  bindGroupMenuOwnerFromCtx,
  callbackMenuMessageId,
};
