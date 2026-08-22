/**
 * Private admin-only Phase 2 Control Center.
 * Menu button and p2:* callbacks. No group details. No auto-reward.
 */

const { isAdmin } = require("../services/points");
const { isPrivateChat, MENU_LABELS } = require("../utils/botMenu");
const { log } = require("../utils/logger");
const { startInteractiveDeliver } = require("./deliver");
const {
  PHASE2_CALLBACK,
  REJECT_TEXT,
  STALE_TEXT,
  UNVERIFIED_CREATE,
  parsePhase2Callback,
  isPhase2Callback,
  gatePhase2Access,
  resolveSession,
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
  loadMemberDetail,
  createMysteryGiftForMember,
} = require("../services/phase2ControlCenter");

async function answerQuiet(ctx) {
  if (typeof ctx.answerCbQuery === "function") {
    try {
      await ctx.answerCbQuery();
    } catch {
      // Non-fatal.
    }
  }
}

async function showView(ctx, view) {
  if (!view || typeof view.text !== "string") {
    return undefined;
  }
  if (ctx.callbackQuery && typeof ctx.editMessageText === "function") {
    try {
      return await ctx.editMessageText(view.text, view.extra);
    } catch {
      // Fall through to a new reply.
    }
  }
  return ctx.reply(view.text, view.extra);
}

async function rejectAccess(ctx, gate) {
  if (gate.silent) {
    return undefined;
  }
  if (ctx.callbackQuery && typeof ctx.answerCbQuery === "function") {
    try {
      await ctx.answerCbQuery(gate.text || REJECT_TEXT);
    } catch {
      // ignore
    }
    return undefined;
  }
  if (isPrivateChat(ctx)) {
    return ctx.reply(gate.text || REJECT_TEXT);
  }
  return undefined;
}

function handlePhase2Open(ctx, options = {}) {
  const gate = gatePhase2Access(ctx);
  if (!gate.ok) {
    if (gate.reason === "not-admin" && !isPrivateChat(ctx)) {
      return undefined;
    }
    return rejectAccess(ctx, gate);
  }
  log("[phase2] control center opened");
  return showView(ctx, buildHomeView(options));
}

async function resolveMemberSession(ctx, token, options) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const session = resolveSession(token, now);
  if (!session || session.kind !== "member" || !session.userId) {
    await ctx.reply(STALE_TEXT);
    return null;
  }
  return session;
}

async function handlePhase2Callback(ctx, options = {}) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";
  const parsed = parsePhase2Callback(data);
  if (!parsed) {
    return undefined;
  }

  const gate = gatePhase2Access(ctx);
  if (!gate.ok) {
    return rejectAccess(ctx, gate);
  }

  await answerQuiet(ctx);

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const files = { ...options, now };

  if (parsed.action === "unknown") {
    return undefined;
  }
  if (parsed.action === "home") {
    return showView(ctx, buildHomeView(files));
  }
  if (parsed.action === "xp") {
    return showView(ctx, buildXpView(files, parsed.page));
  }
  if (parsed.action === "bp") {
    return showView(ctx, buildBpView(files, parsed.page));
  }
  if (parsed.action === "active") {
    return showView(ctx, buildActiveView(files, parsed.page));
  }
  if (parsed.action === "candidates") {
    return showView(ctx, buildCandidatesView(files, parsed.page));
  }
  if (parsed.action === "rewards") {
    return showView(ctx, buildRewardsView(files));
  }
  if (parsed.action === "rewards-pending") {
    return showView(ctx, buildRewardSubsetView("pending", files));
  }
  if (parsed.action === "rewards-sent") {
    return showView(ctx, buildRewardSubsetView("sent", files));
  }
  if (parsed.action === "create") {
    return showView(ctx, buildCreateView(files, parsed.page));
  }
  if (parsed.action === "member") {
    const session = await resolveMemberSession(ctx, parsed.token, files);
    if (!session) {
      return undefined;
    }
    const detail = loadMemberDetail(session.userId, files);
    return showView(ctx, buildMemberView(detail, now));
  }
  if (parsed.action === "gift") {
    const session = await resolveMemberSession(ctx, parsed.token, files);
    if (!session) {
      return undefined;
    }
    log("[phase2] member selected");
    const detail = loadMemberDetail(session.userId, files);
    return showView(ctx, buildGiftConfirmView(detail, parsed.token));
  }
  if (parsed.action === "make") {
    const session = await resolveMemberSession(ctx, parsed.token, files);
    if (!session) {
      return undefined;
    }
    if (session.createdRewardId) {
      const detail = loadMemberDetail(session.userId, files);
      return showView(
        ctx,
        buildCreatedView(
          { rewardId: session.createdRewardId },
          detail.displayName,
          now
        )
      );
    }
    const created = createMysteryGiftForMember(
      session.userId,
      ctx.from.id,
      files
    );
    if (!created.ok) {
      return ctx.reply(created.error || UNVERIFIED_CREATE);
    }
    session.createdRewardId = created.reward.rewardId;
    return showView(
      ctx,
      buildCreatedView(created.reward, created.displayName, now)
    );
  }
  if (parsed.action === "member-rewards") {
    const session = await resolveMemberSession(ctx, parsed.token, files);
    if (!session) {
      return undefined;
    }
    return showView(ctx, buildMemberRewardsView(session.userId, files));
  }
  if (parsed.action === "deliver") {
    const session = resolveSession(parsed.token, now);
    if (!session || session.kind !== "reward" || !session.rewardId) {
      return ctx.reply(STALE_TEXT);
    }
    return startInteractiveDeliver(ctx, session.rewardId, files);
  }
  return undefined;
}

function handlePhase2Menu(ctx, options = {}) {
  if (!isPrivateChat(ctx)) {
    return undefined;
  }
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    return undefined;
  }
  return handlePhase2Open(ctx, options);
}

module.exports = (bot) => {
  bot.hears(MENU_LABELS.PHASE2, (ctx) => handlePhase2Menu(ctx));
  bot.action(/^p2:/, (ctx) => handlePhase2Callback(ctx));
};

module.exports.handlePhase2Open = handlePhase2Open;
module.exports.handlePhase2Callback = handlePhase2Callback;
module.exports.handlePhase2Menu = handlePhase2Menu;
module.exports.isPhase2Callback = isPhase2Callback;
module.exports.PHASE2_CALLBACK = PHASE2_CALLBACK;
