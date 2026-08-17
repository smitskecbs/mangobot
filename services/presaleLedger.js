/**
 * Presale contribution ledger: reservations, caps, prepare, confirm.
 * Wallet identity always from verified mapping. Integer strings only.
 *
 * Capacity is reserved at prepare under exclusive lock so two last-slot
 * payments cannot both receive a payable order.
 */

const crypto = require("node:crypto");
const { getVerifiedWalletForUser, normalizeUserId } = require("./walletLinks");
const { mutatePresaleStore, loadPresaleStore } = require("./presaleStore");
const { pruneExpiredSessions, lookupPresaleSession } = require("./presaleSessions");
const { getPresaleConfig, isPresaleLive, presaleWindowReason } = require("./presaleConfig");
const { getTransaction, getLatestBlockhash, getBlockHeight, GENERIC_RPC_ERROR } = require("./presaleRpc");
const { verifyPresaleTransaction } = require("./presaleVerify");
const { scanTreasuryForOrder, needsReconciliation } = require("./presaleReconcile");
const {
  MIN_CONTRIBUTION_LAMPORTS,
  MAX_WALLET_LAMPORTS,
  HARD_CAP_LAMPORTS,
  PRESALE_MANGO_HUMAN,
  MEMO_PREFIX,
  RESERVATION_TTL_MS,
  isAllowedAmount,
  parseLamportsInteger,
  mangoBaseUnitsFromLamports,
  formatLamportsAsSol,
  formatMangoHuman,
} = require("./presaleConstants");

function emptyUser(uid) {
  return {
    telegramUserId: uid,
    confirmedLamports: "0",
    allocatedMangoBaseUnits: "0",
    contributions: [],
  };
}

function userConfirmedLamports(user) {
  if (!user || typeof user !== "object") {
    return 0n;
  }
  const parsed = parseLamportsInteger(user.confirmedLamports);
  if (parsed.ok) {
    return BigInt(parsed.lamports);
  }
  let total = 0n;
  const list = Array.isArray(user.contributions) ? user.contributions : [];
  for (const item of list) {
    const lamports = parseLamportsInteger(item && item.contributedLamports);
    if (lamports.ok) {
      total += BigInt(lamports.lamports);
    }
  }
  return total;
}

function orderLamports(order) {
  const parsed = parseLamportsInteger(
    order && (order.requestedLamports || order.lamports)
  );
  return parsed.ok ? BigInt(parsed.lamports) : 0n;
}

function orderMango(order) {
  const parsed = parseLamportsInteger(order && order.mangoAllocationBaseUnits);
  return parsed.ok ? BigInt(parsed.lamports) : 0n;
}

function parseBlockHeight(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const height = Number(value);
  if (!Number.isFinite(height) || height < 0) {
    return null;
  }
  return height;
}

/**
 * Capacity is held while a payable tx can still land.
 * Missing block height fail-closes: payment-ready/submitted stay reserved.
 */
function holdsCapacity(order, now, blockHeight) {
  if (!order || typeof order !== "object") {
    return false;
  }
  const status = order.status;
  if (status === "confirmed" || status === "expired" || status === "superseded") {
    return false;
  }
  if (status === "reserved" || status === "prepared") {
    return typeof order.expiresAt === "number" && order.expiresAt > now;
  }
  if (status === "submitted" || status === "reconciliation-pending") {
    return true;
  }
  if (status === "payment-ready") {
    return true;
  }
  return false;
}

function isActiveReservation(order, now, blockHeight) {
  return holdsCapacity(order, now, blockHeight);
}

async function resolveBlockHeight(options = {}) {
  if (options.currentBlockHeight !== undefined && options.currentBlockHeight !== null) {
    return parseBlockHeight(options.currentBlockHeight);
  }
  const result = await getBlockHeight(options);
  return result.ok ? result.height : null;
}

function reservedFromOrders(store, now, options = {}) {
  const excludeIds = new Set(
    Array.isArray(options.excludeIds) ? options.excludeIds.map(String) : []
  );
  const onlyUser =
    options.telegramUserId === undefined || options.telegramUserId === null
      ? null
      : String(options.telegramUserId);
  const blockHeight = parseBlockHeight(options.blockHeight);
  let reservedLamports = 0n;
  let reservedMangoBaseUnits = 0n;
  let count = 0;
  for (const [id, order] of Object.entries(store.orders || {})) {
    if (excludeIds.has(String(id)) || excludeIds.has(String(order && order.id))) {
      continue;
    }
    if (!holdsCapacity(order, now, blockHeight)) {
      continue;
    }
    if (onlyUser && String(order.telegramUserId) !== onlyUser) {
      continue;
    }
    reservedLamports += orderLamports(order);
    reservedMangoBaseUnits += orderMango(order);
    count += 1;
  }
  return { reservedLamports, reservedMangoBaseUnits, count };
}

function findActiveReservationForUser(store, uid, now, blockHeight) {
  for (const order of Object.values(store.orders || {})) {
    if (
      holdsCapacity(order, now, blockHeight) &&
      String(order.telegramUserId) === String(uid)
    ) {
      return order;
    }
  }
  return null;
}

function totalsFromStore(store, now = Date.now(), blockHeight = null) {
  let confirmed = 0n;
  let allocated = 0n;
  for (const user of Object.values(store.users || {})) {
    confirmed += userConfirmedLamports(user);
    const mango = parseLamportsInteger(user && user.allocatedMangoBaseUnits);
    if (mango.ok) {
      allocated += BigInt(mango.lamports);
    }
  }
  const reserved = reservedFromOrders(store, now, { blockHeight });
  return {
    confirmedLamports: confirmed,
    allocatedMangoBaseUnits: allocated,
    reservedLamports: reserved.reservedLamports,
    reservedMangoBaseUnits: reserved.reservedMangoBaseUnits,
    activeReservations: reserved.count,
  };
}

