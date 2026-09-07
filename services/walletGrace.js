/**
 * 48-hour wallet-connection grace period for newly observed Telegram joins.
 * Deadlines live in known-members.json. Wallet-links.json remains authoritative.
 * Manual /walletcleanup confirm is unchanged and separate.
 */

const { isAdmin } = require("./points");
const {
  resolveWalletFile,
  readWalletSnapshot,
  getLinkedWalletFromStore,
} = require("./walletLinks");
const { getConfiguredCommunityChatId } = require("./chatFight");
const { log, error: logError } = require("../utils/logger");
const {
  loadKnownMembersStore,
  listPendingGraceMembers,
  getKnownMemberRecord,
  getWalletGraceNoticeState,
  isPendingWalletGrace,
  isExplicitlyProtected,
  markWalletRequirementSatisfied,
  markWalletGraceReminderSent,
  markWalletGraceEnforced,
  markWalletGraceScanAt,
  touchWalletEnforcementCheck,
  tryClaimWalletGraceNotice,
  releaseWalletGraceNoticeClaim,
  markWalletGraceNoticeSent,
  displayNameFromRecord,
  asTelegramUserId,
  REMINDER_STATE,
  NOTICE_STATE,
  WALLET_GRACE_MS,
} = require("./knownMembers");
const {
  BUCKET,
  classifyWalletCleanupMember,
  kickThenUnban,
} = require("./walletCleanup");

const GRACE_MS = WALLET_GRACE_MS;
const REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 15 * 60 * 1000;

const CONCISE_WALLET_GRACE_NOTICE = [
  "🥭 Welcome to ManGo!",
  "",
  "To stay in the community, connect your Solana wallet within 48 hours.",
  "",
  "Use /menu → Wallet to register your wallet.",
  "",
  "No wallet connected after 48 hours = automatic removal.",
  "",
  "You can always rejoin later and connect one.",
].join("\n");

function resolveSendMessage(options = {}) {
  if (typeof options.sendMessage === "function") {
    return options.sendMessage;
  }
  const telegram = options.telegram;
  if (telegram && typeof telegram.sendMessage === "function") {
    return (chatId, text, extra) => telegram.sendMessage(chatId, text, extra);
  }
  return null;
}

function hasConfirmedWalletGraceNotice(record) {
  return Boolean(record && record.walletGraceNoticeState === NOTICE_STATE.SENT);
}

