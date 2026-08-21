/**
 * Admin-signed MANGO delivery. Server prepares and verifies. Never signs.
 * Destination is always the frozen walletSnapshot. Single transfer per tx.
 */

const crypto = require("node:crypto");
const { isAdmin } = require("./points");
const { shortenWallet, normalizeSolanaPublicKey } = require("../utils/solanaWallet");
const {
  getReward,
  listRewardsForUser,
  mutateRewardsStore,
  isPlausibleTxSignature,
  markRewardSubmitted,
  markRewardDeliveryReview,
  findRewardIdByTxSignature,
  normalizeOffchainGiftLabel,
  writeOffchainGiftLabel,
} = require("./memberRewards");
const { getPresaleParticipation } = require("./presaleLedger");
const { mutatePresaleStore } = require("./presaleStore");
const { getLatestBlockhash, getTransaction } = require("./presaleRpc");
const { getDeliveryConfig, safeLogReason } = require("./deliveryConfig");
const {
  mutateDeliveryStore,
  loadDeliveryStore,
  pruneExpiredDeliverySessions,
} = require("./deliveryStore");
const { verifyDeliveryTransaction } = require("./deliveryVerify");
const { inspectMint, validateSplMintInfo } = require("./deliveryMintInspect");
const { announceMysteryGiftDelivered } = require("./mysteryGiftAnnounce");
const { notifyMysteryGiftRecipient } = require("./mysteryGiftNotify");
const { log } = require("../utils/logger");
const {
  MANGO_MINT,
  MANGO_MINT_DECIMALS,
  TOKEN_BYTES,
  PURPOSE_REWARD_DELIVERY,
  PURPOSE_PRESALE_DISTRIBUTION,
  DELIVERY_TTL_MS,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEFAULT_DELIVERY_URL,
  ASSET_MANGO,
  ASSET_SPL,
  ASSET_NFT,
  ASSET_OFFCHAIN,
  DELIVERY_TYPE_MANGO_TOKEN,
  DELIVERY_TYPE_OFFCHAIN,
  deliveryMemo,
  formatMangoGrouped,
  formatMangoHuman,
  mangoHumanToBaseUnits,
  humanAmountToBaseUnits,
  parseBaseUnits,
  assetTypeLabel,
  deliveryTypeForAsset,
} = require("./deliveryConstants");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function getDeliveryBaseUrl(options = {}) {
  if (typeof options.deliveryUrl === "string" && options.deliveryUrl.trim()) {
    return options.deliveryUrl.trim().replace(/\/+$/, "");
  }
  return getDeliveryConfig(options.env).deliveryUrl || DEFAULT_DELIVERY_URL;
}

function withDeliveryRpc(options = {}) {
  const config = getDeliveryConfig(options.env);
  const override = typeof options.rpcUrl === "string" ? options.rpcUrl.trim() : "";
  return {
    ...options,
    rpcUrl: override || config.rpcUrl,
  };
}

function publicError(reason) {
  if (reason === "expired") {
    return "This delivery link has expired.";
  }
  if (reason === "disabled") {
    return "Reward delivery is disabled.";
  }
  if (reason === "distribution-wallet-missing") {
    return "Distribution wallet is not configured.";
  }
  if (reason === "unverified") {
    return "This member needs to verify a wallet first.";
  }
  if (reason === "already-sent") {
    return "This reward was already sent.";
  }
  if (reason === "session-active") {
    return "A delivery session is already open for this reward.";
  }
  if (reason === "not-admin") {
    return "This command is admin only.";
  }
  if (reason === "in-flight") {
    return "This delivery is already submitted and waiting for confirmation.";
  }
  if (reason === "gift-required") {
    return "Enter the gift before marking delivered.";
  }
  if (reason === "empty") {
    return "Send what the gift is (1–120 characters).";
  }
  if (reason === "too-long") {
    return "Gift name is too long (max 120 characters).";
  }
  return "Invalid request.";
}

function logDeliveryEvent(event, extra = {}) {
  const label = typeof event === "string" ? event.trim() : "";
  if (!label) {
    return;
  }
  const parts = [`[delivery] ${label}`];
  if (extra.reason) {
    parts.push(`reason=${safeLogReason(extra.reason)}`);
  }
  log(parts.join(" "));
}

function isLikelyTestProcess() {
  for (const arg of process.argv) {
    if (typeof arg !== "string") {
      continue;
    }
    const norm = arg.replace(/\\/g, "/");
    if (norm.includes("/tests/") || /\.test\.js$/i.test(norm)) {
      return true;
    }
  }
  return false;
}

function isDurableDeliveryRecord(record) {
  if (!record || typeof record !== "object") {
    return false;
  }
  if (record.status === "consumed" || record.status === "submitted") {
    return true;
  }
  return typeof record.txSignature === "string" && record.txSignature.length > 0;
}

function findSessionByDeliveryId(store, deliveryId) {
  if (!deliveryId) {
    return null;
  }
  for (const [hash, record] of Object.entries((store && store.sessions) || {})) {
    if (record && record.deliveryId === deliveryId) {
      return { hash, record };
    }
  }
  return null;
}

function deliveryIdIsBound(store, deliveryId) {
  if (!deliveryId || !store || !store.usedSignatures) {
    return false;
  }
  return Object.values(store.usedSignatures).includes(deliveryId);
}

function lookupDeliverySession(rawToken, options = {}) {
  if (typeof rawToken !== "string" || !rawToken || rawToken.length > 128) {
    return { status: "invalid" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(rawToken)) {
    return { status: "invalid" };
  }
  const now = options.now === undefined ? Date.now() : options.now;
  const tokenHash = hashToken(rawToken);
  const store = loadDeliveryStore(options.deliveryFile);
  const record = store.sessions[tokenHash];
  if (!record || typeof record !== "object") {
    return { status: "invalid", tokenHash };
  }
  if (
    record.purpose !== PURPOSE_REWARD_DELIVERY &&
    record.purpose !== PURPOSE_PRESALE_DISTRIBUTION
  ) {
    return { status: "wrong-purpose", tokenHash };
  }
  if (typeof record.expiresAt !== "number" || record.expiresAt <= now) {
    return { status: "expired", tokenHash, record };
  }
  return { status: "ok", tokenHash, record };
}

function findActiveSessionForTarget(store, kind, targetId) {
  for (const [hash, record] of Object.entries(store.sessions || {})) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (record.status === "consumed") {
      continue;
    }
    if (record.kind !== kind) {
      continue;
    }
    if (kind === "reward" && record.rewardId === targetId) {
      return { hash, record };
    }
    if (kind === "presale" && record.contributionId === targetId) {
      return { hash, record };
    }
  }
  return null;
}