function persistDerivedTotals(store, now, blockHeight) {
  const totals = totalsFromStore(store, now, blockHeight);
  store.totals.confirmedLamports = totals.confirmedLamports.toString();
  store.totals.reservedLamports = totals.reservedLamports.toString();
  store.totals.allocatedMangoBaseUnits = totals.allocatedMangoBaseUnits.toString();
  store.totals.reservedMangoBaseUnits = totals.reservedMangoBaseUnits.toString();
  return totals;
}

function availableGlobalLamports(store, now, blockHeight) {
  const totals = totalsFromStore(store, now, blockHeight);
  const remaining = HARD_CAP_LAMPORTS - totals.confirmedLamports - totals.reservedLamports;
  return remaining > 0n ? remaining : 0n;
}

function remainingGlobalLamports(store, now = Date.now(), blockHeight = null) {
  return availableGlobalLamports(store, now, blockHeight);
}

function participantCount(store) {
  let count = 0;
  for (const user of Object.values(store.users || {})) {
    if (userConfirmedLamports(user) > 0n) {
      count += 1;
    }
  }
  return count;
}

function reservationInvariant(store, now, blockHeight) {
  const totals = totalsFromStore(store, now, blockHeight);
  if (totals.confirmedLamports + totals.reservedLamports > HARD_CAP_LAMPORTS) {
    return { ok: false, reason: "global-over-cap" };
  }
  const perUser = {};
  for (const [uid, user] of Object.entries(store.users || {})) {
    perUser[uid] = userConfirmedLamports(user);
  }
  for (const order of Object.values(store.orders || {})) {
    if (!holdsCapacity(order, now, blockHeight)) {
      continue;
    }
    const uid = String(order.telegramUserId);
    perUser[uid] = (perUser[uid] || 0n) + orderLamports(order);
  }
  for (const [uid, total] of Object.entries(perUser)) {
    if (total > MAX_WALLET_LAMPORTS) {
      return { ok: false, reason: "wallet-over-cap", telegramUserId: uid };
    }
  }
  return { ok: true, totals, perUser };
}

function getPresaleStatus(options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const config = getPresaleConfig(options.env);
  const live = isPresaleLive(now, options.env);
  const store = loadPresaleStore(options.presaleFile);
  const blockHeight = parseBlockHeight(options.currentBlockHeight);
  const totals = totalsFromStore(store, now, blockHeight);
  const availableLamports = availableGlobalLamports(store, now, blockHeight);
  const remainingMango = mangoBaseUnitsFromLamports(availableLamports);
  const reservedMango = formatMangoHuman(totals.reservedMangoBaseUnits.toString());
  const allocatedHuman = formatMangoHuman(totals.allocatedMangoBaseUnits.toString());
  return {
    enabled: config.enabled,
    live,
    treasuryConfigured: Boolean(config.treasury),
    treasury: config.treasury,
    windowReason: presaleWindowReason(now, options.env),
    confirmedLamports: totals.confirmedLamports.toString(),
    confirmedSol: formatLamportsAsSol(totals.confirmedLamports.toString()),
    reservedLamports: totals.reservedLamports.toString(),
    reservedSol: formatLamportsAsSol(totals.reservedLamports.toString()),
    availableLamports: availableLamports.toString(),
    availableSol: formatLamportsAsSol(availableLamports.toString()),
    hardCapLamports: HARD_CAP_LAMPORTS.toString(),
    hardCapSol: "5",
    allocatedMangoBaseUnits: totals.allocatedMangoBaseUnits.toString(),
    allocatedMango: allocatedHuman,
    reservedMangoBaseUnits: totals.reservedMangoBaseUnits.toString(),
    reservedMango,
    remainingLamports: availableLamports.toString(),
    remainingMango: remainingMango.ok ? remainingMango.human : "0",
    remainingMangoBaseUnits: remainingMango.ok ? remainingMango.baseUnits : "0",
    targetMango: PRESALE_MANGO_HUMAN.toString(),
    participantCount: participantCount(store),
    activeReservations: totals.activeReservations,
    soldOut:
      availableLamports < MIN_CONTRIBUTION_LAMPORTS ||
      totals.confirmedLamports + totals.reservedLamports >= HARD_CAP_LAMPORTS,
  };
}

function getRemainingPresaleLamports(options = {}) {
  return getPresaleStatus(options).availableLamports;
}

function getRemainingPresaleAllocation(options = {}) {
  return getPresaleStatus(options).remainingMangoBaseUnits;
}

function summarizeUser(uid, store, now = Date.now(), blockHeight = null) {
  const user = store.users[uid] || emptyUser(uid);
  const confirmed = userConfirmedLamports(user);
  const mango = parseLamportsInteger(user.allocatedMangoBaseUnits);
  const allocation = mango.ok ? mango.lamports : "0";
  const contributions = Array.isArray(user.contributions) ? user.contributions : [];
  const snapshots = contributions
    .map((item) => item && item.walletSnapshot)
    .filter(Boolean);
  const userReserved = reservedFromOrders(store, now, { telegramUserId: uid, blockHeight });
  const remainingWallet =
    MAX_WALLET_LAMPORTS - confirmed - userReserved.reservedLamports;
  return {
    recorded: confirmed > 0n,
    status: confirmed > 0n ? "recorded" : "not-started",
    telegramUserId: uid,
    confirmedLamports: confirmed.toString(),
    contributedLamports: confirmed.toString(),
    reservedLamports: userReserved.reservedLamports.toString(),
    allocatedMangoBaseUnits: allocation,
    allocation: formatMangoHuman(allocation),
    walletSnapshot: snapshots.length ? snapshots[snapshots.length - 1] : null,
    contributions,
    distributionStatus: contributions.length
      ? contributions.every((item) => item && item.distributionStatus === "sent")
        ? "sent"
        : "pending"
      : null,
    distributionTxSignature: (() => {
      const sent = contributions.filter((item) => item && item.distributionTxSignature);
      return sent.length ? sent[sent.length - 1].distributionTxSignature : null;
    })(),
    updatedAt: contributions.length
      ? Number(contributions[contributions.length - 1].confirmedAt) || null
      : null,
    remainingWalletLamports: (remainingWallet > 0n ? remainingWallet : 0n).toString(),
    activeReservation: findActiveReservationForUser(store, uid, now, blockHeight),
  };
}

