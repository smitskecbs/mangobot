/**
 * Member reward queue (Mystery Gifts, airdrops, later delivery).
 *
 * Stores pending/prepared/sent/cancelled records. Does NOT send SOL, SPL, or NFTs.
 * Destination wallet is snapshotted from the verified mapping at creation time.
 * Replacing a verified wallet later does not mutate existing reward destinations.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("node:crypto");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");
const {
  getLinkedWalletForUser,
  normalizeUserId,
} = require("./walletLinks");
const { normalizeSolanaPublicKey, shortenWallet } = require("../utils/solanaWallet");

const DEFAULT_REWARDS_FILE = path.resolve(__dirname, "..", "data", "member-rewards.json");

const REWARD_TYPES = Object.freeze(["mystery-gift", "airdrop", "nft", "other"]);
const STATUSES = Object.freeze([
  "pending",
  "prepared",
  "delivery-ready",
  "submitted",
  "sent",
  "cancelled",
]);

const LOCK_OPTIONS = Object.freeze({
  stale: 10_000,
  realpath: false,
});

const LOCK_RETRY = Object.freeze({
  attempts: 100,
  minTimeoutMs: 20,
  maxTimeoutMs: 500,
  factor: 1.5,
});

let rewardsFileOverride = null;
let autoTestRewardsFile = null;

function setRewardsFileForTests(filePath) {
  rewardsFileOverride = filePath || null;
}

function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_MEMBER_REWARDS === "1") {
    return true;
  }
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

function getAutoTestRewardsFile() {
  if (!autoTestRewardsFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-member-rewards-"));
    autoTestRewardsFile = path.join(dir, "member-rewards.json");
  }
  return autoTestRewardsFile;
}

function resolveRewardsFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (rewardsFileOverride) {
    return rewardsFileOverride;
  }
  const fromEnv =
    typeof process.env.MEMBER_REWARDS_FILE === "string"
      ? process.env.MEMBER_REWARDS_FILE.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  if (isLikelyTestProcess()) {
    return getAutoTestRewardsFile();
  }
  return DEFAULT_REWARDS_FILE;
}

function sleepSync(ms) {
  const delay = Math.max(0, Math.ceil(ms));
  if (delay === 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function emptyStore() {
  return { rewards: {}, byUser: {} };
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return store;
  }
  if (raw.rewards && typeof raw.rewards === "object" && !Array.isArray(raw.rewards)) {
    store.rewards = raw.rewards;
  }
  if (raw.byUser && typeof raw.byUser === "object" && !Array.isArray(raw.byUser)) {
    store.byUser = raw.byUser;
  }
  return store;
}

function readRewardsSnapshot(rewardsFile, options = {}) {
  try {
    if (!fs.existsSync(rewardsFile)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(rewardsFile, "utf8").trim();
    if (!raw) {
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (options.strict && err && err.code !== "ENOENT") {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read member-rewards.json: ${message}`);
    }
    logError("Error reading member-rewards.json:", err);
    return emptyStore();
  }
}

function acquireRewardsLock(rewardsFile) {
  const dir = path.dirname(rewardsFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(rewardsFile)) {
    writeJsonFileAtomic(rewardsFile, emptyStore());
  }

  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;

  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(rewardsFile, LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire member-rewards.json lock: ${message}`);
      }
      sleepSync(timeoutMs);
      timeoutMs = Math.min(
        LOCK_RETRY.maxTimeoutMs,
        Math.ceil(timeoutMs * LOCK_RETRY.factor)
      );
    }
  }

  const message =
    lastError && lastError.message ? lastError.message : "lock retries exhausted";
  throw new Error(`Failed to acquire member-rewards.json lock: ${message}`);
}

function mutateRewardsStore(mutator, rewardsFile) {
  if (typeof mutator !== "function") {
    throw new TypeError("mutateRewardsStore requires a mutator function");
  }

  const filePath = resolveRewardsFile(rewardsFile);
  const release = acquireRewardsLock(filePath);

  try {
    const data = readRewardsSnapshot(filePath, { strict: true });
    const result = mutator(data);

    try {
      writeJsonFileAtomic(filePath, data);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to write member-rewards.json: ${message}`);
    }

    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release member-rewards.json lock:", err);
    }
  }
}

function loadRewardsStore(rewardsFile) {
  return readRewardsSnapshot(resolveRewardsFile(rewardsFile));
}

function normalizeRewardType(type) {
  if (type === "mystery") {
    return "mystery-gift";
  }
  if (typeof type !== "string") {
    return "mystery-gift";
  }
  const trimmed = type.trim().toLowerCase();
  if (REWARD_TYPES.includes(trimmed)) {
    return trimmed;
  }
  return null;
}

const ANNOUNCE_CLAIM_TTL_MS = 15 * 60 * 1000;
const SIDE_EFFECT_SENDING_TTL_MS = ANNOUNCE_CLAIM_TTL_MS;

function sanitizeTelegramUsername(value) {
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(raw)) {
    return null;
  }
  return raw;
}

function sanitizeDisplayName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function lookupPointsDisplayName(userId, pointsFile) {
  if (pointsFile === undefined && isLikelyTestProcess()) {
    return null;
  }
  try {
    const { loadPoints, getUserRecord } = require("./points");
    const user = getUserRecord(loadPoints(pointsFile), userId);
    if (!user || typeof user.name !== "string") {
      return null;
    }
    if (user.name === "Unknown") {
      return null;
    }
    return sanitizeDisplayName(user.name);
  } catch {
    return null;
  }
}

function snapshotRewardIdentity(uid, input = {}) {
  return {
    telegramUsername: sanitizeTelegramUsername(input.telegramUsername),
    displayNameSnapshot:
      sanitizeDisplayName(input.displayName) || lookupPointsDisplayName(uid, input.pointsFile),
  };
}

function defaultLabelForType(type) {
  if (type === "mystery-gift") {
    return "Mystery Gift";
  }
  if (type === "airdrop") {
    return "Airdrop";
  }
  if (type === "nft") {
    return "NFT";
  }
  return "Reward";
}

function createRewardId(store) {
  for (let i = 0; i < 8; i += 1) {
    const id = crypto.randomBytes(9).toString("base64url").slice(0, 12).toUpperCase();
    if (!store.rewards[id]) {
      return id;
    }
  }
  return crypto.randomBytes(12).toString("hex").slice(0, 16).toUpperCase();
}

function indexUserReward(store, uid, rewardId) {
  if (!Array.isArray(store.byUser[uid])) {
    store.byUser[uid] = [];
  }
  if (!store.byUser[uid].includes(rewardId)) {
    store.byUser[uid].push(rewardId);
  }
}

function publicReward(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  return {
    rewardId: record.rewardId,
    telegramUserId: record.telegramUserId,
    walletSnapshot: record.walletSnapshot,
    type: record.type,
    label: record.label,
    status: record.status,
    createdAt: record.createdAt,
    sentAt: record.sentAt,
    cancelledAt: record.cancelledAt || null,
    txSignature: record.txSignature,
    deliveryType: record.deliveryType || null,
    assetType: record.assetType || null,
    amountBaseUnits: record.amountBaseUnits || null,
    mint: record.mint || null,
    deliveryId: record.deliveryId || null,
    telegramUsername: record.telegramUsername || null,
    displayNameSnapshot: record.displayNameSnapshot || null,
    submittedAt: record.submittedAt || null,
    deliveryReview: record.deliveryReview || null,
    reconcileAttempts: Number(record.reconcileAttempts) || 0,
    recipientNotifyState: record.recipientNotifyState || null,
    recipientNotifiedAt: record.recipientNotifiedAt || null,
    groupAnnounceState: record.groupAnnounceState || null,
    groupAnnouncedAt: record.groupAnnouncedAt || null,
  };
}

function isRewardEligible(userId, walletFile) {
  return getLinkedWalletForUser(userId, walletFile) !== null;
}

function countRewardsForUser(userId, rewardsFile) {
  const list = listRewardsForUser(userId, rewardsFile);
  let pending = 0;
  let delivered = 0;
  let cancelled = 0;
  let mysteryPending = 0;
  for (const item of list) {
    if (
      item.status === "pending" ||
      item.status === "prepared" ||
      item.status === "delivery-ready" ||
      item.status === "submitted"
    ) {
      pending += 1;
      if (item.type === "mystery-gift") {
        mysteryPending += 1;
      }
    } else if (item.status === "sent") {
      delivered += 1;
    } else if (item.status === "cancelled") {
      cancelled += 1;
    }
  }
  return { pending, delivered, cancelled, mysteryPending, total: list.length };
}

function listRewardsForUser(userId, rewardsFile) {
  const uid = normalizeUserId(userId);
  if (!uid) {
    return [];
  }
  const store = loadRewardsStore(rewardsFile);
  const ids = Array.isArray(store.byUser[uid]) ? store.byUser[uid] : [];
  const out = [];
  for (const id of ids) {
    const record = store.rewards[id];
    if (!record || typeof record !== "object") {
      continue;
    }
    out.push(publicReward({ ...record, rewardId: id }));
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

function getReward(rewardId, rewardsFile) {
  if (typeof rewardId !== "string" || !rewardId.trim()) {
    return null;
  }
  const store = loadRewardsStore(rewardsFile);
  const record = store.rewards[rewardId.trim()];
  if (!record || typeof record !== "object") {
    return null;
  }
  return publicReward({ ...record, rewardId: rewardId.trim() });
}

/**
 * Create a pending reward. Wallet comes from the linked mapping (registered or verified).
 * Snapshot is frozen at creation and never follows later wallet changes.
 * @param {{ telegramUserId: string|number, type?: string, label?: string, createdBy?: string|number, now?: number, walletFile?: string, rewardsFile?: string, pointsFile?: string, telegramUsername?: string, displayName?: string }} input
 */
