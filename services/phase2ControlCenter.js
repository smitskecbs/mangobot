/**
 * Phase 2 Control Center — private admin-only decision support.
 * Read-only except explicit Create Mystery Gift (existing createReward).
 * Never auto-picks a winner or delivers assets.
 */

const crypto = require("node:crypto");
const { Markup } = require("telegraf");
const { log } = require("../utils/logger");
const { isCommunityCompetitionExcluded } = require("../utils/competition");
const {
  isAdmin,
  loadPoints,
  getUserRecord,
  getRank,
  getWeekId,
  getTodayDate,
  readStreak,
} = require("./points");
const { getWeeklyRanked } = require("./leaderboard");
const {
  getBuilderLeaderboard,
  getBuilderLeaderboardEntries,
  getBuilderMemberSnapshot,
  startOfUtcWeekMs,
  BUILDER_PERIOD,
} = require("./communityBuilder");
const {
  getLootAccount,
} = require("./mangoLoot");
const {
  getActiveTitle,
  getOwnedTitleIds,
  formatTitleLabel,
} = require("./mangoShop");
const {
  createReward,
  loadRewardsStore,
  listRewardsForUser,
  countRewardsForUser,
} = require("./memberRewards");
const { getMemberWalletProfile } = require("./memberWalletProfile");
const { isPrivateChat } = require("../utils/botMenu");

const PAGE_SIZE = 10;
const HOME_PREVIEW = 3;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 2000;
const TOKEN_RE = /^[A-Za-z0-9_-]{8}$/;

const PHASE2_CALLBACK = Object.freeze({
  HOME: "p2:home",
  XP: "p2:xp",
  BP: "p2:bp",
  ACTIVE: "p2:active",
  CANDIDATES: "p2:candidates",
  REWARDS: "p2:rewards",
  REWARDS_PENDING: "p2:rewards:p",
  REWARDS_SENT: "p2:rewards:s",
  CREATE: "p2:create",
});

const CANDIDATE_ORDER =
  "weekly XP descending, then weekly BP descending, then active days descending";

const REJECT_TEXT = "Not available.";
const GROUP_REJECT = "Open a private chat with the bot.";
const STALE_TEXT = "This selection expired. Open Control Center again.";
const UNVERIFIED_CREATE = "This member needs to verify a wallet first.";

const PENDING_STATUSES = new Set([
  "pending",
  "prepared",
  "delivery-ready",
  "submitted",
]);

const sessions = new Map();

function weeklyPointsAt(user, now) {
  if (!user || typeof user !== "object") {
    return 0;
  }
  if (user.weekId !== getWeekId(new Date(now))) {
    return 0;
  }
  return typeof user.weeklyPoints === "number" ? user.weeklyPoints : 0;
}

function utcDateMs(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    return NaN;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function daysInclusive(fromStr, toStr) {
  const start = utcDateMs(fromStr);
  const end = utcDateMs(toStr);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 0;
  }
  return Math.floor((end - start) / 86400000) + 1;
}

function isDateInCurrentUtcWeek(dateStr, now) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const weekStart = getWeekId(new Date(now));
  const today = getTodayDate(new Date(now));
  return dateStr >= weekStart && dateStr <= today;
}

/**
 * Consecutive days overlapping this UTC week from lastActiveDate + current streak.
 * Returns null when the store has no reliable overlap (no fabricated history).
 */
function consecutiveActiveDaysThisWeek(user, now) {
  const streak = readStreak(user);
  const last = streak.lastActiveDate;
  if (!isDateInCurrentUtcWeek(last, now)) {
    return null;
  }
  const weekStart = getWeekId(new Date(now));
  const span = daysInclusive(weekStart, last);
  if (streak.current <= 0) {
    return 1;
  }
  return Math.min(streak.current, span);
}

function sanitizeDisplayName(value, fallback = "Member") {
  if (typeof value !== "string") {
    return fallback;
  }
  const name = value.replace(/[\r\n]+/g, " ").trim();
  if (!name || /^\d+$/.test(name)) {
    return fallback;
  }
  return name.slice(0, 32);
}

function walletStatusLabel(profile) {
  if (profile && profile.verified) {
    return "🟢 Verified";
  }
  if (profile && (profile.registered || profile.wallet || profile.address)) {
    return "🟡 Registered";
  }
  return "⬜ Not linked";
}

function compactWalletLabel(profile) {
  if (profile && profile.verified) {
    return "✅ Linked";
  }
  if (profile && (profile.registered || profile.wallet || profile.address)) {
    return "🟡 Registered";
  }
  return "⬜ Not linked";
}

