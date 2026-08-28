/**
 * Admin-only cleanup of safe pending Mystery Gifts.
 * Never deletes sent, cancelled, submitted, or records that may have been broadcast.
 * Never sends tokens. Temp/test files only unless an admin confirms in production later.
 */

const fs = require("fs");
const path = require("path");
const { isAdmin } = require("./points");
const {
  loadRewardsStore,
  mutateRewardsStore,
  isPlausibleTxSignature,
  resolveRewardsFile,
} = require("./memberRewards");
const {
  loadDeliveryStore,
  mutateDeliveryStore,
  resolveDeliveryFile,
} = require("./deliveryStore");
const { error: logError, log } = require("../utils/logger");

const SAFE_PENDING_STATUSES = Object.freeze(["pending", "prepared", "delivery-ready"]);
const UNSAFE_SESSION_STATUSES = Object.freeze(["payment-ready", "submitted", "consumed", "failed"]);

function emptyCounts() {
  return {
    pendingRemoved: 0,
    deliveredPreserved: 0,
    failedPreserved: 0,
    ambiguousSkipped: 0,
    otherPreserved: 0,
  };
}

function sessionIndexByRewardId(deliveryStore) {
  const map = new Map();
  if (!deliveryStore || typeof deliveryStore !== "object") {
    return map;
  }
  for (const record of Object.values(deliveryStore.sessions || {})) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const rewardId = typeof record.rewardId === "string" ? record.rewardId.trim() : "";
    if (!rewardId) {
      continue;
    }
    map.set(rewardId, record);
  }
  return map;
}

function deliveryIdIsUsed(deliveryStore, deliveryId) {
  if (!deliveryId || !deliveryStore || !deliveryStore.usedSignatures) {
    return false;
  }
  return Object.values(deliveryStore.usedSignatures).includes(deliveryId);
}

/**
 * Classify one Mystery Gift for cleanup. Any on-chain/ambiguous signal → skip.
 * @returns {"pending"|"delivered"|"failed"|"ambiguous"|"other"}
 */
function classifyMysteryGiftForCleanup(record, session, deliveryStore) {
  if (!record || typeof record !== "object") {
    return "other";
  }
  if (record.type !== "mystery-gift") {
    return "other";
  }
  if (record.status === "sent") {
    return "delivered";
  }
  if (record.status === "cancelled") {
    return "failed";
  }

  const hasRewardSig = isPlausibleTxSignature(record.txSignature);
  const hasSessionSig = Boolean(session && isPlausibleTxSignature(session.txSignature));
  const sessionStatus = session && typeof session.status === "string" ? session.status : "";
  const deliveryId =
    typeof record.deliveryId === "string"
      ? record.deliveryId.trim()
      : session && typeof session.deliveryId === "string"
        ? session.deliveryId.trim()
        : "";
  const bound = deliveryIdIsUsed(deliveryStore, deliveryId);
  const unsafeSession = UNSAFE_SESSION_STATUSES.includes(sessionStatus);

  if (
    hasRewardSig ||
    hasSessionSig ||
    bound ||
    unsafeSession ||
    record.status === "submitted"
  ) {
    return "ambiguous";
  }

  if (SAFE_PENDING_STATUSES.includes(record.status)) {
    return "pending";
  }
  return "ambiguous";
}

function scanMysteryGifts(rewardsStore, deliveryStore) {
  const sessions = sessionIndexByRewardId(deliveryStore);
  const pendingIds = [];
  const counts = emptyCounts();
  for (const [rewardId, record] of Object.entries((rewardsStore && rewardsStore.rewards) || {})) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const bucket = classifyMysteryGiftForCleanup(record, sessions.get(rewardId), deliveryStore);
    if (bucket === "pending") {
      counts.pendingRemoved += 1;
      pendingIds.push(rewardId);
    } else if (bucket === "delivered") {
      counts.deliveredPreserved += 1;
    } else if (bucket === "failed") {
      counts.failedPreserved += 1;
    } else if (bucket === "ambiguous") {
      counts.ambiguousSkipped += 1;
    } else {
      counts.otherPreserved += 1;
    }
  }
  return { pendingIds, counts };
}

function copyFileAtomic(src, dest) {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempFile = `${dest}.tmp-${unique}`;
  try {
    fs.copyFileSync(src, tempFile);
    fs.renameSync(tempFile, dest);
  } catch (err) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function backupStoreFile(filePath, now, kind) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: true, skipped: true, kind };
  }
  const stamp = new Date(Number.isFinite(now) ? now : Date.now())
    .toISOString()
    .replace(/[:.]/g, "-");
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const ext = path.extname(filePath) || ".json";
  const dest = path.join(dir, `${base}.pre-clear-${stamp}${ext}`);
  copyFileAtomic(filePath, dest);
  return { ok: true, kind, path: dest };
}