function getPresaleParticipation(userId, presaleFile, now = Date.now(), blockHeight = null) {
  const uid = normalizeUserId(userId);
  if (!uid) {
    return summarizeUser("", { users: {}, orders: {} }, now, blockHeight);
  }
  const store = loadPresaleStore(presaleFile);
  return summarizeUser(uid, store, now, blockHeight);
}

function canUserContribute(userId, amountLamports, options = {}) {
  const uid = normalizeUserId(userId);
  const parsed = parseLamportsInteger(amountLamports);
  if (!uid || !parsed.ok) {
    return { ok: false, reason: "invalid" };
  }
  const requested = BigInt(parsed.lamports);
  if (requested < MIN_CONTRIBUTION_LAMPORTS) {
    return { ok: false, reason: "below-min" };
  }
  if (!isAllowedAmount(requested)) {
    return { ok: false, reason: "amount-not-allowed" };
  }
  const now = options.now === undefined ? Date.now() : options.now;
  if (!isPresaleLive(now, options.env)) {
    const reason = presaleWindowReason(now, options.env) || "disabled";
    return { ok: false, reason };
  }
  const verified = getVerifiedWalletForUser(uid, options.walletFile);
  if (!verified) {
    return { ok: false, reason: "unverified" };
  }
  const store = options.store || loadPresaleStore(options.presaleFile);
  const blockHeight = parseBlockHeight(options.currentBlockHeight);
  const user = summarizeUser(uid, store, now, blockHeight);
  const remainingWallet = BigInt(user.remainingWalletLamports);
  if (requested > remainingWallet) {
    return { ok: false, reason: remainingWallet <= 0n ? "wallet-max" : "wallet-cap" };
  }
  const remainingGlobal = remainingGlobalLamports(store, now, blockHeight);
  if (remainingGlobal < MIN_CONTRIBUTION_LAMPORTS || requested > remainingGlobal) {
    return { ok: false, reason: "sold-out" };
  }
  const allocation = mangoBaseUnitsFromLamports(requested);
  if (!allocation.ok) {
    return { ok: false, reason: "allocation" };
  }
  return {
    ok: true,
    requested: requested.toString(),
    expectedWallet: verified.wallet,
    allocation,
  };
}

function createOrderId() {
  return crypto.randomBytes(16).toString("base64url");
}

function publicPrepareError(reason) {
  if (reason === "sold-out") {
    return "Presale is sold out.";
  }
  if (reason === "wallet-max" || reason === "wallet-cap") {
    return "Maximum contribution reached.";
  }
  if (reason === "unverified") {
    return "Wallet verification required.";
  }
  if (reason === "expired") {
    return "This presale link has expired.";
  }
  if (
    reason === "disabled" ||
    reason === "treasury-missing" ||
    reason === "rpc-missing" ||
    reason === "not-started" ||
    reason === "ended"
  ) {
    return "Presale is not live.";
  }
  return "Invalid request.";
}

function toPrepareResult(order, treasury) {
  return {
    ok: true,
    orderId: order.id,
    memo: order.memo,
    from: order.walletSnapshot,
    to: treasury,
    lamports: order.requestedLamports || order.lamports,
    mangoAllocationBaseUnits: order.mangoAllocationBaseUnits,
    mangoHuman: formatMangoHuman(order.mangoAllocationBaseUnits),
    expiresAt: order.expiresAt,
    network: "mainnet-beta",
    status: order.status || "reserved",
    recentBlockhash: order.recentBlockhash || null,
    lastValidBlockHeight:
      order.lastValidBlockHeight === undefined ? null : order.lastValidBlockHeight,
  };
}

