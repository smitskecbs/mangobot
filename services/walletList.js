/**
 * Admin wallet overview. Short wallets only. No uids in public callback data.
 */

const { loadPoints } = require("./points");
const { loadWalletStore, getLinkedWalletForUser } = require("./walletLinks");
const { getXpWalletLinkStatus } = require("./xpWalletGate");
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

function collectWalletListRows(options = {}) {
  const points = loadPoints(options.pointsFile);
  const walletStore = loadWalletStore(options.walletFile);
  const ids = new Set([
    ...Object.keys((points && points.users) || {}),
    ...Object.keys((walletStore && walletStore.users) || {}),
  ]);
  const rows = [];
  for (const userId of ids) {
    const status = getXpWalletLinkStatus(userId, options.walletFile);
    const linked = status === "none" ? null : getLinkedWalletForUser(userId, options.walletFile);
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

function clampPage(page, total, pageSize = WALLET_LIST_PAGE_SIZE) {
  const last = pageCount(total, pageSize) - 1;
  const n = Number.isInteger(page) ? page : 0;
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
  const page = clampPage(options.page || 0, rows.length, pageSize);
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
  return `${WALLET_LIST_CALLBACK_PREFIX}${page}`;
}

module.exports = {
  WALLET_LIST_PAGE_SIZE,
  WALLET_LIST_CALLBACK_PREFIX,
  collectWalletListRows,
  summarizeWalletList,
  buildWalletListPage,
  parseWalletListCallback,
  walletListCallbackData,
  clampPage,
  pageCount,
  escapeHtml,
};