function pruneSessions(now = Date.now()) {
  for (const [token, row] of sessions.entries()) {
    if (!row || !Number.isFinite(row.expiresAt) || row.expiresAt <= now) {
      sessions.delete(token);
    }
  }
  while (sessions.size > MAX_SESSIONS) {
    const first = sessions.keys().next();
    if (first.done) {
      break;
    }
    sessions.delete(first.value);
  }
}

function issueSession(payload, now = Date.now()) {
  pruneSessions(now);
  for (let i = 0; i < 12; i += 1) {
    const token = crypto.randomBytes(6).toString("base64url").slice(0, 8);
    if (!TOKEN_RE.test(token) || /^\d+$/.test(token) || sessions.has(token)) {
      continue;
    }
    sessions.set(token, {
      ...payload,
      expiresAt: now + TOKEN_TTL_MS,
    });
    return token;
  }
  const fallback = crypto.randomBytes(8).toString("hex").slice(0, 8);
  sessions.set(fallback, { ...payload, expiresAt: now + TOKEN_TTL_MS });
  return fallback;
}

function resolveSession(token, now = Date.now()) {
  pruneSessions(now);
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return null;
  }
  const row = sessions.get(token);
  if (!row || row.expiresAt <= now) {
    sessions.delete(token);
    return null;
  }
  return row;
}

function resetPhase2Sessions() {
  sessions.clear();
}

function expirePhase2Sessions(now = Date.now()) {
  for (const row of sessions.values()) {
    if (row) {
      row.expiresAt = now - 1;
    }
  }
  pruneSessions(now);
}

function pageCallback(base, page) {
  if (!page) {
    return base;
  }
  return `${base}:${page}`;
}

function memberCallback(token) {
  return `p2:member:${token}`;
}

function parsePhase2Callback(data) {
  if (typeof data !== "string" || !data.startsWith("p2:")) {
    return null;
  }
  if (data === PHASE2_CALLBACK.HOME) {
    return { action: "home" };
  }
  if (data === PHASE2_CALLBACK.XP) {
    return { action: "xp", page: 0 };
  }
  if (data === PHASE2_CALLBACK.BP) {
    return { action: "bp", page: 0 };
  }
  if (data === PHASE2_CALLBACK.ACTIVE) {
    return { action: "active", page: 0 };
  }
  if (data === PHASE2_CALLBACK.CANDIDATES) {
    return { action: "candidates", page: 0 };
  }
  if (data === PHASE2_CALLBACK.REWARDS) {
    return { action: "rewards" };
  }
  if (data === PHASE2_CALLBACK.REWARDS_PENDING) {
    return { action: "rewards-pending" };
  }
  if (data === PHASE2_CALLBACK.REWARDS_SENT) {
    return { action: "rewards-sent" };
  }
  if (data === PHASE2_CALLBACK.CREATE) {
    return { action: "create", page: 0 };
  }

  let match = /^p2:xp:(\d+)$/.exec(data);
  if (match) {
    return { action: "xp", page: Number(match[1]) };
  }
  match = /^p2:bp:(\d+)$/.exec(data);
  if (match) {
    return { action: "bp", page: Number(match[1]) };
  }
  match = /^p2:active:(\d+)$/.exec(data);
  if (match) {
    return { action: "active", page: Number(match[1]) };
  }
  match = /^p2:candidates:(\d+)$/.exec(data);
  if (match) {
    return { action: "candidates", page: Number(match[1]) };
  }
  match = /^p2:create:(\d+)$/.exec(data);
  if (match) {
    return { action: "create", page: Number(match[1]) };
  }
  match = /^p2:member:([A-Za-z0-9_-]{8})$/.exec(data);
  if (match) {
    return { action: "member", token: match[1] };
  }
  match = /^p2:gift:([A-Za-z0-9_-]{8})$/.exec(data);
  if (match) {
    return { action: "gift", token: match[1] };
  }
  match = /^p2:make:([A-Za-z0-9_-]{8})$/.exec(data);
  if (match) {
    return { action: "make", token: match[1] };
  }
  match = /^p2:dlv:([A-Za-z0-9_-]{8})$/.exec(data);
  if (match) {
    return { action: "deliver", token: match[1] };
  }
  match = /^p2:mr:([A-Za-z0-9_-]{8})$/.exec(data);
  if (match) {
    return { action: "member-rewards", token: match[1] };
  }
  return { action: "unknown" };
}

