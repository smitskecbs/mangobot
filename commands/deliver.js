/**
 * Admin-only /deliver and /presaledistribute.
 * Creates a one-time admin delivery session. Does not sign or hold keys.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const { getReplyTargetUser, parseCommandArg } = require("../utils/telegramReplyTarget");
const { shortenWallet, normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const {
  prepareRewardDelivery,
  preparePresaleDistribution,
  listPendingRewardsForAdmin,
  findPendingPresaleContribution,
  markOffchainDelivered,
  isOffchainRecord,
} = require("../services/rewardDelivery");
const { getReward } = require("../services/memberRewards");
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

function offchainKeyboard(rewardId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Mark Delivered", `dlv:d:${rewardId}`)],
    [Markup.button.callback("Cancel", `dlv:x:${rewardId}`)],
  ]);
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
  lines.push("");
  if (offchain) {
    lines.push("Mark delivered after you have sent this gift off-chain.");
    lines.push("Optional: send a delivery note, then tap Mark Delivered.");
  } else {
    lines.push("Sign with the configured distribution wallet.");
    lines.push("The bot never holds private keys.");
  }

  const extra = offchain
    ? offchainKeyboard(review.deliveryId ? review.rewardId : "")
    : deliveryKeyboard(url);
  return { text: lines.join("\n"), extra };
}

function formatReadyForReward(result) {
  const review = {
    ...result.review,
    rewardId: result.reward && result.reward.rewardId,
  };
  if (result.offchain || isOffchainRecord(result.reward) || isOffchainRecord(result.review)) {
    return {
      text: formatReady(review, null).text,
      extra: offchainKeyboard(result.reward && result.reward.rewardId),
    };
  }
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
  const match = /^dlv:([msnoxd]):([A-Za-z0-9_-]{8,24})$/.exec(data);
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
    const pending = getPending(ctx.from.id);
    const note = pending && pending.kind === "offchain_note" ? pending.deliveryNote : "";
    clearPending(ctx.from.id);
    const result = await markOffchainDelivered({
      adminUserId: ctx.from.id,
      rewardId,
      deliveryNote: note || undefined,
      ...files,
    });
    if (!result.ok) {
      return ctx.reply(result.error || "Invalid request.");
    }
    return ctx.reply("🎁 Off-chain Mystery Gift marked delivered.");
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
      kind: "offchain_note",
      rewardId,
      files: snapshotFiles(files),
      deliveryNote: "",
    });
    return replyPrepared(ctx, result);
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
  const text = ctx.message && typeof ctx.message.text === "string" ? ctx.message.text.trim() : "";
  if (!text || isCommandLike(text)) {
    return false;
  }
  const pending = getPending(ctx.from.id);
  if (!pending) {
    return false;
  }
  if (!isPrivateChat(ctx)) {
    return false;
  }
  const files = fileOptionsFrom(options, pending);

  if (pending.kind === "offchain_note") {
    pending.deliveryNote = text.slice(0, 500);
    pending.expiresAt = Date.now() + PENDING_TTL_MS;
    pendingByAdmin.set(String(ctx.from.id), pending);
    await ctx.reply("Delivery note saved. Tap Mark Delivered when the gift has been sent.");
    return true;
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
  bot.action(/^dlv:[msnoxd]:[A-Za-z0-9_-]{8,24}$/, (ctx) =>
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
module.exports.formatReady = formatReady;
module.exports.pickerKeyboard = pickerKeyboard;
module.exports.shortenWallet = shortenWallet;
module.exports.formatMangoGrouped = formatMangoGrouped;
module.exports.formatMangoHuman = formatMangoHuman;
module.exports.setPendingDeliverInput = setPending;
module.exports.clearPendingDeliverInput = clearPending;
module.exports.getPendingDeliverInput = getPending;
