/**
 * Persistent known-member registry for the community group.
 * Observation log only: does not prove current Telegram membership.
 * Cleanup always re-checks with getChatMember. Wallet status lives in wallet-links.json.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const lockfile = require("proper-lockfile");
const { writeJsonFileAtomic } = require("../utils/json");
const { error: logError } = require("../utils/logger");
const { loadPoints, isAdmin } = require("./points");
const {
  resolveWalletFile,
  readWalletSnapshot,
  getLinkedWalletFromStore,
} = require("./walletLinks");
const { loadBuilderStore } = require("./communityBuilderStore");
const { getConfiguredCommunityChatId } = require("./chatFight");

const DEFAULT_MEMBERS_FILE = path.resolve(
  __dirname,
  "..",
  "data",
  "known-members.json"
);
const STORE_VERSION = 1;

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

const SOURCE = Object.freeze({
  POINTS: "points",
  WALLET: "wallet",
  BUILDER_WELCOME: "builder-welcome",
  BUILDER_REFERRAL: "builder-referral",
  BUILDER: "builder",
  NEW_CHAT_MEMBERS: "new_chat_members",
  CHAT_MEMBER: "chat_member",
  LEFT_CHAT_MEMBER: "left_chat_member",
  ACTIVITY: "activity",
  SHOP: "shop",
  PRESALE: "presale",
  REWARD: "reward",
});

const JOIN_STATUSES = new Set(["member", "restricted", "administrator", "creator"]);
const LEFT_STATUSES = new Set(["left", "kicked"]);

const WALLET_GRACE_MS = 48 * 60 * 60 * 1000;

const REMINDER_STATE = Object.freeze({
  PENDING: "pending",
  SENT: "sent",
  SATISFIED: "satisfied",
  ENFORCED: "enforced",
});

const NOTICE_STATE = Object.freeze({
  PENDING: "pending",
  SENDING: "sending",
  SENT: "sent",
  NOT_REQUIRED: "not-required",
});

const NOTICE_STATES = new Set(Object.values(NOTICE_STATE));
const NOTICE_CLAIM_STALE_MS = 2 * 60 * 1000;

function normalizeNoticeState(value) {
  if (value == null || value === "") {
    return null;
  }
  const state = String(value);
  return NOTICE_STATES.has(state) ? state : null;
}

let membersFileOverride = null;
let autoTestMembersFile = null;

function setKnownMembersFileForTests(filePath) {
  membersFileOverride = filePath || null;
}

function isLikelyTestProcess() {
  if (process.env.MANGO_FORCE_TEST_KNOWN_MEMBERS === "1") {
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

function getAutoTestMembersFile() {
  if (!autoTestMembersFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-known-members-"));
    autoTestMembersFile = path.join(dir, "known-members.json");
  }
  return autoTestMembersFile;
}

function resolveMembersFile(explicit) {
  if (explicit) {
    return explicit;
  }
  if (membersFileOverride) {
    return membersFileOverride;
  }
  const fromEnv =
    typeof process.env.KNOWN_MEMBERS_FILE === "string"
      ? process.env.KNOWN_MEMBERS_FILE.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  if (isLikelyTestProcess()) {
    return getAutoTestMembersFile();
  }
  return DEFAULT_MEMBERS_FILE;
}

function sleepSync(ms) {
  const delay = Math.max(0, Math.ceil(ms));
  if (delay === 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    members: {},
    protectedUserIds: {},
    lastWalletGraceScanAt: 0,
  };
}

function asTelegramUserId(raw) {
  if (raw === undefined || raw === null) {
    return "";
  }
  const uid = String(raw).trim();
  return /^\d{1,20}$/.test(uid) ? uid : "";
}

function addTelegramUserId(ids, raw) {
  const uid = asTelegramUserId(raw);
  if (uid) {
    ids.add(uid);
  }
}

function clipName(value, max = 64) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

function clipUsername(value) {
  const raw = clipName(value, 32);
  return raw.replace(/^@+/, "");
}

function asObjectMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeMemberRecord(userId, raw) {
  const telegramUserId = asTelegramUserId(userId);
  if (!telegramUserId) {
    return null;
  }
  const src = raw && typeof raw === "object" ? raw : {};
  const sources = Array.isArray(src.sources)
    ? [...new Set(src.sources.map((s) => String(s || "").trim()).filter(Boolean))]
    : [];
  return {
    telegramUserId,
    username: clipUsername(src.username) || "",
    displayName: clipName(src.displayName) || "",
    firstSeenAt: Number(src.firstSeenAt) || 0,
    lastSeenAt: Number(src.lastSeenAt) || 0,
    joinedAt: Number(src.joinedAt) || 0,
    leftAt: Number(src.leftAt) || 0,
    sources,
    walletGraceDeadline: src.walletGraceDeadline == null ? null : Number(src.walletGraceDeadline) || null,
    reminderState: src.reminderState == null ? null : String(src.reminderState),
    walletRequirementSatisfiedAt:
      src.walletRequirementSatisfiedAt == null
        ? null
        : Number(src.walletRequirementSatisfiedAt) || null,
    lastWalletEnforcementCheckAt:
      src.lastWalletEnforcementCheckAt == null
        ? null
        : Number(src.lastWalletEnforcementCheckAt) || null,
    walletGraceNoticeState: normalizeNoticeState(src.walletGraceNoticeState),
    walletGraceNoticeClaimedAt:
      src.walletGraceNoticeClaimedAt == null
        ? null
        : Number(src.walletGraceNoticeClaimedAt) || null,
  };
}

function normalizeProtected(raw) {
  const map = {};
  const src = asObjectMap(raw);
  for (const [key, value] of Object.entries(src)) {
    const uid = asTelegramUserId(key);
    if (!uid) {
      continue;
    }
    const row = value && typeof value === "object" ? value : {};
    map[uid] = {
      addedAt: Number(row.addedAt) || 0,
      note: clipName(row.note, 80),
    };
  }
  return map;
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return store;
  }
  const members = asObjectMap(raw.members);
  for (const [key, value] of Object.entries(members)) {
    const record = normalizeMemberRecord(key, value);
    if (record) {
      store.members[record.telegramUserId] = record;
    }
  }
  store.protectedUserIds = normalizeProtected(raw.protectedUserIds);
  store.lastWalletGraceScanAt = Number(raw.lastWalletGraceScanAt) || 0;
  return store;
}

function readSnapshot(filePath, options = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      if (options.strict) {
        throw new Error("known-members.json is empty");
      }
      return emptyStore();
    }
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (options.strict && err && err.code !== "ENOENT") {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`Failed to read known-members.json: ${message}`);
    }
    if (!options.strict) {
      logError("Error reading known-members.json:", err);
    }
    return emptyStore();
  }
}

function acquireLock(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    writeJsonFileAtomic(filePath, emptyStore());
  }
  let lastError;
  let timeoutMs = LOCK_RETRY.minTimeoutMs;
  for (let attempt = 0; attempt < LOCK_RETRY.attempts; attempt += 1) {
    try {
      return lockfile.lockSync(filePath, LOCK_OPTIONS);
    } catch (err) {
      lastError = err;
      if (!err || err.code !== "ELOCKED") {
        const message = err && err.message ? err.message : String(err);
        throw new Error(`Failed to acquire known-members.json lock: ${message}`);
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
  throw new Error(`Failed to acquire known-members.json lock: ${message}`);
}

function mutateKnownMembersStore(mutator, explicitFile) {
  if (typeof mutator !== "function") {
    throw new TypeError("mutateKnownMembersStore requires a mutator function");
  }
  const filePath = resolveMembersFile(explicitFile);
  const release = acquireLock(filePath);
  try {
    const data = readSnapshot(filePath, { strict: true });
    const result = mutator(data);
    writeJsonFileAtomic(filePath, data);
    return result;
  } finally {
    try {
      release();
    } catch (err) {
      logError("Failed to release known-members.json lock:", err);
    }
  }
}

function loadKnownMembersStore(explicitFile) {
  return readSnapshot(resolveMembersFile(explicitFile));
}

function isCommunityChat(chatId) {
  const configured = getConfiguredCommunityChatId();
  if (!configured) {
    return false;
  }
  return String(chatId) === String(configured);
}

function isJoinTransition(oldStatus, newStatus) {
  const from = typeof oldStatus === "string" ? oldStatus : "";
  const to = typeof newStatus === "string" ? newStatus : "";
  if (!JOIN_STATUSES.has(to)) {
    return false;
  }
  if (!from) {
    return true;
  }
  return LEFT_STATUSES.has(from) || from === "unknown";
}

function isLeaveTransition(oldStatus, newStatus) {
  const from = typeof oldStatus === "string" ? oldStatus : "";
  const to = typeof newStatus === "string" ? newStatus : "";
  return JOIN_STATUSES.has(from) && LEFT_STATUSES.has(to);
}

function upsertMember(store, input, now) {
  const uid = asTelegramUserId(input && input.userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const existing = store.members[uid] || normalizeMemberRecord(uid, {});
  const source = typeof input.source === "string" && input.source.trim()
    ? input.source.trim()
    : "";
  if (source && !existing.sources.includes(source)) {
    existing.sources.push(source);
  }
  const username = clipUsername(input.username);
  if (username) {
    existing.username = username;
  }
  const displayName = clipName(input.displayName);
  if (displayName) {
    existing.displayName = displayName;
  }
  if (!existing.firstSeenAt) {
    existing.firstSeenAt = now;
  }
  existing.lastSeenAt = now;
  if (input.joined === true) {
    if (!existing.joinedAt) {
      existing.joinedAt = now;
    }
    existing.leftAt = 0;
  }
  if (input.left === true) {
    existing.leftAt = now;
  }
  if (existing.walletGraceDeadline === undefined) {
    existing.walletGraceDeadline = null;
  }
  if (existing.reminderState === undefined) {
    existing.reminderState = null;
  }
  if (existing.walletRequirementSatisfiedAt === undefined) {
    existing.walletRequirementSatisfiedAt = null;
  }
  if (existing.lastWalletEnforcementCheckAt === undefined) {
    existing.lastWalletEnforcementCheckAt = null;
  }
  if (existing.walletGraceNoticeState === undefined) {
    existing.walletGraceNoticeState = null;
  }
  if (existing.walletGraceNoticeClaimedAt === undefined) {
    existing.walletGraceNoticeClaimedAt = null;
  }
  store.members[uid] = existing;
  return { ok: true, record: existing };
}

function shouldStartWalletGrace(existing) {
  if (!existing) {
    return true;
  }
  if (Number(existing.leftAt) > 0) {
    return true;
  }
  if (!Number(existing.joinedAt)) {
    return true;
  }
  return false;
}

function userHasLinkedWallet(userId, walletFile) {
  try {
    const store = readWalletSnapshot(resolveWalletFile(walletFile));
    const linked = getLinkedWalletFromStore(store, userId);
    return Boolean(linked && linked.wallet);
  } catch (_err) {
    return false;
  }
}

function isExemptFromWalletGraceNotice(userId, store, newStatus, options = {}) {
  const isAdminFn =
    typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;
  try {
    if (isAdminFn(userId)) {
      return true;
    }
  } catch (_err) {
    /* fail open to a pending notice rather than skip enforcement text */
  }
  if (isExplicitlyProtected(userId, store)) {
    return true;
  }
  const status = typeof newStatus === "string" ? newStatus : "";
  return status === "administrator" || status === "creator";
}

