/**
 * Admin-only /deliver and /presaledistribute.
 * Creates a one-time admin delivery session. Does not sign or hold keys.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const { getReplyTargetUser, parseCommandArg } = require("../utils/telegramReplyTarget");
const { shortenWallet, normalizeSolanaPublicKey, escapeTelegramHtml } = require("../utils/solanaWallet");
const {
  prepareRewardDelivery,
  preparePresaleDistribution,
  listPendingRewardsForAdmin,
  findPendingPresaleContribution,
  markOffchainDelivered,
  setOffchainGiftLabel,
  isOffchainRecord,
} = require("../services/rewardDelivery");
const {
  getReward,
  normalizeOffchainGiftLabel,
  OFFCHAIN_GIFT_LABEL_MAX,
} = require("../services/memberRewards");
const {
  formatMangoGrouped,
  formatMangoHuman,
  assetTypeLabel,
  ASSET_MANGO,
  ASSET_SPL,
  ASSET_NFT,
  ASSET_OFFCHAIN,
} = require("../services/deliveryConstants");

const ADMIN_ONLY = "This command is admin only.";
const USAGE_DELIVER =
  "Use /deliver <rewardId> <mangoAmount>, or reply to a member with /deliver.";
const USAGE_PRESALE =
  "Reply to a member's message with /presaledistribute.";
const PICKER_PRIVATE_ONLY =
  "Open a private chat with the bot to choose SPL, NFT, or off-chain. In a group, use /deliver <rewardId> <mangoAmount>.";
const OFFCHAIN_GIFT_PROMPT = `Send what the gift is (max ${OFFCHAIN_GIFT_LABEL_MAX} characters).`;
const PENDING_TTL_MS = 10 * 60 * 1000;

const pendingByAdmin = new Map();

function prunePending(now = Date.now()) {
  for (const [userId, row] of pendingByAdmin.entries()) {
    if (!row || row.expiresAt <= now) {
      pendingByAdmin.delete(userId);
    }
  }
}

function setPending(adminUserId, row) {
  prunePending();
  pendingByAdmin.set(String(adminUserId), {
    ...row,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

function getPending(adminUserId) {
  prunePending();
  const row = pendingByAdmin.get(String(adminUserId));
  if (!row) {
    return null;
  }
  if (row.expiresAt <= Date.now()) {
    pendingByAdmin.delete(String(adminUserId));
    return null;
  }
  return row;
}

function clearPending(adminUserId) {
  pendingByAdmin.delete(String(adminUserId));
}

function deliveryKeyboard(url) {
  if (!url) {
    return undefined;
  }
  return Markup.inlineKeyboard([[Markup.button.url("Confirm in Wallet", url)]]);
}

function offchainEnterGiftKeyboard(rewardId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✍️ Enter Gift", `dlv:g:${rewardId}`)],
    [Markup.button.callback("❌ Cancel", `dlv:x:${rewardId}`)],
  ]);
}

function offchainReviewKeyboard(rewardId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Mark Delivered", `dlv:d:${rewardId}`)],
    [Markup.button.callback("✏️ Change Gift", `dlv:g:${rewardId}`)],
    [Markup.button.callback("❌ Cancel", `dlv:x:${rewardId}`)],
  ]);
}

function htmlKeyboard(keyboard) {
  return {
    parse_mode: "HTML",
    reply_markup: keyboard && keyboard.reply_markup,
  };
}

function formatOffchainPrompt(rewardId) {
  return {
    text: ["🎁 Off-chain Mystery Gift", "", OFFCHAIN_GIFT_PROMPT].join("\n"),
    extra: offchainEnterGiftKeyboard(rewardId),
  };
}

function formatOffchainReview(reward) {
  const gift = escapeTelegramHtml(
    reward && typeof reward.offchainGiftLabel === "string"
      ? reward.offchainGiftLabel
      : ""
  );
  const recipient = escapeTelegramHtml(
    (reward && (reward.displayNameSnapshot || reward.displayName)) || "Member"
  );
  return {
    text: [
      "🎁 Off-chain Mystery Gift",
      "",
      "Gift:",
      gift,
      "",
      "Recipient:",
      recipient,
    ].join("\n"),
    extra: htmlKeyboard(offchainReviewKeyboard(reward && reward.rewardId)),
  };
}

function pickerKeyboard(rewardId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🥭 MANGO", `dlv:m:${rewardId}`),
      Markup.button.callback("🪙 SPL Token", `dlv:s:${rewardId}`),
    ],
    [
      Markup.button.callback("🖼 NFT", `dlv:n:${rewardId}`),
      Markup.button.callback("🎁 Off-chain", `dlv:o:${rewardId}`),
    ],
    [Markup.button.callback("Cancel", `dlv:x:${rewardId}`)],
  ]);
}

function formatReady(review, url) {
  const isPresale = review && review.kind === "presale";
  if (isPresale) {
    return {
      text: [
        "🎁 ManGo Delivery",
        "",
        `Type: ${review.typeLabel}`,
        `To: ${review.destinationShort}`,
        "Asset: MANGO",
        `Amount: ${review.amountDisplay} MANGO`,
        "",
        "Sign with the configured distribution wallet.",
        "The bot never holds private keys.",
      ].join("\n"),
      extra: deliveryKeyboard(url),
    };
  }

  const offchain = isOffchainRecord(review) || review.assetType === ASSET_OFFCHAIN;
  const typeLine = review.assetTypeLabel || assetTypeLabel(review.assetType) || "MANGO";
  const lines = [
    "🎁 Mystery Gift Delivery",
    "",
    `Type: ${typeLine}`,
    `Asset: ${review.asset || typeLine}`,
  ];
  if (!offchain && review.mint) {
    lines.push(`Mint: ${review.mintShort || shortenWallet(review.mint)}`);
  }
  if (!offchain) {
    lines.push(`Amount: ${review.amountDisplay}`);
  }
  lines.push(`To: ${review.destinationShort}`);
  if (review.expectedSignerShort) {
    lines.push(`From: ${review.expectedSignerShort}`);
  }
  if (!offchain) {
    lines.push("");
    lines.push("Sign with the configured distribution wallet.");
    lines.push("The bot never holds private keys.");
  }

  return { text: lines.join("\n"), extra: offchain ? undefined : deliveryKeyboard(url) };
}

function formatReadyForReward(result) {
  const review = {
    ...result.review,
    rewardId: result.reward && result.reward.rewardId,
  };
  return formatReady(review, result.url);
}

function fileOptionsFrom(options = {}, pending = null) {
  const fromPending = pending && pending.files ? pending.files : {};
  return {
    walletFile: options.walletFile || fromPending.walletFile,
    rewardsFile: options.rewardsFile || fromPending.rewardsFile,
    deliveryFile: options.deliveryFile || fromPending.deliveryFile,
    env: options.env || fromPending.env,
    now: options.now || fromPending.now,
    deliveryUrl: options.deliveryUrl || fromPending.deliveryUrl,
    inspectMint: options.inspectMint || fromPending.inspectMint,
  };
}

function snapshotFiles(options = {}) {
  return {
    walletFile: options.walletFile,
    rewardsFile: options.rewardsFile,
    deliveryFile: options.deliveryFile,
    env: options.env,
    now: options.now,
    deliveryUrl: options.deliveryUrl,
    inspectMint: options.inspectMint,
  };
}

function handleDeliver(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }

  const arg = parseCommandArg(ctx);
  const parts = arg ? arg.split(/\s+/).filter(Boolean) : [];
  const target = getReplyTargetUser(ctx);

  if (!parts.length && target) {
    const pending = listPendingRewardsForAdmin(target.id, options.rewardsFile);
    if (!pending.length) {
      return ctx.reply(`No pending rewards for ${target.firstName}.`);
    }
    const lines = [`🎁 Pending rewards for ${target.firstName}`, ""];
    for (const reward of pending.slice(0, 8)) {
      lines.push(
        `• ${reward.label || reward.type} · ${reward.rewardId} · ${reward.status}`
      );
    }
    lines.push("", "Use /deliver <rewardId> <mangoAmount>.");
    return ctx.reply(lines.join("\n"));
  }

  if (!parts.length) {
    return ctx.reply(USAGE_DELIVER);
  }

  const rewardId = parts[0];
  const amountHuman = parts.slice(1).join(" ");
  const existing = getReward(rewardId, options.rewardsFile);
  if (!existing) {
    return ctx.reply(USAGE_DELIVER);
  }

  if (!amountHuman) {
    if (!isPrivateChat(ctx)) {
      return ctx.reply(PICKER_PRIVATE_ONLY);
    }
    setPending(ctx.from.id, {
      kind: "pick",
      rewardId,
      files: snapshotFiles(options),
    });
    return ctx.reply("🎁 Choose Mystery Gift type:", pickerKeyboard(rewardId));
  }

  const result = prepareRewardDelivery({
    adminUserId: ctx.from.id,
    rewardId,
    amountHuman,
    walletFile: options.walletFile,
    rewardsFile: options.rewardsFile,
    deliveryFile: options.deliveryFile,
    env: options.env,
    now: options.now,
    deliveryUrl: options.deliveryUrl,
  });

  if (!result.ok) {
    return ctx.reply(result.error || "Invalid request.");
  }

  const formatted = formatReadyForReward(result);
  return ctx.reply(formatted.text, formatted.extra);
}

function handlePresaleDistribute(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }

  const target = getReplyTargetUser(ctx);
  if (!target) {
    return ctx.reply(USAGE_PRESALE);
  }

  const contribution = findPendingPresaleContribution(target.id, options);
  if (!contribution) {
    return ctx.reply(`No pending presale allocation for ${target.firstName}.`);
  }

  const result = preparePresaleDistribution({
    adminUserId: ctx.from.id,
    telegramUserId: target.id,
    contribution,
    presaleFile: options.presaleFile,
    deliveryFile: options.deliveryFile,
    env: options.env,
    now: options.now,
    deliveryUrl: options.deliveryUrl,
  });

  if (!result.ok) {
    return ctx.reply(result.error || "Invalid request.");
  }

  const formatted = formatReady(result.review, result.url);
  return ctx.reply(formatted.text, formatted.extra);
}

async function replyPrepared(ctx, result) {
  if (!result.ok) {
    return ctx.reply(result.error || "Invalid request.");
  }
  const formatted = formatReadyForReward(result);
  return ctx.reply(formatted.text, formatted.extra);
}

async function handleDeliverCallback(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (typeof ctx.answerCbQuery === "function") {
    try {
      await ctx.answerCbQuery();
    } catch {
      // ignore
    }
  }
  if (!isAdmin(ctx.from.id)) {
    return undefined;
  }
  const data =
    ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";
  const match = /^dlv:([msnoxdg]):([A-Za-z0-9_-]{8,24})$/.exec(data);
  if (!match) {
    return undefined;
  }
  const action = match[1];
  const rewardId = match[2];
  const files = fileOptionsFrom(options, getPending(ctx.from.id));

  if (action === "x") {
    clearPending(ctx.from.id);
    return ctx.reply("Delivery cancelled.");
  }

  if (!isPrivateChat(ctx)) {
    return ctx.reply(PICKER_PRIVATE_ONLY);
  }

  if (action === "d") {
    const result = await markOffchainDelivered({
      adminUserId: ctx.from.id,
      rewardId,
      ...files,
    });
    if (!result.ok) {
      return ctx.reply(result.error || "Invalid request.");
    }
    clearPending(ctx.from.id);
    return ctx.reply("🎁 Off-chain Mystery Gift marked delivered.");
  }

  if (action === "g") {
    const reward = getReward(rewardId, files.rewardsFile);
    if (!reward || !isOffchainRecord(reward)) {
      return ctx.reply("This reward is not an off-chain delivery.");
    }
    setPending(ctx.from.id, {
      kind: "offchain_gift",
      rewardId,
      files: snapshotFiles(files),
    });
    const prompt = formatOffchainPrompt(rewardId);
    return ctx.reply(prompt.text, prompt.extra);
  }

  if (action === "m") {
    setPending(ctx.from.id, {
      kind: "mango_amount",
      rewardId,
      files: snapshotFiles(files),
    });
    return ctx.reply("Send the whole MANGO amount (integers only, commas allowed).");
  }

  if (action === "s") {
    setPending(ctx.from.id, {
      kind: "spl_mint",
      rewardId,
      files: snapshotFiles(files),
    });
    return ctx.reply("Send the SPL token mint address.");
  }

  if (action === "n") {
    setPending(ctx.from.id, {
      kind: "nft_mint",
      rewardId,
      files: snapshotFiles(files),
    });
    return ctx.reply("Send the NFT mint address. Amount is frozen at 1.");
  }

  if (action === "o") {
    const result = prepareRewardDelivery({
      adminUserId: ctx.from.id,
      rewardId,
      assetType: ASSET_OFFCHAIN,
      ...files,
    });
    if (!result.ok) {
      return ctx.reply(result.error || "Invalid request.");
    }
    setPending(ctx.from.id, {
      kind: "offchain_gift",
      rewardId,
      files: snapshotFiles(files),
    });
    const prompt = formatOffchainPrompt(rewardId);
    return ctx.reply(prompt.text, prompt.extra);
  }

  return undefined;
}

function isCommandLike(text) {
  return typeof text === "string" && text.trim().startsWith("/");
}

async function handleDeliverText(ctx, options = {}) {
  if (!ctx || !ctx.from || !isAdmin(ctx.from.id)) {
    return false;
  }
  const pending = getPending(ctx.from.id);
  if (!pending) {
    return false;
  }
  if (!isPrivateChat(ctx)) {
    return false;
  }
  const raw = ctx.message && typeof ctx.message.text === "string" ? ctx.message.text : "";
  if (isCommandLike(raw)) {
    return false;
  }
  const files = fileOptionsFrom(options, pending);

  if (pending.kind === "offchain_gift") {
    const normalized = normalizeOffchainGiftLabel(raw);
    if (!normalized.ok) {
      await ctx.reply(
        normalized.reason === "too-long"
          ? `Gift name is too long (max ${OFFCHAIN_GIFT_LABEL_MAX} characters).`
          : `Send what the gift is (1–${OFFCHAIN_GIFT_LABEL_MAX} characters).`
      );
      return true;
    }
    const saved = setOffchainGiftLabel({
      adminUserId: ctx.from.id,
      rewardId: pending.rewardId,
      label: normalized.label,
      ...files,
    });
    if (!saved.ok) {
      await ctx.reply(saved.error || "Invalid request.");
      return true;
    }
    pending.expiresAt = Date.now() + PENDING_TTL_MS;
    pendingByAdmin.set(String(ctx.from.id), pending);
    const review = formatOffchainReview(saved.reward);
    await ctx.reply(review.text, review.extra);
    return true;
  }

  const text = raw.trim();
  if (!text) {
    return false;
  }

  if (pending.kind === "mango_amount") {
    clearPending(ctx.from.id);
    const result = prepareRewardDelivery({
      adminUserId: ctx.from.id,
      rewardId: pending.rewardId,
      amountHuman: text,
      assetType: ASSET_MANGO,
      ...files,
    });
    await replyPrepared(ctx, result);
    return true;
  }

  if (pending.kind === "spl_mint") {
    const mint = normalizeSolanaPublicKey(text);
    if (!mint) {
      await ctx.reply("Enter a valid Solana mint address.");
      return true;
    }
    setPending(ctx.from.id, {
      kind: "spl_amount",
      rewardId: pending.rewardId,
      mint,
      files: snapshotFiles(files),
    });
    await ctx.reply("Send the token amount.");
    return true;
  }

  if (pending.kind === "spl_amount") {
    const mint = pending.mint;
    clearPending(ctx.from.id);
    const result = await Promise.resolve(
      prepareRewardDelivery({
        adminUserId: ctx.from.id,
        rewardId: pending.rewardId,
        assetType: ASSET_SPL,
        mint,
        amountHuman: text,
        ...files,
      })
    );
    await replyPrepared(ctx, result);
    return true;
  }

  if (pending.kind === "nft_mint") {
    const mint = normalizeSolanaPublicKey(text);
    if (!mint) {
      await ctx.reply("Enter a valid Solana mint address.");
      return true;
    }
    clearPending(ctx.from.id);
    const result = await Promise.resolve(
      prepareRewardDelivery({
        adminUserId: ctx.from.id,
        rewardId: pending.rewardId,
        assetType: ASSET_NFT,
        mint,
        ...files,
      })
    );
    await replyPrepared(ctx, result);
    return true;
  }

  return false;
}

module.exports = (bot) => {
  bot.command("deliver", (ctx) => handleDeliver(ctx));
  bot.command("presaledistribute", (ctx) => handlePresaleDistribute(ctx));
  bot.action(/^dlv:[msnoxdg]:[A-Za-z0-9_-]{8,24}$/, (ctx) =>
    Promise.resolve(handleDeliverCallback(ctx)).catch(() => undefined)
  );
  bot.on("text", (ctx, next) => {
    const continueChain = typeof next === "function" ? next : () => undefined;
    const result = handleDeliverText(ctx);
    if (result && typeof result.then === "function") {
      return result.then((handled) => (handled ? undefined : continueChain()));
    }
    if (result) {
      return undefined;
    }
    return continueChain();
  });
};

module.exports.handleDeliver = handleDeliver;
module.exports.handlePresaleDistribute = handlePresaleDistribute;
module.exports.handleDeliverCallback = handleDeliverCallback;
module.exports.handleDeliverText = handleDeliverText;
module.exports.ADMIN_ONLY = ADMIN_ONLY;
module.exports.USAGE_DELIVER = USAGE_DELIVER;
module.exports.USAGE_PRESALE = USAGE_PRESALE;
module.exports.PICKER_PRIVATE_ONLY = PICKER_PRIVATE_ONLY;
module.exports.OFFCHAIN_GIFT_PROMPT = OFFCHAIN_GIFT_PROMPT;
module.exports.formatReady = formatReady;
module.exports.formatOffchainPrompt = formatOffchainPrompt;
module.exports.formatOffchainReview = formatOffchainReview;
module.exports.pickerKeyboard = pickerKeyboard;
module.exports.shortenWallet = shortenWallet;
module.exports.formatMangoGrouped = formatMangoGrouped;
module.exports.formatMangoHuman = formatMangoHuman;
module.exports.setPendingDeliverInput = setPending;
module.exports.clearPendingDeliverInput = clearPending;
module.exports.getPendingDeliverInput = getPending;