function isPhase2Callback(data) {
  return Boolean(parsePhase2Callback(data));
}

function paginate(items, page, size = PAGE_SIZE) {
  const list = Array.isArray(items) ? items : [];
  const lastPage = Math.max(0, Math.ceil(list.length / size) - 1);
  const safePage = Math.min(Math.max(0, Number(page) || 0), lastPage);
  const start = safePage * size;
  return {
    rows: list.slice(start, start + size),
    page: safePage,
    lastPage,
    total: list.length,
  };
}

function navRow(base, page, lastPage) {
  const row = [];
  if (page > 0) {
    row.push({
      text: "⬅️ Previous",
      callback_data: pageCallback(base, page - 1),
    });
  }
  if (page < lastPage) {
    row.push({
      text: "Next ➡️",
      callback_data: pageCallback(base, page + 1),
    });
  }
  return row.length ? [row] : [];
}

function backHomeRow() {
  return [[{ text: "⬅️ Back", callback_data: PHASE2_CALLBACK.HOME }]];
}

function extraFromRows(rows) {
  return Markup.inlineKeyboard(rows);
}

function fileOptions(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return {
    pointsFile: options.pointsFile,
    walletFile: options.walletFile,
    rewardsFile: options.rewardsFile,
    storeFile: options.storeFile,
    shopFile: options.shopFile,
    deliveryFile: options.deliveryFile,
    now,
  };
}

function builderOpts(options) {
  const files = fileOptions(options);
  return {
    storeFile: files.storeFile,
    pointsFile: files.pointsFile,
    walletFile: files.walletFile,
    now: files.now,
    period: BUILDER_PERIOD.WEEKLY,
  };
}

function collectXpLeaders(options) {
  const files = fileOptions(options);
  const data = loadPoints(files.pointsFile);
  return getWeeklyRanked(data.users, (user) => weeklyPointsAt(user, files.now)).map(
    (user) => ({
      userId: String(user.userId),
      displayName: sanitizeDisplayName(user.name),
      weeklyXp: user.weeklyPoints,
      lifetimeXp: typeof user.points === "number" ? user.points : 0,
    })
  );
}

function collectBpLeaders(options) {
  const files = fileOptions(options);
  return getBuilderLeaderboardEntries({
    ...builderOpts(files),
    period: BUILDER_PERIOD.WEEKLY,
  }).map((row) => ({
    userId: String(row.userId),
    displayName: sanitizeDisplayName(row.displayName),
    weeklyBp: row.points,
    activeReferrals: row.activeCount || 0,
  }));
}

function publicBpLeaders(options) {
  const files = fileOptions(options);
  return getBuilderLeaderboard({
    ...builderOpts(files),
    period: BUILDER_PERIOD.WEEKLY,
  });
}

function isActiveThisWeek(user, userId, now) {
  if (isCommunityCompetitionExcluded(userId)) {
    return false;
  }
  if (weeklyPointsAt(user, now) > 0) {
    return true;
  }
  return isDateInCurrentUtcWeek(readStreak(user).lastActiveDate, now);
}

function collectActiveMembers(options) {
  const files = fileOptions(options);
  const data = loadPoints(files.pointsFile);
  const rows = [];
  for (const [userId, user] of Object.entries(data.users || {})) {
    if (!isActiveThisWeek(user, userId, files.now)) {
      continue;
    }
    const weeklyXp = weeklyPointsAt(user, files.now);
    const lifetimeXp = user && typeof user.points === "number" ? user.points : 0;
    rows.push({
      userId: String(userId),
      displayName: sanitizeDisplayName(user && user.name),
      weeklyXp,
      lifetimeXp,
      rank: getRank(lifetimeXp),
      activeDays: consecutiveActiveDaysThisWeek(user, files.now),
    });
  }
  rows.sort(
    (a, b) =>
      b.weeklyXp - a.weeklyXp ||
      (b.activeDays || 0) - (a.activeDays || 0) ||
      String(a.userId).localeCompare(String(b.userId))
  );
  return rows;
}