function isOffchainRecord(record) {
  if (!record || typeof record !== "object") {
    return false;
  }
  return record.assetType === ASSET_OFFCHAIN || record.deliveryType === DELIVERY_TYPE_OFFCHAIN;
}

function normalizeAssetType(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === ASSET_SPL || raw === ASSET_NFT || raw === ASSET_OFFCHAIN || raw === ASSET_MANGO) {
    return raw;
  }
  return null;
}

function formatBaseUnitsHuman(baseUnits, decimals) {
  const parsed = parseBaseUnits(baseUnits);
  const dec = Number(decimals);
  if (!parsed.ok || !Number.isInteger(dec) || dec < 0 || dec > 18) {
    return "0";
  }
  const scale = 10n ** BigInt(dec);
  const value = BigInt(parsed.lamports);
  const whole = value / scale;
  const frac = value % scale;
  if (frac === 0n) {
    return whole.toString();
  }
  return `${whole.toString()}.${frac.toString().padStart(dec, "0").replace(/0+$/, "")}`;
}

function sessionAssetFields(plan = {}) {
  const assetType = plan.assetType || ASSET_MANGO;
  const decimals = Number.isInteger(plan.decimals) ? plan.decimals : MANGO_MINT_DECIMALS;
  return {
    mint: plan.mint || MANGO_MINT,
    decimals,
    tokenProgram: plan.tokenProgram || TOKEN_PROGRAM_ID,
    assetType,
    deliveryType: plan.deliveryType || deliveryTypeForAsset(assetType),
    assetLabel: plan.assetLabel || assetTypeLabel(assetType),
    amountHuman: plan.amountHuman || null,
  };
}

function createSessionRecord({
  purpose,
  kind,
  rewardId,
  contributionId,
  telegramUserId,
  destination,
  amountBaseUnits,
  expectedSigner,
  createdBy,
  now,
  expiresAt,
  deliveryId,
  mint,
  decimals,
  tokenProgram,
  assetType,
  deliveryType,
  assetLabel,
  amountHuman,
}) {
  const assets = sessionAssetFields({
    mint,
    decimals,
    tokenProgram,
    assetType,
    deliveryType,
    assetLabel,
    amountHuman,
  });
  return {
    purpose,
    kind,
    rewardId: rewardId || null,
    contributionId: contributionId || null,
    telegramUserId: String(telegramUserId),
    destination,
    amountBaseUnits,
    expectedSigner,
    createdBy: createdBy === undefined ? null : String(createdBy),
    createdAt: now,
    expiresAt,
    deliveryId,
    status: "open",
    recentBlockhash: null,
    lastValidBlockHeight: null,
    ...assets,
  };
}

function reviewPayload(record) {
  const assetType = (record && record.assetType) || ASSET_MANGO;
  const mint = normalizeSolanaPublicKey(record && record.mint) || (isOffchainRecord(record) ? null : MANGO_MINT);
  const decimals = Number.isInteger(record && record.decimals)
    ? record.decimals
    : isOffchainRecord(record)
      ? null
      : MANGO_MINT_DECIMALS;
  const tokenProgram = (record && record.tokenProgram) || (isOffchainRecord(record) ? null : TOKEN_PROGRAM_ID);
  const asset = (record && record.assetLabel) || assetTypeLabel(assetType);
  let human = record && record.amountHuman;
  if (!human && record && record.amountBaseUnits && Number.isInteger(decimals)) {
    human =
      assetType === ASSET_MANGO
        ? formatMangoHuman(record.amountBaseUnits, decimals)
        : formatBaseUnitsHuman(record.amountBaseUnits, decimals);
  }
  if (!human) {
    human = isOffchainRecord(record) ? "" : "0";
  }
  const amountDisplay =
    assetType === ASSET_MANGO ? formatMangoGrouped(human) : human;
  const typeLabel =
    record.kind === "presale"
      ? "Presale Allocation"
      : record.rewardType === "airdrop"
        ? "Airdrop"
        : record.rewardType === "nft"
          ? "NFT"
          : "Mystery Gift";
  return {
    typeLabel,
    kind: record.kind,
    destination: record.destination,
    destinationShort: shortenWallet(record.destination),
    asset,
    assetType,
    assetTypeLabel: assetTypeLabel(assetType),
    deliveryType: (record && record.deliveryType) || deliveryTypeForAsset(assetType),
    amountHuman: human,
    amountDisplay,
    amountBaseUnits: record.amountBaseUnits,
    mint,
    mintShort: mint ? shortenWallet(mint) : "",
    expectedSigner: record.expectedSigner,
    expectedSignerShort: shortenWallet(record.expectedSigner),
    memo: record.deliveryId ? deliveryMemo(record.deliveryId) : "",
    deliveryId: record.deliveryId || null,
    tokenProgram,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    decimals,
  };
}

function expectedFromRecord(record, extras = {}) {
  const source = record && typeof record === "object" ? record : {};
  return {
    expectedSigner: normalizeSolanaPublicKey(source.expectedSigner || extras.expectedSigner),
    destinationOwner: normalizeSolanaPublicKey(
      source.destination || source.walletSnapshot || extras.destinationOwner
    ),
    mint: normalizeSolanaPublicKey(source.mint) || MANGO_MINT,
    amountBaseUnits: source.amountBaseUnits,
    memo: deliveryMemo(source.deliveryId),
    createdAt: source.createdAt || extras.createdAt,
    tokenProgram: source.tokenProgram || TOKEN_PROGRAM_ID,
  };
}

function applyRewardPlan(store, rewardId, plan) {
  const record = store.rewards[rewardId];
  if (!record || typeof record !== "object") {
    return { ok: false, reason: "missing" };
  }
  if (record.status === "sent" || record.status === "cancelled") {
    return { ok: false, reason: "already-sent" };
  }
  if (record.status === "submitted") {
    return { ok: false, reason: "in-flight" };
  }
  const assetType = plan.assetType || ASSET_MANGO;
  record.deliveryType = plan.deliveryType || deliveryTypeForAsset(assetType);
  record.assetType = assetType;
  record.assetLabel = plan.assetLabel || assetTypeLabel(assetType);
  if (assetType === ASSET_OFFCHAIN) {
    record.mint = null;
    record.decimals = null;
    record.tokenProgram = null;
    record.amountBaseUnits = null;
  } else {
    record.mint = plan.mint || MANGO_MINT;
    record.decimals = Number.isInteger(plan.decimals) ? plan.decimals : MANGO_MINT_DECIMALS;
    record.tokenProgram = plan.tokenProgram || TOKEN_PROGRAM_ID;
    record.amountBaseUnits = plan.amountBaseUnits;
  }
  record.deliveryId = plan.deliveryId;
  record.status = "delivery-ready";
  return { ok: true, reward: { ...record, rewardId } };
}

