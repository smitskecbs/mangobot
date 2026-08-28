/**
 * Private admin Control Center. Keyboard label + adm:* callbacks.
 * Reuses existing Phase 2, cleanup, retry, wallet, builder, and status handlers.
 * Members never see this hub. Callbacks re-check ADMIN_USER_ID + private chat.
 */

const { isAdmin } = require("../services/points");
const {
  isPrivateChat,
  MENU_LABELS,
  PRIVATE_MENU_HINT,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");
const {
  ADMIN_CALLBACK,
  REJECT_TEXT,
  parseAdminCallback,
  isAdminCallback,
  gateAdminMenuAccess,
  buildHomeView,
  buildPhase2MenuView,
  buildDeliveryView,
  buildCommunityView,
  buildWalletsView,
  buildRewardsView,
  buildStatusView,
  buildCommandsView,
} = require("../services/adminControlCenter");
const {
  handlePhase2Open,
  handlePhase2Callback,
  PHASE2_CALLBACK,
} = require("./phase2");
const {
  handleClearPendingGifts,
  handleRetryMysteryAnnounce,
} = require("./clearpendinggifts");
const { handleWalletList } = require("./walletlist");
const {
  handleCommunityBuilder,
  handleBuilderBoard,
} = require("./communitybuilder");
const { handlePresaleStatus } = require("./presalestatus");
const { handleChatFightStatus } = require("./chatfightstatus");

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

function withCallbackData(ctx, data) {
  return {
    chat: ctx.chat,
    from: ctx.from,
    telegram: ctx.telegram,
    match: ctx.match,
    callbackQuery: { ...(ctx.callbackQuery || {}), data },
    reply: (...args) => ctx.reply(...args),
    editMessageText: (...args) =>
      typeof ctx.editMessageText === "function"
        ? ctx.editMessageText(...args)
        : undefined,
    answerCbQuery: (...args) =>
      typeof ctx.answerCbQuery === "function"
        ? ctx.answerCbQuery(...args)
        : undefined,
  };
}

function handleAdminOpen(ctx, options = {}) {
  const gate = gateAdminMenuAccess(ctx);
  if (!gate.ok) {
    if (gate.reason === "not-admin" && !isPrivateChat(ctx)) {
      return undefined;
    }
    return rejectAccess(ctx, gate);
  }
  return showView(ctx, buildHomeView(options));
}

function handleAdminMenu(ctx, options = {}) {
  if (!isPrivateChat(ctx)) {
    return undefined;
  }
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    return undefined;
  }
  return handleAdminOpen(ctx, options);
}

async function handleAdminCallback(ctx, options = {}) {
  const data =
    ctx && ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
      ? ctx.callbackQuery.data
      : "";
  if (!data.startsWith("adm:")) {
    return undefined;
  }

  const gate = gateAdminMenuAccess(ctx);
  if (!gate.ok) {
    return rejectAccess(ctx, gate);
  }

  const parsed = parseAdminCallback(data);
  if (!parsed) {
    await answerQuiet(ctx);
    return undefined;
  }

  const action = parsed.action;
  if (action === ADMIN_CALLBACK.PHASE2_CLEAR) {
    await answerQuiet(ctx);
    return handleClearPendingGifts(ctx, options);
  }
  if (action === ADMIN_CALLBACK.PHASE2_RETRY) {
    await answerQuiet(ctx);
    return handleRetryMysteryAnnounce(ctx, options);
  }
  if (action === ADMIN_CALLBACK.PHASE2_OPEN) {
    return handlePhase2Open(ctx, options);
  }
  if (action === ADMIN_CALLBACK.PHASE2_CREATE) {
    return handlePhase2Callback(
      withCallbackData(ctx, PHASE2_CALLBACK.CREATE),
      options
    );
  }
  if (action === ADMIN_CALLBACK.PHASE2_PENDING) {
    return handlePhase2Callback(
      withCallbackData(ctx, PHASE2_CALLBACK.REWARDS_PENDING),
      options
    );
  }
  if (action === ADMIN_CALLBACK.COMMUNITY_BUILDER) {
    await answerQuiet(ctx);
    return handleCommunityBuilder(ctx, options);
  }
  if (action === ADMIN_CALLBACK.BUILDER_BOARD) {
    await answerQuiet(ctx);
    return handleBuilderBoard(ctx, options);
  }
  if (action === ADMIN_CALLBACK.WALLET_LIST) {
    await answerQuiet(ctx);
    return handleWalletList(ctx, options);
  }
  if (action === ADMIN_CALLBACK.PRESALE) {
    await answerQuiet(ctx);
    return handlePresaleStatus(ctx, options);
  }
  if (action === ADMIN_CALLBACK.FIGHT) {
    await answerQuiet(ctx);
    return handleChatFightStatus(ctx, options);
  }
  if (action === ADMIN_CALLBACK.BACK) {
    await answerQuiet(ctx);
    return ctx.reply(PRIVATE_MENU_HINT, getPrivateMenuKeyboard(ctx));
  }

  await answerQuiet(ctx);
  if (action === ADMIN_CALLBACK.HOME) {
    return showView(ctx, buildHomeView(options));
  }
  if (action === ADMIN_CALLBACK.PHASE2) {
    return showView(ctx, buildPhase2MenuView());
  }
  if (action === ADMIN_CALLBACK.PHASE2_DELIVER) {
    return showView(ctx, buildDeliveryView());
  }
  if (action === ADMIN_CALLBACK.COMMUNITY) {
    return showView(ctx, buildCommunityView());
  }
  if (action === ADMIN_CALLBACK.WALLETS) {
    return showView(ctx, buildWalletsView());
  }
  if (action === ADMIN_CALLBACK.REWARDS) {
    return showView(ctx, buildRewardsView());
  }
  if (action === ADMIN_CALLBACK.STATUS) {
    return showView(ctx, buildStatusView());
  }
  if (action === ADMIN_CALLBACK.COMMANDS) {
    return showView(ctx, buildCommandsView());
  }
  return undefined;
}

module.exports = (bot) => {
  bot.hears(MENU_LABELS.ADMIN, (ctx) => handleAdminMenu(ctx));
  bot.action(/^adm:/, (ctx) =>
    Promise.resolve(handleAdminCallback(ctx)).catch(() => undefined)
  );
};

module.exports.handleAdminOpen = handleAdminOpen;
module.exports.handleAdminMenu = handleAdminMenu;
module.exports.handleAdminCallback = handleAdminCallback;
module.exports.ADMIN_CALLBACK = ADMIN_CALLBACK;
module.exports.isAdminCallback = isAdminCallback;