function createReward(input = {}) {
  const uid = normalizeUserId(input.telegramUserId);
  if (!uid) {
    return { ok: false, error: "Invalid request.", reason: "invalid-user" };
  }

  const type = normalizeRewardType(input.type || "mystery-gift");
  if (!type) {
    return { ok: false, error: "Invalid request.", reason: "invalid-type" };
  }

  const linked = getLinkedWalletForUser(uid, input.walletFile);
  if (!linked) {
    return {
      ok: false,
      error: "This member needs to verify a wallet first.",
      reason: "unverified",
    };
  }

  const walletSnapshot = normalizeSolanaPublicKey(linked.wallet);
  if (!walletSnapshot) {
    return {
      ok: false,
      error: "This member needs to verify a wallet first.",
      reason: "unverified",
    };
  }

  const identity = snapshotRewardIdentity(uid, input);
  const now = input.now === undefined ? Date.now() : input.now;
  const label =
    typeof input.label === "string" && input.label.trim()
      ? input.label.trim().slice(0, 80)
      : defaultLabelForType(type);

  return mutateRewardsStore((store) => {
    const rewardId = createRewardId(store);
    store.rewards[rewardId] = {
      telegramUserId: uid,
      walletSnapshot,
      type,
      label,
      status: "pending",
      createdAt: now,
      sentAt: null,
      cancelledAt: null,
      txSignature: null,
      createdBy: input.createdBy === undefined ? null : String(input.createdBy),
      telegramUsername: identity.telegramUsername,
      displayNameSnapshot: identity.displayNameSnapshot,
    };
    indexUserReward(store, uid, rewardId);
    return {
      ok: true,
      reward: publicReward({ ...store.rewards[rewardId], rewardId }),
    };
  }, input.rewardsFile);
}