function gatePrepareReward(input = {}) {
  if (!isAdmin(input.adminUserId)) {
    return { ok: false, reason: "not-admin", error: publicError("not-admin") };
  }
  const config = getDeliveryConfig(input.env);
  if (!config.rewardDeliveryEnabled) {
    return { ok: false, reason: "disabled", error: publicError("disabled") };
  }
  if (!config.distributionWallet) {
    return {
      ok: false,
      reason: "distribution-wallet-missing",
      error: publicError("distribution-wallet-missing"),
    };
  }
  if (normalizeAssetType(input.assetType) !== ASSET_OFFCHAIN && !config.rpcUrl && !input.rpcUrl) {
    return { ok: false, reason: "rpc-missing", error: publicError("disabled") };
  }

  const rewardId = typeof input.rewardId === "string" ? input.rewardId.trim() : "";
  const reward = getReward(rewardId, input.rewardsFile);
  if (!reward) {
    return { ok: false, reason: "missing", error: publicError("invalid") };
  }
  if (reward.status === "sent" || reward.status === "cancelled") {
    return { ok: false, reason: "already-sent", error: publicError("already-sent") };
  }
  if (reward.status === "submitted") {
    return { ok: false, reason: "in-flight", error: publicError("in-flight") };
  }

  const destination = normalizeSolanaPublicKey(reward.walletSnapshot);
  if (!destination) {
    return { ok: false, reason: "unverified", error: publicError("unverified") };
  }
  return { ok: true, config, rewardId, reward, destination };
}

function resolvePrepareAssetType(input, reward) {
  const requested = normalizeAssetType(input.assetType);
  if (requested) {
    return requested;
  }
  if (reward && reward.amountBaseUnits && reward.assetType) {
    return normalizeAssetType(reward.assetType) || ASSET_MANGO;
  }
  return ASSET_MANGO;
}

function commitOnchainRewardSession(input, ctx, plan) {
  const now = input.now === undefined ? Date.now() : input.now;
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const deliveryId =
    typeof ctx.reward.deliveryId === "string" && ctx.reward.deliveryId.trim()
      ? ctx.reward.deliveryId.trim()
      : crypto.randomBytes(8).toString("hex");
  const expiresAt = now + DELIVERY_TTL_MS;

  const sessionResult = mutateDeliveryStore((store) => {
    pruneExpiredDeliverySessions(store, now);
    if (deliveryIdIsBound(store, deliveryId)) {
      return { ok: false, reason: "in-flight" };
    }
    const existing = findActiveSessionForTarget(store, "reward", ctx.rewardId);
    if (existing) {
      return { ok: false, reason: "session-active" };
    }
    store.sessions[tokenHash] = createSessionRecord({
      purpose: PURPOSE_REWARD_DELIVERY,
      kind: "reward",
      rewardId: ctx.rewardId,
      telegramUserId: ctx.reward.telegramUserId,
      destination: ctx.destination,
      amountBaseUnits: plan.amountBaseUnits,
      expectedSigner: ctx.config.distributionWallet,
      createdBy: input.adminUserId,
      now,
      expiresAt,
      deliveryId,
      mint: plan.mint,
      decimals: plan.decimals,
      tokenProgram: plan.tokenProgram,
      assetType: plan.assetType,
      deliveryType: plan.deliveryType,
      assetLabel: plan.assetLabel,
      amountHuman: plan.amountHuman,
    });
    store.sessions[tokenHash].rewardType = ctx.reward.type;
    return { ok: true };
  }, input.deliveryFile);

  if (!sessionResult.ok) {
    return {
      ok: false,
      reason: sessionResult.reason,
      error: publicError(sessionResult.reason),
    };
  }

  const planned = mutateRewardsStore((store) => {
    return applyRewardPlan(store, ctx.rewardId, {
      amountBaseUnits: plan.amountBaseUnits,
      deliveryId,
      mint: plan.mint,
      decimals: plan.decimals,
      tokenProgram: plan.tokenProgram,
      assetType: plan.assetType,
      deliveryType: plan.deliveryType,
      assetLabel: plan.assetLabel,
    });
  }, input.rewardsFile);

  if (!planned.ok) {
    mutateDeliveryStore((store) => {
      delete store.sessions[tokenHash];
    }, input.deliveryFile);
    return { ok: false, reason: planned.reason, error: publicError(planned.reason) };
  }

  const url = `${getDeliveryBaseUrl(input)}/${encodeURIComponent(rawToken)}`;
  return {
    ok: true,
    token: rawToken,
    url,
    expiresAt,
    reward: getReward(ctx.rewardId, input.rewardsFile),
    review: reviewPayload({
      kind: "reward",
      rewardType: ctx.reward.type,
      destination: ctx.destination,
      amountBaseUnits: plan.amountBaseUnits,
      expectedSigner: ctx.config.distributionWallet,
      deliveryId,
      mint: plan.mint,
      decimals: plan.decimals,
      tokenProgram: plan.tokenProgram,
      assetType: plan.assetType,
      deliveryType: plan.deliveryType,
      assetLabel: plan.assetLabel,
      amountHuman: plan.amountHuman,
    }),
  };
}

function prepareMangoRewardDelivery(input, ctx) {
  if (!ctx.config.rpcUrl && !input.rpcUrl) {
    return { ok: false, reason: "rpc-missing", error: publicError("disabled") };
  }
  let amount;
  let amountHuman;
  if (ctx.reward.amountBaseUnits) {
    amount = parseBaseUnits(ctx.reward.amountBaseUnits);
    if (!amount.ok || BigInt(amount.lamports) <= 0n) {
      return { ok: false, reason: "invalid-amount", error: publicError("invalid") };
    }
    amount = { ok: true, baseUnits: amount.lamports, human: formatMangoHuman(amount.lamports) };
    amountHuman = amount.human;
  } else {
    amount = mangoHumanToBaseUnits(input.amountHuman);
    if (!amount.ok) {
      return { ok: false, reason: "invalid-amount", error: "Use /deliver <rewardId> <mangoAmount>." };
    }
    amountHuman = amount.human;
  }

  return commitOnchainRewardSession(input, ctx, {
    amountBaseUnits: amount.baseUnits,
    amountHuman,
    mint: MANGO_MINT,
    decimals: MANGO_MINT_DECIMALS,
    tokenProgram: TOKEN_PROGRAM_ID,
    assetType: ASSET_MANGO,
    deliveryType: DELIVERY_TYPE_MANGO_TOKEN,
    assetLabel: "MANGO",
  });
}