function applyWalletGraceOnJoin(record, now, options = {}) {
  const graceMs =
    Number.isFinite(options.graceMs) && options.graceMs > 0
      ? options.graceMs
      : WALLET_GRACE_MS;
  record.joinedAt = now;
  record.leftAt = 0;
  record.walletGraceDeadline = now + graceMs;
  record.reminderState = REMINDER_STATE.PENDING;
  record.walletRequirementSatisfiedAt = null;
  record.lastWalletEnforcementCheckAt = null;
  record.walletGraceNoticeState = NOTICE_STATE.PENDING;
  record.walletGraceNoticeClaimedAt = null;
  const linked =
    options.alreadyLinked === true ||
    userHasLinkedWallet(record.telegramUserId, options.walletFile);
  if (linked) {
    record.reminderState = REMINDER_STATE.SATISFIED;
    record.walletRequirementSatisfiedAt = now;
    record.walletGraceNoticeState = NOTICE_STATE.NOT_REQUIRED;
  } else if (options.exemptFromKick === true) {
    record.walletGraceNoticeState = NOTICE_STATE.NOT_REQUIRED;
  }
  return record;
}

function isPendingWalletGrace(record) {
  if (!record || record.walletGraceDeadline == null) {
    return false;
  }
  if (record.walletRequirementSatisfiedAt) {
    return false;
  }
  const state = record.reminderState;
  if (state === REMINDER_STATE.SATISFIED || state === REMINDER_STATE.ENFORCED) {
    return false;
  }
  return true;
}

