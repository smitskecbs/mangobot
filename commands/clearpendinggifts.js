/**
 * Admin-only private /clearpendinggifts and /retrymysteryannounce.
 * Cleanup never sends tokens. Retry never resends on-chain rewards.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const { parseCommandArg } = require("../utils/telegramReplyTarget");
const {
  previewPendingMysteryGiftCleanup,
  clearPendingMysteryGifts,
  formatClearConfirmText,
} = require("../services/mysteryGiftCleanup");
const {
  getReward,
  loadRewardsStore,
} = require("../services/memberRewards");
const { announceMysteryGiftDelivered } = require("../services/mysteryGiftAnnounce");
const { notifyMysteryGiftRecipient } = require("../services/mysteryGiftNotify");

const ADMIN_ONLY = "This command is admin only.";
const PRIVATE_ONLY = "Use this command in a private chat with the bot.";
const CPG_ASK = "cpg:ask";
const CPG_GO = "cpg:go";
const CPG_X = "cpg:x";

function confirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🗑 Clear Pending", CPG_GO)],
    [Markup.button.callback("Cancel", CPG_X)],
  ]);
}

function fileOptions(options = {}) {
  return {
    walletFile: options.walletFile,
    rewardsFile: options.rewardsFile,
    deliveryFile: options.deliveryFile,
    env: options.env,
    now: options.now,
    botToken: options.botToken,
    chatId: options.chatId,
    fetchImpl: options.fetchImpl,
    announceMysteryGift: options.announceMysteryGift,
    notifyMysteryGift: options.notifyMysteryGift,
  };
}

function gateAdminPrivate(ctx) {
  if (!ctx || !ctx.from) {
    return { ok: false, silent: true };
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return { ok: false, silent: false, text: ADMIN_ONLY };
    }
    return { ok: false, silent: true };
  }
  if (!isPrivateChat(ctx)) {
    return { ok: false, silent: false, text: PRIVATE_ONLY };
  }
  return { ok: true };
}

function handleClearPendingGifts(ctx, options = {}) {
  const gate = gateAdminPrivate(ctx);
  if (!gate.ok) {
    if (gate.silent) {
      return undefined;
    }
    return ctx.reply(gate.text);
  }
  const preview = previewPendingMysteryGiftCleanup(fileOptions(options));
  return ctx.reply(formatClearConfirmText(preview.pendingCount), confirmKeyboard());
}

async function handleClearPendingCallback(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (typeof ctx.answerCbQuery === "function") {
    try {
      await ctx.answerCbQuery();
    } catch {
      /* ignore */
    }
  }
  const data =
    ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";
  if (data !== CPG_ASK && data !== CPG_GO && data !== CPG_X) {
    return undefined;
  }

  if (!isAdmin(ctx.from.id)) {
    return undefined;
  }
  if (!isPrivateChat(ctx)) {
    return ctx.reply(PRIVATE_ONLY);
  }

  const files = fileOptions(options);
  if (data === CPG_X) {
    return ctx.reply("Cleanup cancelled. Nothing was removed.");
  }
  if (data === CPG_ASK) {
    const preview = previewPendingMysteryGiftCleanup(files);
    return ctx.reply(formatClearConfirmText(preview.pendingCount), confirmKeyboard());
  }

  const result = clearPendingMysteryGifts({
    adminUserId: ctx.from.id,
    ...files,
  });
  if (!result.ok) {
    return ctx.reply(result.error || "Cleanup failed. Nothing was removed.");
  }
  return ctx.reply(result.report);
}

function listRetryableMysteryGifts(rewardsFile) {
  const store = loadRewardsStore(rewardsFile);
  const ids = [];
  for (const [id, record] of Object.entries(store.rewards || {})) {
    if (!record || record.type !== "mystery-gift" || record.status !== "sent") {
      continue;
    }
    const groupDone = record.groupAnnounceState === "sent" || Number(record.groupAnnouncedAt) > 0;
    const dmDone = record.recipientNotifyState === "sent" || Number(record.recipientNotifiedAt) > 0;
    if (groupDone && dmDone) {
      continue;
    }
    ids.push(id);
  }
  return ids;
}

async function retryOne(rewardId, options) {
  const reward = getReward(rewardId, options.rewardsFile);
  if (!reward || reward.status !== "sent" || reward.type !== "mystery-gift") {
    return { ok: false, reason: "not-sent" };
  }
  const notify = await notifyMysteryGiftRecipient(rewardId, {
    ...options,
    notifyMysteryGift: true,
  });
  const announce = await announceMysteryGiftDelivered(rewardId, {
    ...options,
    announceMysteryGift: true,
  });
  return {
    ok: true,
    rewardId,
    notify,
    announce,
  };
}

async function handleRetryMysteryAnnounce(ctx, options = {}) {
  const gate = gateAdminPrivate(ctx);
  if (!gate.ok) {
    if (gate.silent) {
      return undefined;
    }
    return ctx.reply(gate.text);
  }

  const files = fileOptions(options);
  const arg = parseCommandArg(ctx);
  const wanted = arg ? arg.trim() : "";
  const ids = wanted ? [wanted] : listRetryableMysteryGifts(files.rewardsFile);
  if (!ids.length) {
    return ctx.reply("No Mystery Gift notifications need a retry.");
  }

  let groupSent = 0;
  let skipped = 0;
  for (const rewardId of ids) {
    const result = await retryOne(rewardId, files);
    if (!result.ok) {
      skipped += 1;
      continue;
    }
    if (result.announce && result.announce.sent) {
      groupSent += 1;
    } else {
      skipped += 1;
    }
  }
  return ctx.reply(
    [
      "📣 Mystery Gift notification retry",
      "",
      `Group sent: ${groupSent}`,
      `Skipped/already sent: ${skipped}`,
      "",
      "On-chain rewards were not resent.",
    ].join("\n")
  );
}

module.exports = (bot) => {
  bot.command("clearpendinggifts", (ctx) => handleClearPendingGifts(ctx));
  bot.command("retrymysteryannounce", (ctx) =>
    Promise.resolve(handleRetryMysteryAnnounce(ctx)).catch(() => undefined)
  );
  bot.action(/^cpg:(ask|go|x)$/, (ctx) =>
    Promise.resolve(handleClearPendingCallback(ctx)).catch(() => undefined)
  );
};

module.exports.handleClearPendingGifts = handleClearPendingGifts;
module.exports.handleClearPendingCallback = handleClearPendingCallback;
module.exports.handleRetryMysteryAnnounce = handleRetryMysteryAnnounce;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.PRIVATE_ONLY = PRIVATE_ONLY;
module.exports.CPG_ASK = CPG_ASK;
module.exports.CPG_GO = CPG_GO;
module.exports.CPG_X = CPG_X;
module.exports.confirmKeyboard = confirmKeyboard;
