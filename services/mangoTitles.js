/**
 * Community title catalog + reserved staff-title validation.
 * Cosmetic only: no Telegram permissions.
 */

const TITLE_KIND = "title";

const RESERVED_TITLE_TOKENS = Object.freeze([
  "admin",
  "administrator",
  "owner",
  "team",
  "staff",
  "mod",
  "moderator",
  "dev",
  "developer",
  "official",
  "support-team",
  "security",
  "support",
]);

const TITLE_CATALOG = Object.freeze([
  {
    id: "supporter",
    name: "ManGo Supporter",
    emoji: "🥭",
    description: "A community member who supports ManGo.",
    requiredXp: 50,
    requiredBp: 5,
    lootPrice: 25,
    purchasable: true,
    active: true,
    availableFrom: null,
    availableUntil: null,
    limited: false,
    kind: TITLE_KIND,
  },
  {
    id: "contributor",
    name: "ManGo Contributor",
    emoji: "🤝",
    description: "An active member who helps the ManGo community grow.",
    requiredXp: 100,
    requiredBp: 15,
    lootPrice: 50,
    purchasable: true,
    active: true,
    availableFrom: null,
    availableUntil: null,
    limited: false,
    kind: TITLE_KIND,
  },
  {
    id: "ambassador",
    name: "ManGo Ambassador",
    emoji: "🌟",
    description:
      "A respected community member who actively supports and helps ManGo grow.",
    requiredXp: 250,
    requiredBp: 30,
    lootPrice: 100,
    purchasable: true,
    active: true,
    availableFrom: null,
    availableUntil: null,
    limited: false,
    kind: TITLE_KIND,
  },
  {
    id: "advocate",
    name: "ManGo Advocate",
    emoji: "🏅",
    description: "A dedicated community champion who represents ManGo values.",
    requiredXp: 500,
    requiredBp: 60,
    lootPrice: 200,
    purchasable: true,
    active: true,
    availableFrom: null,
    availableUntil: null,
    limited: false,
    kind: TITLE_KIND,
  },
]);

function tokenizeTitleText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isReservedTitleToken(token) {
  return RESERVED_TITLE_TOKENS.includes(String(token || "").toLowerCase());
}

function findReservedTitleMatch(title) {
  if (!title || typeof title !== "object") {
    return "invalid";
  }
  const idTokens = String(title.id || "")
    .toLowerCase()
    .split("-")
    .filter(Boolean);
  const nameTokens = tokenizeTitleText(title.name);
  const all = idTokens.concat(nameTokens);
  for (const token of all) {
    if (isReservedTitleToken(token)) {
      return token;
    }
  }
  return null;
}

function assertCatalogSafe(catalog = TITLE_CATALOG) {
  const seen = new Set();
  for (const title of catalog) {
    if (!title || typeof title.id !== "string" || !/^[a-z][a-z0-9-]{0,20}$/.test(title.id)) {
      throw new Error("invalid-title-id");
    }
    if (seen.has(title.id)) {
      throw new Error("duplicate-title-id");
    }
    seen.add(title.id);
    const reserved = findReservedTitleMatch(title);
    if (reserved) {
      throw new Error(`reserved-title:${reserved}`);
    }
  }
  return true;
}

assertCatalogSafe(TITLE_CATALOG);

function getTitleCatalog() {
  return TITLE_CATALOG.map((row) => Object.assign({}, row));
}

function getTitleById(titleId) {
  const id = String(titleId || "");
  const found = TITLE_CATALOG.find((row) => row.id === id);
  return found ? Object.assign({}, found) : null;
}

function formatTitleLabel(title) {
  if (!title) {
    return "None";
  }
  return `${title.emoji} ${title.name}`;
}

function isTitleWindowOpen(title, now = Date.now()) {
  if (!title) {
    return false;
  }
  if (title.active === false) {
    return false;
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  if (title.availableFrom != null && ts < title.availableFrom) {
    return false;
  }
  if (title.availableUntil != null && ts > title.availableUntil) {
    return false;
  }
  return true;
}

function isTitlePurchasable(title, now = Date.now()) {
  return Boolean(title && title.purchasable !== false && isTitleWindowOpen(title, now));
}

module.exports = {
  TITLE_KIND,
  TITLE_CATALOG,
  RESERVED_TITLE_TOKENS,
  getTitleCatalog,
  getTitleById,
  formatTitleLabel,
  isTitleWindowOpen,
  isTitlePurchasable,
  findReservedTitleMatch,
  assertCatalogSafe,
  isReservedTitleToken,
};