async function prepareTokenAssetDelivery(input, ctx, assetType) {
  if (!ctx.config.rpcUrl && !input.rpcUrl) {
    return { ok: false, reason: "rpc-missing", error: publicError("disabled") };
  }
  const expectNft = assetType === ASSET_NFT;
  let mint;
  let decimals;
  let tokenProgram;
  let amountBaseUnits;
  let amountHuman;
  let assetLabel;

  const frozen =
    ctx.reward.amountBaseUnits &&
    ctx.reward.mint &&
    (ctx.reward.assetType === assetType || (!ctx.reward.assetType && !input.mint));

  if (frozen && ctx.reward.assetType === assetType) {
    mint = normalizeSolanaPublicKey(ctx.reward.mint);
    decimals = Number.isInteger(ctx.reward.decimals) ? ctx.reward.decimals : expectNft ? 0 : null;
    tokenProgram = ctx.reward.tokenProgram || TOKEN_PROGRAM_ID;
    amountBaseUnits = String(ctx.reward.amountBaseUnits);
    amountHuman = expectNft ? "1" : formatBaseUnitsHuman(amountBaseUnits, decimals);
    assetLabel = ctx.reward.assetLabel || assetTypeLabel(assetType);
    if (!mint || !Number.isInteger(decimals)) {
      return { ok: false, reason: "invalid-mint", error: "Enter a valid Solana mint address." };
    }
  } else {
    mint = normalizeSolanaPublicKey(input.mint);
    if (!mint) {
      return { ok: false, reason: "invalid-mint", error: "Enter a valid Solana mint address." };
    }
    const inspectFn = typeof input.inspectMint === "function" ? input.inspectMint : inspectMint;
    const inspectRpcUrl =
      (typeof input.rpcUrl === "string" && input.rpcUrl.trim()) || ctx.config.rpcUrl;
    const info = await inspectFn(mint, {
      sourceOwner: ctx.config.distributionWallet,
      expectNft,
      rpcUrl: inspectRpcUrl,
      env: input.env,
    });
    if (!info || !info.ok) {
      return {
        ok: false,
        reason: (info && info.reason) || "invalid-mint",
        error: (info && info.error) || "This mint could not be loaded.",
      };
    }
    if (expectNft) {
      amountBaseUnits = "1";
      amountHuman = "1";
    } else {
      const converted = humanAmountToBaseUnits(input.amountHuman, info.decimals);
      if (!converted.ok) {
        return { ok: false, reason: "invalid-amount", error: "Enter a valid token amount." };
      }
      amountBaseUnits = converted.baseUnits;
      amountHuman = converted.human;
    }
    const validated = validateSplMintInfo(info, { amountBaseUnits, expectNft });
    if (!validated.ok) {
      return {
        ok: false,
        reason: validated.reason,
        error: validated.error,
      };
    }
    decimals = info.decimals;
    tokenProgram = info.tokenProgram || TOKEN_PROGRAM_ID;
    assetLabel = expectNft ? "NFT" : assetTypeLabel(ASSET_SPL);
  }

  return commitOnchainRewardSession(input, ctx, {
    amountBaseUnits,
    amountHuman,
    mint,
    decimals,
    tokenProgram,
    assetType,
    deliveryType: deliveryTypeForAsset(assetType),
    assetLabel,
  });
}

function prepareOffchainRewardDelivery(input, ctx) {
  const now = input.now === undefined ? Date.now() : input.now;
  const deliveryId =
    typeof ctx.reward.deliveryId === "string" && ctx.reward.deliveryId.trim()
      ? ctx.reward.deliveryId.trim()
      : crypto.randomBytes(8).toString("hex");

  const sessionGuard = mutateDeliveryStore((store) => {
    pruneExpiredDeliverySessions(store, now);
    const existing = findActiveSessionForTarget(store, "reward", ctx.rewardId);
    if (existing) {
      return { ok: false, reason: "session-active" };
    }
    return { ok: true };
  }, input.deliveryFile);

  if (!sessionGuard.ok) {
    return {
      ok: false,
      reason: sessionGuard.reason,
      error: publicError(sessionGuard.reason),
    };
  }

  const planned = mutateRewardsStore((store) => {
    return applyRewardPlan(store, ctx.rewardId, {
      deliveryId,
      assetType: ASSET_OFFCHAIN,
      deliveryType: DELIVERY_TYPE_OFFCHAIN,
      assetLabel: "Off-chain",
    });
  }, input.rewardsFile);

  if (!planned.ok) {
    return { ok: false, reason: planned.reason, error: publicError(planned.reason) };
  }

  return {
    ok: true,
    token: null,
    url: null,
    expiresAt: null,
    offchain: true,
    reward: getReward(ctx.rewardId, input.rewardsFile),
    review: reviewPayload({
      kind: "reward",
      rewardType: ctx.reward.type,
      destination: ctx.destination,
      expectedSigner: ctx.config.distributionWallet,
      deliveryId,
      assetType: ASSET_OFFCHAIN,
      deliveryType: DELIVERY_TYPE_OFFCHAIN,
      assetLabel: "Off-chain",
      amountBaseUnits: null,
      mint: null,
      decimals: null,
      tokenProgram: null,
    }),
  };
}

function prepareRewardDelivery(input = {}) {
  const gated = gatePrepareReward(input);
  if (!gated.ok) {
    return gated;
  }
  const assetType = resolvePrepareAssetType(input, gated.reward);
  if (assetType === ASSET_SPL || assetType === ASSET_NFT) {
    return prepareTokenAssetDelivery(input, gated, assetType);
  }
  if (assetType === ASSET_OFFCHAIN) {
    return prepareOffchainRewardDelivery(input, gated);
  }
  return prepareMangoRewardDelivery(input, gated);
}

function findPendingPresaleContribution(userId, options = {}) {
  const participation = getPresaleParticipation(
    userId,
    options.presaleFile,
    options.now,
    options.currentBlockHeight
  );
  const list = Array.isArray(participation.contributions) ? participation.contributions : [];
  return (
    list.find(
      (item) =>
        item &&
        (item.distributionStatus === "pending" || !item.distributionStatus) &&
        parseBaseUnits(item.mangoAllocationBaseUnits).ok
    ) || null
  );
}