function prepareRewardsForUsers(userIds, type, options = {}) {
  const ids = Array.isArray(userIds) ? userIds : [];
  const created = [];
  const skipped = [];
  for (const userId of ids) {
    const result = createReward({
      telegramUserId: userId,
      type,
      label: options.label,
      createdBy: options.createdBy,
      now: options.now,
      walletFile: options.walletFile,
      rewardsFile: options.rewardsFile,
      pointsFile: options.pointsFile,
      telegramUsername: options.telegramUsername,
      displayName: options.displayName,
    });
    if (result.ok) {
      created.push(result.reward);
    } else {
      skipped.push({
        telegramUserId: normalizeUserId(userId),
        reason: result.reason || "failed",
      });
    }
  }
  return { ok: true, created, skipped };
}

function markRewardPrepared(rewardId, options = {}) {
  return transitionReward(rewardId, "prepared", options);
}

function isPlausibleTxSignature(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length < 64 || trimmed.length > 128) {
    return false;
  }
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
}

function markRewardSent(rewardId, txSignature, options = {}) {
  if (!isPlausibleTxSignature(txSignature)) {
    return { ok: false, error: "Invalid request.", reason: "invalid-signature" };
  }
  return transitionReward(rewardId, "sent", {
    ...options,
    txSignature: txSignature.trim(),
  });
}

