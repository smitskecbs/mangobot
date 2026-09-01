/**
 * Telegram Community Builder / referral attribution.
 * Builder Points are separate from lifetime XP. Invite URLs are never logged.
 */

const crypto = require("node:crypto");
const { log, error: logError } = require("../utils/logger");
const {
  loadBuilderStore,
  mutateBuilderStore,
  resolveBuilderFile,
} = require("./communityBuilderStore");
const { getLinkedWalletForUser } = require("./walletLinks");
const { loadPoints, getWeekId, isAdmin, isCommandText } = require("./points");
const { notifyCommunityBuilder } = require("./communityBuilderNotify");
const { fetchWithTimeout, TELEGRAM_TIMEOUT_MS } = require("../utils/safeFetch");

let runtimeConfig = {};

function configureCommunityBuilderForTests(config) {
  runtimeConfig = config && typeof config === "object" ? { ...config } : {};
  if (runtimeConfig.storeFile) {
    const { setCommunityBuilderFileForTests } = require("./communityBuilderStore");
    setCommunityBuilderFileForTests(runtimeConfig.storeFile);
  }
}

const JOIN_BUILDER_POINTS = 1;
const JOIN_XP = 1;
const WALLET_BUILDER_POINTS = 1;
const WALLET_XP = 1;
const ACTIVE_BUILDER_POINTS = 2;
const ACTIVE_XP = 0;
const ACTIVE_LIFETIME_XP = 5;
const FIRST_WELCOME_POINTS = 1;
const FIRST_WELCOME_WINDOW_MS = 30 * 60 * 1000;
const FIRST_WELCOME_DAILY_CAP = 3;
const FIRST_WELCOME_MIN_CHARS = 8;
const FIRST_WELCOME_MIN_WORDS = 2;
const FIRST_WELCOME_MIN_LETTERS = 4;
const MANUAL_AWARD_MIN = 1;
const MANUAL_AWARD_MAX = 5;
const MANUAL_AWARD_REASON_MIN = 3;
const MANUAL_AWARD_REASON_MAX = 120;
const REFERRALS_PAGE_SIZE = 20;
const LEADERBOARD_LIMIT = 15;
const BUILDER_RANK_THRESHOLDS = Object.freeze([5, 10, 25, 50, 100]);

const LEFT_STATUSES = new Set(["left", "kicked"]);
const MEMBER_STATUSES = new Set([
  "member",
  "restricted",
  "administrator",
  "creator",
]);

const JOIN_EVENT = Object.freeze({
  ATTRIBUTED: "attributed",
  ALREADY_REFERRED: "already-referred",
  SELF_REFERRAL: "self-referral",
  BOT: "bot",
  UNKNOWN_INVITE: "unknown-invite",
  WRONG_CHAT: "wrong-chat",
  PUBLIC_JOIN: "public-join",
  NOT_JOIN: "not-join",
});

const BUILDER_PERIOD = Object.freeze({
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  ALLTIME: "alltime",
});

const BUILDER_EVENT_REASON = Object.freeze({
  JOIN: "referral-join",
  WALLET: "referral-wallet",
  ACTIVE: "referral-active",
  FIRST_WELCOME: "first-welcome",
  MANUAL_AWARD: "manual-award",
});

const FIRST_WELCOME_GROUP_TEXT = [
  "🤝 Community Builder +1 BP",
  "",
  "Thanks for welcoming our new member! 🥭",
].join("\n");

const BUILDER_EVENT_ID_SUFFIX = Object.freeze({
  [BUILDER_EVENT_REASON.JOIN]: "join",
  [BUILDER_EVENT_REASON.WALLET]: "wallet",
  [BUILDER_EVENT_REASON.ACTIVE]: "active",
});

/**
 * Safe referral diagnostics. Never logs user ids or invite URLs.
 * @param {string} event
 * @param {{ oldStatus?: string, newStatus?: string }} [detail]
 */
function logReferralEvent(event, detail = {}) {
  if (event === JOIN_EVENT.NOT_JOIN) {
    const incoming = MEMBER_STATUSES.has(detail.newStatus);
    const fromOutside =
      !detail.oldStatus || LEFT_STATUSES.has(detail.oldStatus);
    if (!incoming || !fromOutside) {
      return;
    }
  }
  const parts = [`[community-builder] referral event=${event}`];
  if (event === JOIN_EVENT.NOT_JOIN) {
    parts.push(
      `transition=${detail.oldStatus || "unknown"}->${detail.newStatus || "unknown"}`
    );
  }
  log(parts.join(" "));
}

function normalizeUserId(value) {
  if (value === undefined || value === null) {
    return "";
  }
  const id = String(value).trim();
  return id && /^\d+$/.test(id) ? id : "";
}

function configuredChatId() {
  const raw =
    typeof process.env.TELEGRAM_CHAT_ID === "string"
      ? process.env.TELEGRAM_CHAT_ID.trim()
      : "";
  return raw || "";
}

function sameChat(chatId, expected) {
  const got = chatId == null ? "" : String(chatId).trim();
  const want = expected == null ? "" : String(expected).trim();
  return Boolean(got && want && got === want);
}

