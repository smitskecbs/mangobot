/**
 * Private admin Control Center views and callback parsing.
 * Authorization is re-checked by the command handler on every callback.
 * Callback data carries no user ids, wallets, or secrets.
 */

const { Markup } = require("telegraf");
const { isAdmin } = require("./points");
const { isPrivateChat } = require("../utils/botMenu");

const ADMIN_CALLBACK = Object.freeze({
  HOME: "adm:home",
  PHASE2: "adm:p2",
  PHASE2_OPEN: "adm:p2:open",
  PHASE2_CREATE: "adm:p2:new",
  PHASE2_PENDING: "adm:p2:pend",
  PHASE2_DELIVER: "adm:p2:dlv",
  PHASE2_RETRY: "adm:p2:retry",
  PHASE2_CLEAR: "adm:p2:clr",
  COMMUNITY: "adm:comm",
  COMMUNITY_BUILDER: "adm:cbuild",
  BUILDER_BOARD: "adm:cboard",
  WALLETS: "adm:wal",
  WALLET_LIST: "adm:wlist",
  REWARDS: "adm:rew",
  STATUS: "adm:stat",
  PRESALE: "adm:psale",
  FIGHT: "adm:fight",
  COMMANDS: "adm:cmds",
  BACK: "adm:back",
});

const CALLBACK_SET = new Set(Object.values(ADMIN_CALLBACK));

const REJECT_TEXT = "Not available.";
const GROUP_REJECT = "Open a private chat with the bot.";

const HOME_TEXT = `🛠 ManGo Admin

Choose what you want to manage.`;

const PHASE2_TEXT = `🎁 Mystery Gifts

Create, review, deliver, or clean up Phase 2 gifts.`;

const DELIVERY_TEXT = `🚚 Delivery

Open pending gifts and tap Deliver on a gift.
Or use /deliver <rewardId>
Reply to a member with /deliver.`;

const COMMUNITY_TEXT = `👥 Community

Builder tools for the ManGo group.`;

const WALLETS_TEXT = `💳 Wallets

Linked vs unlinked members. No private keys.`;

const REWARDS_TEXT = `🏆 Builder / Rewards

Create Mystery Gifts from here.
Reply-based awards still use commands.`;

const STATUS_TEXT = `📊 Status

Operational overviews. No secrets.`;

const COMMANDS_TEXT = `⌨️ Admin Commands

Buttons first. Commands remain as fallback.

/reward
/walletlist
/builderaward
/lootaward
/membercheck
/deliver
/clearpendinggifts
/retrymysteryannounce`;

function extraFromRows(rows) {
  return Markup.inlineKeyboard(rows);
}

function btn(label, data) {
  return Markup.button.callback(label, data);
}

function row(label, data) {
  return [btn(label, data)];
}

function backHomeRow() {
  return row("⬅️ Back", ADMIN_CALLBACK.HOME);
}

function parseAdminCallback(data) {
  if (typeof data !== "string" || !CALLBACK_SET.has(data)) {
    return null;
  }
  return { action: data };
}

function isAdminCallback(data) {
  return Boolean(parseAdminCallback(data));
}

function gateAdminMenuAccess(ctx) {
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

function buildHomeView() {
  return {
    text: HOME_TEXT,
    extra: extraFromRows([
      row("🎁 Phase 2 / Mystery Gifts", ADMIN_CALLBACK.PHASE2),
      row("👥 Community", ADMIN_CALLBACK.COMMUNITY),
      row("💳 Wallets", ADMIN_CALLBACK.WALLETS),
      row("🏆 Rewards", ADMIN_CALLBACK.REWARDS),
      row("📊 Status", ADMIN_CALLBACK.STATUS),
      row("⌨️ Commands", ADMIN_CALLBACK.COMMANDS),
      row("⬅️ Back", ADMIN_CALLBACK.BACK),
    ]),
  };
}

function buildPhase2MenuView() {
  return {
    text: PHASE2_TEXT,
    extra: extraFromRows([
      row("🚀 Open Phase 2", ADMIN_CALLBACK.PHASE2_OPEN),
      row("➕ Create Reward", ADMIN_CALLBACK.PHASE2_CREATE),
      row("📋 Pending Gifts", ADMIN_CALLBACK.PHASE2_PENDING),
      row("🚚 Delivery", ADMIN_CALLBACK.PHASE2_DELIVER),
      row("📣 Retry Announcement", ADMIN_CALLBACK.PHASE2_RETRY),
      row("🗑 Clear Pending", ADMIN_CALLBACK.PHASE2_CLEAR),
      backHomeRow(),
    ]),
  };
}

function buildDeliveryView() {
  return {
    text: DELIVERY_TEXT,
    extra: extraFromRows([
      row("📋 Pending Gifts", ADMIN_CALLBACK.PHASE2_PENDING),
      row("🚀 Open Phase 2", ADMIN_CALLBACK.PHASE2_OPEN),
      backHomeRow(),
    ]),
  };
}

function buildCommunityView() {
  return {
    text: COMMUNITY_TEXT,
    extra: extraFromRows([
      row("🤝 Community Builder", ADMIN_CALLBACK.COMMUNITY_BUILDER),
      row("🏆 Builder Board", ADMIN_CALLBACK.BUILDER_BOARD),
      backHomeRow(),
    ]),
  };
}

function buildWalletsView() {
  return {
    text: WALLETS_TEXT,
    extra: extraFromRows([
      row("📋 Wallet List", ADMIN_CALLBACK.WALLET_LIST),
      backHomeRow(),
    ]),
  };
}

function buildRewardsView() {
  return {
    text: REWARDS_TEXT,
    extra: extraFromRows([
      row("➕ Create Reward", ADMIN_CALLBACK.PHASE2_CREATE),
      row("📋 Pending Gifts", ADMIN_CALLBACK.PHASE2_PENDING),
      row("🏆 Builder Board", ADMIN_CALLBACK.BUILDER_BOARD),
      backHomeRow(),
    ]),
  };
}

function buildStatusView() {
  return {
    text: STATUS_TEXT,
    extra: extraFromRows([
      row("🥭 Presale Status", ADMIN_CALLBACK.PRESALE),
      row("⚔️ Scheduler / Chat Fight", ADMIN_CALLBACK.FIGHT),
      backHomeRow(),
    ]),
  };
}

function buildCommandsView() {
  return {
    text: COMMANDS_TEXT,
    extra: extraFromRows([backHomeRow()]),
  };
}

function collectAdminCallbackData(extra) {
  const rows =
    extra && extra.reply_markup && extra.reply_markup.inline_keyboard;
  if (!Array.isArray(rows)) {
    return [];
  }
  const out = [];
  for (const rowButtons of rows) {
    if (!Array.isArray(rowButtons)) {
      continue;
    }
    for (const button of rowButtons) {
      if (button && typeof button.callback_data === "string") {
        out.push(button.callback_data);
      }
    }
  }
  return out;
}

module.exports = {
  ADMIN_CALLBACK,
  REJECT_TEXT,
  GROUP_REJECT,
  HOME_TEXT,
  PHASE2_TEXT,
  DELIVERY_TEXT,
  COMMUNITY_TEXT,
  WALLETS_TEXT,
  REWARDS_TEXT,
  STATUS_TEXT,
  COMMANDS_TEXT,
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
  collectAdminCallbackData,
};