function preparePresaleDistribution(input = {}) {
  if (!isAdmin(input.adminUserId)) {
    return { ok: false, reason: "not-admin", error: publicError("not-admin") };
  }
  const config = getDeliveryConfig(input.env);
  if (!config.presaleDistributionEnabled) {
    return { ok: false, reason: "disabled", error: "Presale distribution is disabled." };
  }
  if (!config.distributionWallet) {
    return {
      ok: false,
      reason: "distribution-wallet-missing",
      error: publicError("distribution-wallet-missing"),
    };
  }

  const contribution =
    input.contribution ||
    findPendingPresaleContribution(input.telegramUserId, input);
  if (!contribution) {
    return { ok: false, reason: "missing", error: "No pending presale allocation to deliver." };
  }
  if (contribution.distributionStatus === "sent") {
    return { ok: false, reason: "already-sent", error: publicError("already-sent") };
  }
  const destination = normalizeSolanaPublicKey(contribution.walletSnapshot);
  if (!destination) {
    return { ok: false, reason: "unverified", error: publicError("unverified") };
  }
  const amount = parseBaseUnits(contribution.mangoAllocationBaseUnits);
  if (!amount.ok || BigInt(amount.lamports) <= 0n) {
    return { ok: false, reason: "invalid-amount", error: publicError("invalid") };
  }

  const now = input.now === undefined ? Date.now() : input.now;
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const deliveryId = crypto.randomBytes(8).toString("hex");
  const expiresAt = now + DELIVERY_TTL_MS;
  const contributionId = String(contribution.id);

  const sessionResult = mutateDeliveryStore((store) => {
    pruneExpiredDeliverySessions(store, now);
    const existing = findActiveSessionForTarget(store, "presale", contributionId);
    if (existing) {
      return { ok: false, reason: "session-active" };
    }
    store.sessions[tokenHash] = createSessionRecord({
      purpose: PURPOSE_PRESALE_DISTRIBUTION,
      kind: "presale",
      contributionId,
      telegramUserId: input.telegramUserId,
      destination,
      amountBaseUnits: amount.lamports,
      expectedSigner: config.distributionWallet,
      createdBy: input.adminUserId,
      now,
      expiresAt,
      deliveryId,
    });
    return { ok: true };
  }, input.deliveryFile);

  if (!sessionResult.ok) {
    return {
      ok: false,
      reason: sessionResult.reason,
      error: publicError(sessionResult.reason),
    };
  }

  const url = `${getDeliveryBaseUrl(input)}/${encodeURIComponent(rawToken)}`;
  return {
    ok: true,
    token: rawToken,
    url,
    expiresAt,
    contributionId,
    review: reviewPayload({
      kind: "presale",
      destination,
      amountBaseUnits: amount.lamports,
      expectedSigner: config.distributionWallet,
      deliveryId,
    }),
  };
}

function publicDeliveryState(record, reward) {
  if (reward && reward.status === "sent") {
    return "sent";
  }
  if (record && record.status === "consumed") {
    return "sent";
  }
  if ((reward && reward.deliveryReview === "manual") || (record && record.status === "failed")) {
    return "failed";
  }
  if (
    (record && record.status === "submitted") ||
    (reward && reward.status === "submitted")
  ) {
    return "submitted";
  }
  if (record && record.status === "payment-ready") {
    return "payment-ready";
  }
  return "open";
}

function publicStatusForSession(record, extra = {}) {
  const review = reviewPayload(record);
  const reward = extra.reward || null;
  return {
    ok: true,
    ...review,
    from: record.expectedSigner,
    to: record.destination,
    fromShort: review.expectedSignerShort,
    toShort: review.destinationShort,
    expiresAt: record.expiresAt,
    recentBlockhash: record.recentBlockhash || null,
    lastValidBlockHeight:
      record.lastValidBlockHeight === undefined ? null : record.lastValidBlockHeight,
    network: "mainnet-beta",
    deliveryState: publicDeliveryState(record, reward),
    hasSignature: Boolean(
      (record && record.txSignature) || (reward && reward.txSignature)
    ),
  };
}

async function issueDeliveryPayment(rawToken, options = {}) {
  const session = lookupDeliverySession(rawToken, options);
  if (session.status === "expired") {
    return { ok: false, reason: "expired", error: publicError("expired") };
  }
  if (session.status !== "ok") {
    return { ok: false, reason: "invalid", error: publicError("invalid") };
  }
  if (isOffchainRecord(session.record)) {
    return {
      ok: false,
      reason: "offchain",
      error: "This delivery is off-chain and cannot be signed.",
    };
  }
  if (session.record.status === "consumed" || session.record.status === "submitted") {
    return { ok: false, reason: "in-flight", error: publicError("in-flight") };
  }
  if (options.connectedWallet) {
    const connected = normalizeSolanaPublicKey(options.connectedWallet);
    if (connected && connected !== session.record.expectedSigner) {
      return { ok: false, reason: "wrong-signer", error: publicError("invalid") };
    }
  }

  const hashResult = await getLatestBlockhash(withDeliveryRpc(options));
  if (!hashResult.ok) {
    return {
      ok: false,
      reason: hashResult.reason || "rpc-error",
      error: "Delivery is temporarily unavailable.",
    };
  }

  const bound = mutateDeliveryStore((store) => {
    const record = store.sessions[session.tokenHash];
    if (!record || record.status === "consumed" || record.status === "submitted") {
      return { ok: false, reason: "invalid" };
    }
    record.recentBlockhash = hashResult.blockhash;
    record.lastValidBlockHeight = hashResult.lastValidBlockHeight;
    record.status = "payment-ready";
    return { ok: true, record };
  }, options.deliveryFile);

  if (!bound.ok) {
    return { ok: false, reason: bound.reason, error: publicError(bound.reason) };
  }
  return {
    ...publicStatusForSession(bound.record),
    recentBlockhash: hashResult.blockhash,
    lastValidBlockHeight: hashResult.lastValidBlockHeight,
  };
}

function ignoreClientOverrides(body, record) {
  if (!body || typeof body !== "object") {
    return { ok: true };
  }
  const dest = normalizeSolanaPublicKey(body.destination || body.to || body.wallet);
  if (dest && dest !== record.destination) {
    return { ok: false, reason: "wrong-destination" };
  }
  const sessionMint = normalizeSolanaPublicKey(record.mint) || MANGO_MINT;
  const mint = normalizeSolanaPublicKey(body.mint);
  if (mint && mint !== sessionMint) {
    return { ok: false, reason: "wrong-mint" };
  }
  if (body.amountBaseUnits !== undefined && String(body.amountBaseUnits) !== String(record.amountBaseUnits)) {
    return { ok: false, reason: "wrong-amount" };
  }
  if (body.assetType !== undefined && body.assetType !== "" && body.assetType !== (record.assetType || ASSET_MANGO)) {
    return { ok: false, reason: "wrong-asset" };
  }
  if (body.decimals !== undefined && body.decimals !== null && body.decimals !== "") {
    const sessionDecimals = Number.isInteger(record.decimals) ? record.decimals : MANGO_MINT_DECIMALS;
    if (Number(body.decimals) !== sessionDecimals) {
      return { ok: false, reason: "wrong-decimals" };
    }
  }
  if (body.tokenProgram) {
    const sessionProgram = record.tokenProgram || TOKEN_PROGRAM_ID;
    if (String(body.tokenProgram) !== String(sessionProgram)) {
      return { ok: false, reason: "wrong-token-program" };
    }
  }
  return { ok: true };
}