function listPendingGraceMembers(storeOrFile) {
  const store =
    storeOrFile && typeof storeOrFile === "object" && storeOrFile.members
      ? storeOrFile
      : loadKnownMembersStore(storeOrFile);
  return Object.values(store.members || {}).filter(isPendingWalletGrace);
}

function getKnownMemberRecord(userId, storeOrFile) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return null;
  }
  const store =
    storeOrFile && typeof storeOrFile === "object" && storeOrFile.members
      ? storeOrFile
      : loadKnownMembersStore(storeOrFile);
  return (store.members && store.members[uid]) || null;
}

function recordObservedJoin(input = {}, options = {}) {
  const uid = asTelegramUserId(input.userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  if (input.isBot) {
    return { ok: false, reason: "bot" };
  }
  if (input.chatId != null && !isCommunityChat(input.chatId) && !options.skipChatCheck) {
    return { ok: false, reason: "wrong-chat" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const source = input.source || SOURCE.NEW_CHAT_MEMBERS;
  const alreadyLinked = userHasLinkedWallet(uid, options.walletFile);
  try {
    return mutateKnownMembersStore((store) => {
      const existingBefore = store.members[uid] || null;
      const startGrace = shouldStartWalletGrace(existingBefore);
      const result = upsertMember(
        store,
        {
          userId: uid,
          username: input.username,
          displayName: input.displayName,
          source,
          joined: true,
        },
        now
      );
      if (!result.ok) {
        return result;
      }
      if (startGrace) {
        const newStatus =
          typeof input.newStatus === "string" ? input.newStatus : "";
        applyWalletGraceOnJoin(result.record, now, {
          ...options,
          alreadyLinked,
          exemptFromKick:
            options.exemptFromKick === true ||
            isExemptFromWalletGraceNotice(uid, store, newStatus, options),
        });
      }
      return { ...result, graceStarted: startGrace };
    }, options.membersFile);
  } catch (err) {
    logError("[known-members] record join failed:", err && err.message ? err.message : err);
    return { ok: false, reason: "store-error" };
  }
}

function recordObservedLeave(input = {}, options = {}) {
  const uid = asTelegramUserId(input.userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  if (input.chatId != null && !isCommunityChat(input.chatId) && !options.skipChatCheck) {
    return { ok: false, reason: "wrong-chat" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const source = input.source || SOURCE.LEFT_CHAT_MEMBER;
  try {
    return mutateKnownMembersStore((store) => {
      return upsertMember(
        store,
        {
          userId: uid,
          username: input.username,
          displayName: input.displayName,
          source,
          left: true,
        },
        now
      );
    }, options.membersFile);
  } catch (err) {
    logError("[known-members] record leave failed:", err && err.message ? err.message : err);
    return { ok: false, reason: "store-error" };
  }
}

function recordChatMemberTransition(input = {}, options = {}) {
  if (input.isBot) {
    return { ok: false, reason: "bot" };
  }
  if (isJoinTransition(input.oldStatus, input.newStatus)) {
    return recordObservedJoin(
      { ...input, source: SOURCE.CHAT_MEMBER },
      options
    );
  }
  if (isLeaveTransition(input.oldStatus, input.newStatus)) {
    return recordObservedLeave(
      { ...input, source: SOURCE.CHAT_MEMBER },
      options
    );
  }
  return { ok: false, reason: "not-join-or-leave" };
}

function markWalletRequirementSatisfied(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  try {
    return mutateKnownMembersStore((store) => {
      const existing = store.members[uid];
      if (!existing) {
        upsertMember(
          store,
          {
            userId: uid,
            source: SOURCE.WALLET,
          },
          now
        );
      }
      const record = store.members[uid];
      if (!record) {
        return { ok: false, reason: "missing-record" };
      }
      record.reminderState = REMINDER_STATE.SATISFIED;
      record.walletRequirementSatisfiedAt = now;
      record.lastWalletEnforcementCheckAt = now;
      record.walletGraceNoticeState = NOTICE_STATE.NOT_REQUIRED;
      record.walletGraceNoticeClaimedAt = null;
      return { ok: true, record };
    }, options.membersFile);
  } catch (err) {
    logError(
      "[known-members] mark wallet requirement satisfied failed:",
      err && err.message ? err.message : err
    );
    return { ok: false, reason: "store-error" };
  }
}

function getWalletGraceNoticeState(userId, storeOrFile) {
  const record = getKnownMemberRecord(userId, storeOrFile);
  return record ? record.walletGraceNoticeState : null;
}

function tryClaimWalletGraceNotice(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const staleMs =
    Number.isFinite(options.staleMs) && options.staleMs >= 0
      ? options.staleMs
      : NOTICE_CLAIM_STALE_MS;
  try {
    return mutateKnownMembersStore((store) => {
      const record = store.members[uid];
      if (!record) {
        return { ok: false, reason: "missing-record" };
      }
      const state = record.walletGraceNoticeState;
      if (state === NOTICE_STATE.PENDING) {
        record.walletGraceNoticeState = NOTICE_STATE.SENDING;
        record.walletGraceNoticeClaimedAt = now;
        return { ok: true, record };
      }
      if (state === NOTICE_STATE.SENDING) {
        const claimedAt = Number(record.walletGraceNoticeClaimedAt) || 0;
        const stale = !claimedAt || now - claimedAt >= staleMs;
        if (!stale) {
          return { ok: false, reason: "already-claimed", record };
        }
        record.walletGraceNoticeClaimedAt = now;
        return { ok: true, record, reclaimed: true };
      }
      return {
        ok: false,
        reason: state ? `not-pending:${state}` : "not-pending",
        record,
      };
    }, options.membersFile);
  } catch (err) {
    logError(
      "[known-members] claim wallet grace notice failed:",
      err && err.message ? err.message : err
    );
    return { ok: false, reason: "store-error" };
  }
}

function releaseWalletGraceNoticeClaim(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  try {
    return mutateKnownMembersStore((store) => {
      const record = store.members[uid];
      if (!record) {
        return { ok: false, reason: "missing-record" };
      }
      if (record.walletGraceNoticeState !== NOTICE_STATE.SENDING) {
        return { ok: false, reason: "not-sending", record };
      }
      record.walletGraceNoticeState = NOTICE_STATE.PENDING;
      record.walletGraceNoticeClaimedAt = null;
      return { ok: true, record };
    }, options.membersFile);
  } catch (err) {
    logError(
      "[known-members] release wallet grace notice claim failed:",
      err && err.message ? err.message : err
    );
    return { ok: false, reason: "store-error" };
  }
}

function markWalletGraceNoticeSent(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  try {
    return mutateKnownMembersStore((store) => {
      const record = store.members[uid];
      if (!record) {
        return { ok: false, reason: "missing-record" };
      }
      record.walletGraceNoticeState = NOTICE_STATE.SENT;
      record.walletGraceNoticeClaimedAt =
        Number(record.walletGraceNoticeClaimedAt) || now;
      return { ok: true, record };
    }, options.membersFile);
  } catch (err) {
    logError(
      "[known-members] mark wallet grace notice sent failed:",
      err && err.message ? err.message : err
    );
    return { ok: false, reason: "store-error" };
  }
}

function markWalletGraceReminderSent(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return mutateKnownMembersStore((store) => {
    const record = store.members[uid];
    if (!record) {
      return { ok: false, reason: "missing-record" };
    }
    if (
      record.reminderState === REMINDER_STATE.SENT ||
      record.reminderState === REMINDER_STATE.SATISFIED ||
      record.reminderState === REMINDER_STATE.ENFORCED
    ) {
      return { ok: false, reason: "already-marked", record };
    }
    record.reminderState = REMINDER_STATE.SENT;
    record.lastWalletEnforcementCheckAt = now;
    return { ok: true, record };
  }, options.membersFile);
}

function markWalletGraceEnforced(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return mutateKnownMembersStore((store) => {
    const record = store.members[uid];
    if (!record) {
      return { ok: false, reason: "missing-record" };
    }
    record.reminderState = REMINDER_STATE.ENFORCED;
    record.leftAt = now;
    record.lastWalletEnforcementCheckAt = now;
    return { ok: true, record };
  }, options.membersFile);
}

function markWalletGraceScanAt(now, options = {}) {
  const ts = Number.isFinite(now) ? now : Date.now();
  return mutateKnownMembersStore((store) => {
    store.lastWalletGraceScanAt = ts;
    return { ok: true, lastWalletGraceScanAt: ts };
  }, options.membersFile);
}

function touchWalletEnforcementCheck(userId, now, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  return mutateKnownMembersStore((store) => {
    const record = store.members[uid];
    if (!record) {
      return { ok: false, reason: "missing-record" };
    }
    record.lastWalletEnforcementCheckAt = ts;
    return { ok: true, record };
  }, options.membersFile);
}

function addProtectedUser(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return mutateKnownMembersStore((store) => {
    store.protectedUserIds[uid] = {
      addedAt: now,
      note: clipName(options.note, 80),
    };
    return { ok: true, userId: uid };
  }, options.membersFile);
}

function removeProtectedUser(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  return mutateKnownMembersStore((store) => {
    const existed = Boolean(store.protectedUserIds[uid]);
    delete store.protectedUserIds[uid];
    return { ok: true, userId: uid, existed };
  }, options.membersFile);
}

function isExplicitlyProtected(userId, storeOrFile) {
  const uid = asTelegramUserId(userId);
  if (!uid) {
    return false;
  }
  const store =
    storeOrFile && typeof storeOrFile === "object" && storeOrFile.protectedUserIds
      ? storeOrFile
      : loadKnownMembersStore(storeOrFile);
  return Boolean(store.protectedUserIds && store.protectedUserIds[uid]);
}

function displayNameFromRecord(record, fallback = "Member") {
  if (record && clipName(record.displayName)) {
    return clipName(record.displayName);
  }
  if (record && clipUsername(record.username)) {
    return `@${clipUsername(record.username)}`;
  }
  return fallback;
}

function addKeys(set, map) {
  if (!map || typeof map !== "object") {
    return;
  }
  for (const key of Object.keys(map)) {
    addTelegramUserId(set, key);
  }
}

function collectIdsFromBuilder(store, ids) {
  if (!store || typeof store !== "object") {
    return;
  }
  addKeys(ids, store.builders);
  addKeys(ids, store.referrals);
  addKeys(ids, store.welcomeOpportunities);
  if (store.inviteLinks && typeof store.inviteLinks === "object") {
    for (const link of Object.values(store.inviteLinks)) {
      if (link && link.inviterUserId != null) {
        addTelegramUserId(ids, link.inviterUserId);
      }
    }
  }
  if (store.builderEvents && typeof store.builderEvents === "object") {
    for (const event of Object.values(store.builderEvents)) {
      if (event && event.builderUserId != null) {
        addTelegramUserId(ids, event.builderUserId);
      }
    }
  }
}

function collectKnownTelegramIds(options = {}) {
  const ids = new Set();
  const membersStore =
    options.membersStore || loadKnownMembersStore(options.membersFile);
  addKeys(ids, membersStore.members);
  addKeys(ids, membersStore.protectedUserIds);

  const points = options.points || loadPoints(options.pointsFile);
  addKeys(ids, points && points.users);

  const walletStore =
    options.walletStore ||
    readWalletSnapshot(resolveWalletFile(options.walletFile));
  addKeys(ids, walletStore && walletStore.users);
  if (walletStore && walletStore.wallets) {
    for (const ownerId of Object.values(walletStore.wallets)) {
      addTelegramUserId(ids, ownerId);
    }
  }

  const builder =
    options.builderStore || loadBuilderStore(options.builderFile);
  collectIdsFromBuilder(builder, ids);

  if (options.shopUsers) {
    addKeys(ids, options.shopUsers);
  }
  if (options.presaleUsers) {
    addKeys(ids, options.presaleUsers);
  }
  if (options.rewardByUser) {
    addKeys(ids, options.rewardByUser);
  }
  if (Array.isArray(options.extraUserIds)) {
    for (const id of options.extraUserIds) {
      addTelegramUserId(ids, id);
    }
  }

  return [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function sourcesForUser(userId, options = {}) {
  const uid = asTelegramUserId(userId);
  const sources = [];
  const membersStore =
    options.membersStore || loadKnownMembersStore(options.membersFile);
  const record = membersStore.members && membersStore.members[uid];
  if (record && Array.isArray(record.sources)) {
    sources.push(...record.sources);
  }
  const points = options.points;
  if (points && points.users && points.users[uid]) {
    sources.push(SOURCE.POINTS);
  }
  const walletStore = options.walletStore;
  if (walletStore && walletStore.users && walletStore.users[uid]) {
    sources.push(SOURCE.WALLET);
  }
  const builder = options.builderStore;
  if (builder) {
    if (builder.welcomeOpportunities && builder.welcomeOpportunities[uid]) {
      sources.push(SOURCE.BUILDER_WELCOME);
    }
    if (builder.referrals && builder.referrals[uid]) {
      sources.push(SOURCE.BUILDER_REFERRAL);
    }
    if (builder.builders && builder.builders[uid]) {
      sources.push(SOURCE.BUILDER);
    }
  }
  return [...new Set(sources)];
}

module.exports = {
  SOURCE,
  DEFAULT_MEMBERS_FILE,
  WALLET_GRACE_MS,
  REMINDER_STATE,
  NOTICE_STATE,
  NOTICE_CLAIM_STALE_MS,
  setKnownMembersFileForTests,
  resolveMembersFile,
  loadKnownMembersStore,
  mutateKnownMembersStore,
  recordObservedJoin,
  recordObservedLeave,
  recordChatMemberTransition,
  shouldStartWalletGrace,
  isPendingWalletGrace,
  listPendingGraceMembers,
  getKnownMemberRecord,
  markWalletRequirementSatisfied,
  getWalletGraceNoticeState,
  tryClaimWalletGraceNotice,
  releaseWalletGraceNoticeClaim,
  markWalletGraceNoticeSent,
  markWalletGraceReminderSent,
  markWalletGraceEnforced,
  markWalletGraceScanAt,
  touchWalletEnforcementCheck,
  addProtectedUser,
  removeProtectedUser,
  isExplicitlyProtected,
  collectKnownTelegramIds,
  sourcesForUser,
  displayNameFromRecord,
  asTelegramUserId,
  isCommunityChat,
  isJoinTransition,
  isLeaveTransition,
  emptyStore,
};