function markRewardSubmitted(rewardId, txSignature, options = {}) {
  if (!isPlausibleTxSignature(txSignature)) {
    return { ok: false, error: "Invalid request.", reason: "invalid-signature" };
  }
  const signature = txSignature.trim();
  const id = typeof rewardId === "string" ? rewardId.trim() : "";
  if (!id) {
    return { ok: false, error: "Invalid request.", reason: "invalid-id" };
  }
  const now = options.now === undefined ? Date.now() : options.now;
  return mutateRewardsStore((store) => {
    const record = store.rewards[id];
    if (!record || typeof record !== "object") {
      return { ok: false, error: "Invalid request.", reason: "missing" };
    }
    if (record.status === "cancelled") {
      return { ok: false, error: "Invalid request.", reason: "already-sent" };
    }
    if (record.status === "sent") {
      if (record.txSignature === signature) {
        return { ok: true, idempotent: true, alreadySent: true, reward: publicReward({ ...record, rewardId: id }) };
      }
      return { ok: false, error: "Invalid request.", reason: "already-sent" };
    }
    if (record.txSignature && record.txSignature !== signature) {
      return { ok: false, error: "Invalid request.", reason: "signature-conflict" };
    }
    record.status = "submitted";
    record.txSignature = signature;
    if (!record.submittedAt) {
      record.submittedAt = now;
    }
    return { ok: true, reward: publicReward({ ...record, rewardId: id }) };
  }, options.rewardsFile);
}

function markRewardDeliveryReview(rewardId, reason, options = {}) {
  const id = typeof rewardId === "string" ? rewardId.trim() : "";
  if (!id) {
    return { ok: false, reason: "invalid-id" };
  }
  const safeReason =
    typeof reason === "string" && /^[a-z0-9_-]{1,64}$/i.test(reason.trim())
      ? reason.trim()
      : "mismatch";
  return mutateRewardsStore((store) => {
    const record = store.rewards[id];
    if (!record || typeof record !== "object") {
      return { ok: false, reason: "missing" };
    }
    if (record.status === "sent") {
      return { ok: true, reward: publicReward({ ...record, rewardId: id }), skipped: true };
    }
    record.deliveryReview = "manual";
    record.deliveryFailureReason = safeReason;
    return { ok: true, reward: publicReward({ ...record, rewardId: id }) };
  }, options.rewardsFile);
}

function bumpRewardReconcileAttempts(rewardId, options = {}) {
  const id = typeof rewardId === "string" ? rewardId.trim() : "";
  if (!id) {
    return { ok: false, reason: "invalid-id" };
  }
  return mutateRewardsStore((store) => {
    const record = store.rewards[id];
    if (!record || typeof record !== "object") {
      return { ok: false, reason: "missing" };
    }
    record.reconcileAttempts = (Number(record.reconcileAttempts) || 0) + 1;
    return { ok: true, attempts: record.reconcileAttempts };
  }, options.rewardsFile);
}

function listSubmittedRewards(rewardsFile) {
  const store = loadRewardsStore(rewardsFile);
  const out = [];
  for (const [id, record] of Object.entries(store.rewards || {})) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (record.status !== "submitted") {
      continue;
    }
    if (record.deliveryReview === "manual") {
      continue;
    }
    if (!isPlausibleTxSignature(record.txSignature)) {
      continue;
    }
    out.push(publicReward({ ...record, rewardId: id }));
  }
  return out;
}

function findRewardIdByTxSignature(signature, rewardsFile) {
  if (!isPlausibleTxSignature(signature)) {
    return null;
  }
  const store = loadRewardsStore(rewardsFile);
  for (const [id, record] of Object.entries(store.rewards || {})) {
    if (record && record.txSignature === signature) {
      return id;
    }
  }
  return null;
}

