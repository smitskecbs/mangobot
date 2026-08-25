/**
 * ManGo Shop — title requirements, atomic purchase, active title.
 * Cosmetic community titles only. Never promotes Telegram admins.
 */

const crypto = require("crypto");
const { loadPoints, getUserRecord } = require("./points");
const { getBuilderMemberSnapshot } = require("./communityBuilder");
const {
  mutateShopStore,
  loadShopStore,
  ensureUser,
} = require("./mangoShopStore");
const { getLootAccount } = require("./mangoLoot");
const {
  getTitleCatalog,
  getTitleById,
  formatTitleLabel,
  isTitlePurchasable,
  isTitleWindowOpen,
} = require("./mangoTitles");

let titleLookup = getTitleById;

function setTitleLookupForTests(fn) {
  titleLookup = typeof fn === "function" ? fn : getTitleById;
}

function lookupTitle(titleId) {
  return titleLookup(titleId);
}

function normalizeUserId(userId) {
  if (userId == null || userId === "") {
    return null;
  }
  const id = String(userId).trim();
  return id || null;
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function readLifetimeXp(userId, pointsFile) {
  const data = loadPoints(pointsFile);
  const user = getUserRecord(data, userId);
  return user && typeof user.points === "number" ? user.points : 0;
}

function readAlltimeBp(userId, options = {}) {
  const snap = getBuilderMemberSnapshot(userId, {
    storeFile: options.builderFile,
    now: options.now,
  });
  return snap && typeof snap.alltimeBp === "number" ? snap.alltimeBp : 0;
}

function mark(ok) {
  return ok ? "✅" : "❌";
}

function missingNeeds(progress) {
  const need = [];
  if (!progress.xpOk) {
    need.push(`${progress.requiredXp - progress.xp} more XP`);
  }
  if (!progress.bpOk) {
    need.push(`${progress.requiredBp - progress.bp} more BP`);
  }
  if (!progress.lootOk) {
    need.push(`${progress.price - progress.loot} more ManGo Loot`);
  }
  return need;
}

function titleProgress(userId, title, options = {}) {
  const id = normalizeUserId(userId);
  const xp = readLifetimeXp(id, options.pointsFile);
  const bp = readAlltimeBp(id, options);
  const loot = getLootAccount(id, options.shopFile).balance;
  const store = loadShopStore(options.shopFile);
  const user = id && store.users[id] ? store.users[id] : null;
  const owned = Boolean(user && user.ownedTitles && user.ownedTitles[title.id]);
  const active = Boolean(user && user.activeTitle === title.id);
  const windowOpen = isTitleWindowOpen(title, options.now);
  const purchasable = isTitlePurchasable(title, options.now);
  const xpOk = xp >= title.requiredXp;
  const bpOk = bp >= title.requiredBp;
  const lootOk = loot >= title.lootPrice;
  const unlocked = xpOk && bpOk && lootOk && purchasable && windowOpen;
  return {
    title,
    xp,
    bp,
    loot,
    requiredXp: title.requiredXp,
    requiredBp: title.requiredBp,
    price: title.lootPrice,
    xpOk,
    bpOk,
    lootOk,
    owned,
    active,
    purchasable,
    windowOpen,
    unlocked,
    available: unlocked && !owned,
    status: owned ? "owned" : unlocked ? "available" : "locked",
  };
}

function getOwnedTitleIds(userId, shopFile) {
  const id = normalizeUserId(userId);
  if (!id) {
    return [];
  }
  const store = loadShopStore(shopFile);
  const user = store.users[id];
  return user ? Object.keys(user.ownedTitles || {}) : [];
}

function getActiveTitle(userId, shopFile) {
  const id = normalizeUserId(userId);
  if (!id) {
    return null;
  }
  const store = loadShopStore(shopFile);
  const user = store.users[id];
  if (!user || !user.activeTitle) {
    return null;
  }
  return getTitleById(user.activeTitle);
}

function nextLockedTitle(userId, options = {}) {
  for (const title of getTitleCatalog()) {
    const progress = titleProgress(userId, title, options);
    if (!progress.owned && title.active) {
      return progress;
    }
  }
  return null;
}

function purchaseTitle(userId, titleId, options = {}) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  const title = lookupTitle(titleId);
  if (!title) {
    return { ok: false, reason: "unknown" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!isTitleWindowOpen(title, now)) {
    return { ok: false, reason: "unavailable" };
  }
  if (title.purchasable === false) {
    return { ok: false, reason: "disabled" };
  }

  const xp = readLifetimeXp(id, options.pointsFile);
  const bp = readAlltimeBp(id, { builderFile: options.builderFile, now });
  const referenceId = `title-buy:${id}:${title.id}`;

  return mutateShopStore((store) => {
    const existingRef = store.referenceIndex[referenceId];
    if (existingRef && store.purchases[existingRef]) {
      const user = ensureUser(store, id);
      return {
        ok: true,
        duplicate: true,
        lootSpent: 0,
        balance: user.loot.balance,
        title,
      };
    }
    const user = ensureUser(store, id);
    if (user.ownedTitles[title.id]) {
      return { ok: false, reason: "owned", title };
    }
    const xpOk = xp >= title.requiredXp;
    const bpOk = bp >= title.requiredBp;
    const lootOk = user.loot.balance >= title.lootPrice;
    if (!xpOk || !bpOk || !lootOk) {
      return {
        ok: false,
        reason: "locked",
        title,
        progress: {
          xp,
          bp,
          loot: user.loot.balance,
          requiredXp: title.requiredXp,
          requiredBp: title.requiredBp,
          price: title.lootPrice,
          xpOk,
          bpOk,
          lootOk,
        },
      };
    }

    user.loot.balance -= title.lootPrice;
    user.loot.lifetimeSpent += title.lootPrice;
    user.loot.updatedAt = now;
    const purchaseId = newId();
    user.ownedTitles[title.id] = { purchasedAt: now, purchaseId };
    store.purchases[purchaseId] = {
      userId: id,
      titleId: title.id,
      lootSpent: title.lootPrice,
      createdAt: now,
    };
    store.transactions[purchaseId] = {
      id: purchaseId,
      userId: id,
      type: "spend",
      amount: title.lootPrice,
      reason: "title-purchase",
      createdAt: now,
      referenceId,
    };
    store.referenceIndex[referenceId] = purchaseId;
    return {
      ok: true,
      duplicate: false,
      lootSpent: title.lootPrice,
      balance: user.loot.balance,
      title,
      purchaseId,
    };
  }, options.shopFile);
}

function setActiveTitle(userId, titleId, options = {}) {
  const id = normalizeUserId(userId);
  const title = getTitleById(titleId);
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  if (!title) {
    return { ok: false, reason: "unknown" };
  }
  return mutateShopStore((store) => {
    const user = ensureUser(store, id);
    if (!user.ownedTitles[title.id]) {
      return { ok: false, reason: "unowned" };
    }
    user.activeTitle = title.id;
    return { ok: true, title };
  }, options.shopFile);
}

function clearActiveTitle(userId, options = {}) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  return mutateShopStore((store) => {
    const user = ensureUser(store, id);
    user.activeTitle = null;
    return { ok: true };
  }, options.shopFile);
}

