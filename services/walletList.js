/**
 * Admin wallet overview. Short wallets only. No uids in public callback data.
 * Current-member stats come from Telegram getChatMember, not store size.
 * Wallet-link records are read-only here and are never deleted.
 */

const { loadPoints } = require("./points");
const {
  resolveWalletFile,
  readWalletSnapshot,
  getLinkedWalletFromStore,
} = require("./walletLinks");
const { shortenWallet } = require("../utils/solanaWallet");
const { getConfiguredCommunityChatId } = require("./chatFight");

const WALLET_LIST_PAGE_SIZE = 25;
const WALLET_LIST_CALLBACK_PREFIX = "wlst:";
const STATUS_ORDER = Object.freeze({ none: 0, registered: 1, verified: 2 });
const STATUS_ICON = Object.freeze({
  none: "⬜",
  registered: "🟡",
  verified: "🟢",
});
const CURRENT_GROUP_STATUSES = Object.freeze([
  "member",
  "administrator",
  "creator",
  "restricted",
]);
const CURRENT_GROUP_STATUS_SET = new Set(CURRENT_GROUP_STATUSES);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayNameFor(userId, pointsUser) {
  const fromPoints =
    pointsUser && typeof pointsUser.name === "string" ? pointsUser.name.trim() : "";
  if (fromPoints) {
    return fromPoints;
  }
  return "Member";
}

function statusFromLinked(linked) {
  if (!linked || !linked.wallet) {
    return "none";
  }
  if (linked.verified) {
    return "verified";
  }
  return "registered";
}

function asTelegramUserId(raw) {
  if (raw === undefined || raw === null) {
    return "";
  }
  const uid = String(raw).trim();
  return /^\d{1,20}$/.test(uid) ? uid : "";
}

function addTelegramUserId(ids, raw) {
  const uid = asTelegramUserId(raw);
  if (uid) {
    ids.add(uid);
  }
}

function collectWalletIds(points, walletStore) {
  const ids = new Set();
  for (const userId of Object.keys((points && points.users) || {})) {
    addTelegramUserId(ids, userId);
  }
  for (const userId of Object.keys((walletStore && walletStore.users) || {})) {
    addTelegramUserId(ids, userId);
  }
  for (const ownerId of Object.values((walletStore && walletStore.wallets) || {})) {
    addTelegramUserId(ids, ownerId);
  }
  return ids;
}

function resolveWalletListChatId(options = {}) {
  const override = options.chatId;
  if (override != null && String(override).trim() !== "") {
    return String(override).trim();
  }
  return getConfiguredCommunityChatId();
}

function isCurrentGroupStatus(status) {
  return CURRENT_GROUP_STATUS_SET.has(status);
}

function membershipFromChatMember(member) {
  if (!member || typeof member !== "object") {
    return { status: "unknown", isBot: false, current: false };
  }
  const status = typeof member.status === "string" ? member.status : "unknown";
  const isBot = Boolean(member.user && member.user.is_bot);
  return {
    status,
    isBot,
    current: isCurrentGroupStatus(status) && !isBot,
  };
}

async function lookupMemberships(userIds, options = {}) {
  const byUserId = new Map();
  if (options.membershipByUserId instanceof Map) {
    return {
      chatConfigured: true,
      lookedUp: options.membershipByUserId.size,
      byUserId: options.membershipByUserId,
    };
  }
  const chatId = resolveWalletListChatId(options);
  const getChatMember =
    typeof options.getChatMember === "function" ? options.getChatMember : null;
  if (!chatId || !getChatMember) {
    return { chatConfigured: Boolean(chatId), lookedUp: 0, byUserId };
  }
  let lookedUp = 0;
  for (const rawId of userIds) {
    const userId = asTelegramUserId(rawId);
    if (!userId) {
      continue;
    }
    lookedUp += 1;
    try {
      const member = await getChatMember(chatId, userId);
      byUserId.set(userId, membershipFromChatMember(member));
    } catch (_err) {
      byUserId.set(userId, { status: "unknown", isBot: false, current: false });
    }
  }
  return { chatConfigured: true, lookedUp, byUserId };
}

function partitionWalletRows(rows, membershipByUserId) {
  const current = [];
  const historicalWallets = [];
  for (const row of rows) {
    const uid = asTelegramUserId(row.userId);
    const membership = membershipByUserId.get(uid) || {
      status: "unknown",
      isBot: false,
      current: false,
    };
    if (membership.current) {
      current.push(row);
      continue;
    }
    if (row.status !== "none" && !membership.isBot) {
      historicalWallets.push(row);
    }
  }
  return { current, historicalWallets };
}

function summarizeCurrentMembers(currentRows) {
  let withWallet = 0;
  let withoutWallet = 0;
  for (const row of currentRows) {
    if (row.status === "none") {
      withoutWallet += 1;
    } else {
      withWallet += 1;
    }
  }
  return {
    currentMembers: currentRows.length,
    withWallet,
    withoutWallet,
  };
}

