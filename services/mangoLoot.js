/**
 * ManGo Loot — spendable community currency.
 * XP and BP are never mutated here.
 */

const crypto = require("crypto");
const { mutateShopStore, loadShopStore, ensureUser } = require("./mangoShopStore");

const EARN_REASONS = Object.freeze([
  "daily-activity",
  "daily-streak",
  "special-event",
  "admin-award",
]);

const SPEND_REASONS = Object.freeze(["title-purchase"]);

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

function snapshotLoot(user) {
  const loot = user && user.loot ? user.loot : { balance: 0, lifetimeEarned: 0, lifetimeSpent: 0 };
  return {
    balance: loot.balance || 0,
    lifetimeEarned: loot.lifetimeEarned || 0,
    lifetimeSpent: loot.lifetimeSpent || 0,
    updatedAt: loot.updatedAt || 0,
  };
}

function findByReference(store, referenceId) {
  if (!referenceId) {
    return null;
  }
  const txId = store.referenceIndex[String(referenceId)];
  if (!txId || !store.transactions[txId]) {
    return null;
  }
  return store.transactions[txId];
}

function recordTransaction(store, row) {
  store.transactions[row.id] = row;
  if (row.referenceId) {
    store.referenceIndex[row.referenceId] = row.id;
  }
}

function getLootBalance(userId, shopFile) {
  const id = normalizeUserId(userId);
  if (!id) {
    return 0;
  }
  const store = loadShopStore(shopFile);
  const user = store.users[id];
  return user ? snapshotLoot(user).balance : 0;
}

function getLootAccount(userId, shopFile) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, updatedAt: 0 };
  }
  const store = loadShopStore(shopFile);
  const user = store.users[id];
  return user
    ? snapshotLoot(user)
    : { balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, updatedAt: 0 };
}

function applyLootAwardToStore(store, userId, amount, reason, referenceId, now) {
  const id = normalizeUserId(userId);
  const qty = Number(amount);
  const why = String(reason || "");
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, reason: "amount" };
  }
  if (!EARN_REASONS.includes(why) && why !== "admin-award") {
    return { ok: false, reason: "reason" };
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  const type = why === "admin-award" ? "adjust" : "earn";
  if (referenceId) {
    const existing = findByReference(store, referenceId);
    if (existing) {
      const user = ensureUser(store, id);
      return {
        ok: true,
        duplicate: true,
        balance: snapshotLoot(user).balance,
        amount: existing.amount,
        transactionId: existing.id,
      };
    }
  }
  const user = ensureUser(store, id);
  user.loot.balance += qty;
  user.loot.lifetimeEarned += qty;
  user.loot.updatedAt = ts;
  const txId = newId();
  recordTransaction(store, {
    id: txId,
    userId: id,
    type,
    amount: qty,
    reason: why,
    createdAt: ts,
    referenceId: referenceId ? String(referenceId) : null,
  });
  return {
    ok: true,
    duplicate: false,
    balance: user.loot.balance,
    amount: qty,
    transactionId: txId,
  };
}

function awardLoot(userId, amount, reason, referenceId, options = {}) {
  const id = normalizeUserId(userId);
  const qty = Number(amount);
  const why = String(reason || "");
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, reason: "amount" };
  }
  if (!EARN_REASONS.includes(why) && why !== "admin-award") {
    return { ok: false, reason: "reason" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return mutateShopStore(
    (store) => applyLootAwardToStore(store, id, qty, why, referenceId, now),
    options.shopFile
  );
}

function spendLoot(userId, amount, reason, referenceId, options = {}) {
  const id = normalizeUserId(userId);
  const qty = Number(amount);
  const why = String(reason || "");
  if (!id) {
    return { ok: false, reason: "no-user" };
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, reason: "amount" };
  }
  if (!SPEND_REASONS.includes(why)) {
    return { ok: false, reason: "reason" };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return mutateShopStore((store) => {
    if (referenceId) {
      const existing = findByReference(store, referenceId);
      if (existing) {
        const user = ensureUser(store, id);
        return {
          ok: true,
          duplicate: true,
          balance: snapshotLoot(user).balance,
          amount: existing.amount,
          transactionId: existing.id,
        };
      }
    }
    const user = ensureUser(store, id);
    if (user.loot.balance < qty) {
      return { ok: false, reason: "insufficient", balance: user.loot.balance };
    }
    user.loot.balance -= qty;
    user.loot.lifetimeSpent += qty;
    user.loot.updatedAt = now;
    const txId = newId();
    recordTransaction(store, {
      id: txId,
      userId: id,
      type: "spend",
      amount: qty,
      reason: why,
      createdAt: now,
      referenceId: referenceId ? String(referenceId) : null,
    });
    return {
      ok: true,
      duplicate: false,
      balance: user.loot.balance,
      amount: qty,
      transactionId: txId,
    };
  }, options.shopFile);
}

function getLootHistory(userId, options = {}) {
  const id = normalizeUserId(userId);
  if (!id) {
    return [];
  }
  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
  const store = loadShopStore(options.shopFile);
  const rows = Object.values(store.transactions).filter(
    (row) => row && String(row.userId) === id
  );
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows.slice(0, limit).map((row) => Object.assign({}, row));
}

/**
 * Insertion point for Daily Activities (not the full quest system).
 * Stable reference: daily:<date>:<activityId>:<userId>
 */
function awardDailyActivityLoot({ userId, activityId, date, amount } = {}, options = {}) {
  const uid = normalizeUserId(userId);
  const activity = String(activityId || "").trim();
  const day = String(date || "").trim();
  if (!uid || !activity || !day) {
    return { ok: false, reason: "reference" };
  }
  const referenceId = `daily:${day}:${activity}:${uid}`;
  return awardLoot(uid, amount, "daily-activity", referenceId, options);
}

module.exports = {
  EARN_REASONS,
  SPEND_REASONS,
  getLootBalance,
  getLootAccount,
  awardLoot,
  spendLoot,
  getLootHistory,
  awardDailyActivityLoot,
  applyLootAwardToStore,
};