function collectCandidates(options) {
  const files = fileOptions(options);
  const byId = new Map();
  for (const row of collectXpLeaders(files)) {
    byId.set(row.userId, {
      userId: row.userId,
      displayName: row.displayName,
      weeklyXp: row.weeklyXp,
      weeklyBp: 0,
      activeDays: null,
      rankTitle: getRank(row.lifetimeXp).title,
      referralsActive: 0,
    });
  }
  for (const row of collectActiveMembers(files)) {
    const current = byId.get(row.userId) || {
      userId: row.userId,
      displayName: row.displayName,
      weeklyXp: row.weeklyXp,
      weeklyBp: 0,
      activeDays: row.activeDays,
      rankTitle: row.rank.title,
      referralsActive: 0,
    };
    current.activeDays = row.activeDays;
    current.weeklyXp = Math.max(current.weeklyXp, row.weeklyXp);
    current.rankTitle = row.rank.title;
    byId.set(row.userId, current);
  }
  for (const row of collectBpLeaders(files)) {
    if (isAdmin(row.userId) || isCommunityCompetitionExcluded(row.userId)) {
      continue;
    }
    const current = byId.get(row.userId) || {
      userId: row.userId,
      displayName: row.displayName,
      weeklyXp: 0,
      weeklyBp: 0,
      activeDays: null,
      rankTitle: "Seed",
      referralsActive: 0,
    };
    current.weeklyBp = row.weeklyBp;
    current.referralsActive = row.activeReferrals;
    if (current.displayName === "Member") {
      current.displayName = row.displayName;
    }
    byId.set(row.userId, current);
  }

  const data = loadPoints(files.pointsFile);
  for (const row of byId.values()) {
    const snapshot = getBuilderMemberSnapshot(row.userId, builderOpts(files));
    row.weeklyBp = snapshot.weeklyBp;
    row.referralsActive = snapshot.activeReferrals;
    const user = getUserRecord(data, row.userId);
    if (row.activeDays == null) {
      row.activeDays = consecutiveActiveDaysThisWeek(user, files.now);
    }
    const lifetimeXp = user && typeof user.points === "number" ? user.points : 0;
    row.rankTitle = getRank(lifetimeXp).title;
    row.weeklyXp = weeklyPointsAt(user, files.now);
  }

  return [...byId.values()].sort(
    (a, b) =>
      b.weeklyXp - a.weeklyXp ||
      b.weeklyBp - a.weeklyBp ||
      (b.activeDays || 0) - (a.activeDays || 0) ||
      String(a.userId).localeCompare(String(b.userId))
  );
}

function collectCreatePool(options) {
  const seen = new Map();
  for (const row of collectCandidates(options)) {
    if (isAdmin(row.userId)) {
      continue;
    }
    seen.set(row.userId, row);
  }
  return [...seen.values()];
}