async function preparePresalePayment(rawToken, amountLamports, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const blockHeight = await resolveBlockHeight(options);
  const session = lookupPresaleSession(rawToken, options);
  if (session.status === "expired") {
    return { ok: false, reason: "expired", error: publicPrepareError("expired") };
  }
  if (session.status !== "ok") {
    return { ok: false, reason: "invalid", error: publicPrepareError("invalid") };
  }
  const parsed = parseLamportsInteger(amountLamports);
  if (!parsed.ok) {
    return { ok: false, reason: "invalid", error: publicPrepareError("invalid") };
  }

  const config = getPresaleConfig(options.env);
  const uid = session.record.telegramUserId;
  const contribOptions = { ...options, currentBlockHeight: blockHeight };
  await reconcileExpiredPresaleOrders({ ...options, currentBlockHeight: blockHeight, now });

  const prepared = mutatePresaleStore((store) => {
    pruneExpiredSessions(store, now, blockHeight);
    const record = store.sessions[session.tokenHash];
    if (!record || record.purpose !== "presale") {
      return { ok: false, reason: "invalid" };
    }
    if (typeof record.expiresAt !== "number" || record.expiresAt <= now) {
      return { ok: false, reason: "expired" };
    }

    const existing = findActiveReservationForUser(store, uid, now, blockHeight);
    if (existing && (existing.status === "payment-ready" || existing.status === "submitted" || existing.status === "reconciliation-pending")) {
      if (
        String(existing.requestedLamports || existing.lamports) === parsed.lamports &&
        existing.walletSnapshot === record.expectedWallet
      ) {
        persistDerivedTotals(store, now, blockHeight);
        return { ok: true, reused: true, order: existing };
      }
      return { ok: false, reason: "wallet-cap" };
    }
    if (
      existing &&
      String(existing.requestedLamports || existing.lamports) === parsed.lamports &&
      existing.walletSnapshot === record.expectedWallet
    ) {
      persistDerivedTotals(store, now, blockHeight);
      return { ok: true, reused: true, order: existing };
    }
    if (existing && existing.status === "reserved") {
      existing.status = "superseded";
      existing.supersededAt = now;
    }

    const locked = canUserContribute(uid, parsed.lamports, {
      ...contribOptions,
      store,
      now,
    });
    if (!locked.ok) {
      return { ok: false, reason: locked.reason };
    }
    if (locked.expectedWallet !== record.expectedWallet) {
      return { ok: false, reason: "unverified" };
    }

    const orderId = createOrderId();
    const memo = `${MEMO_PREFIX}${orderId}`;
    const expiresAt = now + RESERVATION_TTL_MS;
    const order = {
      id: orderId,
      orderId,
      sessionHash: session.tokenHash,
      telegramUserId: uid,
      walletSnapshot: locked.expectedWallet,
      requestedLamports: locked.requested,
      lamports: locked.requested,
      mangoAllocationBaseUnits: locked.allocation.baseUnits,
      memo,
      createdAt: now,
      expiresAt,
      status: "reserved",
    };
    store.orders[orderId] = order;
    persistDerivedTotals(store, now, blockHeight);
    const invariant = reservationInvariant(store, now, blockHeight);
    if (!invariant.ok) {
      delete store.orders[orderId];
      persistDerivedTotals(store, now, blockHeight);
      return { ok: false, reason: invariant.reason === "wallet-over-cap" ? "wallet-cap" : "sold-out" };
    }
    return { ok: true, order };
  }, options.presaleFile);

  if (!prepared.ok) {
    return { ok: false, reason: prepared.reason, error: publicPrepareError(prepared.reason) };
  }
  return toPrepareResult(prepared.order, config.treasury);
}

function paymentValidityActive(order, blockHeight) {
  if (!order || order.status !== "payment-ready") {
    return false;
  }
  const last = Number(order.lastValidBlockHeight);
  if (!Number.isFinite(last) || last <= 0) {
    return true;
  }
  if (!Number.isFinite(blockHeight)) {
    return true;
  }
  return Number(blockHeight) <= last;
}

function toPaymentResult(order, treasury) {
  return {
    ok: true,
    orderId: order.id,
    memo: order.memo,
    from: order.walletSnapshot,
    to: treasury,
    lamports: order.requestedLamports || order.lamports,
    mangoAllocationBaseUnits: order.mangoAllocationBaseUnits,
    mangoHuman: formatMangoHuman(order.mangoAllocationBaseUnits),
    network: "mainnet-beta",
    status: order.status,
    recentBlockhash: order.recentBlockhash,
    lastValidBlockHeight: order.lastValidBlockHeight,
  };
}

/**
 * Bind a trusted RPC blockhash to an existing reserved order.
 * RPC is fetched outside the store lock; binding happens under lock.
 */