function completeRewardSent(rewardId, signature, now, rewardsFile) {
  return mutateRewardsStore((store) => {
    const record = store.rewards[rewardId];
    if (!record || typeof record !== "object") {
      return { ok: false, reason: "missing" };
    }
    if (record.status === "sent") {
      if (record.txSignature === signature) {
        return { ok: true, idempotent: true, reward: { ...record, rewardId } };
      }
      return { ok: false, reason: "already-sent" };
    }
    if (record.status === "cancelled") {
      return { ok: false, reason: "already-sent" };
    }
    record.status = "sent";
    record.txSignature = signature;
    record.sentAt = now;
    return { ok: true, reward: { ...record, rewardId } };
  }, rewardsFile);
}

async function maybeNotifyMysteryGiftSent(reward, options = {}) {
  if (!reward || reward.type !== "mystery-gift" || reward.status !== "sent") {
    return;
  }
  const test = isLikelyTestProcess();
  try {
    if (!test || options.notifyMysteryGift === true) {
      await notifyMysteryGiftRecipient(reward.rewardId, options);
    }
  } catch {
    // Notification must never roll back sent status.
  }
  try {
    if (!test || options.announceMysteryGift === true) {
      await announceMysteryGiftDelivered(reward.rewardId, options);
    }
  } catch {
    // Announcement must never roll back sent status.
  }
}

function completePresaleSent(contributionId, signature, now, presaleFile, telegramUserId) {
  return mutatePresaleStore((store) => {
    const uid = String(telegramUserId);
    const user = store.users && store.users[uid];
    const list = user && Array.isArray(user.contributions) ? user.contributions : [];
    const contribution = list.find((item) => item && String(item.id) === String(contributionId));
    if (!contribution) {
      return { ok: false, reason: "missing" };
    }
    if (contribution.distributionStatus === "sent") {
      if (contribution.distributionTxSignature === signature) {
        return { ok: true, idempotent: true, contribution };
      }
      return { ok: false, reason: "already-sent" };
    }
    contribution.distributionStatus = "sent";
    contribution.distributionTxSignature = signature;
    contribution.distributedAt = now;
    return { ok: true, contribution };
  }, presaleFile);
}

function isPendingRpcResult(rpc) {
  if (!rpc) {
    return true;
  }
  if (!rpc.ok) {
    return (
      rpc.reason === "rpc-missing" ||
      rpc.reason === "rpc-timeout" ||
      rpc.reason === "rpc-network" ||
      rpc.reason === "rpc-json" ||
      rpc.reason === "rpc-error"
    );
  }
  return rpc.result == null;
}

function bindDeliverySignature(signature, deliveryId, tokenHash, now, deliveryFile, consume) {
  return mutateDeliveryStore((locked) => {
    const previous = locked.usedSignatures[signature];
    if (previous && previous !== deliveryId) {
      return { ok: false, reason: "duplicate-signature" };
    }
    locked.usedSignatures[signature] = deliveryId;
    let record = tokenHash ? locked.sessions[tokenHash] : null;
    if (!record) {
      const found = findSessionByDeliveryId(locked, deliveryId);
      record = found && found.record;
    }
    if (record) {
      record.txSignature = signature;
      if (consume) {
        record.status = "consumed";
        record.consumedAt = now;
      } else if (record.status !== "consumed") {
        record.status = "submitted";
        if (!record.submittedAt) {
          record.submittedAt = now;
        }
      }
    }
    return { ok: true };
  }, deliveryFile);
}

async function finalizeVerifiedReward({
  rewardId,
  signature,
  deliveryId,
  tokenHash,
  expected,
  now,
  options,
}) {
  const rpc = await getTransaction(signature, withDeliveryRpc(options));
  if (isPendingRpcResult(rpc)) {
    logDeliveryEvent("confirm pending", { reason: (rpc && rpc.reason) || "not-finalized" });
    return {
      ok: true,
      pending: true,
      status: "pending",
      reason: (rpc && rpc.reason) || "not-finalized",
      deliveryState: "submitted",
      kind: "reward",
      signature,
    };
  }

  const verified = verifyDeliveryTransaction(rpc.result, expected);
  if (!verified.ok) {
    markRewardDeliveryReview(rewardId, verified.reason, { rewardsFile: options.rewardsFile });
    return {
      ok: false,
      reason: verified.reason,
      error: verified.error,
      status: "failed",
      deliveryState: "failed",
    };
  }

  logDeliveryEvent("reconcile verified");
  const done = completeRewardSent(rewardId, signature, now, options.rewardsFile);
  if (!done.ok) {
    return { ok: false, reason: done.reason, error: publicError(done.reason) };
  }
  bindDeliverySignature(signature, deliveryId, tokenHash, now, options.deliveryFile, true);
  logDeliveryEvent("reward sent");
  await maybeNotifyMysteryGiftSent(done.reward, options);
  return {
    ok: true,
    signature,
    kind: "reward",
    idempotent: Boolean(done.idempotent),
    status: "sent",
    deliveryState: "sent",
  };
}