function resolveGraceChatId(options = {}) {
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

function mentionFor(record) {
  if (record && record.username) {
    return `@${String(record.username).replace(/^@+/, "")}`;
  }
  if (record && record.displayName) {
    return String(record.displayName).trim();
  }
  return `user ${record && record.telegramUserId ? record.telegramUserId : "?"}`;
}

function formatHoursLeft(ms) {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

function formatRemainingShort(ms) {
  if (ms <= 0) {
    return "overdue";
  }
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 2) {
    return `${hours}h remaining`;
  }
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins === 1 ? "1m remaining" : `${mins}m remaining`;
}

function walletStatusLabel(linked) {
  if (!linked || !linked.wallet) {
    return "no wallet";
  }
  return linked.verified ? "verified wallet" : "registered wallet";
}

function reminderDue(record, now) {
  const deadline = Number(record && record.walletGraceDeadline) || 0;
  if (!deadline || now >= deadline) {
    return false;
  }
  return now >= deadline - REMINDER_AFTER_MS;
}

function deadlineExpired(record, now) {
  const deadline = Number(record && record.walletGraceDeadline) || 0;
  return Boolean(deadline) && now >= deadline;
}

function onWalletLinked(userId, options = {}) {
  try {
    return markWalletRequirementSatisfied(userId, options);
  } catch (err) {
    logError(
      "[wallet-grace] satisfy-on-link failed:",
      err && err.message ? err.message : err
    );
    return { ok: false, reason: "error" };
  }
}

function classifyGraceAdminRow(record, now, membersStore, linked) {
  const protectedUser = isExplicitlyProtected(record.telegramUserId, membersStore);
  if (record.reminderState === REMINDER_STATE.SATISFIED || record.walletRequirementSatisfiedAt) {
    return "satisfied";
  }
  if (record.reminderState === REMINDER_STATE.ENFORCED) {
    return "enforced";
  }
  if (protectedUser) {
    return "protected";
  }
  if (linked && linked.wallet) {
    return "satisfied";
  }
  if (deadlineExpired(record, now)) {
    return "overdue";
  }
  if (record.reminderState === REMINDER_STATE.SENT) {
    return "reminder-sent";
  }
  if (record.walletGraceDeadline != null) {
    return "pending";
  }
  return "none";
}

function formatWalletGraceSummary(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const store = loadKnownMembersStore(options.membersFile);
  const counts = {
    pending: 0,
    reminderSent: 0,
    satisfied: 0,
    overdue: 0,
    protected: 0,
  };
  for (const record of Object.values(store.members || {})) {
    const bucket = classifyGraceAdminRow(record, now, store, null);
    if (bucket === "pending") counts.pending += 1;
    else if (bucket === "reminder-sent") counts.reminderSent += 1;
    else if (bucket === "satisfied") counts.satisfied += 1;
    else if (bucket === "overdue") counts.overdue += 1;
    else if (bucket === "protected") counts.protected += 1;
  }
  return [
    "Wallet grace:",
    `⏳ Pending: ${counts.pending}`,
    `🔔 Reminder sent: ${counts.reminderSent}`,
    `✅ Satisfied: ${counts.satisfied}`,
    `⚠️ Overdue: ${counts.overdue}`,
    `🛡 Protected: ${counts.protected}`,
  ].join("\n");
}

function formatOneGraceMember(record, now, membersStore, linked) {
  const name = displayNameFromRecord(record, record.telegramUserId);
  const status = walletStatusLabel(linked);
  const remaining = formatRemainingShort(
    (Number(record.walletGraceDeadline) || 0) - now
  );
  const bucket = classifyGraceAdminRow(record, now, membersStore, linked);
  return `${name} — ${status} — ${remaining} (${bucket})`;
}

function formatWalletGraceAdmin(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const store = loadKnownMembersStore(options.membersFile);
  const userId = asTelegramUserId(options.userId);
  const walletLoaded = loadWalletStoreStrict(options);
  const walletStore = walletLoaded.ok ? walletLoaded.store : null;

  if (userId) {
    const record = getKnownMemberRecord(userId, store);
    if (!record) {
      return `No known-member record for ${userId}.`;
    }
    const linked = walletStore
      ? getLinkedWalletFromStore(walletStore, userId)
      : null;
    const lines = [
      `🥭 Wallet grace — ${userId}`,
      `Name: ${displayNameFromRecord(record, userId)}`,
      `State: ${classifyGraceAdminRow(record, now, store, linked)}`,
      `Reminder: ${record.reminderState || "none"}`,
      `Deadline: ${
        record.walletGraceDeadline
          ? new Date(record.walletGraceDeadline).toISOString()
          : "none"
      }`,
      `Remaining: ${
        record.walletGraceDeadline
          ? formatRemainingShort(record.walletGraceDeadline - now)
          : "n/a"
      }`,
      `Wallet: ${walletStatusLabel(linked)}`,
      `Protected: ${isExplicitlyProtected(userId, store) ? "yes" : "no"}`,
      `Notice: ${record.walletGraceNoticeState || "none"}`,
    ];
    if (!walletLoaded.ok) {
      lines.push("Wallet store unavailable — status may be incomplete.");
    }
    return lines.join("\n");
  }

  const pending = [];
  const reminderSent = [];
  const overdue = [];
  const counts = {
    pending: 0,
    reminderSent: 0,
    satisfied: 0,
    overdue: 0,
    protected: 0,
  };

  for (const record of Object.values(store.members || {})) {
    const linked = walletStore
      ? getLinkedWalletFromStore(walletStore, record.telegramUserId)
      : null;
    const bucket = classifyGraceAdminRow(record, now, store, linked);
    if (bucket === "pending") {
      counts.pending += 1;
      pending.push(formatOneGraceMember(record, now, store, linked));
    } else if (bucket === "reminder-sent") {
      counts.reminderSent += 1;
      reminderSent.push(formatOneGraceMember(record, now, store, linked));
    } else if (bucket === "satisfied") {
      counts.satisfied += 1;
    } else if (bucket === "overdue") {
      counts.overdue += 1;
      overdue.push(formatOneGraceMember(record, now, store, linked));
    } else if (bucket === "protected") {
      counts.protected += 1;
    }
  }

  const lines = [
    "🥭 Wallet grace",
    "",
    `⏳ Pending: ${counts.pending}`,
    `🔔 Reminder sent: ${counts.reminderSent}`,
    `✅ Satisfied: ${counts.satisfied}`,
    `⚠️ Overdue: ${counts.overdue}`,
    `🛡 Protected: ${counts.protected}`,
  ];

  const show = [...pending, ...reminderSent];
  if (show.length) {
    lines.push("", "Pending members:");
    for (const line of show.slice(0, 30)) {
      lines.push(line);
    }
    if (show.length > 30) {
      lines.push(`…and ${show.length - 30} more`);
    }
  }
  if (overdue.length) {
    lines.push("", "Overdue (not yet enforced):");
    for (const line of overdue.slice(0, 20)) {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

async function classifyLiveMember(userId, options = {}) {
  const chatId = resolveGraceChatId(options);
  const getChatMember =
    typeof options.getChatMember === "function" ? options.getChatMember : null;
  const isAdminFn = typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;
  const membersStore = options.membersStore || loadKnownMembersStore(options.membersFile);

  if (!chatId || typeof getChatMember !== "function") {
    return { ok: false, reason: "missing-telegram" };
  }

  const walletLoaded = loadWalletStoreStrict(options);
  if (!walletLoaded.ok) {
    return { ok: false, reason: "wallet-store-unavailable" };
  }

  const looked = await lookupMember(chatId, userId, getChatMember);
  const linked = getLinkedWalletFromStore(walletLoaded.store, userId);
  const classified = classifyWalletCleanupMember({
    userId,
    lookupOk: looked.ok,
    lookupReason: looked.reason,
    member: looked.member,
    isEnvAdmin: isAdminFn(userId),
    explicitlyProtected: isExplicitlyProtected(userId, membersStore),
    walletLinked: Boolean(linked && linked.wallet),
    walletVerified: Boolean(linked && linked.verified),
  });
  return {
    ok: true,
    classified,
    linked,
    looked,
    walletLoaded,
    membersStore,
    chatId,
  };
}

async function maybeSendWalletGraceNotice(input = {}) {
  const userId = asTelegramUserId(input.userId);
  if (!userId) {
    return { ok: false, reason: "invalid-user", sent: false };
  }
  const membersFile = input.membersFile;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  let state;
  try {
    state = getWalletGraceNoticeState(userId, membersFile);
  } catch (err) {
    logError(
      "[wallet-grace] notice state read failed:",
      err && err.message ? err.message : err
    );
    return { ok: false, reason: "store-error", sent: false };
  }
  if (
    state === NOTICE_STATE.SENT ||
    state === NOTICE_STATE.NOT_REQUIRED ||
    state == null
  ) {
    return { ok: false, reason: state ? `not-needed:${state}` : "not-needed", sent: false };
  }

  const sendMessage = resolveSendMessage(input);
  const chatId =
    input.chatId != null && String(input.chatId).trim() !== ""
      ? String(input.chatId).trim()
      : resolveGraceChatId(input);
  if (typeof sendMessage !== "function" || !chatId) {
    return { ok: false, reason: "no-send", sent: false };
  }

  const claimed = tryClaimWalletGraceNotice(userId, {
    membersFile,
    now,
    staleMs: input.staleMs,
  });
  if (!claimed || claimed.ok !== true) {
    return {
      ok: false,
      reason: (claimed && claimed.reason) || "already-claimed",
      sent: false,
    };
  }

  try {
    await sendMessage(chatId, CONCISE_WALLET_GRACE_NOTICE);
    markWalletGraceNoticeSent(userId, { membersFile, now });
    log(`[wallet-grace] notice sent userId=${userId}`);
    return { ok: true, sent: true, reason: "sent" };
  } catch (err) {
    try {
      releaseWalletGraceNoticeClaim(userId, { membersFile });
    } catch (_releaseErr) {
      /* persist-before-send claim stays sending until stale retry */
    }
    logError(
      `[wallet-grace] notice send failed userId=${userId}:`,
      err && err.message ? err.message : err
    );
    return {
      ok: false,
      reason: "send-failed",
      sent: false,
      error: err && err.message ? err.message : String(err),
    };
  }
}

async function maybeSendReminder(record, now, options, result) {
  if (!hasConfirmedWalletGraceNotice(record)) {
    return;
  }
  if (!reminderDue(record, now)) {
    return;
  }
  if (record.reminderState === REMINDER_STATE.SENT) {
    return;
  }
  if (typeof options.sendMessage !== "function") {
    return;
  }

  const live = await classifyLiveMember(record.telegramUserId, {
    ...options,
    membersStore: options.membersStore,
  });
  if (!live.ok) {
    result.skipped.push({
      userId: record.telegramUserId,
      reason: live.reason,
      action: "reminder",
    });
    return;
  }
  if (live.classified.bucket !== BUCKET.ELIGIBLE) {
    if (live.classified.bucket === BUCKET.WALLET_LINKED) {
      onWalletLinked(record.telegramUserId, { now, membersFile: options.membersFile });
    }
    result.skipped.push({
      userId: record.telegramUserId,
      reason: live.classified.reason,
      action: "reminder",
    });
    return;
  }

  const marked = markWalletGraceReminderSent(record.telegramUserId, {
    now,
    membersFile: options.membersFile,
  });
  if (!marked || marked.ok !== true) {
    result.skipped.push({
      userId: record.telegramUserId,
      reason: (marked && marked.reason) || "already-marked",
      action: "reminder",
    });
    return;
  }

  const remaining = Math.max(0, Number(record.walletGraceDeadline) - now);
  const text = [
    `⏳ ${mentionFor(record)} — remember to connect your wallet.`,
    `You have about ${formatHoursLeft(remaining)} left before automatic removal.`,
  ].join("\n");

  try {
    await options.sendMessage(live.chatId, text);
    result.reminders.push({ userId: record.telegramUserId });
    log(`[wallet-grace] reminder sent userId=${record.telegramUserId}`);
  } catch (err) {
    result.reminderFailed.push({
      userId: record.telegramUserId,
      error: err && err.message ? err.message : String(err),
    });
    logError(
      `[wallet-grace] reminder send failed userId=${record.telegramUserId} (not retried)`
    );
  }
}

async function maybeEnforce(record, now, options, result) {
  if (!hasConfirmedWalletGraceNotice(record)) {
    result.skipped.push({
      userId: record.telegramUserId,
      reason: "notice-not-sent",
      action: "enforce",
    });
    return;
  }
  if (!deadlineExpired(record, now)) {
    return;
  }
  if (typeof options.banChatMember !== "function" || typeof options.unbanChatMember !== "function") {
    result.skipped.push({
      userId: record.telegramUserId,
      reason: "missing-kick-api",
      action: "enforce",
    });
    return;
  }

  const live = await classifyLiveMember(record.telegramUserId, options);
  touchWalletEnforcementCheck(record.telegramUserId, now, {
    membersFile: options.membersFile,
  });

  if (!live.ok) {
    result.skipped.push({
      userId: record.telegramUserId,
      reason: live.reason,
      action: "enforce",
    });
    return;
  }

  const freshWallet = loadWalletStoreStrict(options);
  if (!freshWallet.ok) {
    result.skipped.push({
      userId: record.telegramUserId,
      reason: "wallet-store-unavailable",
      action: "enforce",
    });
    return;
  }
  const linked = getLinkedWalletFromStore(freshWallet.store, record.telegramUserId);
  const membersStore = loadKnownMembersStore(options.membersFile);
  const freshRecord = membersStore.members[record.telegramUserId];
  if (
    !freshRecord ||
    !isPendingWalletGrace(freshRecord) ||
    !deadlineExpired(freshRecord, now) ||
    !hasConfirmedWalletGraceNotice(freshRecord)
  ) {
    result.skipped.push({
      userId: record.telegramUserId,
      reason: !hasConfirmedWalletGraceNotice(freshRecord)
        ? "notice-not-sent"
        : "grace-no-longer-pending",
      action: "enforce",
    });
    return;
  }

  const classified = classifyWalletCleanupMember({
    userId: record.telegramUserId,
    lookupOk: live.looked.ok,
    lookupReason: live.looked.reason,
    member: live.looked.member,
    isEnvAdmin: (typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin)(
      record.telegramUserId
    ),
    explicitlyProtected: isExplicitlyProtected(record.telegramUserId, membersStore),
    walletLinked: Boolean(linked && linked.wallet),
    walletVerified: Boolean(linked && linked.verified),
  });

  if (classified.bucket === BUCKET.WALLET_LINKED) {
    onWalletLinked(record.telegramUserId, { now, membersFile: options.membersFile });
    result.skipped.push({
      userId: record.telegramUserId,
      reason: classified.reason,
      action: "enforce",
    });
    return;
  }
  if (classified.bucket !== BUCKET.ELIGIBLE) {
    result.skipped.push({
      userId: record.telegramUserId,
      reason: classified.reason || classified.bucket,
      action: "enforce",
    });
    return;
  }

  const action = await kickThenUnban({
    chatId: live.chatId,
    userId: record.telegramUserId,
    banChatMember: options.banChatMember,
    unbanChatMember: options.unbanChatMember,
  });
  const row = {
    userId: record.telegramUserId,
    name: displayNameFromRecord(record, ""),
    username: record.username || "",
    reason: "wallet-grace-expired",
    ...action,
    timestamp: now,
  };
  log(
    `[wallet-grace] userId=${row.userId} kicked=${action.kicked} unbanned=${action.unbanned} kickError=${action.kickError || "-"} unbanError=${action.unbanError || "-"}`
  );

  if (!action.kicked) {
    result.kickFailed.push(row);
    return;
  }

  markWalletGraceEnforced(record.telegramUserId, {
    now,
    membersFile: options.membersFile,
  });
  result.enforced.push(row);

  if (!action.unbanned) {
    result.unbanFailed.push(row);
    logError(
      `[wallet-grace] UNBAN FAILED after kick userId=${record.telegramUserId} error=${action.unbanError || "unknown"}`
    );
  }
}

async function processWalletGraceTick(options = {}) {
  const chatId = resolveGraceChatId(options);
  const getChatMember =
    typeof options.getChatMember === "function" ? options.getChatMember : null;
  if (!chatId || typeof getChatMember !== "function") {
    return { skipped: "missing-telegram" };
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const store = loadKnownMembersStore(options.membersFile);
  const lastScan = Number(store.lastWalletGraceScanAt) || 0;
  if (!options.force && lastScan && now - lastScan < SCAN_INTERVAL_MS) {
    return { skipped: "throttled", lastScan };
  }

  try {
    markWalletGraceScanAt(now, { membersFile: options.membersFile });
  } catch (err) {
    logError(
      "[wallet-grace] failed to persist lastWalletGraceScanAt:",
      err && err.message ? err.message : err
    );
  }

  const result = {
    reminders: [],
    reminderFailed: [],
    notices: [],
    noticeFailed: [],
    enforced: [],
    kickFailed: [],
    unbanFailed: [],
    skipped: [],
    scanned: 0,
  };

  const pending = listPendingGraceMembers(options.membersFile);
  result.scanned = pending.length;
  const tickOptions = { ...options, chatId, membersStore: store };

  for (const record of pending) {
    try {
      const noticeSend = await maybeSendWalletGraceNotice({
        userId: record.telegramUserId,
        chatId,
        sendMessage: options.sendMessage,
        telegram: options.telegram,
        membersFile: options.membersFile,
        now,
      });
      if (noticeSend && noticeSend.sent) {
        result.notices.push({ userId: record.telegramUserId });
        continue;
      }
      if (noticeSend && noticeSend.reason === "send-failed") {
        result.noticeFailed.push({
          userId: record.telegramUserId,
          error: noticeSend.error || "send-failed",
        });
      }
      const fresh =
        getKnownMemberRecord(record.telegramUserId, options.membersFile) || record;
      if (!hasConfirmedWalletGraceNotice(fresh)) {
        if (deadlineExpired(fresh, now)) {
          result.skipped.push({
            userId: record.telegramUserId,
            reason: "notice-not-sent",
            action: "enforce",
          });
        }
        continue;
      }
      if (reminderDue(fresh, now) && !deadlineExpired(fresh, now)) {
        await maybeSendReminder(fresh, now, tickOptions, result);
      }
      if (deadlineExpired(fresh, now)) {
        await maybeEnforce(fresh, now, tickOptions, result);
      }
    } catch (err) {
      result.skipped.push({
        userId: record.telegramUserId,
        reason: err && err.message ? err.message : String(err),
        action: "tick",
      });
      logError(
        `[wallet-grace] member tick failed userId=${record.telegramUserId}:`,
        err && err.message ? err.message : err
      );
    }
  }

  return result;
}

module.exports = {
  GRACE_MS,
  REMINDER_AFTER_MS,
  SCAN_INTERVAL_MS,
  CONCISE_WALLET_GRACE_NOTICE,
  processWalletGraceTick,
  maybeSendWalletGraceNotice,
  onWalletLinked,
  formatWalletGraceAdmin,
  formatWalletGraceSummary,
  reminderDue,
  deadlineExpired,
};
