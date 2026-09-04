/**
 * One-time conservative dry-run: known Telegram user IDs with no wallet
 * and no recorded participation. Does not remove anyone. Does not write stores.
 */

const { isAdmin, loadPoints } = require("./points");
const { loadWalletStore, getLinkedWalletFromStore } = require("./walletLinks");
const { loadShopStore } = require("./mangoShopStore");
const { loadPresaleStore } = require("./presaleStore");
const { loadRewardsStore } = require("./memberRewards");
const { loadBuilderStore } = require("./communityBuilderStore");
const { readScoresFile: readSnakeScores, getScoresFilePath: getSnakeScoresPath } = require("./snakeScores");
const { readScoresFile: readBounchScores, getScoresFilePath: getBounchScoresPath } = require("./bounchScores");
const { readWinnersState } = require("./weeklyWinners");
const { getConfiguredCommunityChatId } = require("./chatFight");

const CURRENT_IN_CHAT = new Set([
  "member",
  "administrator",
  "creator",
  "restricted",
]);

const TELEGRAM_TEXT_LIMIT = 3900;

function asTelegramUserId(raw) {
  if (raw === undefined || raw === null) {
    return "";
  }
  const uid = String(raw).trim();
  return /^\d{1,20}$/.test(uid) ? uid : "";
}

function addId(set, raw) {
  const id = asTelegramUserId(raw);
  if (id) {
    set.add(id);
  }
}

function addKeys(set, map) {
  if (!map || typeof map !== "object") {
    return;
  }
  for (const key of Object.keys(map)) {
    addId(set, key);
  }
}