async function confirmPresaleDelivery(session, signature, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const store = loadDeliveryStore(options.deliveryFile);
  if (store.usedSignatures[signature]) {
    const previous = store.usedSignatures[signature];
    if (previous === session.record.deliveryId) {
      return { ok: true, idempotent: true, signature, kind: "presale" };
    }
    return { ok: false, reason: "duplicate-signature", error: publicError("invalid") };
  }

  const rpc = await getTransaction(signature, withDeliveryRpc(options));
  if (!rpc.ok || rpc.result == null) {
    return {
      ok: false,
      reason: (rpc && rpc.reason) || "rpc-error",
      error: "This transaction could not be verified.",
    };
  }
  const verified = verifyDeliveryTransaction(rpc.result, {
    ...expectedFromRecord(session.record),
    mint: MANGO_MINT,
    tokenProgram: TOKEN_PROGRAM_ID,
    createdAt: session.record.createdAt,
  });
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, error: verified.error };
  }

  const claimed = mutateDeliveryStore((locked) => {
    if (locked.usedSignatures[signature] && locked.usedSignatures[signature] !== session.record.deliveryId) {
      return { ok: false, reason: "duplicate-signature" };
    }
    const record = locked.sessions[session.tokenHash];
    if (!record) {
      return { ok: false, reason: "invalid" };
    }
    locked.usedSignatures[signature] = record.deliveryId;
    record.status = "consumed";
    record.txSignature = signature;
    record.consumedAt = now;
    return { ok: true, record };
  }, options.deliveryFile);

  if (!claimed.ok) {
    return { ok: false, reason: claimed.reason, error: publicError(claimed.reason) };
  }

  const done = completePresaleSent(
    session.record.contributionId,
    signature,
    now,
    options.presaleFile,
    session.record.telegramUserId
  );
  if (!done.ok) {
    return { ok: false, reason: done.reason, error: publicError(done.reason) };
  }
  return { ok: true, signature, kind: "presale", idempotent: Boolean(done.idempotent) };
}

async function confirmRewardSession(session, signature, options = {}) {
  const record = session.record;
  const rewardId = record.rewardId;
  const now = options.now === undefined ? Date.now() : options.now;
  const existing = getReward(rewardId, options.rewardsFile);
  if (!existing) {
    return { ok: false, reason: "missing", error: publicError("invalid") };
  }
  if (existing.status === "sent") {
    if (existing.txSignature === signature) {
      await maybeNotifyMysteryGiftSent(existing, options);
      bindDeliverySignature(signature, record.deliveryId, session.tokenHash, now, options.deliveryFile, true);
      return {
        ok: true,
        idempotent: true,
        signature,
        kind: "reward",
        status: "sent",
        deliveryState: "sent",
      };
    }
    return { ok: false, reason: "already-sent", error: publicError("already-sent") };
  }

  const other = findRewardIdByTxSignature(signature, options.rewardsFile);
  if (other && other !== rewardId) {
    return { ok: false, reason: "duplicate-signature", error: publicError("invalid") };
  }
  const store = loadDeliveryStore(options.deliveryFile);
  if (store.usedSignatures[signature] && store.usedSignatures[signature] !== record.deliveryId) {
    return { ok: false, reason: "duplicate-signature", error: publicError("invalid") };
  }

  const submitted = markRewardSubmitted(rewardId, signature, {
    rewardsFile: options.rewardsFile,
    now,
  });
  if (!submitted.ok) {
    return { ok: false, reason: submitted.reason, error: publicError(submitted.reason) };
  }
  if (submitted.alreadySent) {
    await maybeNotifyMysteryGiftSent(submitted.reward, options);
    return {
      ok: true,
      idempotent: true,
      signature,
      kind: "reward",
      status: "sent",
      deliveryState: "sent",
    };
  }

  const bound = bindDeliverySignature(
    signature,
    record.deliveryId,
    session.tokenHash,
    now,
    options.deliveryFile,
    false
  );
  if (!bound.ok) {
    return { ok: false, reason: bound.reason, error: publicError(bound.reason) };
  }
  logDeliveryEvent("submitted");

  return finalizeVerifiedReward({
    rewardId,
    signature,
    deliveryId: record.deliveryId,
    tokenHash: session.tokenHash,
    expected: expectedFromRecord(record, {
      createdAt: record.createdAt || existing.createdAt,
    }),
    now,
    options,
  });
}

async function confirmDelivery(rawToken, signature, options = {}) {
  const session = lookupDeliverySession(rawToken, options);
  if (session.status === "invalid" || session.status === "wrong-purpose") {
    return { ok: false, reason: session.status, error: publicError("invalid") };
  }
  if (!session.record) {
    return { ok: false, reason: "expired", error: publicError("expired") };
  }
  if (isOffchainRecord(session.record)) {
    return {
      ok: false,
      reason: "offchain",
      error: "This delivery is off-chain and cannot be signed.",
    };
  }
  if (!isPlausibleTxSignature(signature)) {
    return { ok: false, reason: "invalid-signature", error: publicError("invalid") };
  }

  const override = ignoreClientOverrides(options.body, session.record);
  if (!override.ok) {
    return { ok: false, reason: override.reason, error: publicError("invalid") };
  }

  if (session.record.kind === "presale") {
    if (session.status === "expired") {
      return { ok: false, reason: "expired", error: publicError("expired") };
    }
    return confirmPresaleDelivery(session, signature, options);
  }

  return confirmRewardSession(session, signature, options);
}

async function reconcileDeliveryPayment(input = {}) {
  if (!input.allowInternal && !isAdmin(input.adminUserId)) {
    return { ok: false, reason: "not-admin", error: publicError("not-admin") };
  }
  const rewardId = typeof input.rewardId === "string" ? input.rewardId.trim() : "";
  const signature = typeof input.signature === "string" ? input.signature.trim() : "";
  if (!rewardId || !isPlausibleTxSignature(signature)) {
    return { ok: false, reason: "invalid", error: publicError("invalid") };
  }

  const config = getDeliveryConfig(input.env);
  if (!config.distributionWallet) {
    return {
      ok: false,
      reason: "distribution-wallet-missing",
      error: publicError("distribution-wallet-missing"),
    };
  }

  const reward = getReward(rewardId, input.rewardsFile);
  if (!reward) {
    return { ok: false, reason: "missing", error: publicError("invalid") };
  }
  if (isOffchainRecord(reward)) {
    return {
      ok: false,
      reason: "offchain",
      error: "This delivery is off-chain and cannot be signed.",
    };
  }
  if (reward.status === "cancelled") {
    return { ok: false, reason: "already-sent", error: publicError("already-sent") };
  }
  if (reward.status === "sent") {
    if (reward.txSignature === signature) {
      await maybeNotifyMysteryGiftSent(reward, input);
      return {
        ok: true,
        idempotent: true,
        status: "sent",
        signature,
        kind: "reward",
        deliveryState: "sent",
      };
    }
    return { ok: false, reason: "already-sent", error: publicError("already-sent") };
  }
  if (!reward.walletSnapshot || !reward.amountBaseUnits || !reward.deliveryId) {
    return { ok: false, reason: "missing-plan", error: publicError("invalid") };
  }

  const other = findRewardIdByTxSignature(signature, input.rewardsFile);
  if (other && other !== rewardId) {
    return { ok: false, reason: "duplicate-signature", error: publicError("invalid") };
  }
  const store = loadDeliveryStore(input.deliveryFile);
  if (store.usedSignatures[signature] && store.usedSignatures[signature] !== reward.deliveryId) {
    return { ok: false, reason: "duplicate-signature", error: publicError("invalid") };
  }

  logDeliveryEvent("reconcile start");
  const now = input.now === undefined ? Date.now() : input.now;
  const submitted = markRewardSubmitted(rewardId, signature, {
    rewardsFile: input.rewardsFile,
    now,
  });
  if (!submitted.ok) {
    return { ok: false, reason: submitted.reason, error: publicError(submitted.reason) };
  }
  if (submitted.alreadySent) {
    await maybeNotifyMysteryGiftSent(submitted.reward, input);
    return {
      ok: true,
      idempotent: true,
      status: "sent",
      signature,
      kind: "reward",
      deliveryState: "sent",
    };
  }

  const found = findSessionByDeliveryId(store, reward.deliveryId);
  const bound = bindDeliverySignature(
    signature,
    reward.deliveryId,
    found && found.hash,
    now,
    input.deliveryFile,
    false
  );
  if (!bound.ok) {
    return { ok: false, reason: bound.reason, error: publicError(bound.reason) };
  }

  return finalizeVerifiedReward({
    rewardId,
    signature,
    deliveryId: reward.deliveryId,
    tokenHash: found && found.hash,
    expected: expectedFromRecord(reward, {
      expectedSigner: config.distributionWallet,
      destinationOwner: reward.walletSnapshot,
      createdAt: reward.createdAt,
    }),
    now,
    options: input,
  });
}