function inviteIdentity(inviteLink) {
  if (typeof inviteLink !== "string") {
    return "";
  }
  const raw = inviteLink.trim();
  if (!raw) {
    return "";
  }
  const plus = raw.match(/t\.me\/\+([A-Za-z0-9_-]+)/i);
  if (plus) {
    return plus[1];
  }
  const join = raw.match(/t\.me\/joinchat\/([A-Za-z0-9_-]+)/i);
  if (join) {
    return join[1];
  }
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function safeDisplayName(user) {
  if (!user || typeof user !== "object") {
    return "Member";
  }
  const username =
    typeof user.username === "string" ? user.username.trim() : "";
  if (username && !/^\d+$/.test(username)) {
    return username.replace(/[\r\n]+/g, " ").slice(0, 32);
  }
  const first =
    typeof user.first_name === "string" ? user.first_name.trim() : "";
  const last = typeof user.last_name === "string" ? user.last_name.trim() : "";
  const combined = `${first} ${last}`.trim();
  if (combined) {
    return combined.replace(/[\r\n]+/g, " ").slice(0, 32);
  }
  return "Member";
}

function telegramErrorText(err) {
  if (!err) {
    return "";
  }
  return String(
    (err.response && err.response.description) ||
      err.description ||
      err.message ||
      ""
  );
}

function isInvitePermissionError(err) {
  const text = telegramErrorText(err).toLowerCase();
  return (
    text.includes("not enough rights") ||
    text.includes("chat_admin_required") ||
    text.includes("need administrator rights") ||
    text.includes("can't create invite") ||
    text.includes("not enough rights to manage chat invite links") ||
    text.includes("invite_links") && text.includes("rights")
  );
}

function ensureBuilder(store, inviterId, displayName, now) {
  if (!store.builders[inviterId] || typeof store.builders[inviterId] !== "object") {
    store.builders[inviterId] = {
      points: 0,
      referralIds: [],
      displayName: displayName || "Member",
      createdAt: now,
      activeInviteId: null,
    };
  }
  const builder = store.builders[inviterId];
  if (!Array.isArray(builder.referralIds)) {
    builder.referralIds = [];
  }
  if (typeof builder.points !== "number" || !Number.isFinite(builder.points)) {
    builder.points = 0;
  }
  if (displayName && builder.displayName === "Member") {
    builder.displayName = displayName;
  } else if (displayName && !builder.displayName) {
    builder.displayName = displayName;
  }
  return builder;
}

function addBuilderPoints(builder, amount) {
  /* Builder Points are a contribution score: admins/devs are eligible. */
  const previous = builder.points;
  builder.points += amount;
  return {
    previous,
    next: builder.points,
    crossed: BUILDER_RANK_THRESHOLDS.filter(
      (threshold) => previous < threshold && builder.points >= threshold
    ),
  };
}

function ensureBuilderEvents(store) {
  if (!store.builderEvents || typeof store.builderEvents !== "object" || Array.isArray(store.builderEvents)) {
    store.builderEvents = {};
  }
  return store.builderEvents;
}

function builderEventId(referralUserId, reason) {
  const suffix = BUILDER_EVENT_ID_SUFFIX[reason] || String(reason || "");
  return `${referralUserId}:${suffix}`;
}

function firstWelcomeEventId(newMemberUserId) {
  const uid = normalizeUserId(newMemberUserId);
  return uid ? `welcome:${uid}` : "";
}

function manualAwardEventId(chatId, messageId) {
  if (chatId == null || messageId == null || messageId === "") {
    return "";
  }
  return `manual:${String(chatId)}:${String(messageId)}`;
}

function putBuilderAwardEvent(store, input) {
  const events = ensureBuilderEvents(store);
  const builderUserId = normalizeUserId(input.builderUserId);
  const reason = input.reason;
  if (!builderUserId || !reason) {
    return { recorded: false, duplicate: false };
  }
  const referralUserId = normalizeUserId(input.referralUserId);
  const explicitId =
    typeof input.eventId === "string" && input.eventId.trim()
      ? input.eventId.trim()
      : "";
  const eventId = explicitId || (referralUserId ? builderEventId(referralUserId, reason) : "");
  if (!eventId) {
    return { recorded: false, duplicate: false };
  }
  if (events[eventId]) {
    return { recorded: false, duplicate: true, eventId };
  }
  const event = {
    eventId,
    builderUserId,
    points: input.points,
    reason,
    createdAt: input.createdAt,
  };
  if (referralUserId) {
    event.referralUserId = referralUserId;
  }
  const subjectUserId = normalizeUserId(input.subjectUserId);
  if (subjectUserId) {
    event.subjectUserId = subjectUserId;
  }
  if (typeof input.note === "string" && input.note.trim()) {
    event.note = input.note.trim().slice(0, MANUAL_AWARD_REASON_MAX);
  }
  const awardedBy = normalizeUserId(input.awardedBy);
  if (awardedBy) {
    event.awardedBy = awardedBy;
  }
  events[eventId] = event;
  return { recorded: true, duplicate: false, eventId };
}

function isTrustworthyTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * Reconstruct missing builderEvents from referral milestone timestamps.
 * Does NOT change builder.points. Idempotent. No invented timestamps.
 */
function reconcileBuilderEventHistory(store) {
  if (!store || typeof store !== "object") {
    return { added: 0 };
  }
  ensureBuilderEvents(store);
  let added = 0;
  for (const [referralId, referral] of Object.entries(store.referrals || {})) {
    if (!referral || typeof referral !== "object") {
      continue;
    }
    const builderUserId = normalizeUserId(referral.inviterUserId);
    const referredId = normalizeUserId(referralId);
    if (!builderUserId || !referredId) {
      continue;
    }
    const specs = [
      {
        reason: BUILDER_EVENT_REASON.JOIN,
        stamp: referral.joinedAt,
        points: JOIN_BUILDER_POINTS,
      },
      {
        reason: BUILDER_EVENT_REASON.WALLET,
        stamp: referral.walletMilestoneAt,
        points: WALLET_BUILDER_POINTS,
      },
      {
        reason: BUILDER_EVENT_REASON.ACTIVE,
        stamp: referral.activeMilestoneAt,
        points: ACTIVE_BUILDER_POINTS,
      },
    ];
    for (const spec of specs) {
      if (!isTrustworthyTimestamp(spec.stamp)) {
        continue;
      }
      const recorded = putBuilderAwardEvent(store, {
        builderUserId,
        points: spec.points,
        reason: spec.reason,
        referralUserId: referredId,
        createdAt: Number(spec.stamp),
      });
      if (recorded.recorded) {
        added += 1;
      }
    }
  }
  return { added };
}

function persistReconcileBuilderEvents(builderFile) {
  const snapshot = loadBuilderStore(builderFile);
  const preview = reconcileBuilderEventHistory({
    ...snapshot,
    builderEvents: { ...(snapshot.builderEvents || {}) },
    referrals: snapshot.referrals,
    builders: snapshot.builders,
  });
  if (!preview.added) {
    return preview;
  }
  return mutateBuilderStore((store) => reconcileBuilderEventHistory(store), builderFile);
}

function mutateReconciledStore(mutator, builderFile) {
  return mutateBuilderStore((store) => {
    reconcileBuilderEventHistory(store);
    return mutator(store);
  }, builderFile);
}

function loadBuilderStoreWithEvents(builderFile) {
  const snapshot = loadBuilderStore(builderFile);
  const result = reconcileBuilderEventHistory(snapshot);
  if (result.added > 0) {
    try {
      persistReconcileBuilderEvents(builderFile);
    } catch (err) {
      logError(
        "[community-builder] history reconcile persist failed:",
        err && err.message ? err.message : err
      );
    }
  }
  return snapshot;
}

function awardBuilderPointsOnce(store, builder, amount, meta) {
  const recorded = putBuilderAwardEvent(store, {
    builderUserId: meta.builderUserId,
    points: amount,
    reason: meta.reason,
    referralUserId: meta.referralUserId,
    eventId: meta.eventId,
    subjectUserId: meta.subjectUserId,
    note: meta.note,
    awardedBy: meta.awardedBy,
    createdAt: meta.createdAt,
  });
  if (recorded.duplicate || !recorded.recorded) {
    return {
      duplicate: Boolean(recorded.duplicate),
      previous: builder.points,
      next: builder.points,
      crossed: [],
    };
  }
  const ranked = addBuilderPoints(builder, amount);
  return { duplicate: false, ...ranked };
}

function referralMilestones(referral) {
  return {
    joined: Boolean(referral && referral.joinedAt),
    wallet: Boolean(referral && referral.walletMilestoneAt),
    active: Boolean(referral && referral.activeMilestoneAt),
  };
}

function countActiveReferrals(store, inviterId) {
  let n = 0;
  for (const referral of Object.values(store.referrals || {})) {
    if (
      referral &&
      String(referral.inviterUserId) === String(inviterId) &&
      referral.activeMilestoneAt
    ) {
      n += 1;
    }
  }
  return n;
}

function lifetimePointsOf(userId, pointsFile) {
  const data = loadPoints(pointsFile);
  const user = data.users && data.users[String(userId)];
  return user && typeof user.points === "number" ? user.points : 0;
}

async function awardInviterXp(inviterId, displayName, amount, options) {
  if (!amount) {
    return { awarded: false, pointsToAdd: 0, reason: "none" };
  }
  const { awardCommunityBuilderXp } = require("./points");
  return awardCommunityBuilderXp(
    inviterId,
    displayName || "Member",
    amount,
    options.pointsFile,
    options.walletFile
  );
}

function maybeNotify(kind, payload, options) {
  const notify =
    typeof options.notify === "function"
      ? options.notify
      : typeof runtimeConfig.notify === "function"
        ? runtimeConfig.notify
        : notifyCommunityBuilder;
  try {
    Promise.resolve(notify(kind, payload, options)).catch((err) => {
      logError(
        "[community-builder] notify failed:",
        err && err.message ? err.message : err
      );
    });
  } catch (err) {
    logError(
      "[community-builder] notify failed:",
      err && err.message ? err.message : err
    );
  }
}

function resolveOptions(options = {}) {
  return {
    storeFile: resolveBuilderFile(options.storeFile || options.builderFile || runtimeConfig.storeFile),
    pointsFile: options.pointsFile || runtimeConfig.pointsFile,
    walletFile: options.walletFile || runtimeConfig.walletFile,
    chatId:
      options.chatId != null
        ? String(options.chatId)
        : runtimeConfig.chatId != null
          ? String(runtimeConfig.chatId)
          : configuredChatId(),
    now: Number.isFinite(options.now)
      ? options.now
      : Number.isFinite(runtimeConfig.now)
        ? runtimeConfig.now
        : Date.now(),
    notify: options.notify || runtimeConfig.notify,
    telegram: options.telegram || runtimeConfig.telegram,
    createChatInviteLink:
      options.createChatInviteLink || runtimeConfig.createChatInviteLink,
    getChatMember: options.getChatMember || runtimeConfig.getChatMember,
    botId: options.botId || runtimeConfig.botId,
    botToken: options.botToken || runtimeConfig.botToken,
    fetchImpl: options.fetchImpl || runtimeConfig.fetchImpl,
  };
}

function builderSummary(inviterId, options = {}) {
  const opts = resolveOptions(options);
  const uid = normalizeUserId(inviterId);
  const store = loadBuilderStore(opts.storeFile);
  const builder = uid ? store.builders[uid] : null;
  const referralIds = [];
  for (const [referredId, referral] of Object.entries(store.referrals || {})) {
    if (referral && String(referral.inviterUserId) === uid) {
      referralIds.push(referredId);
    }
  }
  return {
    builderPoints: builder && typeof builder.points === "number" ? builder.points : 0,
    validReferrals: referralIds.length,
    displayName: builder && builder.displayName ? builder.displayName : "Member",
  };
}

function listReferrals(inviterId, options = {}) {
  const opts = resolveOptions(options);
  const uid = normalizeUserId(inviterId);
  const store = loadBuilderStore(opts.storeFile);
  const rows = [];
  for (const [referredId, referral] of Object.entries(store.referrals || {})) {
    if (!referral || String(referral.inviterUserId) !== uid) {
      continue;
    }
    const marks = referralMilestones(referral);
    rows.push({
      displayName: referral.displayName || "Member",
      joined: marks.joined,
      wallet: marks.wallet,
      active: marks.active,
      joinedAt: referral.joinedAt || 0,
    });
  }
  rows.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.displayName.localeCompare(b.displayName));
  return rows;
}

