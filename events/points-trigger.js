/**
 * Community activity pipeline: daily activity (silent) then gm/gn trigger awards.
 * Rank-ups may announce; activity itself never posts "+1".
 *
 * Daily activity only in the configured Telegram community group, max 1× per UTC day.
 * Eligible: text, reply, sticker, GIF/animation, photo, video / video_note.
 * Not eligible: commands, bots, service messages, callbacks, private chat, wrong group.
 *
 * Runs after events/chat-fight.js (alphabetical). If ChatFight already
 * announced a rank-up on the winner reply, skip a duplicate rank-up here.
 */

const {
  isCommandText,
  detectTrigger,
  awardDailyActivityPoint,
  awardTriggerPoints,
  getCombinedRankUpReply,
} = require("../services/points");
const { reminderForBlockedXp } = require("../services/xpWalletGate");
const {
  isPrivateChat,
  isGroupChat,
  isPrivateMenuLabel,
} = require("../utils/botMenu");
const { noteCommunityActivity } = require("../utils/communityActivityPulse");
const { isAllowedChatFightChat } = require("../services/chatFight");

const COMMUNITY_ACTIVITY_UPDATES = Object.freeze([
  "text",
  "sticker",
  "animation",
  "photo",
  "video",
  "video_note",
]);

/**
 * Private reply-keyboard taps and slash commands are not community messages.
 * @param {object} ctx
 * @param {string} text
 * @returns {boolean}
 */
function shouldSkipCommunityActivity(ctx, text) {
  if (isCommandText(text)) {
    return true;
  }
  if (isPrivateChat(ctx)) {
    return true;
  }
  return isPrivateMenuLabel(text);
}

function isServiceMessage(msg) {
  if (!msg || typeof msg !== "object") {
    return true;
  }
  return Boolean(
    msg.new_chat_members ||
      msg.left_chat_member ||
      msg.new_chat_member ||
      msg.group_chat_created ||
      msg.supergroup_chat_created ||
      msg.channel_chat_created ||
      msg.pinned_message ||
      msg.migrate_to_chat_id ||
      msg.migrate_from_chat_id ||
      msg.new_chat_title ||
      msg.new_chat_photo ||
      msg.delete_chat_photo ||
      msg.message_auto_delete_timer_changed ||
      msg.connected_website ||
      msg.proximity_alert_triggered ||
      msg.voice_chat_started ||
      msg.voice_chat_ended ||
      msg.video_chat_started ||
      msg.video_chat_ended ||
      msg.video_chat_participants_invited
  );
}

function getMessageTextForTrigger(ctx) {
  if (!ctx || !ctx.message) {
    return "";
  }
  if (typeof ctx.message.text === "string") {
    return ctx.message.text;
  }
  if (typeof ctx.message.caption === "string") {
    return ctx.message.caption;
  }
  return "";
}

function hasEligibleCommunityContent(msg) {
  if (!msg || isServiceMessage(msg)) {
    return false;
  }
  if (typeof msg.text === "string" && msg.text.trim() && !isCommandText(msg.text)) {
    return true;
  }
  if (msg.sticker) {
    return true;
  }
  if (msg.animation) {
    return true;
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    return true;
  }
  if (msg.video || msg.video_note) {
    return true;
  }
  return false;
}

/**
 * Daily Quest community slot: text or caption, not slash, not sticker/GIF-only.
 * @param {object} msg
 * @returns {boolean}
 */
function hasDailyQuestCommunityText(msg) {
  if (!msg) {
    return false;
  }
  if (typeof msg.text === "string" && msg.text.trim() && !isCommandText(msg.text)) {
    return true;
  }
  if (typeof msg.caption === "string" && msg.caption.trim() && !isCommandText(msg.caption)) {
    return true;
  }
  return false;
}

function isCommandMessage(msg) {
  if (!msg) {
    return false;
  }
  if (typeof msg.text === "string" && isCommandText(msg.text)) {
    return true;
  }
  if (typeof msg.caption === "string" && isCommandText(msg.caption)) {
    return true;
  }
  return false;
}

function communityMessageDedupeKey(ctx) {
  if (!ctx || !ctx.chat || !ctx.message) {
    return null;
  }
  if (ctx.message.message_id == null) {
    return null;
  }
  return `${ctx.chat.id}:${ctx.message.message_id}`;
}

function isValidDailyQuestReply(ctx) {
  if (!isEligibleCommunityActivityMessage(ctx)) {
    return false;
  }
  const msg = ctx.message;
  if (!msg || isCommandMessage(msg)) {
    return false;
  }
  const reply = msg.reply_to_message;
  if (!reply || !reply.from) {
    return false;
  }
  if (reply.from.is_bot) {
    return false;
  }
  if (ctx.from && String(reply.from.id) === String(ctx.from.id)) {
    return false;
  }
  return true;
}

function isDailyQuestMediaMessage(ctx) {
  if (!isEligibleCommunityActivityMessage(ctx)) {
    return false;
  }
  const msg = ctx.message;
  if (!msg || isCommandMessage(msg) || isServiceMessage(msg)) {
    return false;
  }
  if (msg.sticker || msg.document) {
    return false;
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    return true;
  }
  if (msg.video || msg.animation || msg.video_note) {
    return true;
  }
  return false;
}

function isDailyQuestCountableMessage(ctx) {
  if (!isEligibleCommunityActivityMessage(ctx)) {
    return false;
  }
  return hasDailyQuestCommunityText(ctx.message);
}

function isEligibleDailyQuestCommunityMessage(ctx) {
  return isDailyQuestCountableMessage(ctx);
}

