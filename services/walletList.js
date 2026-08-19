/**
 * Admin wallet overview. Short wallets only. No uids in public callback data.
 * Pagination walks the full sorted member list (not a Not-linked-only filter).
 */

const { loadPoints } = require("./points");
const {
  resolveWalletFile,
  readWalletSnapshot,
  getLinkedWalletFromStore,
} = require("./walletLinks");
const { shortenWallet } = require("../utils/solanaWallet");

const WALLET_LIST_PAGE_SIZE = 25;
const WALLET_LIST_CALLBACK_PREFIX = "wlst:";
const STATUS_ORDER = Object.freeze({ none: 0, registered: 1, verified: 2 });
const STATUS_ICON = Object.freeze({
  none: "⬜",
  registered: "🟡",
  verified: "🟢",
});

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

function collectWalletIds(points, walletStore) {
  const ids = new Set();
  for (const userId of Object.keys((points && points.users) || {})) {
    ids.add(String(userId));
  }
  for (const userId of Object.keys((walletStore && walletStore.users) || {})) {
    ids.add(String(userId));
  }
  for (const ownerId of Object.values((walletStore && walletStore.wallets) || {})) {
    if (ownerId != null && String(ownerId).trim()) {
      ids.add(String(ownerId));
    }
  }
  return ids;
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

function buildWalletListPage(options = {}) {
  const pageSize = options.pageSize || WALLET_LIST_PAGE_SIZE;
  const rows = collectWalletListRows(options);
  const summary = summarizeWalletList(rows);
  const page = clampPage(options.page ?? 0, rows.length, pageSize);
  const start = page * pageSize;
  const slice = rows.slice(start, start + pageSize);
  const lines = ["<b>🥭 ManGo Wallet Overview</b>", ""];
  if (!slice.length) {
    lines.push("No known members yet.");
  } else {
    for (const row of slice) {
      lines.push(formatWalletListLine(row));
    }
  }
  lines.push(
    "",
    "Summary:",
    `🟢 Verified: ${summary.verified}`,
    `🟡 Registered: ${summary.registered}`,
    `⬜ Not linked: ${summary.none}`,
    `Total known members: ${summary.total}`
  );
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
    total: rows.length,
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
  collectWalletListRows,
  summarizeWalletList,
  buildWalletListPage,
  parseWalletListCallback,
  walletListCallbackData,
  walletListNavButtons,
  clampPage,
  pageCount,
  escapeHtml,
  toPageIndex,
};