function paginateReferrals(inviterId, page, options = {}) {
  const rows = listReferrals(inviterId, options);
  const size = REFERRALS_PAGE_SIZE;
  const lastPage = Math.max(0, Math.ceil(rows.length / size) - 1);
  const safePage = Math.min(Math.max(0, Number(page) || 0), lastPage);
  const start = safePage * size;
  return {
    rows: rows.slice(start, start + size),
    page: safePage,
    lastPage,
    total: rows.length,
  };
}

function compareBuilders(a, b) {
  return (
    b.points - a.points ||
    b.activeCount - a.activeCount ||
    (a.createdAt || 0) - (b.createdAt || 0) ||
    String(a.displayName).localeCompare(String(b.displayName))
  );
}

function toUtcDate(value) {
  if (value instanceof Date) {
    return value;
  }
  if (Number.isFinite(value)) {
    return new Date(value);
  }
  return new Date();
}

/**
 * Monday 00:00 UTC of the ISO-like week used by XP (`getWeekId` in points.js).
 */
function startOfUtcWeekMs(now) {
  const weekId = getWeekId(toUtcDate(now));
  return Date.parse(`${weekId}T00:00:00.000Z`);
}

/**
 * First day of the UTC calendar month, 00:00 UTC.
 */
function startOfUtcMonthMs(now) {
  const d = toUtcDate(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

function startOfUtcDayMs(now) {
  const d = toUtcDate(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function normalizeBuilderPeriod(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "weekly" || raw === "week" || raw === "w") {
    return BUILDER_PERIOD.WEEKLY;
  }
  if (raw === "monthly" || raw === "month" || raw === "m") {
    return BUILDER_PERIOD.MONTHLY;
  }
  if (raw === "alltime" || raw === "all-time" || raw === "all" || raw === "a") {
    return BUILDER_PERIOD.ALLTIME;
  }
  return null;
}

function resolveLeaderboardArgs(periodOrOptions, maybeNow) {
  if (typeof periodOrOptions === "string") {
    if (
      maybeNow instanceof Date ||
      typeof maybeNow === "number" ||
      maybeNow == null
    ) {
      return { period: periodOrOptions, now: maybeNow };
    }
    return { ...(maybeNow || {}), period: periodOrOptions };
  }
  return periodOrOptions && typeof periodOrOptions === "object"
    ? periodOrOptions
    : {};
}

function periodWindow(period, nowMs) {
  if (period === BUILDER_PERIOD.WEEKLY) {
    return { start: startOfUtcWeekMs(nowMs), end: nowMs };
  }
  if (period === BUILDER_PERIOD.MONTHLY) {
    return { start: startOfUtcMonthMs(nowMs), end: nowMs };
  }
  return null;
}

function aggregatePeriodPoints(store, startMs, endMs) {
  const byBuilder = new Map();
  for (const event of Object.values(store.builderEvents || {})) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const ts = Number(event.createdAt);
    if (!Number.isFinite(ts) || ts < startMs || ts > endMs) {
      continue;
    }
    const id = normalizeUserId(event.builderUserId);
    if (!id) {
      continue;
    }
    const pts =
      typeof event.points === "number" && Number.isFinite(event.points)
        ? event.points
        : 0;
    byBuilder.set(id, (byBuilder.get(id) || 0) + pts);
  }
  return byBuilder;
}

function sumMapValues(map) {
  let total = 0;
  for (const value of map.values()) {
    total += value;
  }
  return total;
}

function getBuilderLeaderboardEntries(periodOrOptions, maybeNow) {
  const raw = resolveLeaderboardArgs(periodOrOptions, maybeNow);
  const opts = resolveOptions(raw);
  const period = normalizeBuilderPeriod(raw.period) || BUILDER_PERIOD.ALLTIME;
  const store = loadBuilderStoreWithEvents(opts.storeFile);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const window = periodWindow(period, nowMs);
  const periodPoints = window
    ? aggregatePeriodPoints(store, window.start, window.end)
    : null;
  const rows = [];
  for (const [userId, builder] of Object.entries(store.builders || {})) {
    if (!builder || typeof builder !== "object") {
      continue;
    }
    const points = periodPoints
      ? periodPoints.get(userId) || 0
      : typeof builder.points === "number"
        ? builder.points
        : 0;
    if (points <= 0) {
      continue;
    }
    /* Include ADMIN_USER_ID and group admins. Do not reuse XP competition exclusion. */
    rows.push({
      userId,
      displayName: builder.displayName || "Member",
      points,
      activeCount: countActiveReferrals(store, userId),
      createdAt: builder.createdAt || 0,
    });
  }
  rows.sort(compareBuilders);
  return rows.slice(0, LEADERBOARD_LIMIT).map((row, index) => ({
    rank: index + 1,
    userId: row.userId,
    displayName: row.displayName,
    points: row.points,
    activeCount: row.activeCount,
  }));
}

function getBuilderLeaderboard(periodOrOptions, maybeNow) {
  return getBuilderLeaderboardEntries(periodOrOptions, maybeNow).map((row) => ({
    rank: row.rank,
    displayName: row.displayName,
    points: row.points,
  }));
}

function getBuilderMemberSnapshot(userId, options = {}) {
  const opts = resolveOptions(options);
  const id = normalizeUserId(userId);
  const store = loadBuilderStoreWithEvents(opts.storeFile);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const weekMap = aggregatePeriodPoints(
    store,
    startOfUtcWeekMs(nowMs),
    nowMs
  );
  const builder = id && store.builders ? store.builders[id] : null;
  return {
    userId: id,
    displayName:
      builder && typeof builder.displayName === "string" && builder.displayName.trim()
        ? builder.displayName.trim()
        : null,
    weeklyBp: id ? weekMap.get(id) || 0 : 0,
    alltimeBp:
      builder && typeof builder.points === "number" ? builder.points : 0,
    activeReferrals: id ? countActiveReferrals(store, id) : 0,
  };
}

function periodCaption(period, now) {
  if (period === BUILDER_PERIOD.WEEKLY) {
    return "Period:\nThis week";
  }
  if (period === BUILDER_PERIOD.MONTHLY) {
    const d = toUtcDate(now);
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    return `Period:\n${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  return "";
}

function periodLeaderboardTitle(period) {
  if (period === BUILDER_PERIOD.WEEKLY) {
    return "🏆 Weekly Community Builders";
  }
  if (period === BUILDER_PERIOD.MONTHLY) {
    return "🏆 Monthly Community Builders";
  }
  return "🏆 All-time Community Builders";
}

function emptyLeaderboardText(period, now) {
  const title = periodLeaderboardTitle(period);
  const caption = periodCaption(period, now);
  const head = caption ? `${title}\n\n${caption}\n\n` : `${title}\n\n`;
  if (period === BUILDER_PERIOD.WEEKLY) {
    return `${head}No Builder Points earned this week yet.`;
  }
  if (period === BUILDER_PERIOD.MONTHLY) {
    return `${head}No Builder Points earned this month yet.`;
  }
  return `${head}No Builder Points yet. Invite real members to start.`;
}

function formatBuilderLeaderboard(rows, period = BUILDER_PERIOD.ALLTIME, kind = "private", now = Date.now()) {
  const normalized = normalizeBuilderPeriod(period) || BUILDER_PERIOD.ALLTIME;
  if (!rows || !rows.length) {
    return emptyLeaderboardText(normalized, now);
  }
  const lines = [periodLeaderboardTitle(normalized), ""];
  const caption = periodCaption(normalized, now);
  if (caption) {
    lines.push(caption, "");
  }
  for (const row of rows) {
    lines.push(`${row.rank}. ${row.displayName} — ${row.points} BP`);
  }
  if (kind === "share") {
    if (normalized === BUILDER_PERIOD.WEEKLY) {
      lines.push("", "Who will climb the board next week? 🥭");
    } else if (normalized === BUILDER_PERIOD.MONTHLY) {
      lines.push("", "Who will climb the board this month? 🥭");
    } else {
      lines.push("", "Who will climb the board next? 🥭");
    }
  } else if (normalized === BUILDER_PERIOD.WEEKLY) {
    lines.push("", "Keep building the ManGo community. 🥭");
  }
  return lines.join("\n");
}

function getBuilderPeriodTotals(options = {}) {
  const opts = resolveOptions(options);
  const store = loadBuilderStoreWithEvents(opts.storeFile);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const week = aggregatePeriodPoints(
    store,
    startOfUtcWeekMs(nowMs),
    nowMs
  );
  const month = aggregatePeriodPoints(
    store,
    startOfUtcMonthMs(nowMs),
    nowMs
  );
  let allTime = 0;
  for (const builder of Object.values(store.builders || {})) {
    if (builder && typeof builder.points === "number" && builder.points > 0) {
      allTime += builder.points;
    }
  }
  return {
    week: sumMapValues(week),
    month: sumMapValues(month),
    allTime,
  };
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

function resolveBotToken(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "botToken")) {
    return typeof options.botToken === "string" ? options.botToken.trim() : "";
  }
  return typeof process.env.BOT_TOKEN === "string" ? process.env.BOT_TOKEN.trim() : "";
}

async function shareBuilderLeaderboard(period, options = {}) {
  if (!isAdmin(options.adminUserId)) {
    return { ok: false, reason: "not-admin" };
  }
  const normalized = normalizeBuilderPeriod(period) || BUILDER_PERIOD.ALLTIME;
  const opts = resolveOptions(options);
  if (isLikelyTestProcess() && options.shareToGroup !== true) {
    return { ok: false, skipped: true, reason: "test-process" };
  }
  const chatId = opts.chatId;
  const botToken = resolveBotToken(opts);
  if (!chatId || !botToken) {
    return { ok: false, reason: "unconfigured" };
  }
  const rows = getBuilderLeaderboard({ ...opts, period: normalized });
  const text = formatBuilderLeaderboard(rows, normalized, "share");
  const fetchFn = typeof opts.fetchImpl === "function" ? opts.fetchImpl : fetch;
  try {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        timeoutMs:
          Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : TELEGRAM_TIMEOUT_MS,
        fetchImpl: fetchFn,
      }
    );
    if (!response || response.ok !== true) {
      logError("[community-builder] leaderboard share failed");
      return { ok: false, reason: "telegram_http" };
    }
    log(`[community-builder] leaderboard shared period=${normalized}`);
    return { ok: true, text };
  } catch (_err) {
    logError("[community-builder] leaderboard share failed");
    return { ok: false, reason: "telegram_error" };
  }
}

function getBuilderStats(options = {}) {
  const opts = resolveOptions(options);
  const store = loadBuilderStoreWithEvents(opts.storeFile);
  const referrals = Object.values(store.referrals || {});
  let walletLinked = 0;
  let active = 0;
  for (const referral of referrals) {
    if (referral && referral.walletMilestoneAt) {
      walletLinked += 1;
    }
    if (referral && referral.activeMilestoneAt) {
      active += 1;
    }
  }
  const builders = Object.values(store.builders || {}).filter(
    (row) => row && typeof row.points === "number" && row.points > 0
  );
  const periodTotals = getBuilderPeriodTotals(opts);
  return {
    uniqueReferrals: referrals.length,
    walletLinked,
    active,
    totalBuilders: builders.length,
    top: getBuilderLeaderboard(opts),
    weekBp: periodTotals.week,
    monthBp: periodTotals.month,
    allTimeBp: periodTotals.allTime,
  };
}

async function checkInvitePermission(opts) {
  const chatId = opts.chatId;
  if (!chatId) {
    return {
      ok: false,
      reason: "no-chat",
      message:
        "Couldn't create your invite link. The ManGo group is not configured.",
    };
  }
  const getChatMember =
    typeof opts.getChatMember === "function"
      ? opts.getChatMember
      : opts.telegram && typeof opts.telegram.getChatMember === "function"
        ? (cid, userId) => opts.telegram.getChatMember(cid, userId)
        : null;
  if (!getChatMember || !opts.botId) {
    return { ok: true };
  }
  try {
    const member = await getChatMember(chatId, opts.botId);
    const status = member && member.status;
    if (status === "creator") {
      return { ok: true };
    }
    if (status !== "administrator") {
      return {
        ok: false,
        reason: "not-admin",
        message:
          "Couldn't create your invite link. The bot needs to be an admin in the ManGo group with invite permission.",
      };
    }
    if (member.can_invite_users !== true) {
      return {
        ok: false,
        reason: "no-invite-right",
        message:
          "Couldn't create your invite link. The bot needs permission to invite users in the ManGo group.",
      };
    }
    return { ok: true };
  } catch (err) {
    if (isInvitePermissionError(err)) {
      return {
        ok: false,
        reason: "no-invite-right",
        message:
          "Couldn't create your invite link. The bot needs permission to invite users in the ManGo group.",
      };
    }
    logError(
      "[community-builder] permission check failed:",
      err && err.message ? err.message : err
    );
    return {
      ok: false,
      reason: "permission-check-failed",
      message:
        "Couldn't create your invite link right now. Please try again later.",
    };
  }
}

async function getOrCreateInviteLink(inviterUser, options = {}) {
  const opts = resolveOptions(options);
  const uid = normalizeUserId(inviterUser && (inviterUser.id || inviterUser.userId));
  if (!uid) {
    return { ok: false, reason: "invalid-user", message: "Couldn't create your invite link." };
  }
  const displayName = safeDisplayName(inviterUser);
  const existing = mutateReconciledStore((store) => {
    const builder = ensureBuilder(store, uid, displayName, opts.now);
    const activeId = builder.activeInviteId;
    const link = activeId ? store.inviteLinks[activeId] : null;
    if (
      link &&
      link.active !== false &&
      !link.revokedAt &&
      typeof link.inviteUrl === "string" &&
      link.inviteUrl &&
      String(link.inviterUserId) === uid
    ) {
      return { ok: true, reused: true, inviteUrl: link.inviteUrl, inviteId: activeId };
    }
    return null;
  }, opts.storeFile);
  if (existing && existing.ok) {
    return existing;
  }

  const permission = await checkInvitePermission(opts);
  if (!permission.ok) {
    return permission;
  }

  const create =
    typeof opts.createChatInviteLink === "function"
      ? opts.createChatInviteLink
      : opts.telegram && typeof opts.telegram.createChatInviteLink === "function"
        ? (chatId, extra) => opts.telegram.createChatInviteLink(chatId, extra)
        : null;
  if (!create) {
    return {
      ok: false,
      reason: "no-telegram",
      message: "Couldn't create your invite link right now. Please try again later.",
    };
  }

  let created;
  try {
    created = await create(opts.chatId, { name: "ManGo CB" });
  } catch (err) {
    if (isInvitePermissionError(err)) {
      return {
        ok: false,
        reason: "no-invite-right",
        message:
          "Couldn't create your invite link. The bot needs permission to invite users in the ManGo group.",
      };
    }
    logError(
      "[community-builder] create invite failed:",
      err && err.message ? err.message : err
    );
    return {
      ok: false,
      reason: "create-failed",
      message: "Couldn't create your invite link right now. Please try again later.",
    };
  }

  const inviteUrl =
    created && typeof created.invite_link === "string" ? created.invite_link.trim() : "";
  const identity = inviteIdentity(inviteUrl);
  if (!inviteUrl || !identity) {
    return {
      ok: false,
      reason: "invalid-invite",
      message: "Couldn't create your invite link right now. Please try again later.",
    };
  }

  log("[community-builder] invite created");
  return mutateReconciledStore((store) => {
    const builder = ensureBuilder(store, uid, displayName, opts.now);
    if (builder.activeInviteId && store.inviteLinks[builder.activeInviteId]) {
      store.inviteLinks[builder.activeInviteId].active = false;
    }
    store.inviteLinks[identity] = {
      inviterUserId: uid,
      createdAt: opts.now,
      active: true,
      revokedAt: null,
      inviteUrl,
    };
    builder.activeInviteId = identity;
    return { ok: true, reused: false, inviteUrl, inviteId: identity };
  }, opts.storeFile);
}

function isJoinTransition(oldStatus, newStatus) {
  const from = typeof oldStatus === "string" ? oldStatus : "";
  const to = typeof newStatus === "string" ? newStatus : "";
  return LEFT_STATUSES.has(from) && MEMBER_STATUSES.has(to);
}

function extractUsedInviteLink(update) {
  if (!update || typeof update !== "object") {
    return "";
  }
  const invite = update.invite_link;
  if (invite && typeof invite.invite_link === "string") {
    return invite.invite_link;
  }
  if (typeof update.invite_link === "string") {
    return update.invite_link;
  }
  return "";
}

async function applyJoinAttribution(input, options = {}) {
  const opts = resolveOptions(options);
  const referredId = normalizeUserId(input.userId);
  const chatId = input.chatId;
  if (!opts.chatId || !sameChat(chatId, opts.chatId)) {
    logReferralEvent(JOIN_EVENT.WRONG_CHAT);
    return { ok: false, reason: JOIN_EVENT.WRONG_CHAT };
  }
  if (!referredId) {
    return { ok: false, reason: "invalid-user" };
  }
  if (input.isBot) {
    logReferralEvent(JOIN_EVENT.BOT);
    return { ok: false, reason: JOIN_EVENT.BOT };
  }
  if (!isJoinTransition(input.oldStatus, input.newStatus)) {
    logReferralEvent(JOIN_EVENT.NOT_JOIN, {
      oldStatus: input.oldStatus,
      newStatus: input.newStatus,
    });
    return { ok: false, reason: JOIN_EVENT.NOT_JOIN };
  }
  const inviteUrl = extractUsedInviteLink({ invite_link: input.inviteLink });
  const identity = inviteIdentity(inviteUrl);
  if (!identity) {
    logReferralEvent(JOIN_EVENT.PUBLIC_JOIN);
    return { ok: false, reason: JOIN_EVENT.PUBLIC_JOIN };
  }

  const result = mutateReconciledStore((store) => {
    const existing = store.referrals[referredId];
    if (existing && existing.inviterUserId) {
      return { ok: false, reason: JOIN_EVENT.ALREADY_REFERRED, frozen: true };
    }
    ensureBuilderEvents(store);
    if (store.builderEvents[builderEventId(referredId, BUILDER_EVENT_REASON.JOIN)]) {
      return { ok: false, reason: JOIN_EVENT.ALREADY_REFERRED, frozen: true };
    }
    const link = store.inviteLinks[identity];
    if (!link || !link.inviterUserId) {
      return { ok: false, reason: JOIN_EVENT.UNKNOWN_INVITE };
    }
    const inviterId = normalizeUserId(link.inviterUserId);
    if (!inviterId) {
      return { ok: false, reason: JOIN_EVENT.UNKNOWN_INVITE };
    }
    if (inviterId === referredId) {
      return { ok: false, reason: JOIN_EVENT.SELF_REFERRAL };
    }
    const displayName = input.displayName || "Member";
    const builder = ensureBuilder(store, inviterId, null, opts.now);
    store.referrals[referredId] = {
      inviterUserId: inviterId,
      joinedAt: opts.now,
      inviteId: identity,
      displayName,
      walletMilestoneAt: null,
      activeMilestoneAt: null,
    };
    if (!builder.referralIds.includes(referredId)) {
      builder.referralIds.push(referredId);
    }
    const ranked = awardBuilderPointsOnce(store, builder, JOIN_BUILDER_POINTS, {
      builderUserId: inviterId,
      reason: BUILDER_EVENT_REASON.JOIN,
      referralUserId: referredId,
      createdAt: opts.now,
    });
    if (ranked.duplicate) {
      return { ok: false, reason: JOIN_EVENT.ALREADY_REFERRED, frozen: true };
    }
    return {
      ok: true,
      stage: "join",
      reason: JOIN_EVENT.ATTRIBUTED,
      inviterUserId: inviterId,
      inviterName: builder.displayName,
      builderPointsAwarded: JOIN_BUILDER_POINTS,
      xpAmount: JOIN_XP,
      rankCrossed: ranked.crossed,
    };
  }, opts.storeFile);

  logReferralEvent(result.reason || (result.ok ? JOIN_EVENT.ATTRIBUTED : "rejected"));

  if (!result.ok) {
    return result;
  }

  const xp = await awardInviterXp(
    result.inviterUserId,
    result.inviterName,
    JOIN_XP,
    opts
  );
  const xpAwarded = Boolean(xp && xp.awarded);
  maybeNotify(
    "join",
    {
      inviterUserId: result.inviterUserId,
      builderPoints: JOIN_BUILDER_POINTS,
      xpAwarded,
      walletLocked: xp && xp.reason === "wallet-required",
    },
    opts
  );

  await tryFollowUpMilestones(referredId, opts);
  return {
    ...result,
    xpAwarded,
    xpReason: xp && xp.reason,
  };
}

function ensureWelcomeOpportunities(store) {
  if (
    !store.welcomeOpportunities ||
    typeof store.welcomeOpportunities !== "object" ||
    Array.isArray(store.welcomeOpportunities)
  ) {
    store.welcomeOpportunities = {};
  }
  return store.welcomeOpportunities;
}

function normalizeStoredUsername(value) {
  if (typeof value !== "string") {
    return "";
  }
  const raw = value.trim().replace(/^@/, "");
  if (!raw || !/^[A-Za-z0-9_]{5,32}$/.test(raw)) {
    return "";
  }
  return raw.toLowerCase();
}

function visibleWelcomeText(text) {
  return String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidWelcomeText(text) {
  if (typeof text !== "string") {
    return false;
  }
  if (isCommandText(text)) {
    return false;
  }
  const visible = visibleWelcomeText(text);
  if (visible.length < FIRST_WELCOME_MIN_CHARS) {
    return false;
  }
  const words = visible.split(" ").filter(Boolean);
  if (words.length < FIRST_WELCOME_MIN_WORDS) {
    return false;
  }
  const letters = visible.replace(/[^\p{L}\p{N}]+/gu, "");
  return letters.length >= FIRST_WELCOME_MIN_LETTERS;
}

function messageTargetsNewMember(message, newMemberId, opportunity) {
  const targetId = normalizeUserId(newMemberId);
  if (!targetId || !message || typeof message !== "object") {
    return false;
  }
  const reply = message.replyTo || message.reply_to_message;
  if (reply && typeof reply === "object") {
    const replyId = Number(reply.message_id);
    if (
      Number.isFinite(replyId) &&
      (replyId === Number(opportunity.joinMessageId) ||
        replyId === Number(opportunity.botWelcomeMessageId))
    ) {
      return true;
    }
    const replyFrom = reply.from && reply.from.id != null ? String(reply.from.id) : "";
    if (replyFrom && replyFrom === targetId) {
      return true;
    }
  }
  const text = typeof message.text === "string" ? message.text : "";
  const entities = Array.isArray(message.entities) ? message.entities : [];
  const username = normalizeStoredUsername(opportunity.username);
  for (const ent of entities) {
    if (!ent || typeof ent !== "object") {
      continue;
    }
    if (ent.type === "text_mention" && ent.user && String(ent.user.id) === targetId) {
      return true;
    }
    if (ent.type === "mention" && username && typeof ent.offset === "number") {
      const slice = text.slice(ent.offset, ent.offset + (ent.length || 0));
      if (normalizeStoredUsername(slice) === username) {
        return true;
      }
    }
  }
  if (username) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionRe = new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, "i");
    if (mentionRe.test(text)) {
      return true;
    }
  }
  return false;
}

function countFirstWelcomeToday(store, welcomerId, nowMs) {
  const dayStart = startOfUtcDayMs(nowMs);
  let n = 0;
  for (const event of Object.values(store.builderEvents || {})) {
    if (!event || event.reason !== BUILDER_EVENT_REASON.FIRST_WELCOME) {
      continue;
    }
    if (normalizeUserId(event.builderUserId) !== welcomerId) {
      continue;
    }
    const ts = Number(event.createdAt);
    if (Number.isFinite(ts) && ts >= dayStart && ts <= nowMs) {
      n += 1;
    }
  }
  return n;
}

function registerWelcomeOpportunity(input = {}, options = {}) {
  const opts = resolveOptions(options);
  if (input.isBot) {
    return { ok: false, reason: "bot" };
  }
  const uid = normalizeUserId(input.userId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  if (!opts.chatId || !sameChat(input.chatId, opts.chatId)) {
    return { ok: false, reason: "wrong-chat" };
  }
  if (input.oldStatus != null || input.newStatus != null) {
    if (!isJoinTransition(input.oldStatus, input.newStatus)) {
      return { ok: false, reason: "not-join" };
    }
  }
  return mutateBuilderStore((store) => {
    const map = ensureWelcomeOpportunities(store);
    const existing = map[uid];
    const eventId = firstWelcomeEventId(uid);
    if (existing) {
      const claimed = Boolean(existing.claimedAt || existing.permanentClaimed);
      const open = !claimed && Number(existing.expiresAt) > opts.now;
      if (!open) {
        return { ok: false, reason: "already-seen" };
      }
      if (input.joinMessageId != null) {
        existing.joinMessageId = Number(input.joinMessageId);
      }
      if (input.botWelcomeMessageId != null) {
        existing.botWelcomeMessageId = Number(input.botWelcomeMessageId);
      }
      const username = normalizeStoredUsername(input.username);
      if (username) {
        existing.username = username;
      }
      return { ok: true, reason: "already-open" };
    }
    if (ensureBuilderEvents(store)[eventId]) {
      map[uid] = {
        joinedAt: opts.now,
        expiresAt: opts.now,
        claimedAt: opts.now,
        claimedBy: null,
        permanentClaimed: true,
      };
      return { ok: false, reason: "already-claimed" };
    }
    map[uid] = {
      joinedAt: opts.now,
      expiresAt: opts.now + FIRST_WELCOME_WINDOW_MS,
      claimedAt: null,
      claimedBy: null,
      permanentClaimed: false,
      username: normalizeStoredUsername(input.username),
      displayName: input.displayName || "Member",
      joinMessageId:
        input.joinMessageId != null && Number.isFinite(Number(input.joinMessageId))
          ? Number(input.joinMessageId)
          : null,
      botWelcomeMessageId:
        input.botWelcomeMessageId != null &&
        Number.isFinite(Number(input.botWelcomeMessageId))
          ? Number(input.botWelcomeMessageId)
          : null,
    };
    return { ok: true, reason: "opened" };
  }, opts.storeFile);
}

function noteBotWelcomeMessage(newMemberUserId, messageId, options = {}) {
  const uid = normalizeUserId(newMemberUserId);
  const mid = Number(messageId);
  if (!uid || !Number.isFinite(mid)) {
    return { ok: false, reason: "invalid" };
  }
  const opts = resolveOptions(options);
  return mutateBuilderStore((store) => {
    const existing = ensureWelcomeOpportunities(store)[uid];
    if (!existing) {
      return { ok: false, reason: "missing" };
    }
    if (existing.claimedAt || existing.permanentClaimed) {
      return { ok: false, reason: "already-claimed" };
    }
    if (!(Number(existing.expiresAt) > opts.now)) {
      return { ok: false, reason: "expired" };
    }
    existing.botWelcomeMessageId = mid;
    return { ok: true };
  }, opts.storeFile);
}

function tryClaimFirstWelcome(input = {}, options = {}) {
  const opts = resolveOptions(options);
  const from = input.from || {};
  if (from.is_bot) {
    return { ok: false, reason: "bot" };
  }
  const welcomerId = normalizeUserId(from.id);
  if (!welcomerId) {
    return { ok: false, reason: "invalid-user" };
  }
  if (!opts.chatId || !sameChat(input.chatId, opts.chatId)) {
    return { ok: false, reason: "wrong-chat" };
  }
  if (input.editDate != null || input.edit_date != null) {
    return { ok: false, reason: "edited" };
  }
  if (input.sticker || input.animation || input.gif) {
    return { ok: false, reason: "invalid-content" };
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (!isValidWelcomeText(text)) {
    return { ok: false, reason: "invalid-content" };
  }

  const preview = loadBuilderStore(opts.storeFile);
  let anyOpen = false;
  for (const opportunity of Object.values(preview.welcomeOpportunities || {})) {
    if (
      opportunity &&
      !opportunity.claimedAt &&
      !opportunity.permanentClaimed &&
      Number(opportunity.expiresAt) > opts.now
    ) {
      anyOpen = true;
      break;
    }
  }
  if (!anyOpen) {
    return { ok: false, reason: "none-open" };
  }

  return mutateBuilderStore((store) => {
    const map = ensureWelcomeOpportunities(store);
    const events = ensureBuilderEvents(store);
    const open = [];
    for (const [newMemberId, opportunity] of Object.entries(map)) {
      if (!opportunity || typeof opportunity !== "object") {
        continue;
      }
      if (opportunity.claimedAt || opportunity.permanentClaimed) {
        continue;
      }
      if (!(Number(opportunity.joinedAt) <= opts.now)) {
        continue;
      }
      if (!(Number(opportunity.expiresAt) > opts.now)) {
        continue;
      }
      if (newMemberId === welcomerId) {
        continue;
      }
      if (events[firstWelcomeEventId(newMemberId)]) {
        continue;
      }
      if (
        !messageTargetsNewMember(
          {
            text,
            entities: input.entities,
            replyTo: input.replyTo || input.reply_to_message,
          },
          newMemberId,
          opportunity
        )
      ) {
        continue;
      }
      open.push(newMemberId);
    }
    if (!open.length) {
      return { ok: false, reason: "not-targeted" };
    }
    if (countFirstWelcomeToday(store, welcomerId, opts.now) >= FIRST_WELCOME_DAILY_CAP) {
      return { ok: false, reason: "daily-cap" };
    }
    const newMemberId = open[0];
    const eventId = firstWelcomeEventId(newMemberId);
    const builder = ensureBuilder(
      store,
      welcomerId,
      safeDisplayName(from),
      opts.now
    );
    const ranked = awardBuilderPointsOnce(store, builder, FIRST_WELCOME_POINTS, {
      builderUserId: welcomerId,
      reason: BUILDER_EVENT_REASON.FIRST_WELCOME,
      eventId,
      subjectUserId: newMemberId,
      createdAt: opts.now,
    });
    if (ranked.duplicate) {
      return { ok: false, reason: "already-claimed" };
    }
    if (ranked.next !== ranked.previous + FIRST_WELCOME_POINTS) {
      return { ok: false, reason: "not-recorded" };
    }
    map[newMemberId].claimedAt = opts.now;
    map[newMemberId].claimedBy = welcomerId;
    map[newMemberId].permanentClaimed = true;
    log("[community-builder] first-welcome awarded");
    return {
      ok: true,
      awarded: true,
      points: FIRST_WELCOME_POINTS,
      eventId,
    };
  }, opts.storeFile);
}

function tryClaimFirstWelcomeFromMessage(ctx, options = {}) {
  if (!ctx || !ctx.from || !ctx.chat || !ctx.message) {
    return { ok: false, reason: "invalid" };
  }
  return tryClaimFirstWelcome(
    {
      chatId: ctx.chat.id,
      from: ctx.from,
      text: ctx.message.text,
      entities: ctx.message.entities,
      replyTo: ctx.message.reply_to_message,
      sticker: ctx.message.sticker,
      animation: ctx.message.animation,
      editDate: ctx.message.edit_date,
    },
    options
  );
}

function parseManualBuilderAwardArgs(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { ok: false, reason: "usage" };
  }
  const matched = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!matched) {
    return { ok: false, reason: "usage" };
  }
  const token = matched[1];
  const reason = typeof matched[2] === "string" ? matched[2].trim() : "";
  if (token.includes(".") || token.includes("e") || token.includes("E")) {
    return { ok: false, reason: "points" };
  }
  if (!/^-?\d+$/.test(token)) {
    return { ok: false, reason: "points" };
  }
  const points = Number(token);
  if (
    !Number.isInteger(points) ||
    points < MANUAL_AWARD_MIN ||
    points > MANUAL_AWARD_MAX
  ) {
    return { ok: false, reason: "points" };
  }
  if (!reason || reason.length < MANUAL_AWARD_REASON_MIN) {
    return { ok: false, reason: "reason" };
  }
  if (reason.length > MANUAL_AWARD_REASON_MAX) {
    return { ok: false, reason: "reason-length" };
  }
  return { ok: true, points, reason };
}

function grantManualBuilderAward(input = {}, options = {}) {
  const opts = resolveOptions(options);
  if (!isAdmin(input.adminUserId)) {
    return { ok: false, reason: "not-admin" };
  }
  const targetId = normalizeUserId(input.targetUserId);
  if (!targetId) {
    return { ok: false, reason: "no-target" };
  }
  if (input.targetIsBot) {
    return { ok: false, reason: "no-target" };
  }
  const rawArg =
    typeof input.rawArg === "string"
      ? input.rawArg
      : `${input.points} ${input.reason || ""}`.trim();
  const parsed = parseManualBuilderAwardArgs(rawArg);
  if (!parsed.ok) {
    return parsed;
  }
  const eventId = manualAwardEventId(input.chatId, input.messageId);
  if (!eventId) {
    return { ok: false, reason: "usage" };
  }
  const result = mutateBuilderStore((store) => {
    const builder = ensureBuilder(
      store,
      targetId,
      input.targetDisplayName || "Member",
      opts.now
    );
    const ranked = awardBuilderPointsOnce(store, builder, parsed.points, {
      builderUserId: targetId,
      reason: BUILDER_EVENT_REASON.MANUAL_AWARD,
      eventId,
      note: parsed.reason,
      awardedBy: normalizeUserId(input.adminUserId),
      createdAt: opts.now,
    });
    if (ranked.duplicate) {
      return { ok: false, reason: "duplicate" };
    }
    log(`[community-builder] manual award points=${parsed.points}`);
    return {
      ok: true,
      points: parsed.points,
      reason: parsed.reason,
      displayName: builder.displayName || "Member",
      eventId,
    };
  }, opts.storeFile);

  if (!result.ok) {
    return result;
  }

  maybeNotify(
    "manual-award",
    {
      userId: targetId,
      points: result.points,
      note: result.reason,
    },
    opts
  );
  return result;
}

async function handleChatMemberUpdate(update, options = {}) {
  if (!update || typeof update !== "object") {
    return { ok: false, reason: "invalid-update" };
  }
  const chatId = update.chat && update.chat.id;
  const newMember = update.new_chat_member || {};
  const oldMember = update.old_chat_member || {};
  const user = newMember.user || oldMember.user || {};
  const attribution = await applyJoinAttribution(
    {
      chatId,
      userId: user.id,
      isBot: Boolean(user.is_bot),
      oldStatus: oldMember.status,
      newStatus: newMember.status,
      inviteLink: update.invite_link,
      displayName: safeDisplayName(user),
    },
    options
  );
  try {
    registerWelcomeOpportunity(
      {
        chatId,
        userId: user.id,
        isBot: Boolean(user.is_bot),
        oldStatus: oldMember.status,
        newStatus: newMember.status,
        username: user.username,
        displayName: safeDisplayName(user),
      },
      options
    );
  } catch (err) {
    logError(
      "[community-builder] welcome opportunity failed:",
      err && err.message ? err.message : err
    );
  }
  return attribution;
}

async function tryWalletMilestone(referredId, options = {}) {
  const opts = resolveOptions(options);
  const uid = normalizeUserId(referredId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const preview = loadBuilderStore(opts.storeFile).referrals[uid];
  if (!preview || !preview.inviterUserId) {
    return { ok: false, reason: "not-referred" };
  }
  if (preview.walletMilestoneAt) {
    return { ok: false, reason: "already-claimed" };
  }
  const result = mutateReconciledStore((store) => {
    const referral = store.referrals[uid];
    if (!referral || !referral.inviterUserId) {
      return { ok: false, reason: "not-referred" };
    }
    if (referral.walletMilestoneAt) {
      return { ok: false, reason: "already-claimed" };
    }
    ensureBuilderEvents(store);
    if (store.builderEvents[builderEventId(uid, BUILDER_EVENT_REASON.WALLET)]) {
      return { ok: false, reason: "already-claimed" };
    }
    referral.walletMilestoneAt = opts.now;
    const builder = ensureBuilder(store, referral.inviterUserId, null, opts.now);
    const ranked = awardBuilderPointsOnce(store, builder, WALLET_BUILDER_POINTS, {
      builderUserId: referral.inviterUserId,
      reason: BUILDER_EVENT_REASON.WALLET,
      referralUserId: uid,
      createdAt: opts.now,
    });
    if (ranked.duplicate) {
      return { ok: false, reason: "already-claimed" };
    }
    return {
      ok: true,
      stage: "wallet-linked",
      inviterUserId: referral.inviterUserId,
      inviterName: builder.displayName,
      builderPointsAwarded: WALLET_BUILDER_POINTS,
      xpAmount: WALLET_XP,
      rankCrossed: ranked.crossed,
    };
  }, opts.storeFile);

  if (!result.ok) {
    return result;
  }

  const xp = await awardInviterXp(
    result.inviterUserId,
    result.inviterName,
    WALLET_XP,
    opts
  );
  const xpAwarded = Boolean(xp && xp.awarded);
  maybeNotify(
    "wallet",
    {
      inviterUserId: result.inviterUserId,
      builderPoints: WALLET_BUILDER_POINTS,
      xpAwarded,
      walletLocked: xp && xp.reason === "wallet-required",
    },
    opts
  );
  return {
    ...result,
    xpAwarded,
    xpReason: xp && xp.reason,
  };
}

function tryActiveMilestone(referredId, options = {}) {
  const opts = resolveOptions(options);
  const uid = normalizeUserId(referredId);
  if (!uid) {
    return { ok: false, reason: "invalid-user" };
  }
  const preview = loadBuilderStore(opts.storeFile).referrals[uid];
  if (!preview || !preview.inviterUserId) {
    return { ok: false, reason: "not-referred" };
  }
  if (preview.activeMilestoneAt) {
    return { ok: false, reason: "already-claimed" };
  }
  const result = mutateReconciledStore((store) => {
    const referral = store.referrals[uid];
    if (!referral || !referral.inviterUserId) {
      return { ok: false, reason: "not-referred" };
    }
    if (referral.activeMilestoneAt) {
      return { ok: false, reason: "already-claimed" };
    }
    ensureBuilderEvents(store);
    if (store.builderEvents[builderEventId(uid, BUILDER_EVENT_REASON.ACTIVE)]) {
      return { ok: false, reason: "already-claimed" };
    }
    referral.activeMilestoneAt = opts.now;
    const builder = ensureBuilder(store, referral.inviterUserId, null, opts.now);
    const ranked = awardBuilderPointsOnce(store, builder, ACTIVE_BUILDER_POINTS, {
      builderUserId: referral.inviterUserId,
      reason: BUILDER_EVENT_REASON.ACTIVE,
      referralUserId: uid,
      createdAt: opts.now,
    });
    if (ranked.duplicate) {
      return { ok: false, reason: "already-claimed" };
    }
    return {
      ok: true,
      stage: "active-member",
      inviterUserId: referral.inviterUserId,
      inviterName: builder.displayName,
      builderPointsAwarded: ACTIVE_BUILDER_POINTS,
      xpAmount: ACTIVE_XP,
      rankCrossed: ranked.crossed,
    };
  }, opts.storeFile);

  if (!result.ok) {
    return result;
  }

  maybeNotify(
    "active",
    {
      inviterUserId: result.inviterUserId,
      builderPoints: ACTIVE_BUILDER_POINTS,
      xpAwarded: false,
    },
    opts
  );
  return result;
}

async function tryFollowUpMilestones(referredId, options = {}) {
  const opts = resolveOptions(options);
  const uid = normalizeUserId(referredId);
  if (!uid) {
    return;
  }
  if (getLinkedWalletForUser(uid, opts.walletFile)) {
    await tryWalletMilestone(uid, opts);
  }
  if (lifetimePointsOf(uid, opts.pointsFile) >= ACTIVE_LIFETIME_XP) {
    tryActiveMilestone(uid, opts);
  }
}

async function onWalletLinked(userId, options = {}) {
  try {
    return await tryWalletMilestone(userId, options);
  } catch (err) {
    logError(
      "[community-builder] wallet milestone failed:",
      err && err.message ? err.message : err
    );
    return { ok: false, reason: "error" };
  }
}

function onLifetimeXpMutated(before, after, options = {}) {
  try {
    const prev = before && typeof before === "object" ? before : {};
    const next = after && typeof after === "object" ? after : {};
    const ids = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const id of ids) {
      const beforePts = typeof prev[id] === "number" ? prev[id] : 0;
      const afterPts = typeof next[id] === "number" ? next[id] : 0;
      if (beforePts < ACTIVE_LIFETIME_XP && afterPts >= ACTIVE_LIFETIME_XP) {
        tryActiveMilestone(id, options);
      }
    }
  } catch (err) {
    logError(
      "[community-builder] active milestone failed:",
      err && err.message ? err.message : err
    );
  }
}

/**
 * Future Mystery Gift / weekly Top Builder insertion point.
 * v1 records crossed thresholds only. No automatic payout.
 */
function builderRankInsertionPoint(previousPoints, nextPoints) {
  return BUILDER_RANK_THRESHOLDS.filter(
    (threshold) => previousPoints < threshold && nextPoints >= threshold
  );
}

module.exports = {
  JOIN_BUILDER_POINTS,
  JOIN_XP,
  WALLET_BUILDER_POINTS,
  WALLET_XP,
  ACTIVE_BUILDER_POINTS,
  ACTIVE_XP,
  ACTIVE_LIFETIME_XP,
  FIRST_WELCOME_POINTS,
  FIRST_WELCOME_WINDOW_MS,
  FIRST_WELCOME_DAILY_CAP,
  FIRST_WELCOME_GROUP_TEXT,
  MANUAL_AWARD_MIN,
  MANUAL_AWARD_MAX,
  MANUAL_AWARD_REASON_MIN,
  MANUAL_AWARD_REASON_MAX,
  REFERRALS_PAGE_SIZE,
  LEADERBOARD_LIMIT,
  BUILDER_RANK_THRESHOLDS,
  JOIN_EVENT,
  BUILDER_PERIOD,
  BUILDER_EVENT_REASON,
  builderEventId,
  firstWelcomeEventId,
  startOfUtcWeekMs,
  startOfUtcMonthMs,
  startOfUtcDayMs,
  normalizeBuilderPeriod,
  formatBuilderLeaderboard,
  shareBuilderLeaderboard,
  getBuilderPeriodTotals,
  reconcileBuilderEventHistory,
  persistReconcileBuilderEvents,
  inviteIdentity,
  safeDisplayName,
  isJoinTransition,
  builderSummary,
  listReferrals,
  paginateReferrals,
  getBuilderLeaderboard,
  getBuilderLeaderboardEntries,
  getBuilderMemberSnapshot,
  getBuilderStats,
  getOrCreateInviteLink,
  applyJoinAttribution,
  handleChatMemberUpdate,
  registerWelcomeOpportunity,
  noteBotWelcomeMessage,
  tryClaimFirstWelcome,
  tryClaimFirstWelcomeFromMessage,
  isValidWelcomeText,
  parseManualBuilderAwardArgs,
  grantManualBuilderAward,
  tryWalletMilestone,
  tryActiveMilestone,
  onWalletLinked,
  onLifetimeXpMutated,
  builderRankInsertionPoint,
  checkInvitePermission,
  configureCommunityBuilderForTests,
};
