/**
 * Optional Telegram Games topic gating for interactive community games.
 *
 * TELEGRAM_GAMES_TOPIC_ID unset → games allowed anywhere in TELEGRAM_CHAT_ID.
 * Set → normal members must start in that forum topic; admins may bypass
 * unless the caller sets allowAdminTopicBypass: false (ManGo Bomb).
 */

const { canManageGroup } = require("./admin");
const { isAllowedChatFightChat } = require("../services/chatFight");

const GAMES_TOPIC_REQUIRED_MESSAGE = `🎮 Games are played in the Games topic.

Please open the Games topic and start your challenge there. 🥭`;

/**
 * @returns {string|null} trimmed topic id, or null when unset/empty
 */
function getConfiguredGamesTopicId() {
  const raw = process.env.TELEGRAM_GAMES_TOPIC_ID;
  if (raw === undefined || raw === null) {
    return null;
  }
  const value = String(raw).trim();
  return value ? value : null;
}

/**
 * Numeric/string id for Telegram sendMessage message_thread_id.
 * @returns {number|string|null}
 */
function getGamesTopicIdForApi() {
  const id = getConfiguredGamesTopicId();
  if (id == null) {
    return null;
  }
  const asNumber = Number(id);
  if (Number.isFinite(asNumber) && String(asNumber) === id) {
    return asNumber;
  }
  return id;
}

/**
 * Resolve forum thread id from a command message or callback message.
 * @param {object} ctx
 * @returns {string|number|null}
 */
function getMessageThreadId(ctx) {
  if (!ctx) {
    return null;
  }
  const msg =
    ctx.message ||
    (ctx.callbackQuery && ctx.callbackQuery.message) ||
    null;
  if (!msg || msg.message_thread_id === undefined || msg.message_thread_id === null) {
    return null;
  }
  return msg.message_thread_id;
}

/**
 * Whether this ctx may start Trivia / TTT / Connect Four under topic policy.
 * Does not check chat allowlist (caller uses isAllowedChatFightChat).
 *
 * @param {object} ctx
 * @param {object} [options]
 * @param {typeof canManageGroup} [options.canManageGroupFn]
 * @param {Function} [options.isAdminFn]
 * @param {Function} [options.getChatMember]
 * @param {string|null} [options.gamesTopicId] test override
 * @param {boolean} [options.allowAdminTopicBypass] default true (Trivia/TTT/C4)
 * @returns {Promise<boolean>}
 */
async function isAllowedGameTopic(ctx, options = {}) {
  const configured =
    options.gamesTopicId !== undefined
      ? options.gamesTopicId == null || String(options.gamesTopicId).trim() === ""
        ? null
        : String(options.gamesTopicId).trim()
      : getConfiguredGamesTopicId();

  if (!configured) {
    return true;
  }

  const threadId = getMessageThreadId(ctx);
  if (threadId != null && String(threadId) === String(configured)) {
    return true;
  }

  if (options.allowAdminTopicBypass === false) {
    return false;
  }

  const canManageFn =
    typeof options.canManageGroupFn === "function"
      ? options.canManageGroupFn
      : canManageGroup;

  try {
    return Boolean(
      await canManageFn(ctx, {
        isAdminFn: options.isAdminFn,
        getChatMember: options.getChatMember,
      })
    );
  } catch (_err) {
    return false;
  }
}

/**
 * Merge optional Games-topic thread into Telegram send extras.
 * @param {object} [extra]
 * @returns {object}
 */
function applyGamesTopicToExtra(extra = {}) {
  const topicId = getGamesTopicIdForApi();
  if (topicId == null) {
    return extra && typeof extra === "object" ? { ...extra } : {};
  }
  const next = extra && typeof extra === "object" ? { ...extra } : {};
  if (next.message_thread_id === undefined || next.message_thread_id === null) {
    next.message_thread_id = topicId;
  }
  return next;
}

/**
 * Keep manual starts in the same thread the user started from.
 * @param {object} ctx
 * @param {object} [extra] Telegraf keyboard / reply extras
 * @returns {object|undefined}
 */
function withCtxThreadExtra(ctx, extra) {
  const base =
    extra && typeof extra === "object" ? { ...extra } : {};
  const threadId = getMessageThreadId(ctx);
  if (threadId != null && base.message_thread_id == null) {
    base.message_thread_id = threadId;
  }
  return Object.keys(base).length ? base : undefined;
}

/**
 * Shared pre-checks for member-started interactive games (not ChatFight).
 * @param {object} ctx
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function assertCanStartInteractiveGame(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return { ok: false, reason: "no-user" };
  }
  if (ctx.from.is_bot) {
    return { ok: false, reason: "bot" };
  }

  const chatAllowedFn =
    typeof options.isAllowedChatFn === "function"
      ? options.isAllowedChatFn
      : isAllowedChatFightChat;
  if (!ctx.chat || !chatAllowedFn(ctx.chat.id)) {
    return { ok: false, reason: "wrong-chat" };
  }

  const topicOk = await isAllowedGameTopic(ctx, options);
  if (!topicOk) {
    return { ok: false, reason: "wrong-topic" };
  }

  return { ok: true };
}

/**
 * Public Games-topic URL for private-menu deep links.
 * Uses TELEGRAM_CHAT_ID + TELEGRAM_GAMES_TOPIC_ID. No new env vars.
 * @returns {string|null}
 */
function buildGamesTopicUrl() {
  const raw = process.env.TELEGRAM_CHAT_ID;
  if (raw == null) {
    return null;
  }
  const chat = String(raw).trim();
  if (!chat.startsWith("-100")) {
    return null;
  }
  const internalId = chat.slice(4);
  if (!/^\d+$/.test(internalId)) {
    return null;
  }
  const topic = getConfiguredGamesTopicId();
  if (topic && /^\d+$/.test(String(topic))) {
    return `https://t.me/c/${internalId}/${topic}`;
  }
  return `https://t.me/c/${internalId}`;
}

module.exports = {
  GAMES_TOPIC_REQUIRED_MESSAGE,
  getConfiguredGamesTopicId,
  getGamesTopicIdForApi,
  getMessageThreadId,
  isAllowedGameTopic,
  applyGamesTopicToExtra,
  withCtxThreadExtra,
  assertCanStartInteractiveGame,
  buildGamesTopicUrl,
};
