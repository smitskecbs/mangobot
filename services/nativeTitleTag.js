/**
 * Cosmetic Telegram native member tags for community titles.
 * Uses Telegraf telegram.callApi("setChatMemberTag", ...).
 * Never promotes, restricts, bans, or sets administrator custom titles.
 */

const { getTitleById, getNativeTagForTitle, isValidNativeTag } = require("./mangoTitles");
const {
  mutateShopStore,
  loadShopStore,
  ensureUser,
} = require("./mangoShopStore");
const { error: logError } = require("../utils/logger");

const SET_CHAT_MEMBER_TAG = "setChatMemberTag";

let telegramClient = null;
let chatIdOverride = null;

function setNativeTitleTagTelegram(telegram) {
  telegramClient =
    telegram && typeof telegram.callApi === "function" ? telegram : null;
}

function setNativeTitleTagChatIdForTests(chatId) {
  chatIdOverride = chatId == null || chatId === "" ? null : String(chatId);
}

function communityChatId() {
  if (chatIdOverride) {
    return chatIdOverride;
  }
  const raw = process.env.TELEGRAM_CHAT_ID;
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  return raw.trim();
}

function normalizeUserId(userId) {
  if (userId == null || userId === "") {
    return null;
  }
  const id = String(userId).trim();
  return id || null;
}

function classifyTagError(err) {
  const code = err && (err.error_code || err.code);
  const desc = String(
    (err && (err.description || err.message)) || ""
  ).toLowerCase();
  if (
    code === 403 ||
    desc.includes("not enough rights") ||
    desc.includes("can_manage_tags") ||
    desc.includes("chat_admin_required") ||
    desc.includes("not an administrator")
  ) {
    return "permission";
  }
  return "network";
}

function logTagFailure(reason) {
  logError(`[mango-title] native tag sync failed reason=${reason}`);
}

function getTagSyncState(userId, shopFile) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { status: "none", at: 0, titleId: null };
  }
  const store = loadShopStore(shopFile);
  const user = store.users[id];
  return user && user.tagSync
    ? {
        status: user.tagSync.status,
        at: user.tagSync.at,
        titleId: user.tagSync.titleId,
      }
    : { status: "none", at: 0, titleId: null };
}

function persistTagSync(userId, status, titleId, shopFile) {
  const id = normalizeUserId(userId);
  if (!id) {
    return;
  }
  try {
    mutateShopStore((store) => {
      const user = ensureUser(store, id);
      user.tagSync = {
        status,
        at: Date.now(),
        titleId: titleId || null,
      };
    }, shopFile);
  } catch (_err) {
    logTagFailure("store");
  }
}

async function callSetChatMemberTag(userId, tag) {
  const chatId = communityChatId();
  if (!chatId) {
    return { ok: false, reason: "no-chat" };
  }
  if (!telegramClient) {
    return { ok: false, reason: "no-client" };
  }
  const uid = Number(userId);
  if (!Number.isFinite(uid)) {
    return { ok: false, reason: "user" };
  }
  if (tag !== "" && !isValidNativeTag(tag)) {
    return { ok: false, reason: "invalid-tag" };
  }
  const payload = {
    chat_id: chatId,
    user_id: uid,
    tag,
  };
  try {
    await telegramClient.callApi(SET_CHAT_MEMBER_TAG, payload);
    return { ok: true, chatId, userId: uid, tag };
  } catch (err) {
    const reason = classifyTagError(err);
    logTagFailure(reason);
    return { ok: false, reason };
  }
}

async function syncActiveTitleTag(userId, options = {}) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  const store = loadShopStore(options.shopFile);
  const user = store.users[id];
  const titleId = user && user.activeTitle ? user.activeTitle : null;
  if (!titleId) {
    return clearNativeTitleTag(id, options);
  }
  if (!user.ownedTitles || !user.ownedTitles[titleId]) {
    return { ok: false, reason: "unowned" };
  }
  const tag = getNativeTagForTitle(titleId);
  if (!tag) {
    persistTagSync(id, "failed", titleId, options.shopFile);
    logTagFailure("invalid-tag");
    return { ok: false, reason: "invalid-tag" };
  }
  const result = await callSetChatMemberTag(id, tag);
  persistTagSync(
    id,
    result.ok ? "synced" : "failed",
    titleId,
    options.shopFile
  );
  return {
    ok: result.ok,
    reason: result.reason || null,
    tag: result.ok ? tag : null,
    title: getTitleById(titleId),
  };
}

async function clearNativeTitleTag(userId, options = {}) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  const result = await callSetChatMemberTag(id, "");
  persistTagSync(id, result.ok ? "cleared" : "failed", null, options.shopFile);
  return {
    ok: result.ok,
    reason: result.reason || null,
    tag: "",
  };
}

function formatTelegramTagLine(userId, shopFile) {
  const state = getTagSyncState(userId, shopFile);
  if (state.status === "synced") {
    return ["Telegram tag:", "✅ Synced"].join("\n");
  }
  if (state.status === "failed") {
    return ["Telegram tag:", "⚠️ Not synced"].join("\n");
  }
  if (state.status === "cleared") {
    return ["Telegram tag:", "None"].join("\n");
  }
  return "";
}

module.exports = {
  SET_CHAT_MEMBER_TAG,
  setNativeTitleTagTelegram,
  setNativeTitleTagChatIdForTests,
  communityChatId,
  getTagSyncState,
  syncActiveTitleTag,
  clearNativeTitleTag,
  formatTelegramTagLine,
  classifyTagError,
};
