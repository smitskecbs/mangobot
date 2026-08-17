/**
 * Public presale HTTP handlers for the Hetzner highscore API.
 *
 *   POST /presale/status
 *   POST /presale/prepare
 *   POST /presale/payment
 *   POST /presale/confirm
 *
 * Session tokens are created by the Telegram bot, not by a public HTTP route.
 * Frontend never supplies telegramUserId or destination wallet as source of truth.
 */

const { applyCorsHeaders, handleCorsPreflight } = require("./httpCors");
const { readJsonBodyLimited, sendJson } = require("./walletApi");
const { lookupPresaleSession } = require("./presaleSessions");
const { getVerifiedWalletForUser } = require("./walletLinks");
const {
  getPresaleStatus,
  getPresaleParticipation,
  preparePresalePayment,
  issuePresalePayment,
  confirmPresalePayment,
  reconcileExpiredPresaleOrders,
} = require("./presaleLedger");
const { getBlockHeight } = require("./presaleRpc");
const { notifyPresaleConfirmed } = require("./presaleNotify");
const { shortenWallet } = require("../utils/solanaWallet");
const {
  MANGO_PER_SOL_HUMAN,
  MIN_SOL_HUMAN,
  MAX_WALLET_SOL_HUMAN,
  ALLOWED_AMOUNTS_LAMPORTS,
  formatLamportsAsSol,
  formatMangoHuman,
  mangoBaseUnitsFromLamports,
  RECONCILE_TICK_MS,
} = require("./presaleConstants");

const TEMPORARY_ERROR = "Presale is temporarily unavailable. Please try again.";

function sessionError(status) {
  if (status === "expired") {
    return { status: 400, body: { ok: false, error: "This presale link has expired.", reason: "expired" } };
  }
  return { status: 400, body: { ok: false, error: "Invalid request.", reason: "invalid" } };
}

function notifyReconciled(payload, options) {
  if (!payload || !payload.telegramUserId || !payload.contribution) {
    return;
  }
  const notify = options.sendPresaleNotification || notifyPresaleConfirmed;
  Promise.resolve(
    notify(
      {
        telegramUserId: payload.telegramUserId,
        contribution: payload.contribution,
      },
      options
    )
  ).catch((err) => {
    const code = (err && err.code) || (err && err.name) || "Error";
    console.error(`[presale] notify failed error=${code}`);
  });
}

async function publicStatusForToken(token, options = {}) {
  const session = lookupPresaleSession(token, options);
  if (session.status !== "ok") {
    return sessionError(session.status);
  }
  const uid = session.record.telegramUserId;
  const verified = getVerifiedWalletForUser(uid, options.walletFile);
  const expectedWallet = session.record.expectedWallet;
  const connectedMatches = Boolean(
    verified && verified.wallet && verified.wallet === expectedWallet
  );
  const heightResult = await getBlockHeight(options);
  const blockHeight = heightResult.ok ? heightResult.height : null;
  const now = options.now === undefined ? Date.now() : options.now;
  await reconcileExpiredPresaleOrders({
    ...options,
    now,
    currentBlockHeight: blockHeight,
    onReconciledContribution: (payload) => notifyReconciled(payload, options),
  });
  const global = getPresaleStatus({ ...options, currentBlockHeight: blockHeight, now });
  const participation = getPresaleParticipation(uid, options.presaleFile, now, blockHeight);
  const reservation = participation.activeReservation;
  return {
    status: 200,
    body: {
      ok: true,
      live: global.live,
      soldOut: global.soldOut,
      expectedWallet,
      expectedWalletShort: shortenWallet(expectedWallet),
      walletVerified: Boolean(verified),
      walletMatch: connectedMatches,
      treasuryShort: global.treasury ? shortenWallet(global.treasury) : "",
      rate: `1 SOL = ${MANGO_PER_SOL_HUMAN.toString()} MANGO`,
      minSol: MIN_SOL_HUMAN,
      maxWalletSol: MAX_WALLET_SOL_HUMAN,
      amounts: ALLOWED_AMOUNTS_LAMPORTS.map((lamports) => {
        const alloc = mangoBaseUnitsFromLamports(lamports);
        return {
          lamports: lamports.toString(),
          sol: formatLamportsAsSol(lamports.toString()),
          mango: alloc.ok ? alloc.human : "0",
        };
      }),
      contributionSol: formatLamportsAsSol(participation.confirmedLamports),
      allocationMango: participation.allocation,
      remainingMango: global.remainingMango,
      targetMango: global.targetMango,
      remainingLamports: global.availableLamports || global.remainingLamports,
      availableLamports: global.availableLamports,
      availableSol: global.availableSol,
      reservedLamports: global.reservedLamports,
      reservedSol: global.reservedSol,
      activeReservation: reservation
        ? {
            orderId: reservation.id,
            status: reservation.status,
            lamports: reservation.requestedLamports || reservation.lamports,
            sol: formatLamportsAsSol(reservation.requestedLamports || reservation.lamports),
            mango: formatMangoHuman(reservation.mangoAllocationBaseUnits),
            memo: reservation.memo,
            expiresAt: reservation.expiresAt,
            from: reservation.walletSnapshot,
            to: global.treasury,
            fromShort: shortenWallet(reservation.walletSnapshot),
            toShort: global.treasury ? shortenWallet(global.treasury) : "",
            recentBlockhash: reservation.recentBlockhash || null,
            lastValidBlockHeight:
              reservation.lastValidBlockHeight === undefined
                ? null
                : reservation.lastValidBlockHeight,
          }
        : null,
    },
  };
}

