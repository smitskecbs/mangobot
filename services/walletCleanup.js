/**
 * Admin wallet-cleanup: preview known IDs, then optional kick+unban after a fresh rescan.
 * Preview never removes anyone. Confirm never trusts a cached preview list.
 */

const { isAdmin, loadPoints } = require("./points");
const {
  resolveWalletFile,
  readWalletSnapshot,
  getLinkedWalletFromStore,
} = require("./walletLinks");
const { loadBuilderStore } = require("./communityBuilderStore");
const { loadShopStore } = require("./mangoShopStore");
const { loadPresaleStore } = require("./presaleStore");
const { loadRewardsStore } = require("./memberRewards");
const { getConfiguredCommunityChatId } = require("./chatFight");
const { log, error: logError } = require("../utils/logger");
const {
  loadKnownMembersStore,
  collectKnownTelegramIds,
  isExplicitlyProtected,
  asTelegramUserId,
  displayNameFromRecord,
} = require("./knownMembers");

const BUCKET = Object.freeze({
  WALLET_LINKED: "wallet-linked",
  ELIGIBLE: "eligible",
  PROTECTED: "protected",
  NOT_IN_GROUP: "not-in-group",
  LOOKUP_FAILED: "lookup-failed",
});

const CURRENT_STATUSES = new Set([
  "member",
  "restricted",
  "administrator",
  "creator",
]);
const STAFF_STATUSES = new Set(["creator", "administrator"]);
const TELEGRAM_TEXT_LIMIT = 3900;
const WALLET_CLEANUP_PAGE_SIZE = 20;
const WALLET_CLEANUP_CALLBACK_PREFIX = "wcln:";

function resolveCleanupChatId(options = {}) {
  if (options.chatId != null && String(options.chatId).trim() !== "") {
    return String(options.chatId).trim();
  }
  return getConfiguredCommunityChatId();
}