function unindexUserReward(store, uid, rewardId) {
  if (!uid || !Array.isArray(store.byUser[uid])) {
    return;
  }
  store.byUser[uid] = store.byUser[uid].filter((id) => id !== rewardId);
  if (!store.byUser[uid].length) {
    delete store.byUser[uid];
  }
}

function previewPendingMysteryGiftCleanup(options = {}) {
  const rewardsStore = loadRewardsStore(options.rewardsFile);
  const deliveryStore = loadDeliveryStore(options.deliveryFile);
  const scanned = scanMysteryGifts(rewardsStore, deliveryStore);
  return {
    ok: true,
    pendingCount: scanned.pendingIds.length,
    pendingIds: scanned.pendingIds,
    counts: scanned.counts,
  };
}

function formatClearConfirmText(pendingCount) {
  const n = Number(pendingCount) || 0;
  return [
    "⚠️ Clear all pending Mystery Gifts?",
    "",
    `Pending: ${n}`,
    "",
    "Sent, failed, and on-chain records are kept.",
  ].join("\n");
}

function formatCleanupReport(counts) {
  const c = counts && typeof counts === "object" ? counts : emptyCounts();
  return [
    "🧹 Mystery Gift cleanup",
    "",
    `Pending removed: ${c.pendingRemoved || 0}`,
    `Delivered preserved: ${c.deliveredPreserved || 0}`,
    `Failed preserved: ${c.failedPreserved || 0}`,
    `Ambiguous/on-chain skipped: ${c.ambiguousSkipped || 0}`,
    "",
    "Queue is ready for a clean test.",
  ].join("\n");
}

/**
 * Remove only safe pending Mystery Gifts. Requires admin. Backs up stores first.
 */
function clearPendingMysteryGifts(input = {}) {
  if (!isAdmin(input.adminUserId)) {
    return { ok: false, reason: "not-admin", error: "This command is admin only." };
  }
  const now = input.now === undefined ? Date.now() : input.now;
  const preview = previewPendingMysteryGiftCleanup(input);
  const backups = [];

  if (preview.pendingIds.length) {
    try {
      backups.push(backupStoreFile(resolveRewardsFile(input.rewardsFile), now, "rewards"));
      backups.push(backupStoreFile(resolveDeliveryFile(input.deliveryFile), now, "delivery"));
    } catch (err) {
      logError(
        "[reward-delivery] cleanup backup failed",
        err && err.message ? err.message : err
      );
      return { ok: false, reason: "backup-failed", error: "Cleanup backup failed. Nothing was removed." };
    }
  }

  const removed = mutateRewardsStore((store) => {
    const deliveryStore = loadDeliveryStore(input.deliveryFile);
    const scanned = scanMysteryGifts(store, deliveryStore);
    const removedIds = [];
    for (const rewardId of scanned.pendingIds) {
      const record = store.rewards[rewardId];
      const bucket = classifyMysteryGiftForCleanup(
        record,
        sessionIndexByRewardId(deliveryStore).get(rewardId),
        deliveryStore
      );
      if (bucket !== "pending") {
        continue;
      }
      const uid = record && record.telegramUserId;
      delete store.rewards[rewardId];
      unindexUserReward(store, uid, rewardId);
      removedIds.push(rewardId);
    }
    scanned.counts.pendingRemoved = removedIds.length;
    return { removedIds, counts: scanned.counts };
  }, input.rewardsFile);

  const removedSet = new Set(removed.removedIds || []);
  if (removedSet.size) {
    mutateDeliveryStore((store) => {
      for (const [hash, record] of Object.entries(store.sessions || {})) {
        if (!record || typeof record !== "object") {
          continue;
        }
        const rewardId = typeof record.rewardId === "string" ? record.rewardId : "";
        if (!removedSet.has(rewardId)) {
          continue;
        }
        if (UNSAFE_SESSION_STATUSES.includes(record.status) || isPlausibleTxSignature(record.txSignature)) {
          continue;
        }
        delete store.sessions[hash];
      }
      return { ok: true };
    }, input.deliveryFile);
  }

  log(
    `[reward-delivery] cleanup pendingRemoved=${removed.counts.pendingRemoved} ambiguous=${removed.counts.ambiguousSkipped}`
  );
  return {
    ok: true,
    counts: removed.counts,
    removedIds: removed.removedIds,
    backups,
    report: formatCleanupReport(removed.counts),
  };
}

module.exports = {
  SAFE_PENDING_STATUSES,
  classifyMysteryGiftForCleanup,
  previewPendingMysteryGiftCleanup,
  clearPendingMysteryGifts,
  formatClearConfirmText,
  formatCleanupReport,
  backupStoreFile,
};