async function issuePresalePayment(rawToken, orderId, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const session = lookupPresaleSession(rawToken, options);
  if (session.status === "expired") {
    return { ok: false, reason: "expired", error: publicPrepareError("expired") };
  }
  if (session.status !== "ok") {
    return { ok: false, reason: "invalid", error: publicPrepareError("invalid") };
  }
  if (typeof orderId !== "string" || !orderId.trim()) {
    return { ok: false, reason: "invalid", error: publicPrepareError("invalid") };
  }

  const config = getPresaleConfig(options.env);
  const uid = session.record.telegramUserId;
  const blockHeight = await resolveBlockHeight(options);

  let store = loadPresaleStore(options.presaleFile);
  let current = store.orders[orderId];
  if (current && needsReconciliation(current, blockHeight)) {
    await reconcilePresaleOrder(orderId, { ...options, now, currentBlockHeight: blockHeight });
    store = loadPresaleStore(options.presaleFile);
    current = store.orders[orderId];
  }
  if (
    current &&
    String(current.telegramUserId) === String(uid) &&
    current.sessionHash === session.tokenHash &&
    paymentValidityActive(current, blockHeight)
  ) {
    return toPaymentResult(current, config.treasury);
  }
  if (
    current &&
    String(current.telegramUserId) === String(uid) &&
    current.status === "submitted"
  ) {
    return toPaymentResult(current, config.treasury);
  }

  const blockhash = await getLatestBlockhash(options);
  if (!blockhash.ok) {
    return { ok: false, reason: blockhash.reason || "rpc", error: GENERIC_RPC_ERROR };
  }

  const issued = mutatePresaleStore((locked) => {
    pruneExpiredSessions(locked, now, blockHeight, { excludeOrderIds: [orderId] });
    const record = locked.sessions[session.tokenHash];
    if (!record || record.purpose !== "presale") {
      return { ok: false, reason: "invalid" };
    }
    if (typeof record.expiresAt !== "number" || record.expiresAt <= now) {
      return { ok: false, reason: "expired" };
    }
    const order = locked.orders[orderId];
    if (!order || String(order.telegramUserId) !== String(uid)) {
      return { ok: false, reason: "invalid" };
    }
    if (order.sessionHash !== session.tokenHash) {
      return { ok: false, reason: "invalid" };
    }
    if (order.walletSnapshot !== record.expectedWallet) {
      return { ok: false, reason: "unverified" };
    }
    if (order.status === "confirmed") {
      return { ok: false, reason: "duplicate" };
    }
    if (order.status === "superseded" || order.status === "expired") {
      return { ok: false, reason: "reservation-expired" };
    }
    if (order.status === "submitted") {
      persistDerivedTotals(locked, now, blockHeight);
      return { ok: true, order };
    }
    if (order.status === "reconciliation-pending") {
      persistDerivedTotals(locked, now, blockHeight);
      return { ok: false, reason: "reservation-expired" };
    }
    if (paymentValidityActive(order, blockHeight)) {
      persistDerivedTotals(locked, now, blockHeight);
      return { ok: true, order };
    }
    if (order.status !== "reserved" && order.status !== "payment-ready") {
      return { ok: false, reason: "reservation-expired" };
    }
    if (order.status === "reserved") {
      if (typeof order.expiresAt === "number" && order.expiresAt <= now) {
        order.status = "expired";
        persistDerivedTotals(locked, now, blockHeight);
        return { ok: false, reason: "reservation-expired" };
      }
    }
    order.status = "payment-ready";
    order.recentBlockhash = blockhash.blockhash;
    order.lastValidBlockHeight = blockhash.lastValidBlockHeight;
    order.paymentIssuedAt = now;
    persistDerivedTotals(locked, now, blockHeight);
    const invariant = reservationInvariant(locked, now, blockHeight);
    if (!invariant.ok) {
      return { ok: false, reason: invariant.reason === "wallet-over-cap" ? "wallet-cap" : "sold-out" };
    }
    return { ok: true, order };
  }, options.presaleFile);

  if (!issued.ok) {
    return {
      ok: false,
      reason: issued.reason,
      error:
        issued.reason === "reservation-expired"
          ? publicConfirmError("reservation-expired")
          : publicPrepareError(issued.reason),
    };
  }
  return toPaymentResult(issued.order, config.treasury);
}

function publicConfirmError(reason) {
  if (reason === "sold-out") {
    return "Presale is sold out.";
  }
  if (reason === "wallet-max" || reason === "wallet-cap") {
    return "Maximum contribution reached.";
  }
  if (reason === "duplicate") {
    return "This contribution is already recorded.";
  }
  if (reason === "reservation-expired") {
    return "Your presale reservation expired. Create a new one.";
  }
  if (reason === "expired") {
    return "This presale link has expired.";
  }
  if (
    reason === "disabled" ||
    reason === "treasury-missing" ||
    reason === "rpc-missing" ||
    reason === "not-started" ||
    reason === "ended"
  ) {
    return "Presale is not live.";
  }
  return "This transaction could not be verified.";
}

function findOrderForConfirm(store, uid, sessionHash, orderId) {
  if (orderId && store.orders[orderId]) {
    return store.orders[orderId];
  }
  return (
    Object.values(store.orders).find(
      (item) =>
        item &&
        item.telegramUserId === uid &&
        item.sessionHash === sessionHash &&
        (item.status === "payment-ready" ||
          item.status === "submitted" ||
          item.status === "reconciliation-pending")
    ) || null
  );
}

function orderPayableForConfirm(order, now, blockHeight) {
  if (!order || typeof order !== "object") {
    return false;
  }
  if (order.status === "confirmed" || order.status === "superseded" || order.status === "expired") {
    return false;
  }
  if (order.status === "submitted" || order.status === "reconciliation-pending") {
    return true;
  }
  if (order.status === "payment-ready") {
    return holdsCapacity(order, now, blockHeight);
  }
  return false;
}

function capacityFitsOrder(store, order, now, blockHeight) {
  const requested = orderLamports(order);
  const uid = String(order.telegramUserId);
  const totals = totalsFromStore(store, now, blockHeight);
  const othersGlobal = reservedFromOrders(store, now, {
    excludeIds: [order.id, order.orderId],
    blockHeight,
  });
  if (totals.confirmedLamports + othersGlobal.reservedLamports + requested > HARD_CAP_LAMPORTS) {
    return { ok: false, reason: "sold-out" };
  }
  const user = store.users[uid] || emptyUser(uid);
  const userReserved = reservedFromOrders(store, now, {
    telegramUserId: uid,
    excludeIds: [order.id, order.orderId],
    blockHeight,
  });
  if (userConfirmedLamports(user) + userReserved.reservedLamports + requested > MAX_WALLET_LAMPORTS) {
    return { ok: false, reason: "wallet-cap" };
  }
  return { ok: true };
}

function applyConfirmedContribution(store, currentOrder, signature, now, blockHeight) {
  const uid = String(currentOrder.telegramUserId);
  const user = store.users[uid] || emptyUser(uid);
  const currentMango = parseLamportsInteger(user.allocatedMangoBaseUnits);
  const nextLamports = userConfirmedLamports(user) + orderLamports(currentOrder);
  const nextMango =
    (currentMango.ok ? BigInt(currentMango.lamports) : 0n) + orderMango(currentOrder);
  const contribution = {
    id: currentOrder.id,
    walletSnapshot: currentOrder.walletSnapshot,
    contributedLamports: currentOrder.requestedLamports || currentOrder.lamports,
    mangoAllocationBaseUnits: currentOrder.mangoAllocationBaseUnits,
    transactionSignature: signature,
    confirmedAt: now,
    distributionStatus: "pending",
    distributionTxSignature: null,
  };
  user.telegramUserId = uid;
  user.confirmedLamports = nextLamports.toString();
  user.allocatedMangoBaseUnits = nextMango.toString();
  user.contributions = Array.isArray(user.contributions)
    ? user.contributions.concat([contribution])
    : [contribution];
  store.users[uid] = user;
  store.usedTransactions[signature] = true;
  currentOrder.status = "confirmed";
  currentOrder.confirmedAt = now;
  currentOrder.transactionSignature = signature;
  persistDerivedTotals(store, now, blockHeight);
  return contribution;
}

