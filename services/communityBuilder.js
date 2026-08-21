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
const { loadPoints } = require("./points");
const { notifyCommunityBuilder } = require("./communityBuilderNotify");

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

function getBuilderLeaderboard(options = {}) {
  const opts = resolveOptions(options);
  const store = loadBuilderStore(opts.storeFile);
  const rows = [];
  for (const [userId, builder] of Object.entries(store.builders || {})) {
    if (!builder || typeof builder !== "object") {
      continue;
    }
    const points = typeof builder.points === "number" ? builder.points : 0;
    if (points <= 0) {
      continue;
    }
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
  return {
    uniqueReferrals: referrals.length,
    walletLinked,
    active,
    totalBuilders: builders.length,
    top: getBuilderLeaderboard(opts),
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
    return { ok: false, reason: "wrong-chat" };
  }
  if (!referredId) {
    return { ok: false, reason: "invalid-user" };
  }
  if (input.isBot) {
    return { ok: false, reason: "bot" };
  }
  if (!isJoinTransition(input.oldStatus, input.newStatus)) {
    return { ok: false, reason: "not-join" };
  }
  const inviteUrl = extractUsedInviteLink({ invite_link: input.inviteLink });
  const identity = inviteIdentity(inviteUrl);
  if (!identity) {
    return { ok: false, reason: "public-join" };
  }

  const result = mutateBuilderStore((store) => {
    const existing = store.referrals[referredId];
    if (existing && existing.inviterUserId) {
      return { ok: false, reason: "already-attributed", frozen: true };
    }
    const link = store.inviteLinks[identity];
    if (!link || !link.inviterUserId) {
      return { ok: false, reason: "unknown-invite" };
    }
    const inviterId = normalizeUserId(link.inviterUserId);
    if (!inviterId) {
      return { ok: false, reason: "unknown-invite" };
    }
    if (inviterId === referredId) {
      return { ok: false, reason: "self-referral" };
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
    const ranked = addBuilderPoints(builder, JOIN_BUILDER_POINTS);
    return {
      ok: true,
      stage: "join",
      inviterUserId: inviterId,
      inviterName: builder.displayName,
      builderPointsAwarded: JOIN_BUILDER_POINTS,
      xpAmount: JOIN_XP,
      rankCrossed: ranked.crossed,
    };
  }, opts.storeFile);

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
    referral.walletMilestoneAt = opts.now;
    const builder = ensureBuilder(store, referral.inviterUserId, null, opts.now);
    const ranked = addBuilderPoints(builder, WALLET_BUILDER_POINTS);
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
    referral.activeMilestoneAt = opts.now;
    const builder = ensureBuilder(store, referral.inviterUserId, null, opts.now);
    const ranked = addBuilderPoints(builder, ACTIVE_BUILDER_POINTS);
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