function listAllRewards(rewardsFile) {
  const store = loadRewardsStore(rewardsFile);
  const out = [];
  for (const [rewardId, record] of Object.entries(store.rewards || {})) {
    if (record && typeof record === "object") {
      out.push({ ...record, rewardId });
    }
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

function inCurrentWeek(ts, now) {
  const stamp = Number(ts);
  if (!Number.isFinite(stamp) || stamp <= 0) {
    return false;
  }
  return stamp >= startOfUtcWeekMs(now) && stamp <= now;
}

function rewardStats(options) {
  const files = fileOptions(options);
  const rewards = listAllRewards(files.rewardsFile);
  let pending = 0;
  let deliveryReady = 0;
  let sentThisWeek = 0;
  let offchainThisWeek = 0;
  for (const reward of rewards) {
    if (PENDING_STATUSES.has(reward.status)) {
      pending += 1;
    }
    if (reward.status === "delivery-ready") {
      deliveryReady += 1;
    }
    if (reward.status === "sent" && inCurrentWeek(reward.sentAt, files.now)) {
      sentThisWeek += 1;
    }
    if (inCurrentWeek(reward.offchainDeliveredAt, files.now)) {
      offchainThisWeek += 1;
    }
  }
  return { pending, deliveryReady, sentThisWeek, offchainThisWeek, rewards };
}

function publicRewardStatus(reward) {
  if (reward.status === "sent") {
    return "Sent";
  }
  if (PENDING_STATUSES.has(reward.status)) {
    return "Pending";
  }
  return null;
}

function formatActiveDays(value) {
  return value == null ? "—" : String(value);
}

function memberButtons(rows, now, action = "member") {
  return rows.map((row) => {
    const token = issueSession(
      { kind: "member", userId: row.userId, createdRewardId: null },
      now
    );
    const prefix = action === "gift" ? "p2:gift:" : "p2:member:";
    return [
      {
        text: sanitizeDisplayName(row.displayName),
        callback_data: `${prefix}${token}`,
      },
    ];
  });
}

function numberedXpLines(rows) {
  if (!rows.length) {
    return ["None yet."];
  }
  return rows.map(
    (row, index) =>
      `${index + 1}. ${sanitizeDisplayName(row.displayName)} — ${row.weeklyXp} XP`
  );
}

function numberedBpLines(rows) {
  if (!rows.length) {
    return ["None yet."];
  }
  return rows.map(
    (row) =>
      `${row.rank}. ${sanitizeDisplayName(row.displayName)} — ${row.points} BP`
  );
}

function buildHomeView(options = {}) {
  const files = fileOptions(options);
  const xp = collectXpLeaders(files).slice(0, HOME_PREVIEW);
  const bp = publicBpLeaders(files).slice(0, HOME_PREVIEW);
  const active = collectActiveMembers(files);
  const stats = rewardStats(files);
  const lines = [
    "🚀 Phase 2 Control Center",
    "",
    "This week",
    "",
    "🏆 XP Leaders",
    ...numberedXpLines(xp),
    "",
    "🤝 Builder Leaders",
    ...numberedBpLines(bp),
    "",
    "🌱 Active Members",
    `${active.length} active this week`,
    "",
    "🎁 Mystery Gifts",
    `Pending: ${stats.pending}`,
    `Sent this week: ${stats.sentThisWeek}`,
  ];
  const extra = extraFromRows([
    [{ text: "🏆 XP Leaders", callback_data: PHASE2_CALLBACK.XP }],
    [{ text: "🤝 Builder Leaders", callback_data: PHASE2_CALLBACK.BP }],
    [{ text: "🌱 Active Members", callback_data: PHASE2_CALLBACK.ACTIVE }],
    [{ text: "🎯 Weekly Candidates", callback_data: PHASE2_CALLBACK.CANDIDATES }],
    [{ text: "🎁 Mystery Gifts", callback_data: PHASE2_CALLBACK.REWARDS }],
    [{ text: "➕ Create Reward", callback_data: PHASE2_CALLBACK.CREATE }],
  ]);
  return { text: lines.join("\n"), extra };
}

function buildXpView(options = {}, page = 0) {
  const files = fileOptions(options);
  const all = collectXpLeaders(files);
  const paged = paginate(all, page);
  const offset = paged.page * PAGE_SIZE;
  const lines = [
    "🏆 Weekly XP Leaders",
    "",
    ...(paged.rows.length
      ? paged.rows.map(
          (row, index) =>
            `${offset + index + 1}. ${sanitizeDisplayName(row.displayName)} — ${row.weeklyXp} XP`
        )
      : ["None yet."]),
  ];
  const rows = [
    ...memberButtons(paged.rows, files.now),
    ...navRow(PHASE2_CALLBACK.XP, paged.page, paged.lastPage),
    [{ text: "🎁 Reward Member", callback_data: PHASE2_CALLBACK.CREATE }],
    ...backHomeRow(),
  ];
  return { text: lines.join("\n"), extra: extraFromRows(rows) };
}

function buildBpView(options = {}, page = 0) {
  const files = fileOptions(options);
  const all = collectBpLeaders(files);
  const publicRows = publicBpLeaders(files);
  const paged = paginate(all, page);
  const offset = paged.page * PAGE_SIZE;
  const lines = [
    "🤝 Weekly Builder Leaders",
    "",
    ...(paged.rows.length
      ? paged.rows.map(
          (row, index) =>
            `${offset + index + 1}. ${sanitizeDisplayName(row.displayName)} — ${row.weeklyBp} BP`
        )
      : ["None yet."]),
  ];
  const rows = [
    ...memberButtons(paged.rows, files.now),
    ...navRow(PHASE2_CALLBACK.BP, paged.page, paged.lastPage),
    ...backHomeRow(),
  ];
  return {
    text: lines.join("\n"),
    extra: extraFromRows(rows),
    publicRows,
  };
}

function formatActiveCard(row, options) {
  const files = fileOptions(options);
  const wallet = getMemberWalletProfile(row.userId, files);
  const days = formatActiveDays(row.activeDays);
  return [
    sanitizeDisplayName(row.displayName),
    `• Active days: ${days}`,
    `• Weekly XP: ${row.weeklyXp}`,
    `• Rank: ${row.rank.title}`,
    `• Wallet: ${compactWalletLabel(wallet)}`,
  ].join("\n");
}

function buildActiveView(options = {}, page = 0) {
  const files = fileOptions(options);
  const all = collectActiveMembers(files);
  const paged = paginate(all, page);
  const lines = ["🌱 Active Members", ""];
  if (!paged.rows.length) {
    lines.push("None yet.");
  } else {
    lines.push(paged.rows.map((row) => formatActiveCard(row, files)).join("\n\n"));
  }
  const rows = [
    ...memberButtons(paged.rows, files.now),
    ...navRow(PHASE2_CALLBACK.ACTIVE, paged.page, paged.lastPage),
    ...backHomeRow(),
  ];
  return { text: lines.join("\n"), extra: extraFromRows(rows) };
}

function formatCandidateCard(row) {
  const lines = [
    sanitizeDisplayName(row.displayName),
    `• Weekly XP: ${row.weeklyXp}`,
    `• Builder BP: ${row.weeklyBp}`,
    `• Active days: ${formatActiveDays(row.activeDays)}`,
    `• Rank: ${row.rankTitle}`,
  ];
  if (row.referralsActive > 0) {
    lines.push(`• Referrals active: ${row.referralsActive}`);
  }
  return lines.join("\n");
}

function buildCandidatesView(options = {}, page = 0) {
  const files = fileOptions(options);
  const all = collectCandidates(files);
  const paged = paginate(all, page);
  const lines = ["🎯 Weekly Reward Candidates", ""];
  if (!paged.rows.length) {
    lines.push("None yet.");
  } else {
    lines.push(paged.rows.map((row) => formatCandidateCard(row)).join("\n\n"));
  }
  const rows = [
    ...memberButtons(paged.rows, files.now),
    ...navRow(PHASE2_CALLBACK.CANDIDATES, paged.page, paged.lastPage),
    ...backHomeRow(),
  ];
  return { text: lines.join("\n"), extra: extraFromRows(rows) };
}

function formatRewardOverviewLine(reward) {
  const status = publicRewardStatus(reward);
  if (!status) {
    return null;
  }
  const name = sanitizeDisplayName(reward.displayNameSnapshot);
  return `${name} — ${status}`;
}

function buildRewardsView(options = {}) {
  const files = fileOptions(options);
  const stats = rewardStats(files);
  const recent = [];
  for (const reward of stats.rewards) {
    const line = formatRewardOverviewLine(reward);
    if (line) {
      recent.push(line);
    }
    if (recent.length >= 10) {
      break;
    }
  }
  const lines = [
    "🎁 Mystery Gifts",
    "",
    `Pending: ${stats.pending}`,
    `Delivery-ready: ${stats.deliveryReady}`,
    `Sent this week: ${stats.sentThisWeek}`,
    `Off-chain delivered this week: ${stats.offchainThisWeek}`,
  ];
  if (recent.length) {
    lines.push("", ...recent);
  }
  const extra = extraFromRows([
    [{ text: "➕ Create Reward", callback_data: PHASE2_CALLBACK.CREATE }],
    [{ text: "📋 Pending", callback_data: PHASE2_CALLBACK.REWARDS_PENDING }],
    [{ text: "✅ Sent This Week", callback_data: PHASE2_CALLBACK.REWARDS_SENT }],
    ...backHomeRow(),
  ]);
  return { text: lines.join("\n"), extra };
}

function buildRewardSubsetView(kind, options = {}) {
  const files = fileOptions(options);
  const stats = rewardStats(files);
  const lines = [];
  if (kind === "pending") {
    lines.push("📋 Pending Mystery Gifts", "");
    const pending = stats.rewards.filter((row) => PENDING_STATUSES.has(row.status));
    if (!pending.length) {
      lines.push("None.");
    } else {
      for (const reward of pending.slice(0, 20)) {
        lines.push(
          `${sanitizeDisplayName(reward.displayNameSnapshot)} — Pending`
        );
      }
    }
  } else {
    lines.push("✅ Sent This Week", "");
    const sent = stats.rewards.filter(
      (row) => row.status === "sent" && inCurrentWeek(row.sentAt, files.now)
    );
    if (!sent.length) {
      lines.push("None.");
    } else {
      for (const reward of sent.slice(0, 20)) {
        lines.push(`${sanitizeDisplayName(reward.displayNameSnapshot)} — Sent`);
      }
    }
  }
  return {
    text: lines.join("\n"),
    extra: extraFromRows([
      [{ text: "🎁 Mystery Gifts", callback_data: PHASE2_CALLBACK.REWARDS }],
      kind === "pending"
        ? [{ text: "🗑 Clear Pending", callback_data: "cpg:ask" }]
        : null,
      ...backHomeRow(),
    ].filter(Boolean)),
  };
}

function buildCreateView(options = {}, page = 0) {
  const files = fileOptions(options);
  const all = collectCreatePool(files);
  const paged = paginate(all, page);
  const lines = ["🎁 Create Mystery Gift", "", "Choose a member:"];
  const rows = [
    ...memberButtons(paged.rows, files.now, "gift"),
    ...navRow(PHASE2_CALLBACK.CREATE, paged.page, paged.lastPage),
    ...backHomeRow(),
  ];
  if (!paged.rows.length) {
    lines.push("", "No known members this week.");
  }
  return { text: lines.join("\n"), extra: extraFromRows(rows) };
}

function loadMemberDetail(userId, options = {}) {
  const files = fileOptions(options);
  const data = loadPoints(files.pointsFile);
  const user = getUserRecord(data, userId);
  const lifetimeXp = user && typeof user.points === "number" ? user.points : 0;
  const weeklyXp = weeklyPointsAt(user, files.now);
  const rank = getRank(lifetimeXp);
  const builder = getBuilderMemberSnapshot(userId, builderOpts(files));
  const wallet = getMemberWalletProfile(userId, files);
  const rewards = countRewardsForUser(userId, files.rewardsFile);
  let mangoLoot = 0;
  let activeTitleLabel = "None";
  let ownedTitleCount = 0;
  let dailyQuestToday = "0/3";
  let dailyStreak = 0;
  try {
    mangoLoot = getLootAccount(userId, files.shopFile).balance;
    ownedTitleCount = getOwnedTitleIds(userId, files.shopFile).length;
    const activeTitle = getActiveTitle(userId, files.shopFile);
    activeTitleLabel = activeTitle ? formatTitleLabel(activeTitle) : "None";
    const { getDailyQuestSnapshot } = require("./dailyQuest");
    const quest = getDailyQuestSnapshot(userId, {
      shopFile: files.shopFile,
      walletFile: files.walletFile,
      now: files.now,
    });
    dailyQuestToday = `${quest.completedToday}/3 today`;
    dailyStreak = quest.streak;
  } catch (_err) {
    mangoLoot = 0;
    activeTitleLabel = "None";
    ownedTitleCount = 0;
  }
  return {
    userId: String(userId),
    displayName: sanitizeDisplayName(
      (user && user.name) || builder.displayName
    ),
    weeklyXp,
    lifetimeXp,
    rank,
    weeklyBp: builder.weeklyBp,
    alltimeBp: builder.alltimeBp,
    mangoLoot,
    activeTitleLabel,
    ownedTitleCount,
    dailyQuestToday,
    dailyStreak,
    activeDays: consecutiveActiveDaysThisWeek(user, files.now),
    referralsActive: builder.activeReferrals,
    walletStatus: walletStatusLabel(wallet),
    pendingRewards: rewards.pending,
    sentRewards: rewards.delivered,
  };
}

function buildMemberView(detail, now = Date.now()) {
  const token = issueSession(
    { kind: "member", userId: detail.userId, createdRewardId: null },
    now
  );
  const lines = [
    `👤 ${detail.displayName}`,
    "",
    `Weekly XP: ${detail.weeklyXp}`,
    `All-time XP: ${detail.lifetimeXp}`,
    `Rank: ${detail.rank.title}`,
    `Builder BP this week: ${detail.weeklyBp}`,
    `Builder BP all-time: ${detail.alltimeBp}`,
    `ManGo Loot: ${detail.mangoLoot}`,
    `Active title: ${detail.activeTitleLabel}`,
    `Owned titles: ${detail.ownedTitleCount}`,
    `Daily Quest: ${detail.dailyQuestToday}`,
    `Daily streak: ${detail.dailyStreak}`,
    `Active days this week: ${formatActiveDays(detail.activeDays)}`,
    `Wallet: ${detail.walletStatus}`,
    `Pending Mystery Gifts: ${detail.pendingRewards}`,
    `Sent Mystery Gifts: ${detail.sentRewards}`,
  ];
  const extra = extraFromRows([
    [{ text: "🎁 Create Mystery Gift", callback_data: `p2:gift:${token}` }],
    [{ text: "📋 Rewards", callback_data: `p2:mr:${token}` }],
    ...backHomeRow(),
  ]);
  return { text: lines.join("\n"), extra };
}

function buildGiftConfirmView(detail, token) {
  return {
    text: [`🎁 Mystery Gift for ${detail.displayName}`, ""].join("\n"),
    extra: extraFromRows([
      [{ text: "🎲 Mystery Gift", callback_data: `p2:make:${token}` }],
      [{ text: "⬅️ Back", callback_data: memberCallback(token) }],
    ]),
  };
}

function buildCreatedView(reward, displayName, now = Date.now()) {
  const token = issueSession(
    { kind: "reward", rewardId: reward.rewardId },
    now
  );
  const lines = [
    "🎁 Mystery Gift prepared",
    "",
    `Member: ${sanitizeDisplayName(displayName)}`,
    "Status: Pending",
    `Reward ID: ${reward.rewardId}`,
  ];
  return {
    text: lines.join("\n"),
    extra: extraFromRows([
      [{ text: "🚚 Deliver Now", callback_data: `p2:dlv:${token}` }],
      [{ text: "⬅️ Control Center", callback_data: PHASE2_CALLBACK.HOME }],
    ]),
    rewardId: reward.rewardId,
  };
}

function buildMemberRewardsView(userId, options = {}) {
  const files = fileOptions(options);
  const detail = loadMemberDetail(userId, files);
  const list = listRewardsForUser(userId, files.rewardsFile);
  const lines = [`🎁 Rewards for ${detail.displayName}`, ""];
  const visible = list.filter((row) => publicRewardStatus(row));
  if (!visible.length) {
    lines.push("No rewards recorded.");
  } else {
    for (const reward of visible.slice(0, 10)) {
      lines.push(
        `${sanitizeDisplayName(detail.displayName)} — ${publicRewardStatus(reward)}`
      );
    }
  }
  const token = issueSession(
    { kind: "member", userId: String(userId), createdRewardId: null },
    files.now
  );
  return {
    text: lines.join("\n"),
    extra: extraFromRows([
      [{ text: "🎁 Create Mystery Gift", callback_data: `p2:gift:${token}` }],
      ...backHomeRow(),
    ]),
  };
}

function createMysteryGiftForMember(userId, adminUserId, options = {}) {
  const files = fileOptions(options);
  const data = loadPoints(files.pointsFile);
  const user = getUserRecord(data, userId);
  const displayName = sanitizeDisplayName(user && user.name);
  log("[phase2] reward create started");
  const result = createReward({
    telegramUserId: userId,
    type: "mystery-gift",
    createdBy: adminUserId,
    displayName,
    walletFile: files.walletFile,
    rewardsFile: files.rewardsFile,
    pointsFile: files.pointsFile,
    now: files.now,
  });
  if (result.ok) {
    log("[phase2] reward created");
  }
  return { ...result, displayName };
}

function gatePhase2Access(ctx) {
  if (!ctx || !ctx.from) {
    return { ok: false, reason: "no-user", silent: true };
  }
  if (!isAdmin(ctx.from.id)) {
    return { ok: false, reason: "not-admin", text: REJECT_TEXT };
  }
  if (!isPrivateChat(ctx)) {
    return { ok: false, reason: "not-private", text: GROUP_REJECT };
  }
  return { ok: true };
}

function collectCallbackData(extra) {
  const rows =
    extra && extra.reply_markup && extra.reply_markup.inline_keyboard;
  if (!Array.isArray(rows)) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (button && typeof button.callback_data === "string") {
        out.push(button.callback_data);
      }
    }
  }
  return out;
}

module.exports = {
  PAGE_SIZE,
  HOME_PREVIEW,
  TOKEN_TTL_MS,
  PHASE2_CALLBACK,
  CANDIDATE_ORDER,
  REJECT_TEXT,
  GROUP_REJECT,
  STALE_TEXT,
  UNVERIFIED_CREATE,
  parsePhase2Callback,
  isPhase2Callback,
  resetPhase2Sessions,
  expirePhase2Sessions,
  resolveSession,
  issueSession,
  weeklyPointsAt,
  consecutiveActiveDaysThisWeek,
  collectXpLeaders,
  collectBpLeaders,
  collectActiveMembers,
  collectCandidates,
  collectCreatePool,
  rewardStats,
  loadMemberDetail,
  buildHomeView,
  buildXpView,
  buildBpView,
  buildActiveView,
  buildCandidatesView,
  buildRewardsView,
  buildRewardSubsetView,
  buildCreateView,
  buildMemberView,
  buildGiftConfirmView,
  buildCreatedView,
  buildMemberRewardsView,
  createMysteryGiftForMember,
  gatePhase2Access,
  collectCallbackData,
  sanitizeDisplayName,
  walletStatusLabel,
};