function markOrderSubmitted(store, order, signature, now, blockHeight) {
  order.status = "submitted";
  order.submittedAt = now;
  order.submittedSignature = signature;
  persistDerivedTotals(store, now, blockHeight);
}

function verifyBoundPayment(rpcResult, order, treasury) {
  return verifyPresaleTransaction(rpcResult, {
    expectedWallet: order.walletSnapshot,
    treasury,
    expectedLamports: order.requestedLamports || order.lamports,
    memo: order.memo,
    createdAt: order.createdAt,
    recentBlockhash: order.recentBlockhash,
  });
}

function markReconciliationPending(store, order, now, blockHeight, reason) {
  order.status = "reconciliation-pending";
  order.reconciliationAttemptedAt = now;
  order.reconciliationReason = reason || "rpc";
  persistDerivedTotals(store, now, blockHeight);
}

function expireReconciledOrder(store, order, now, blockHeight, reason) {
  order.status = "expired";
  order.expiredAt = now;
  order.expiredReason = reason || "blockhash";
  persistDerivedTotals(store, now, blockHeight);
}

async function confirmOrderFromMatch(orderId, signature, rpcResult, options, now, blockHeight) {
  const config = getPresaleConfig(options.env);
  const store = loadPresaleStore(options.presaleFile);
  const order = store.orders[orderId];
  if (!order) {
    return { ok: false, reason: "reservation-expired" };
  }
  const verified = verifyBoundPayment(rpcResult, order, config.treasury);
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }
  try {
    const recorded = mutatePresaleStore((lockedStore) => {
      pruneExpiredSessions(lockedStore, now, blockHeight, { excludeOrderIds: [orderId] });
      if (lockedStore.usedTransactions[signature]) {
        return { ok: false, reason: "duplicate" };
      }
      const currentOrder = lockedStore.orders[orderId];
      if (!currentOrder) {
        return { ok: false, reason: "reservation-expired" };
      }
      if (currentOrder.status === "confirmed") {
        return { ok: false, reason: "duplicate" };
      }
      if (
        currentOrder.status !== "submitted" &&
        currentOrder.status !== "payment-ready" &&
        currentOrder.status !== "reconciliation-pending"
      ) {
        return { ok: false, reason: "reservation-expired" };
      }
      const fit = capacityFitsOrder(lockedStore, currentOrder, now, blockHeight);
      if (!fit.ok) {
        return {
          ok: false,
          reason: fit.reason === "wallet-cap" || fit.reason === "wallet-max" ? "wallet-cap" : "sold-out",
        };
      }
      const contribution = applyConfirmedContribution(
        lockedStore,
        currentOrder,
        signature,
        now,
        blockHeight
      );
      return { ok: true, contribution };
    }, options.presaleFile);
    if (!recorded.ok) {
      return recorded;
    }
    if (typeof options.onReconciledContribution === "function") {
      try {
        await options.onReconciledContribution({
          telegramUserId: String(order.telegramUserId),
          contribution: recorded.contribution,
        });
      } catch {
        // Allocation is already recorded; notify must not undo it.
      }
    }
    return {
      ok: true,
      contribution: recorded.contribution,
      notifyTelegramUserId: String(order.telegramUserId),
      notifyWallet: recorded.contribution.walletSnapshot,
    };
  } catch {
    return { ok: false, reason: "temporary", error: GENERIC_RPC_ERROR };
  }
}

/**
 * Reconcile one payment-ready/submitted/pending order against treasury history
 * or a known signature. Same verification rules as user confirm.
 */