function collectWalletListRows(options = {}) {
  const points = loadPoints(options.pointsFile);
  const walletStore = readWalletSnapshot(resolveWalletFile(options.walletFile));
  const ids = collectWalletIds(points, walletStore);
  const rows = [];
  for (const userId of ids) {
    const linked = getLinkedWalletFromStore(walletStore, userId);
    const status = statusFromLinked(linked);
    const name = displayNameFor(userId, points.users && points.users[userId]);
    rows.push({
      userId,
      name,
      status,
      walletShort: linked && linked.wallet ? shortenWallet(linked.wallet) : "",
    });
  }
  rows.sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) {
      return statusDiff;
    }
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });
  return rows;
}

function summarizeWalletList(rows) {
  const summary = { verified: 0, registered: 0, none: 0, total: rows.length };
  for (const row of rows) {
    if (row.status === "verified") {
      summary.verified += 1;
    } else if (row.status === "registered") {
      summary.registered += 1;
    } else {
      summary.none += 1;
    }
  }
  return summary;
}

function pageCount(total, pageSize = WALLET_LIST_PAGE_SIZE) {
  if (total <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(total / pageSize));
}

function toPageIndex(page) {
  if (typeof page === "number" && Number.isFinite(page)) {
    return Math.trunc(page);
  }
  if (typeof page === "string" && /^-?\d+$/.test(page.trim())) {
    return Number.parseInt(page, 10);
  }
  return 0;
}

function clampPage(page, total, pageSize = WALLET_LIST_PAGE_SIZE) {
  const last = pageCount(total, pageSize) - 1;
  const n = toPageIndex(page);
  if (n < 0) {
    return 0;
  }
  if (n > last) {
    return last;
  }
  return n;
}

function formatWalletListLine(row) {
  const icon = STATUS_ICON[row.status] || STATUS_ICON.none;
  const name = escapeHtml(row.name);
  if (row.status === "none") {
    return `${icon} ${name} — Not linked`;
  }
  return `${icon} ${name} — ${escapeHtml(row.walletShort)}`;
}

async function buildWalletListPage(options = {}) {
  const pageSize = options.pageSize || WALLET_LIST_PAGE_SIZE;
  const allRows = collectWalletListRows(options);
  const membership = await lookupMemberships(
    allRows.map((row) => row.userId),
    options
  );
  const partitioned = partitionWalletRows(allRows, membership.byUserId);
  const rows = partitioned.current;
  const summary = summarizeCurrentMembers(rows);
  const page = clampPage(options.page ?? 0, rows.length, pageSize);
  const start = page * pageSize;
  const slice = rows.slice(start, start + pageSize);
  const lines = ["<b>🥭 ManGo Wallet Overview</b>", ""];
  if (!membership.chatConfigured) {
    lines.push("Telegram group is not configured. Current members cannot be confirmed.");
    lines.push("");
  }
  if (!slice.length) {
    lines.push("No current group members among known wallet/activity records.");
  } else {
    for (const row of slice) {
      lines.push(formatWalletListLine(row));
    }
  }
  lines.push(
    "",
    `👥 Current members checked: ${summary.currentMembers}`,
    `🔗 Current members with wallet: ${summary.withWallet}`,
    `⬜ Current members without wallet: ${summary.withoutWallet}`
  );
  if (partitioned.historicalWallets.length > 0) {
    lines.push(
      `📦 Historical wallets (not in group): ${partitioned.historicalWallets.length}`
    );
  }
  const last = pageCount(rows.length, pageSize) - 1;
  if (last > 0) {
    lines.push("", `Page ${page + 1}/${last + 1}`);
  }
  return {
    text: lines.join("\n"),
    page,
    lastPage: last,
    summary,
    rows: slice,
    allRows: rows,
    knownRecords: allRows.length,
    historicalWallets: partitioned.historicalWallets.length,
    total: rows.length,
    chatConfigured: membership.chatConfigured,
  };
}

function parseWalletListCallback(data) {
  if (typeof data !== "string" || !data.startsWith(WALLET_LIST_CALLBACK_PREFIX)) {
    return null;
  }
  const raw = data.slice(WALLET_LIST_CALLBACK_PREFIX.length);
  if (!/^\d{1,4}$/.test(raw)) {
    return null;
  }
  return { page: Number.parseInt(raw, 10) };
}

function walletListCallbackData(page) {
  return `${WALLET_LIST_CALLBACK_PREFIX}${toPageIndex(page)}`;
}

function walletListNavButtons(page, lastPage) {
  if (lastPage <= 0) {
    return [];
  }
  const row = [];
  if (page > 0) {
    row.push({ text: "⬅️ Previous", callback_data: walletListCallbackData(page - 1) });
  }
  if (page < lastPage) {
    row.push({ text: "Next ➡️", callback_data: walletListCallbackData(page + 1) });
  }
  return row;
}

module.exports = {
  WALLET_LIST_PAGE_SIZE,
  WALLET_LIST_CALLBACK_PREFIX,
  CURRENT_GROUP_STATUSES,
  collectWalletListRows,
  summarizeWalletList,
  summarizeCurrentMembers,
  lookupMemberships,
  partitionWalletRows,
  resolveWalletListChatId,
  buildWalletListPage,
  parseWalletListCallback,
  walletListCallbackData,
  walletListNavButtons,
  clampPage,
  pageCount,
  escapeHtml,
  toPageIndex,
  asTelegramUserId,
};