function formatShopProgressBlock(userId, options = {}) {
  const title = getActiveTitle(userId, options.shopFile);
  const loot = getLootAccount(userId, options.shopFile).balance;
  const bp = readAlltimeBp(userId, options);
  const lines = [
    "Community Title:",
    title ? formatTitleLabel(title) : "None",
    "",
    `🥭 ManGo Loot: ${loot}`,
    `Builder BP: ${bp}`,
  ];
  try {
    const { formatDailyQuestProgressLine } = require("./dailyQuest");
    const quest = formatDailyQuestProgressLine(userId, options);
    if (quest) {
      lines.push("", quest);
    }
  } catch (_err) {
    // Quest store unavailable.
  }
  return lines.join("\n");
}

function getShopHomeModel(userId, options = {}) {
  const loot = getLootAccount(userId, options.shopFile);
  const xp = readLifetimeXp(userId, options.pointsFile);
  const bp = readAlltimeBp(userId, options);
  const next = nextLockedTitle(userId, options);
  let quest = null;
  try {
    const { getDailyQuestSnapshot } = require("./dailyQuest");
    quest = getDailyQuestSnapshot(userId, options);
  } catch (_err) {
    quest = null;
  }
  return { loot, xp, bp, next, quest };
}

module.exports = {
  readLifetimeXp,
  readAlltimeBp,
  titleProgress,
  missingNeeds,
  mark,
  getOwnedTitleIds,
  getActiveTitle,
  nextLockedTitle,
  purchaseTitle,
  setActiveTitle,
  clearActiveTitle,
  formatShopProgressBlock,
  getShopHomeModel,
  formatTitleLabel,
  getTitleCatalog,
  getTitleById,
  setTitleLookupForTests,
};