async function reconcilePresaleOrder(orderId, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const blockHeight = await resolveBlockHeight(options);
  if (typeof orderId !== "string" || !orderId.trim()) {
    return { ok: false, reason: "invalid", error: publicConfirmError("invalid") };
  }
  if (
    options.signature !== undefined &&
    options.signature !== null &&
    options.signature !== ""
  ) {
    if (
      typeof options.signature !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(options.signature)
    ) {
      return { ok: false, reason: "invalid-signature", error: publicConfirmError("invalid") };
    }
  }

  const store = loadPresaleStore(options.presaleFile);
  const order = store.orders[orderId];
  if (!order) {
    return { ok: false, reason: "reservation-expired", error: publicConfirmError("reservation-expired") };
  }
  if (order.status === "confirmed") {
    return { ok: false, reason: "duplicate", error: publicConfirmError("duplicate") };
  }
  if (
    order.status !== "payment-ready" &&
    order.status !== "submitted" &&
    order.status !== "reconciliation-pending"
  ) {
    return { ok: false, reason: "reservation-expired", error: publicConfirmError("reservation-expired") };
  }

  const knownSignature =
    typeof options.signature === "string" && options.signature
      ? options.signature
      : order.submittedSignature || null;

  if (knownSignature) {
    if (store.usedTransactions[knownSignature]) {
      return { ok: false, reason: "duplicate", error: publicConfirmError("duplicate") };
    }
    const rpc = await getTransaction(knownSignature, options);
    if (!rpc.ok) {
      mutatePresaleStore((locked) => {
        const current = locked.orders[orderId];
        if (
          current &&
          (current.status === "payment-ready" ||
            current.status === "submitted" ||
            current.status === "reconciliation-pending")
        ) {
          markReconciliationPending(locked, current, now, blockHeight, rpc.reason || "rpc");
        }
      }, options.presaleFile);
      return { ok: false, reason: rpc.reason || "rpc", pending: true, orderId };
    }
    if (rpc.result) {
      const confirmed = await confirmOrderFromMatch(
        orderId,
        knownSignature,
        rpc.result,
        options,
        now,
        blockHeight
      );
      if (confirmed.ok) {
        return confirmed;
      }
      if (confirmed.reason === "duplicate") {
        return { ok: false, reason: "duplicate", error: publicConfirmError("duplicate") };
      }
    }
  }

  if (!needsReconciliation(order, blockHeight) && order.status !== "reconciliation-pending") {
    return { ok: true, unchanged: true, status: order.status, orderId };
  }

  const config = getPresaleConfig(options.env);
  if (!config.treasury) {
    mutatePresaleStore((locked) => {
      const current = locked.orders[orderId];
      if (current && current.status !== "confirmed" && current.status !== "expired") {
        markReconciliationPending(locked, current, now, blockHeight, "treasury-missing");
      }
    }, options.presaleFile);
    return { ok: false, reason: "treasury-missing", pending: true, orderId };
  }

  const scan = await scanTreasuryForOrder(order, config.treasury, options);
  if (!scan.ok) {
    mutatePresaleStore((locked) => {
      const current = locked.orders[orderId];
      if (
        current &&
        (current.status === "payment-ready" ||
          current.status === "submitted" ||
          current.status === "reconciliation-pending")
      ) {
        markReconciliationPending(locked, current, now, blockHeight, scan.reason || "rpc");
      }
    }, options.presaleFile);
    return { ok: false, reason: scan.reason || "rpc", pending: true, orderId };
  }

  if (scan.coverage === "conflict" || scan.matches.length > 1) {
    mutatePresaleStore((locked) => {
      const current = locked.orders[orderId];
      if (
        current &&
        (current.status === "payment-ready" ||
          current.status === "submitted" ||
          current.status === "reconciliation-pending")
      ) {
        markReconciliationPending(locked, current, now, blockHeight, "multiple-match");
      }
    }, options.presaleFile);
    return { ok: false, reason: "multiple-match", pending: true, orderId };
  }

  if (scan.matches.length === 1) {
    const match = scan.matches[0];
    return confirmOrderFromMatch(orderId, match.signature, match.tx, options, now, blockHeight);
  }

  if (scan.coverage !== "complete") {
    mutatePresaleStore((locked) => {
      const current = locked.orders[orderId];
      if (
        current &&
        (current.status === "payment-ready" ||
          current.status === "submitted" ||
          current.status === "reconciliation-pending")
      ) {
        markReconciliationPending(locked, current, now, blockHeight, "coverage-uncertain");
      }
    }, options.presaleFile);
    return { ok: false, reason: "coverage-uncertain", pending: true, orderId };
  }

  mutatePresaleStore((locked) => {
    const current = locked.orders[orderId];
    if (
      current &&
      (current.status === "payment-ready" ||
        current.status === "submitted" ||
        current.status === "reconciliation-pending")
    ) {
      expireReconciledOrder(locked, current, now, blockHeight, "no-payment");
    }
  }, options.presaleFile);
  return { ok: true, expired: true, orderId };
}

async function reconcileExpiredPresaleOrders(options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const blockHeight = await resolveBlockHeight(options);
  const store = loadPresaleStore(options.presaleFile);
  const ids = Object.keys(store.orders || {}).filter((id) =>
    needsReconciliation(store.orders[id], blockHeight)
  );
  const confirmed = [];
  const expired = [];
  const pending = [];
  for (const orderId of ids) {
    const result = await reconcilePresaleOrder(orderId, { ...options, now, currentBlockHeight: blockHeight });
    if (result && result.ok && result.contribution) {
      confirmed.push(result);
    } else if (result && result.ok && result.expired) {
      expired.push(orderId);
    } else if (result && result.pending) {
      pending.push(orderId);
    }
  }
  return { ok: true, confirmed, expired, pending };
}