function listPendingRewardsForAdmin(userId, rewardsFile) {
  return listRewardsForUser(userId, rewardsFile).filter(
    (item) =>
      item &&
      (item.status === "pending" ||
        item.status === "prepared" ||
        item.status === "delivery-ready" ||
        item.status === "submitted")
  );
}

function setOffchainGiftLabel(input = {}) {
  if (!isAdmin(input.adminUserId)) {
    return { ok: false, reason: "not-admin", error: publicError("not-admin") };
  }
  const rewardId = typeof input.rewardId === "string" ? input.rewardId.trim() : "";
  const reward = getReward(rewardId, input.rewardsFile);
  if (!reward) {
    return { ok: false, reason: "missing", error: publicError("invalid") };
  }
  if (!isOffchainRecord(reward)) {
    return {
      ok: false,
      reason: "not-offchain",
      error: "This reward is not an off-chain delivery.",
    };
  }
  const normalized = normalizeOffchainGiftLabel(input.label);
  if (!normalized.ok) {
    return {
      ok: false,
      reason: normalized.reason,
      error: publicError(normalized.reason),
    };
  }
  const done = writeOffchainGiftLabel(rewardId, normalized.label, input.rewardsFile);
  if (!done.ok) {
    return { ok: false, reason: done.reason, error: publicError(done.reason) };
  }
  return {
    ok: true,
    reward: getReward(rewardId, input.rewardsFile),
  };
}

async function markOffchainDelivered(input = {}) {
  if (!isAdmin(input.adminUserId)) {
    return { ok: false, reason: "not-admin", error: publicError("not-admin") };
  }
  const rewardId = typeof input.rewardId === "string" ? input.rewardId.trim() : "";
  const reward = getReward(rewardId, input.rewardsFile);
  if (!reward) {
    return { ok: false, reason: "missing", error: publicError("invalid") };
  }
  if (!isOffchainRecord(reward)) {
    return {
      ok: false,
      reason: "not-offchain",
      error: "This reward is not an off-chain delivery.",
    };
  }
  if (reward.status === "cancelled") {
    return { ok: false, reason: "already-sent", error: publicError("already-sent") };
  }
  const now = input.now === undefined ? Date.now() : input.now;
  if (reward.status === "sent") {
    await maybeNotifyMysteryGiftSent(reward, input);
    return {
      ok: true,
      idempotent: true,
      status: "sent",
      deliveryState: "sent",
      reward,
    };
  }

  const storedLabel =
    typeof reward.offchainGiftLabel === "string" ? reward.offchainGiftLabel.trim() : "";
  if (!storedLabel) {
    return {
      ok: false,
      reason: "gift-required",
      error: publicError("gift-required"),
    };
  }

  const note =
    typeof input.deliveryNote === "string" ? input.deliveryNote.trim().slice(0, 500) : "";

  const done = mutateRewardsStore((store) => {
    const record = store.rewards[rewardId];
    if (!record || typeof record !== "object") {
      return { ok: false, reason: "missing" };
    }
    if (record.status === "sent") {
      return { ok: true, idempotent: true, reward: { ...record, rewardId } };
    }
    if (record.status === "cancelled") {
      return { ok: false, reason: "already-sent" };
    }
    record.status = "sent";
    record.sentAt = now;
    record.offchainDeliveredAt = now;
    if (typeof record.offchainGiftLabel !== "string" || !record.offchainGiftLabel.trim()) {
      return { ok: false, reason: "gift-required" };
    }
    if (note) {
      record.deliveryNote = note;
    }
    if (record.txSignature) {
      record.txSignature = null;
    }
    return { ok: true, reward: { ...record, rewardId } };
  }, input.rewardsFile);

  if (!done.ok) {
    return { ok: false, reason: done.reason, error: publicError(done.reason) };
  }

  if (reward.deliveryId) {
    mutateDeliveryStore((store) => {
      const found = findSessionByDeliveryId(store, reward.deliveryId);
      if (found && found.record) {
        found.record.status = "consumed";
        found.record.consumedAt = now;
      }
      return { ok: true };
    }, input.deliveryFile);
  }

  logDeliveryEvent("offchain sent");
  await maybeNotifyMysteryGiftSent(done.reward, input);
  return {
    ok: true,
    signature: null,
    kind: "reward",
    idempotent: Boolean(done.idempotent),
    status: "sent",
    deliveryState: "sent",
    reward: getReward(rewardId, input.rewardsFile),
  };
}

module.exports = {
  hashToken,
  lookupDeliverySession,
  isDurableDeliveryRecord,
  prepareRewardDelivery,
  preparePresaleDistribution,
  findPendingPresaleContribution,
  issueDeliveryPayment,
  confirmDelivery,
  reconcileDeliveryPayment,
  markOffchainDelivered,
  setOffchainGiftLabel,
  publicStatusForSession,
  publicDeliveryState,
  listPendingRewardsForAdmin,
  publicError,
  ignoreClientOverrides,
  reviewPayload,
  expectedFromRecord,
  withDeliveryRpc,
  isOffchainRecord,
};
