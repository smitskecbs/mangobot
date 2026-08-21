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
const { loadPoints, getWeekId, isAdmin } = require("./points");
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
});

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

function putBuilderAwardEvent(store, input) {
  const events = ensureBuilderEvents(store);
  const referralUserId = normalizeUserId(input.referralUserId);
  const builderUserId = normalizeUserId(input.builderUserId);
  const reason = input.reason;
  if (!referralUserId || !builderUserId || !reason) {
    return { recorded: false, duplicate: false };
  }
  const eventId = builderEventId(referralUserId, reason);
  if (events[eventId]) {
    return { recorded: false, duplicate: true, eventId };
  }
  events[eventId] = {
    eventId,
    builderUserId,
    points: input.points,
    reason,
    referralUserId,
    createdAt: input.createdAt,
  };
  return { recorded: true, duplicate: false, eventId };
}

function awardBuilderPointsOnce(store, builder, amount, meta) {
  const recorded = putBuilderAwardEvent(store, {
    builderUserId: meta.builderUserId,
    points: amount,
    reason: meta.reason,
    referralUserId: meta.referralUserId,
    createdAt: meta.createdAt,
  });
  if (recorded.duplicate) {
    return {
      duplicate: true,
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

function awardInviterXp(inviterId, displayName, amount, options) {
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
    typeof options.notify === "function" ? options.notify : notifyCommunityBuilder;
  Promise.resolve(notify(kind, payload, options)).catch((err) => {
    logError(
      "[community-builder] notify failed:",
      err && err.message ? err.message : err
    );
  });
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

function getBuilderLeaderboard(periodOrOptions, maybeNow) {
  const raw = resolveLeaderboardArgs(periodOrOptions, maybeNow);
  const opts = resolveOptions(raw);
  const period = normalizeBuilderPeriod(raw.period) || BUILDER_PERIOD.ALLTIME;
  const store = loadBuilderStore(opts.storeFile);
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
    displayName: row.displayName,
    points: row.points,
  }));
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

function emptyLeaderboardText(period) {
  if (period === BUILDER_PERIOD.WEEKLY) {
    return `${periodLeaderboardTitle(period)}\n\nNo Builder Points earned this week yet.`;
  }
  if (period === BUILDER_PERIOD.MONTHLY) {
    return `${periodLeaderboardTitle(period)}\n\nNo Builder Points earned this month yet.`;
  }
  return `${periodLeaderboardTitle(period)}\n\nNo Builder Points yet. Invite real members to start.`;
}

function formatBuilderLeaderboard(rows, period = BUILDER_PERIOD.ALLTIME, kind = "private") {
  const normalized = normalizeBuilderPeriod(period) || BUILDER_PERIOD.ALLTIME;
  if (!rows || !rows.length) {
    return emptyLeaderboardText(normalized);
  }
  const lines = [periodLeaderboardTitle(normalized), ""];
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
  const store = loadBuilderStore(opts.storeFile);
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
  const store = loadBuilderStore(opts.storeFile);
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
  const existing = mutateBuilderStore((store) => {
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
  return mutateBuilderStore((store) => {
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

function applyJoinAttribution(input, options = {}) {
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

  const result = mutateBuilderStore((store) => {
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

  const xp = awardInviterXp(
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

  tryFollowUpMilestones(referredId, opts);
  return {
    ...result,
    xpAwarded,
    xpReason: xp && xp.reason,
  };
}

function handleChatMemberUpdate(update, options = {}) {
  if (!update || typeof update !== "object") {
    return { ok: false, reason: "invalid-update" };
  }
  const chatId = update.chat && update.chat.id;
  const newMember = update.new_chat_member || {};
  const oldMember = update.old_chat_member || {};
  const user = newMember.user || oldMember.user || {};
  return applyJoinAttribution(
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
}

function tryWalletMilestone(referredId, options = {}) {
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
  const result = mutateBuilderStore((store) => {
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

  const xp = awardInviterXp(
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
  const result = mutateBuilderStore((store) => {
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

function tryFollowUpMilestones(referredId, options = {}) {
  const opts = resolveOptions(options);
  const uid = normalizeUserId(referredId);
  if (!uid) {
    return;
  }
  if (getLinkedWalletForUser(uid, opts.walletFile)) {
    tryWalletMilestone(uid, opts);
  }
  if (lifetimePointsOf(uid, opts.pointsFile) >= ACTIVE_LIFETIME_XP) {
    tryActiveMilestone(uid, opts);
  }
}

function onWalletLinked(userId, options = {}) {
  try {
    return tryWalletMilestone(userId, options);
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
  REFERRALS_PAGE_SIZE,
  LEADERBOARD_LIMIT,
  BUILDER_RANK_THRESHOLDS,
  JOIN_EVENT,
  BUILDER_PERIOD,
  BUILDER_EVENT_REASON,
  builderEventId,
  startOfUtcWeekMs,
  startOfUtcMonthMs,
  normalizeBuilderPeriod,
  formatBuilderLeaderboard,
  shareBuilderLeaderboard,
  getBuilderPeriodTotals,
  inviteIdentity,
  safeDisplayName,
  isJoinTransition,
  builderSummary,
  listReferrals,
  paginateReferrals,
  getBuilderLeaderboard,
  getBuilderStats,
  getOrCreateInviteLink,
  applyJoinAttribution,
  handleChatMemberUpdate,
  tryWalletMilestone,
  tryActiveMilestone,
  onWalletLinked,
  onLifetimeXpMutated,
  builderRankInsertionPoint,
  checkInvitePermission,
  configureCommunityBuilderForTests,
};