function cancelReward(rewardId, options = {}) {
  return transitionReward(rewardId, "cancelled", options);
}

function allowedTransition(from, to) {
  if (from === to) {
    return false;
  }
  if (to === "pending") {
    return false;
  }
  if (from === "sent" || from === "cancelled") {
    return false;
  }
  if (to === "prepared") {
    return from === "pending";
  }
  if (to === "delivery-ready") {
    return from === "pending" || from === "prepared" || from === "delivery-ready";
  }
  if (to === "submitted") {
    return from === "delivery-ready" || from === "prepared";
  }
  if (to === "sent") {
    return (
      from === "pending" ||
      from === "prepared" ||
      from === "delivery-ready" ||
      from === "submitted"
    );
  }
  if (to === "cancelled") {
    return (
      from === "pending" ||
      from === "prepared" ||
      from === "delivery-ready" ||
      from === "submitted"
    );
  }
  return false;
}

function transitionReward(rewardId, nextStatus, options = {}) {
  if (typeof rewardId !== "string" || !rewardId.trim()) {
    return { ok: false, error: "Invalid request.", reason: "invalid-id" };
  }
  if (!STATUSES.includes(nextStatus)) {
    return { ok: false, error: "Invalid request.", reason: "invalid-status" };
  }
  const id = rewardId.trim();
  const now = options.now === undefined ? Date.now() : options.now;

  return mutateRewardsStore((store) => {
    const record = store.rewards[id];
    if (!record || typeof record !== "object") {
      return { ok: false, error: "Invalid request.", reason: "missing" };
    }
    if (!allowedTransition(record.status, nextStatus)) {
      return { ok: false, error: "Invalid request.", reason: "invalid-transition" };
    }
    record.status = nextStatus;
    if (nextStatus === "sent") {
      record.txSignature = options.txSignature;
      record.sentAt = now;
    }
    if (nextStatus === "cancelled") {
      record.cancelledAt = now;
    }
    return { ok: true, reward: publicReward({ ...record, rewardId: id }) };
  }, options.rewardsFile);
}

function sideEffectKeys(kind) {
  if (kind === "recipient") {
    return {
      stateKey: "recipientNotifyState",
      atKey: "recipientNotifiedAt",
      claimedKey: "recipientNotifyClaimedAt",
      alreadyReason: "already-notified",
    };
  }
  return {
    stateKey: "groupAnnounceState",
    atKey: "groupAnnouncedAt",
    claimedKey: "groupAnnounceClaimedAt",
    alreadyReason: "already-announced",
  };
}

function claimMysteryGiftSideEffect(rewardId, kind, options = {}) {
  if (typeof rewardId !== "string" || !rewardId.trim()) {
    return { ok: false, reason: "invalid-id" };
  }
  const keys = sideEffectKeys(kind);
  const id = rewardId.trim();
  const now = options.now === undefined ? Date.now() : options.now;
  return mutateRewardsStore((store) => {
    const record = store.rewards[id];
    if (!record || typeof record !== "object") {
      return { ok: false, reason: "missing" };
    }
    if (record.status !== "sent") {
      return { ok: false, reason: "not-sent" };
    }
    if (record.type !== "mystery-gift") {
      return { ok: false, reason: "not-mystery" };
    }
    if (record[keys.stateKey] === "sent" || Number(record[keys.atKey]) > 0) {
      return { ok: false, reason: keys.alreadyReason, done: true, announced: true };
    }
    const claimedAt = Number(record[keys.claimedKey]) || 0;
    if (
      record[keys.stateKey] === "sending" &&
      claimedAt > 0 &&
      now - claimedAt < SIDE_EFFECT_SENDING_TTL_MS
    ) {
      return { ok: false, reason: "in-flight" };
    }
    record[keys.stateKey] = "sending";
    record[keys.claimedKey] = now;
    return { ok: true, reward: { ...record, rewardId: id } };
  }, options.rewardsFile);
}