async function confirmPresalePayment(rawToken, signature, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const blockHeight = await resolveBlockHeight(options);
  if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(signature)) {
    return { ok: false, reason: "invalid-signature", error: publicConfirmError("invalid") };
  }
  const session = lookupPresaleSession(rawToken, options);
  if (session.status === "expired") {
    return { ok: false, reason: "expired", error: publicConfirmError("expired") };
  }
  if (session.status !== "ok") {
    return { ok: false, reason: "invalid", error: publicConfirmError("invalid") };
  }

  const store = loadPresaleStore(options.presaleFile);
  if (store.usedTransactions[signature]) {
    return { ok: false, reason: "duplicate", error: publicConfirmError("duplicate") };
  }

  const uid = session.record.telegramUserId;
  const order = findOrderForConfirm(store, uid, session.tokenHash, options.orderId);
  if (!order) {
    return { ok: false, reason: "reservation-expired", error: publicConfirmError("reservation-expired") };
  }
  if (String(order.telegramUserId) !== String(uid)) {
    return { ok: false, reason: "invalid", error: publicConfirmError("invalid") };
  }
  if (order.status === "confirmed") {
    return { ok: false, reason: "duplicate", error: publicConfirmError("duplicate") };
  }
  if (order.status === "superseded" || order.status === "expired" || order.status === "reserved") {
    return { ok: false, reason: "reservation-expired", error: publicConfirmError("reservation-expired") };
  }
  if (!orderPayableForConfirm(order, now, blockHeight)) {
    return { ok: false, reason: "reservation-expired", error: publicConfirmError("reservation-expired") };
  }

  const submitted = mutatePresaleStore((lockedStore) => {
    pruneExpiredSessions(lockedStore, now, blockHeight, { excludeOrderIds: [order.id] });
    if (lockedStore.usedTransactions[signature]) {
      return { ok: false, reason: "duplicate" };
    }
    const currentOrder = lockedStore.orders[order.id];
    if (!currentOrder) {
      return { ok: false, reason: "reservation-expired" };
    }
    if (currentOrder.status === "confirmed") {
      return { ok: false, reason: "duplicate" };
    }
    if (
      currentOrder.status === "submitted" &&
      currentOrder.submittedSignature &&
      currentOrder.submittedSignature !== signature
    ) {
      return { ok: false, reason: "duplicate" };
    }
    if (!orderPayableForConfirm(currentOrder, now, blockHeight)) {
      return { ok: false, reason: "reservation-expired" };
    }
    if (currentOrder.walletSnapshot !== order.walletSnapshot) {
      return { ok: false, reason: "invalid" };
    }
    markOrderSubmitted(lockedStore, currentOrder, signature, now, blockHeight);
    return { ok: true, order: currentOrder };
  }, options.presaleFile);

  if (!submitted.ok) {
    return { ok: false, reason: submitted.reason, error: publicConfirmError(submitted.reason) };
  }

  const rpc = await getTransaction(signature, options);
  if (!rpc.ok || !rpc.result) {
    return {
      ok: false,
      reason: rpc.reason || "rpc",
      error: GENERIC_RPC_ERROR,
      submitted: true,
      orderId: order.id,
    };
  }

  const config = getPresaleConfig(options.env);
  const verified = verifyBoundPayment(rpc.result, submitted.order, config.treasury);
  if (!verified.ok) {
    mutatePresaleStore((lockedStore) => {
      const currentOrder = lockedStore.orders[order.id];
      if (
        currentOrder &&
        currentOrder.status === "submitted" &&
        currentOrder.submittedSignature === signature
      ) {
        currentOrder.status = "payment-ready";
        delete currentOrder.submittedAt;
        delete currentOrder.submittedSignature;
        persistDerivedTotals(lockedStore, now, blockHeight);
      }
    }, options.presaleFile);
    return { ok: false, reason: verified.reason, error: publicConfirmError(verified.reason) };
  }

  try {
    const recorded = mutatePresaleStore((lockedStore) => {
      pruneExpiredSessions(lockedStore, now, blockHeight);
      if (lockedStore.usedTransactions[signature]) {
        return { ok: false, reason: "duplicate" };
      }
      const currentOrder = lockedStore.orders[order.id];
      if (!currentOrder) {
        return { ok: false, reason: "reservation-expired" };
      }
      if (currentOrder.status === "confirmed") {
        return { ok: false, reason: "duplicate" };
      }
      if (currentOrder.status === "superseded") {
        return { ok: false, reason: "reservation-expired" };
      }
      if (
        currentOrder.status !== "submitted" &&
        currentOrder.status !== "payment-ready" &&
        currentOrder.status !== "reconciliation-pending"
      ) {
        return { ok: false, reason: "reservation-expired" };
      }
      if (currentOrder.walletSnapshot !== order.walletSnapshot) {
        return { ok: false, reason: "invalid" };
      }
      const fit = capacityFitsOrder(lockedStore, currentOrder, now, blockHeight);
      if (!fit.ok) {
        return {
          ok: false,
          reason: fit.reason === "wallet-cap" || fit.reason === "wallet-max" ? "wallet-cap" : "sold-out",
        };
      }
      const contribution = applyConfirmedContribution(
        lockedStore,
        currentOrder,
        signature,
        now,
        blockHeight
      );
      return { ok: true, contribution };
    }, options.presaleFile);

    if (!recorded.ok) {
      return { ok: false, reason: recorded.reason, error: publicConfirmError(recorded.reason) };
    }

    return {
      ok: true,
      contribution: recorded.contribution,
      notifyTelegramUserId: uid,
      notifyWallet: recorded.contribution.walletSnapshot,
    };
  } catch {
    return { ok: false, reason: "temporary", error: GENERIC_RPC_ERROR, submitted: true };
  }
}

/**
 * Admin-safe recovery: same verification as automatic reconciliation.
 * Optional known signature; otherwise scans treasury history.
 */
async function reconcilePresalePayment(orderId, signature, options = {}) {
  return reconcilePresaleOrder(orderId, { ...options, signature });
}

function getPresalePublicStatus(env = process.env) {
  const live = isPresaleLive(Date.now(), env);
  if (!live) {
    return {
      live: false,
      label: "Coming soon",
      userLine: "Coming soon",
    };
  }
  const status = getPresaleStatus({ env });
  if (status.soldOut) {
    return { live: true, label: "Sold out", userLine: "Sold out" };
  }
  return { live: true, label: "Live", userLine: "Live" };
}

module.exports = {
  emptyUser,
  userConfirmedLamports,
  totalsFromStore,
  remainingGlobalLamports,
  availableGlobalLamports,
  reservedFromOrders,
  isActiveReservation,
  holdsCapacity,
  reservationInvariant,
  getPresaleStatus,
  getRemainingPresaleLamports,
  getRemainingPresaleAllocation,
  getPresaleParticipation,
  canUserContribute,
  preparePresalePayment,
  issuePresalePayment,
  confirmPresalePayment,
  reconcilePresalePayment,
  reconcilePresaleOrder,
  reconcileExpiredPresaleOrders,
  getPresalePublicStatus,
  summarizeUser,
  findActiveReservationForUser,
};