function addScoreTelegramIds(set, scores) {
  const board = scores && Array.isArray(scores.leaderboard) ? scores.leaderboard : [];
  for (const entry of board) {
    if (entry && entry.telegramUserId != null) {
      addId(set, entry.telegramUserId);
    }
  }
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function collectKnownUserIds(stores) {
  const ids = new Set();
  addKeys(ids, stores.pointsUsers);
  addKeys(ids, stores.walletUsers);
  addKeys(ids, stores.walletPendingInputs);
  addKeys(ids, stores.shopUsers);
  addKeys(ids, stores.presaleUsers);
  addKeys(ids, stores.rewardByUser);
  addKeys(ids, stores.builderBuilders);
  addKeys(ids, stores.builderReferrals);
  addKeys(ids, stores.builderWelcome);
  addKeys(ids, stores.builderInviteLinks);
  if (stores.builderInviteLinks && typeof stores.builderInviteLinks === "object") {
    for (const link of Object.values(stores.builderInviteLinks)) {
      if (link && link.inviterUserId != null) {
        addId(ids, link.inviterUserId);
      }
    }
  }
  if (stores.builderEvents && typeof stores.builderEvents === "object") {
    for (const event of Object.values(stores.builderEvents)) {
      if (event && event.builderUserId != null) {
        addId(ids, event.builderUserId);
      }
    }
  }
  if (Array.isArray(stores.highscoreUserIds)) {
    for (const id of stores.highscoreUserIds) {
      addId(ids, id);
    }
  }
  if (Array.isArray(stores.weeklyUserIds)) {
    for (const id of stores.weeklyUserIds) {
      addId(ids, id);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function hasLinkedWallet(userId, stores) {
  return Boolean(getLinkedWalletFromStore({ users: stores.walletUsers || {} }, userId));
}

function hasChatParticipation(user) {
  if (!user || typeof user !== "object") {
    return false;
  }
  if (hasNonEmptyString(user.activityDate)) {
    return true;
  }
  const streak = user.streak;
  return Boolean(streak && hasNonEmptyString(streak.lastActiveDate));
}

function hasXp(user) {
  if (!user || typeof user !== "object") {
    return false;
  }
  return positiveNumber(user.points) || positiveNumber(user.weeklyPoints);
}

function hasPointsGameParticipation(user) {
  if (!user || typeof user !== "object") {
    return false;
  }
  const game = user.game;
  if (game && typeof game === "object") {
    if (hasNonEmptyString(game.snakePlayDate) || hasNonEmptyString(game.bounchPlayDate)) {
      return true;
    }
    if (positiveNumber(game.bounchUnlockedMax)) {
      return true;
    }
  }
  const trivia = user.trivia;
  if (trivia && typeof trivia === "object") {
    if (
      hasNonEmptyString(trivia.rewardDate) ||
      positiveNumber(trivia.rewardedRounds) ||
      positiveNumber(trivia.attemptsUsed) ||
      positiveNumber(trivia.correctCount) ||
      positiveNumber(trivia.xpEarnedFromTrivia)
    ) {
      return true;
    }
  }
  const pvp = user.pvp;
  if (pvp && typeof pvp === "object") {
    if (
      hasNonEmptyString(pvp.date) ||
      positiveNumber(pvp.rewardedWins) ||
      positiveNumber(pvp.matchesPlayed) ||
      (Array.isArray(pvp.notedMatchIds) && pvp.notedMatchIds.length > 0)
    ) {
      return true;
    }
  }
  const blackjack = user.blackjack;
  if (blackjack && typeof blackjack === "object") {
    if (
      hasNonEmptyString(blackjack.rewardDate) ||
      hasNonEmptyString(blackjack.firstBotPlayRewardDate) ||
      positiveNumber(blackjack.rewardedRoundsUsed) ||
      (Array.isArray(blackjack.rewardedPvpOpponents) &&
        blackjack.rewardedPvpOpponents.length > 0)
    ) {
      return true;
    }
  }
  const bomb = user.mangoBomb;
  if (bomb && typeof bomb === "object") {
    if (
      hasNonEmptyString(bomb.rewardDate) ||
      hasNonEmptyString(bomb.rewardedRoundId) ||
      positiveNumber(bomb.rewardedRounds)
    ) {
      return true;
    }
  }
  return false;
}

function localKeepReason(userId, stores, options = {}) {
  const id = asTelegramUserId(userId);
  if (!id) {
    return "invalid";
  }
  const isAdminFn = typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;
  if (isAdminFn(id)) {
    return "admin";
  }
  if (hasLinkedWallet(id, stores)) {
    return "wallet";
  }
  const user = stores.pointsUsers && stores.pointsUsers[id];
  if (hasChatParticipation(user)) {
    return "activity";
  }
  if (hasXp(user)) {
    return "xp";
  }
  if (hasPointsGameParticipation(user)) {
    return "game";
  }
  if (stores.highscoreIdSet && stores.highscoreIdSet.has(id)) {
    return "highscore";
  }
  if (stores.presaleUsers && stores.presaleUsers[id]) {
    return "presale";
  }
  if (stores.shopUsers && stores.shopUsers[id]) {
    return "shop";
  }
  if (stores.rewardByUser && stores.rewardByUser[id]) {
    return "reward";
  }
  if (stores.weeklyIdSet && stores.weeklyIdSet.has(id)) {
    return "weekly";
  }
  if (stores.builderBuilders && stores.builderBuilders[id]) {
    return "builder";
  }
  if (stores.builderReferrals && stores.builderReferrals[id]) {
    return "builder";
  }
  if (stores.builderWelcome && stores.builderWelcome[id]) {
    return "builder";
  }
  if (stores.builderEvents) {
    for (const event of Object.values(stores.builderEvents)) {
      if (event && asTelegramUserId(event.builderUserId) === id) {
        return "builder";
      }
    }
  }
  if (stores.builderInviteLinks) {
    for (const link of Object.values(stores.builderInviteLinks)) {
      if (link && asTelegramUserId(link.inviterUserId) === id) {
        return "builder";
      }
    }
  }
  return null;
}

function displayNameFromStores(userId, stores) {
  const id = asTelegramUserId(userId);
  const user = stores.pointsUsers && stores.pointsUsers[id];
  if (user && hasNonEmptyString(user.name)) {
    return user.name.trim().slice(0, 64);
  }
  const welcome = stores.builderWelcome && stores.builderWelcome[id];
  if (welcome && hasNonEmptyString(welcome.displayName)) {
    return welcome.displayName.trim().slice(0, 64);
  }
  const referral = stores.builderReferrals && stores.builderReferrals[id];
  if (referral && hasNonEmptyString(referral.displayName)) {
    return referral.displayName.trim().slice(0, 64);
  }
  return null;
}

function formatCandidateLine(candidate) {
  const id = candidate.userId;
  const name = candidate.name ? String(candidate.name).replace(/\s+/g, " ").trim() : "";
  const username = candidate.username
    ? String(candidate.username).replace(/^@+/, "").trim()
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

function formatCleanupMessages(result) {
  const header = [
    "🧹 Community cleanup",
    `Known users checked: ${result.knownUsersChecked}`,
    `Current members checked: ${result.currentMembersChecked}`,
    `Inactive candidates: ${result.inactiveCandidates.length}`,
    "",
    "No members removed.",
  ].join("\n");

  const lines = result.inactiveCandidates.map(formatCandidateLine);
  if (!lines.length) {
    return [header];
  }

  const chunks = [];
  let current = `${header}\n\nCandidates:`;
  for (const line of lines) {
    const next = `${current}\n${line}`;
    if (next.length > TELEGRAM_TEXT_LIMIT) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function weeklyIdsFromState(state) {
  const ids = [];
  const standings = state && state.current && state.current.standings;
  if (standings && typeof standings === "object") {
    for (const key of Object.keys(standings)) {
      ids.push(key);
    }
  }
  const winners = state && state.latest && Array.isArray(state.latest.winners)
    ? state.latest.winners
    : [];
  for (const row of winners) {
    if (row && row.telegramUserId) {
      ids.push(row.telegramUserId);
    }
  }
  return ids;
}

function loadStoresFromDisk(options = {}) {
  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  }

  const points = safe(() => loadPoints(options.pointsFile), { users: {} });
  const wallet = safe(
    () => loadWalletStore(options.walletFile),
    { users: {}, pendingWalletInputs: {} }
  );
  const shop = safe(() => loadShopStore(options.shopFile), { users: {} });
  const presale = safe(() => loadPresaleStore(options.presaleFile), { users: {} });
  const rewards = safe(() => loadRewardsStore(options.rewardsFile), { byUser: {} });
  const builder = safe(
    () => loadBuilderStore(options.builderFile),
    { builders: {}, referrals: {}, welcomeOpportunities: {}, inviteLinks: {}, builderEvents: {} }
  );
  const snake = safe(
    () => readSnakeScores(options.snakeFile || getSnakeScoresPath()),
    { leaderboard: [] }
  );
  const bounch = safe(
    () => readBounchScores(options.bounchFile || getBounchScoresPath()),
    { leaderboard: [] }
  );
  const weekly = safe(() => readWinnersState(options.weeklyFile), { current: { standings: {} }, latest: null });

  const highscoreIds = new Set();
  addScoreTelegramIds(highscoreIds, snake);
  addScoreTelegramIds(highscoreIds, bounch);

  return decorateStores({
    pointsUsers: (points && points.users) || {},
    walletUsers: (wallet && wallet.users) || {},
    walletPendingInputs: (wallet && wallet.pendingWalletInputs) || {},
    shopUsers: (shop && shop.users) || {},
    presaleUsers: (presale && presale.users) || {},
    rewardByUser: (rewards && rewards.byUser) || {},
    builderBuilders: (builder && builder.builders) || {},
    builderReferrals: (builder && builder.referrals) || {},
    builderWelcome: (builder && builder.welcomeOpportunities) || {},
    builderInviteLinks: (builder && builder.inviteLinks) || {},
    builderEvents: (builder && builder.builderEvents) || {},
    highscoreUserIds: [...highscoreIds],
    weeklyUserIds: weeklyIdsFromState(weekly),
  });
}

function decorateStores(raw) {
  const highscoreIdSet = new Set();
  if (Array.isArray(raw.highscoreUserIds)) {
    for (const id of raw.highscoreUserIds) {
      const uid = asTelegramUserId(id);
      if (uid) {
        highscoreIdSet.add(uid);
      }
    }
  }
  const weeklyIdSet = new Set();
  if (Array.isArray(raw.weeklyUserIds)) {
    for (const id of raw.weeklyUserIds) {
      const uid = asTelegramUserId(id);
      if (uid) {
        weeklyIdSet.add(uid);
      }
    }
  }
  return { ...raw, highscoreIdSet, weeklyIdSet };
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

/**
 * Dry-run scan. Never mutates stores. Never bans/kicks.
 * @param {object} [options]
 */
async function scanInactiveCandidates(options = {}) {
  const stores = decorateStores(
    options.stores ? options.stores : loadStoresFromDisk(options)
  );
  const knownIds = collectKnownUserIds(stores);
  const chatId =
    options.chatId != null && String(options.chatId).trim()
      ? String(options.chatId).trim()
      : getConfiguredCommunityChatId();
  const getChatMember =
    typeof options.getChatMember === "function" ? options.getChatMember : null;

  const localKeep = [];
  const telegramNeeded = [];
  for (const userId of knownIds) {
    const reason = localKeepReason(userId, stores, options);
    if (reason) {
      localKeep.push({ userId, reason });
    } else {
      telegramNeeded.push(userId);
    }
  }

  const inactiveCandidates = [];
  let currentMembersChecked = 0;
  const telegramLookups = [];

  if (!chatId || !getChatMember) {
    return {
      knownUsersChecked: knownIds.length,
      currentMembersChecked: 0,
      telegramNeeded: telegramNeeded.length,
      inactiveCandidates,
      localKeep,
      telegramLookups,
      removed: false,
    };
  }

  for (const userId of telegramNeeded) {
    const looked = await lookupMember(chatId, userId, getChatMember);
    telegramLookups.push({ userId, ok: looked.ok });
    if (!looked.ok) {
      continue;
    }
    const member = looked.member;
    const status = member.status;
    const user = member.user || {};
    if (CURRENT_IN_CHAT.has(status)) {
      currentMembersChecked += 1;
    }
    if (status === "creator" || status === "administrator") {
      continue;
    }
    if (user.is_bot) {
      continue;
    }
    if (status !== "member") {
      continue;
    }
    inactiveCandidates.push({
      userId,
      name: user.first_name || displayNameFromStores(userId, stores),
      username: user.username || null,
    });
  }

  return {
    knownUsersChecked: knownIds.length,
    currentMembersChecked,
    telegramNeeded: telegramNeeded.length,
    inactiveCandidates,
    localKeep,
    telegramLookups,
    removed: false,
  };
}

module.exports = {
  collectKnownUserIds,
  localKeepReason,
  decorateStores,
  scanInactiveCandidates,
  formatCleanupMessages,
  formatCandidateLine,
};