function finishMysteryGiftSideEffect(rewardId, kind, success, options = {}) {
  if (typeof rewardId !== "string" || !rewardId.trim()) {
    return { ok: false, reason: "invalid-id" };
  }
  const keys = sideEffectKeys(kind);
  const id = rewardId.trim();
  const now = options.now === undefined ? Date.now() : options.now;
  return mutateRewardsStore((store) => {
    const record = store.rewards[id];
    if (!record || typeof record !== "object") {
      return { ok: false, reason: "missing" };
    }
    delete record[keys.claimedKey];
    if (success) {
      record[keys.stateKey] = "sent";
      record[keys.atKey] = now;
    } else {
      record[keys.stateKey] = "pending";
    }
    return { ok: true, reward: publicReward({ ...record, rewardId: id }) };
  }, options.rewardsFile);
}

function claimMysteryGiftGroupAnnouncement(rewardId, options = {}) {
  const result = claimMysteryGiftSideEffect(rewardId, "group", options);
  if (!result.ok && result.reason === "already-announced") {
    return { ...result, announced: true };
  }
  return result;
}

function finishMysteryGiftGroupAnnouncement(rewardId, success, options = {}) {
  return finishMysteryGiftSideEffect(rewardId, "group", success, options);
}

function claimMysteryGiftRecipientNotification(rewardId, options = {}) {
  const result = claimMysteryGiftSideEffect(rewardId, "recipient", options);
  if (!result.ok && result.reason === "already-notified") {
    return { ...result, notified: true };
  }
  return result;
}

function finishMysteryGiftRecipientNotification(rewardId, success, options = {}) {
  return finishMysteryGiftSideEffect(rewardId, "recipient", success, options);
}

function formatCreatedDate(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  return new Date(value).toISOString().slice(0, 10);
}

function userFacingRewardLine(reward) {
  if (!reward) {
    return "";
  }
  const title =
    reward.type === "mystery-gift" ? "Mystery Gift" : defaultLabelForType(reward.type);
  const statusLabel =
    reward.status === "sent"
      ? "Sent"
      : reward.status === "cancelled"
        ? "Cancelled"
        : reward.status === "prepared" || reward.status === "delivery-ready"
          ? "Pending"
          : reward.status === "submitted"
            ? "Pending"
            : "Pending";
  const lines = [`🎁 ${title}`, `Status: ${statusLabel}`];
  const created = formatCreatedDate(reward.createdAt);
  if (created) {
    lines.push(`Created: ${created}`);
  }
  if (reward.status === "sent" && typeof reward.txSignature === "string" && reward.txSignature) {
    lines.push(`Tx: ${shortenWallet(reward.txSignature)}`);
  }
  return lines.join("\n");
}

/**
 * Future on-chain delivery hook. Does not send assets or hold keys.
 */
function deliverReward(_rewardId) {
  return {
    ok: false,
    error: "On-chain delivery is not implemented.",
    reason: "not-implemented",
  };
}

module.exports = {
  REWARD_TYPES,
  STATUSES,
  DEFAULT_REWARDS_FILE,
  setRewardsFileForTests,
  resolveRewardsFile,
  loadRewardsStore,
  mutateRewardsStore,
  isRewardEligible,
  createReward,
  prepareRewardsForUsers,
  markRewardPrepared,
  markRewardSent,
  markRewardSubmitted,
  markRewardDeliveryReview,
  bumpRewardReconcileAttempts,
  listSubmittedRewards,
  findRewardIdByTxSignature,
  cancelReward,
  getReward,
  listRewardsForUser,
  countRewardsForUser,
  userFacingRewardLine,
  deliverReward,
  defaultLabelForType,
  normalizeRewardType,
  isPlausibleTxSignature,
  sanitizeTelegramUsername,
  sanitizeDisplayName,
  snapshotRewardIdentity,
  claimMysteryGiftGroupAnnouncement,
  finishMysteryGiftGroupAnnouncement,
  claimMysteryGiftRecipientNotification,
  finishMysteryGiftRecipientNotification,
  claimMysteryGiftSideEffect,
  finishMysteryGiftSideEffect,
  ANNOUNCE_CLAIM_TTL_MS,
  SIDE_EFFECT_SENDING_TTL_MS,
};