function loadWalletStoreStrict(options = {}) {
  try {
    return {
      ok: true,
      store: readWalletSnapshot(resolveWalletFile(options.walletFile), {
        strict: true,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      store: null,
    };
  }
}

function nameFromTelegramUser(user) {
  if (!user || typeof user !== "object") {
    return "";
  }
  const first = typeof user.first_name === "string" ? user.first_name.trim() : "";
  const last = typeof user.last_name === "string" ? user.last_name.trim() : "";
  return `${first} ${last}`.trim();
}

function classifyWalletCleanupMember(input = {}) {
  const userId = asTelegramUserId(input.userId);
  if (!userId) {
    return { bucket: BUCKET.LOOKUP_FAILED, reason: "invalid-user" };
  }
  if (!input.lookupOk) {
    return { bucket: BUCKET.LOOKUP_FAILED, reason: input.lookupReason || "lookup-failed" };
  }
  const member = input.member;
  if (!member || typeof member !== "object") {
    return { bucket: BUCKET.LOOKUP_FAILED, reason: "empty-member" };
  }
  const status = typeof member.status === "string" ? member.status : "";
  const user = member.user && typeof member.user === "object" ? member.user : {};
  if (user.is_bot) {
    return { bucket: BUCKET.PROTECTED, reason: "bot", status };
  }
  if (!status) {
    return { bucket: BUCKET.LOOKUP_FAILED, reason: "unclear-status" };
  }
  if (status === "left" || status === "kicked") {
    return { bucket: BUCKET.NOT_IN_GROUP, reason: status, status };
  }
  if (!CURRENT_STATUSES.has(status)) {
    return { bucket: BUCKET.NOT_IN_GROUP, reason: status, status };
  }
  if (STAFF_STATUSES.has(status)) {
    return { bucket: BUCKET.PROTECTED, reason: status, status };
  }
  if (input.isEnvAdmin) {
    return { bucket: BUCKET.PROTECTED, reason: "admin-user-id", status };
  }
  if (input.explicitlyProtected) {
    return { bucket: BUCKET.PROTECTED, reason: "whitelist", status };
  }
  if (input.walletLinked) {
    return {
      bucket: BUCKET.WALLET_LINKED,
      reason: input.walletVerified ? "verified" : "registered",
      status,
    };
  }
  return { bucket: BUCKET.ELIGIBLE, reason: "no-linked-wallet", status };
}

async function lookupMember(chatId, userId, getChatMember) {
  try {
    const member = await getChatMember(chatId, userId);
    if (!member || typeof member !== "object") {
      return { ok: false, reason: "empty" };
    }
    return { ok: true, member };
  } catch (_err) {
    return { ok: false, reason: "error" };
  }
}

function loadCleanupContext(options = {}) {
  const walletLoaded = loadWalletStoreStrict(options);
  const points = options.points || loadPoints(options.pointsFile);
  const membersStore = options.membersStore || loadKnownMembersStore(options.membersFile);
  const builderStore = options.builderStore || loadBuilderStore(options.builderFile);
  let shopUsers = options.shopUsers;
  let presaleUsers = options.presaleUsers;
  let rewardByUser = options.rewardByUser;
  if (!shopUsers) {
    try {
      shopUsers = (loadShopStore(options.shopFile) || {}).users || {};
    } catch (_err) {
      shopUsers = {};
    }
  }
  if (!presaleUsers) {
    try {
      presaleUsers = (loadPresaleStore(options.presaleFile) || {}).users || {};
    } catch (_err) {
      presaleUsers = {};
    }
  }
  if (!rewardByUser) {
    try {
      rewardByUser = (loadRewardsStore(options.rewardsFile) || {}).byUser || {};
    } catch (_err) {
      rewardByUser = {};
    }
  }
  return {
    walletLoaded,
    points,
    membersStore,
    builderStore,
    shopUsers,
    presaleUsers,
    rewardByUser,
  };
}

function rowFromClassification(userId, classified, extras = {}) {
  return {
    userId,
    name: extras.name || "",
    username: extras.username || "",
    bucket: classified.bucket,
    reason: classified.reason,
    status: classified.status || extras.status || "",
  };
}

/**
 * Classify known Telegram IDs. Never bans/kicks. Never writes wallet/points stores.
 */
async function scanWalletCleanup(options = {}) {
  const ctx = loadCleanupContext(options);
  const chatId = resolveCleanupChatId(options);
  const getChatMember =
    typeof options.getChatMember === "function" ? options.getChatMember : null;
  const isAdminFn = typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;

  const buckets = {
    [BUCKET.WALLET_LINKED]: [],
    [BUCKET.ELIGIBLE]: [],
    [BUCKET.PROTECTED]: [],
    [BUCKET.NOT_IN_GROUP]: [],
    [BUCKET.LOOKUP_FAILED]: [],
  };

  const base = {
    walletStoreAvailable: ctx.walletLoaded.ok,
    telegramGroupConfigured: Boolean(chatId),
    knownIds: 0,
    removed: false,
    buckets,
  };

  if (!ctx.walletLoaded.ok) {
    return {
      ...base,
      abortReason: "wallet-store-unavailable",
    };
  }

  const knownIds = collectKnownTelegramIds({
    membersStore: ctx.membersStore,
    membersFile: options.membersFile,
    points: ctx.points,
    pointsFile: options.pointsFile,
    walletStore: ctx.walletLoaded.store,
    walletFile: options.walletFile,
    builderStore: ctx.builderStore,
    builderFile: options.builderFile,
    shopUsers: ctx.shopUsers,
    presaleUsers: ctx.presaleUsers,
    rewardByUser: ctx.rewardByUser,
    extraUserIds: options.extraUserIds,
  });
  base.knownIds = knownIds.length;

  if (!chatId || !getChatMember) {
    return {
      ...base,
      abortReason: chatId ? "missing-getChatMember" : "chat-not-configured",
    };
  }

  for (const userId of knownIds) {
    const looked = await lookupMember(chatId, userId, getChatMember);
    const linked = getLinkedWalletFromStore(ctx.walletLoaded.store, userId);
    const classified = classifyWalletCleanupMember({
      userId,
      lookupOk: looked.ok,
      lookupReason: looked.reason,
      member: looked.member,
      isEnvAdmin: isAdminFn(userId),
      explicitlyProtected: isExplicitlyProtected(userId, ctx.membersStore),
      walletLinked: Boolean(linked && linked.wallet),
      walletVerified: Boolean(linked && linked.verified),
    });
    const user = looked.member && looked.member.user ? looked.member.user : {};
    const record =
      ctx.membersStore.members && ctx.membersStore.members[userId]
        ? ctx.membersStore.members[userId]
        : null;
    const pointsUser = ctx.points.users && ctx.points.users[userId];
    const name =
      nameFromTelegramUser(user) ||
      displayNameFromRecord(record, "") ||
      (pointsUser && typeof pointsUser.name === "string" ? pointsUser.name.trim() : "") ||
      "";
    const row = rowFromClassification(userId, classified, {
      name,
      username: user.username || (record && record.username) || "",
      status: classified.status,
    });
    buckets[classified.bucket].push(row);
  }

  return base;
}

function formatPersonLine(row) {
  const id = row.userId;
  const name = row.name ? String(row.name).replace(/\s+/g, " ").trim() : "";
  const username = row.username
    ? String(row.username).replace(/^@+/, "").trim()
    : "";
  if (name && username) {
    return `${id} — ${name} (@${username})`;
  }
  if (name) {
    return `${id} — ${name}`;
  }
  if (username) {
    return `${id} — @${username}`;
  }
  return String(id);
}

function formatWalletCleanupPreview(result, options = {}) {
  const pageSize = options.pageSize || WALLET_CLEANUP_PAGE_SIZE;
  const eligible = (result.buckets && result.buckets[BUCKET.ELIGIBLE]) || [];
  const linked = (result.buckets && result.buckets[BUCKET.WALLET_LINKED]) || [];
  const protectedRows = (result.buckets && result.buckets[BUCKET.PROTECTED]) || [];
  const notInGroup = (result.buckets && result.buckets[BUCKET.NOT_IN_GROUP]) || [];
  const failed = (result.buckets && result.buckets[BUCKET.LOOKUP_FAILED]) || [];
  const totalPages = Math.max(1, Math.ceil(eligible.length / pageSize) || 1);
  const lastPage = totalPages - 1;
  const pageRaw = Number.isFinite(options.page) ? Math.trunc(options.page) : 0;
  const page = Math.max(0, Math.min(lastPage, pageRaw));
  const slice = eligible.slice(page * pageSize, page * pageSize + pageSize);

  const lines = [
    "🧹 Wallet cleanup preview",
    "NOBODY was removed. This is a dry run.",
    "",
    "Known members only — Telegram does not provide a complete historical group roster.",
    "",
    `Known Telegram IDs: ${result.knownIds || 0}`,
    `✅ Wallet linked: ${linked.length}`,
    `⬜ No wallet — eligible: ${eligible.length}`,
    `🛡 Protected: ${protectedRows.length}`,
    `🚪 Not currently in group: ${notInGroup.length}`,
    `❓ Unknown / lookup failed: ${failed.length}`,
  ];

  if (!result.walletStoreAvailable) {
    lines.push("", "Wallet store unavailable. No one is eligible. Fail closed.");
  } else if (result.abortReason === "chat-not-configured") {
    lines.push("", "Telegram group is not configured. Current members cannot be confirmed.");
  } else if (result.abortReason === "missing-getChatMember") {
    lines.push("", "Telegram lookup is unavailable. Current members cannot be confirmed.");
  }

  lines.push("", "To remove eligible members, run /walletcleanup_confirm in private chat.");
  lines.push("That command rescans immediately and does not trust this preview.");

  if (slice.length) {
    lines.push("", "Eligible (no connected wallet):");
    for (const row of slice) {
      lines.push(formatPersonLine(row));
    }
    if (lastPage > 0) {
      lines.push("", `Page ${page + 1}/${lastPage + 1}`);
    }
  }

  return {
    text: lines.join("\n"),
    page,
    lastPage,
    eligibleCount: eligible.length,
  };
}

function parseWalletCleanupCallback(data) {
  if (typeof data !== "string" || !data.startsWith(WALLET_CLEANUP_CALLBACK_PREFIX)) {
    return null;
  }
  const raw = data.slice(WALLET_CLEANUP_CALLBACK_PREFIX.length);
  if (!/^\d{1,4}$/.test(raw)) {
    return null;
  }
  return { page: Number.parseInt(raw, 10) };
}

function walletCleanupCallbackData(page) {
  return `${WALLET_CLEANUP_CALLBACK_PREFIX}${Math.max(0, Math.trunc(Number(page) || 0))}`;
}

function walletCleanupNavButtons(page, lastPage) {
  if (lastPage <= 0) {
    return [];
  }
  const row = [];
  if (page > 0) {
    row.push({ text: "⬅️ Previous", callback_data: walletCleanupCallbackData(page - 1) });
  }
  if (page < lastPage) {
    row.push({ text: "Next ➡️", callback_data: walletCleanupCallbackData(page + 1) });
  }
  return row;
}

async function kickThenUnban({ chatId, userId, banChatMember, unbanChatMember }) {
  if (typeof banChatMember !== "function" || typeof unbanChatMember !== "function") {
    return {
      kicked: false,
      unbanned: false,
      kickError: "missing-telegram-api",
      unbanError: null,
    };
  }
  try {
    await banChatMember(chatId, userId);
  } catch (err) {
    return {
      kicked: false,
      unbanned: false,
      kickError: err && err.message ? err.message : String(err),
      unbanError: null,
    };
  }
  try {
    await unbanChatMember(chatId, userId, { only_if_banned: true });
    return { kicked: true, unbanned: true, kickError: null, unbanError: null };
  } catch (err) {
    return {
      kicked: true,
      unbanned: false,
      kickError: null,
      unbanError: err && err.message ? err.message : String(err),
    };
  }
}

function logRemovalAttempt(row, action) {
  log(
    `[wallet-cleanup] userId=${row.userId} username=${row.username || "-"} name=${row.name || "-"} reason=${row.reason || "no-linked-wallet"} kicked=${action.kicked} unbanned=${action.unbanned} kickError=${action.kickError || "-"} unbanError=${action.unbanError || "-"}`
  );
}

/**
 * Rescan then kick+unban current eligible members. Never uses a cached preview list.
 */
async function confirmWalletCleanup(options = {}) {
  const scan = await scanWalletCleanup(options);
  const chatId = resolveCleanupChatId(options);
  const banChatMember =
    typeof options.banChatMember === "function" ? options.banChatMember : null;
  const unbanChatMember =
    typeof options.unbanChatMember === "function" ? options.unbanChatMember : null;

  const result = {
    removed: false,
    walletStoreAvailable: scan.walletStoreAvailable,
    abortReason: scan.abortReason || null,
    scannedEligible: (scan.buckets[BUCKET.ELIGIBLE] || []).length,
    kicked: [],
    kickFailed: [],
    unbanFailed: [],
    skipped: [],
    scan,
  };

  if (!scan.walletStoreAvailable || scan.abortReason) {
    return result;
  }
  if (typeof banChatMember !== "function" || typeof unbanChatMember !== "function") {
    result.abortReason = "missing-kick-api";
    return result;
  }

  const getChatMember = options.getChatMember;
  const ctx = loadCleanupContext(options);
  const isAdminFn = typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;

  for (const previewRow of scan.buckets[BUCKET.ELIGIBLE]) {
    const userId = previewRow.userId;
    const looked = await lookupMember(chatId, userId, getChatMember);
    const linked = getLinkedWalletFromStore(ctx.walletLoaded.store, userId);
    const classified = classifyWalletCleanupMember({
      userId,
      lookupOk: looked.ok,
      lookupReason: looked.reason,
      member: looked.member,
      isEnvAdmin: isAdminFn(userId),
      explicitlyProtected: isExplicitlyProtected(userId, ctx.membersStore),
      walletLinked: Boolean(linked && linked.wallet),
      walletVerified: Boolean(linked && linked.verified),
    });
    if (classified.bucket !== BUCKET.ELIGIBLE) {
      result.skipped.push({
        userId,
        name: previewRow.name,
        username: previewRow.username,
        reason: classified.reason,
        bucket: classified.bucket,
      });
      continue;
    }

    const action = await kickThenUnban({
      chatId,
      userId,
      banChatMember,
      unbanChatMember,
    });
    const row = {
      userId,
      name: previewRow.name,
      username: previewRow.username,
      reason: "no-linked-wallet",
      ...action,
      timestamp: Date.now(),
    };
    logRemovalAttempt(row, action);
    if (!action.kicked) {
      result.kickFailed.push(row);
      continue;
    }
    result.removed = true;
    if (!action.unbanned) {
      result.unbanFailed.push(row);
      logError(
        `[wallet-cleanup] UNBAN FAILED after kick userId=${userId} error=${action.unbanError || "unknown"}`
      );
      continue;
    }
    result.kicked.push(row);
  }

  return result;
}

function formatWalletCleanupConfirm(result) {
  if (!result.walletStoreAvailable) {
    return [
      "Wallet cleanup confirm aborted.",
      "Wallet store unavailable. Nobody was removed.",
    ].join("\n");
  }
  if (result.abortReason === "chat-not-configured") {
    return [
      "Wallet cleanup confirm aborted.",
      "Telegram group is not configured. Nobody was removed.",
    ].join("\n");
  }
  if (result.abortReason === "missing-kick-api" || result.abortReason === "missing-getChatMember") {
    return [
      "Wallet cleanup confirm aborted.",
      "Telegram removal API unavailable. Nobody was removed.",
    ].join("\n");
  }

  const lines = [
    "🧹 Wallet cleanup confirm",
    `Rescanned eligible: ${result.scannedEligible}`,
    `Kicked + unbanned: ${result.kicked.length}`,
    `Kick failed: ${result.kickFailed.length}`,
    `⚠️ Unban failed after kick: ${result.unbanFailed.length}`,
    `Skipped (no longer eligible): ${result.skipped.length}`,
  ];
  if (result.unbanFailed.length) {
    lines.push("", "UNBAN FAILED — these users may still be banned:");
    for (const row of result.unbanFailed) {
      lines.push(formatPersonLine(row));
    }
  }
  if (result.kickFailed.length) {
    lines.push("", "Kick failed (not removed):");
    for (const row of result.kickFailed) {
      lines.push(formatPersonLine(row));
    }
  }
  return lines.join("\n");
}

module.exports = {
  BUCKET,
  WALLET_CLEANUP_PAGE_SIZE,
  WALLET_CLEANUP_CALLBACK_PREFIX,
  classifyWalletCleanupMember,
  scanWalletCleanup,
  confirmWalletCleanup,
  kickThenUnban,
  formatWalletCleanupPreview,
  formatWalletCleanupConfirm,
  formatPersonLine,
  parseWalletCleanupCallback,
  walletCleanupCallbackData,
  walletCleanupNavButtons,
  resolveCleanupChatId,
};