async function handlePresaleStatus(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(res, tooLarge ? 413 : 400, { ok: false, error: "Invalid request." }, origin);
    return;
  }
  const mapped = await publicStatusForToken(body && body.token, options);
  sendJson(res, mapped.status, mapped.body, origin);
}

async function handlePresalePrepare(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(res, tooLarge ? 413 : 400, { ok: false, error: "Invalid request." }, origin);
    return;
  }
  const result = await preparePresalePayment(body && body.token, body && body.lamports, {
    ...options,
    onReconciledContribution: (payload) => notifyReconciled(payload, options),
  });
  if (!result.ok) {
    sendJson(res, 400, { ok: false, error: result.error || "Invalid request." }, origin);
    return;
  }
  sendJson(
    res,
    200,
    {
      ok: true,
      orderId: result.orderId,
      memo: result.memo,
      from: result.from,
      to: result.to,
      lamports: result.lamports,
      sol: formatLamportsAsSol(result.lamports),
      mango: result.mangoHuman,
      mangoAllocationBaseUnits: result.mangoAllocationBaseUnits,
      expiresAt: result.expiresAt,
      network: result.network,
      status: result.status || "reserved",
      fromShort: shortenWallet(result.from),
      toShort: shortenWallet(result.to),
    },
    origin
  );
}

function paymentResponseBody(result) {
  return {
    ok: true,
    orderId: result.orderId,
    memo: result.memo,
    from: result.from,
    to: result.to,
    lamports: result.lamports,
    sol: formatLamportsAsSol(result.lamports),
    mango: result.mangoHuman,
    mangoAllocationBaseUnits: result.mangoAllocationBaseUnits,
    network: result.network,
    status: result.status,
    recentBlockhash: result.recentBlockhash,
    lastValidBlockHeight: result.lastValidBlockHeight,
    fromShort: shortenWallet(result.from),
    toShort: shortenWallet(result.to),
  };
}

async function handlePresalePayment(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(res, tooLarge ? 413 : 400, { ok: false, error: "Invalid request." }, origin);
    return;
  }
  const result = await issuePresalePayment(body && body.token, body && body.orderId, options);
  if (!result.ok) {
    sendJson(res, 400, { ok: false, error: result.error || "Invalid request." }, origin);
    return;
  }
  sendJson(res, 200, paymentResponseBody(result), origin);
}

async function handlePresaleConfirm(req, res, origin, options = {}) {
  let body;
  try {
    body = await readJsonBodyLimited(req);
  } catch (err) {
    const tooLarge = err && err.message === "payload-too-large";
    sendJson(res, tooLarge ? 413 : 400, { ok: false, error: "Invalid request." }, origin);
    return;
  }
  const result = await confirmPresalePayment(
    body && body.token,
    body && body.signature,
    { ...options, orderId: body && body.orderId }
  );
  if (!result.ok) {
    sendJson(res, 400, { ok: false, error: result.error || "Invalid request." }, origin);
    return;
  }

  sendJson(
    res,
    200,
    {
      ok: true,
      sol: formatLamportsAsSol(result.contribution.contributedLamports),
      mango: formatMangoHuman(result.contribution.mangoAllocationBaseUnits),
      walletShort: shortenWallet(result.contribution.walletSnapshot),
    },
    origin
  );

  if (result.notifyTelegramUserId && result.contribution) {
    try {
      const notify = options.sendPresaleNotification || notifyPresaleConfirmed;
      await notify(
        {
          telegramUserId: result.notifyTelegramUserId,
          contribution: result.contribution,
        },
        options
      );
    } catch (err) {
      const code = (err && err.code) || (err && err.name) || "Error";
      console.error(`[presale] notify failed error=${code}`);
    }
  }
}

async function tryHandlePresaleRequest(req, res, origin, url, method, options = {}) {
  if (
    url !== "/presale/status" &&
    url !== "/presale/prepare" &&
    url !== "/presale/payment" &&
    url !== "/presale/confirm"
  ) {
    return false;
  }

  if (method === "OPTIONS") {
    handleCorsPreflight(res, origin);
    return true;
  }

  if (method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed." }, origin);
    return true;
  }

  try {
    if (url === "/presale/status") {
      await handlePresaleStatus(req, res, origin, options);
      return true;
    }
    if (url === "/presale/prepare") {
      await handlePresalePrepare(req, res, origin, options);
      return true;
    }
    if (url === "/presale/payment") {
      await handlePresalePayment(req, res, origin, options);
      return true;
    }
    await handlePresaleConfirm(req, res, origin, options);
    return true;
  } catch {
    sendJson(res, 500, { ok: false, error: TEMPORARY_ERROR }, origin);
    return true;
  }
}

function startPresaleReconciliationTimer(options = {}) {
  const ms = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : RECONCILE_TICK_MS;
  return setInterval(() => {
    reconcileExpiredPresaleOrders(options).catch((err) => {
      const code = (err && err.code) || (err && err.name) || "Error";
      console.error(`[presale] reconcile tick failed error=${code}`);
    });
  }, ms);
}

module.exports = {
  tryHandlePresaleRequest,
  handlePresaleStatus,
  handlePresalePrepare,
  handlePresalePayment,
  handlePresaleConfirm,
  publicStatusForToken,
  startPresaleReconciliationTimer,
};