function isEligibleCommunityActivityMessage(ctx) {
  if (!ctx || !ctx.from || ctx.from.is_bot) {
    return false;
  }
  if (ctx.callbackQuery) {
    return false;
  }
  if (!isGroupChat(ctx)) {
    return false;
  }
  if (!ctx.chat || !isAllowedChatFightChat(ctx.chat.id)) {
    return false;
  }
  const msg = ctx.message;
  if (!msg || isServiceMessage(msg)) {
    return false;
  }
  if (typeof msg.text === "string" && isCommandText(msg.text)) {
    return false;
  }
  return hasEligibleCommunityContent(msg);
}

/**
 * Award daily activity (if eligible) then trigger XP. At most one rank-up reply.
 * @param {object} ctx
 * @param {object} [options]
 */
async function processCommunityMessage(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return { activityResult: null, triggerResult: null, reply: null };
  }

  const userName = ctx.from.first_name || ctx.from.username || "friend";
  const userId = ctx.from.id;
  const textForTrigger = getMessageTextForTrigger(ctx);
  const isMenuTap = isPrivateChat(ctx) && isPrivateMenuLabel(textForTrigger);
  const pointsFile = options.pointsFile;
  const walletFile = options.walletFile;

  let activityResult = null;
  if (!ctx.from.is_bot && isEligibleCommunityActivityMessage(ctx)) {
    activityResult =
      pointsFile !== undefined
        ? await awardDailyActivityPoint(userId, userName, pointsFile, undefined, walletFile)
        : await awardDailyActivityPoint(userId, userName);
    noteCommunityActivity();
  }

  if (!ctx.from.is_bot && isEligibleDailyQuestCommunityMessage(ctx)) {
    try {
      require("../services/dailyQuest").noteDailyQuestCommunity(userId, {
        walletFile,
        shopFile: options.shopFile,
        now: options.now,
      });
    } catch (_err) {
      // Quest tracking must never break the XP pipeline.
    }
  }

  const dedupeKey = communityMessageDedupeKey(ctx);
  if (!ctx.from.is_bot && dedupeKey) {
    const questOptions = {
      walletFile,
      shopFile: options.shopFile,
      now: options.now,
      dedupeKey,
    };
    try {
      const dailyQuest = require("../services/dailyQuest");
      if (isValidDailyQuestReply(ctx)) {
        dailyQuest.noteDailyQuestReply(userId, {
          ...questOptions,
          dedupeBucket: "replies",
        });
      }
      if (isDailyQuestMediaMessage(ctx)) {
        dailyQuest.noteDailyQuestMedia(userId, {
          ...questOptions,
          dedupeBucket: "media",
        });
      }
      if (isDailyQuestCountableMessage(ctx)) {
        dailyQuest.noteDailyQuestMessage(userId, {
          ...questOptions,
          dedupeBucket: "messages",
        });
      }
    } catch (_err) {
      // Quest tracking must never break the XP pipeline.
    }
  }

  const trigger = isMenuTap ? null : detectTrigger(textForTrigger);
  let triggerResult = null;
  if (trigger && !ctx.from.is_bot) {
    triggerResult =
      pointsFile !== undefined
        ? await awardTriggerPoints(userId, userName, trigger, pointsFile, walletFile)
        : await awardTriggerPoints(userId, userName, trigger);
    if (trigger === "gmango" || trigger === "gnango") {
      try {
        require("../services/dailyQuest").noteDailyQuestGreeting(userId, {
          walletFile,
          shopFile: options.shopFile,
          now: options.now,
        });
      } catch (_err) {
        // Quest tracking must never break the XP pipeline.
      }
    }
  }

  const fightAward =
    ctx.state && ctx.state.chatFightAward ? ctx.state.chatFightAward : null;

  if (fightAward && fightAward.rankUp) {
    return { activityResult, triggerResult, reply: null, skippedDuplicateRankUp: true };
  }

  const rankReply = getCombinedRankUpReply(
    activityResult,
    triggerResult,
    userName,
    fightAward
  );
  if (rankReply) {
    return { activityResult, triggerResult, reply: rankReply };
  }
  const reminder = reminderForBlockedXp(
    userId,
    [activityResult, triggerResult],
    options.now,
    { trigger: Boolean(triggerResult && triggerResult.reason === "wallet-required") }
  );
  return { activityResult, triggerResult, reply: reminder };
}

/**
 * @param {object} bot
 * @param {object} [options] forwarded to processCommunityMessage (e.g. pointsFile)
 */
function registerCommunityActivityListener(bot, options = {}) {
  bot.on(COMMUNITY_ACTIVITY_UPDATES, async (ctx, next) => {
    const result = await processCommunityMessage(ctx, options);
    if (result.reply) {
      ctx.reply(result.reply);
    }
    if (typeof next === "function") {
      return next();
    }
  });
}

module.exports = (bot) => {
  registerCommunityActivityListener(bot);
};

module.exports.registerCommunityActivityListener = registerCommunityActivityListener;
module.exports.shouldSkipCommunityActivity = shouldSkipCommunityActivity;
module.exports.isEligibleCommunityActivityMessage = isEligibleCommunityActivityMessage;
module.exports.isEligibleDailyQuestCommunityMessage = isEligibleDailyQuestCommunityMessage;
module.exports.isValidDailyQuestReply = isValidDailyQuestReply;
module.exports.isDailyQuestMediaMessage = isDailyQuestMediaMessage;
module.exports.isDailyQuestCountableMessage = isDailyQuestCountableMessage;
module.exports.isServiceMessage = isServiceMessage;
module.exports.getMessageTextForTrigger = getMessageTextForTrigger;
module.exports.processCommunityMessage = processCommunityMessage;
module.exports.COMMUNITY_ACTIVITY_UPDATES = COMMUNITY_ACTIVITY_UPDATES;
