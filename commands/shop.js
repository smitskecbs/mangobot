/**
 * 🏪 ManGo Shop — private, menu-driven titles.
 * Callbacks: shop:home|titles|title:<id>|buy:<id>|mine|use:<id>|clear
 * Never embeds uid. Mutations use ctx.from.id.
 */

const { Markup } = require("telegraf");
const {
  isPrivateChat,
  isGroupChat,
  resolveBotUsername,
  buildPrivateDeepLink,
  getPrivateMenuKeyboard,
} = require("../utils/botMenu");
const { logError } = require("../utils/logger");
const {
  getTitleCatalog,
  getTitleById,
  formatTitleLabel,
} = require("../services/mangoTitles");
const {
  titleProgress,
  missingNeeds,
  mark,
  purchaseTitle,
  setActiveTitle,
  clearActiveTitle,
  getShopHomeModel,
  getOwnedTitleIds,
  getActiveTitle,
  formatShopProgressBlock,
} = require("../services/mangoShop");

const GROUP_SHOP_TEXT =
  "Open a private chat with the bot to use the ManGo Shop.";

const SHOP_CALLBACK = Object.freeze({
  HOME: "shop:home",
  TITLES: "shop:titles",
  MINE: "shop:mine",
  CLEAR: "shop:clear",
});

function parseShopCallback(data) {
  if (typeof data !== "string" || !data.startsWith("shop:")) {
    return null;
  }
  if (data === SHOP_CALLBACK.HOME) {
    return { action: "home" };
  }
  if (data === SHOP_CALLBACK.TITLES) {
    return { action: "titles" };
  }
  if (data === SHOP_CALLBACK.MINE) {
    return { action: "mine" };
  }
  if (data === SHOP_CALLBACK.CLEAR) {
    return { action: "clear" };
  }
  const parts = data.split(":");
  if (parts.length !== 3) {
    return null;
  }
  const action = parts[1];
  const titleId = parts[2];
  if (!titleId || !/^[a-z][a-z0-9-]{0,20}$/.test(titleId)) {
    return null;
  }
  if (action === "title" || action === "buy" || action === "use") {
    return { action, titleId };
  }
  return null;
}

function shopOptions(options = {}) {
  return {
    shopFile: options.shopFile,
    pointsFile: options.pointsFile,
    builderFile: options.builderFile,
    now: options.now,
  };
}

function btn(label, data) {
  return Markup.button.callback(label, data);
}

function keyboard(rows) {
  return Markup.inlineKeyboard(rows);
}

function groupShopExtra(ctx) {
  const username = resolveBotUsername(ctx);
  const url = buildPrivateDeepLink(username, "shop");
  if (!url) {
    return undefined;
  }
  return Markup.inlineKeyboard([[Markup.button.url("🏪 Open ManGo Shop", url)]]);
}

function homeKeyboard() {
  return keyboard([
    [btn("🏷️ Titles", SHOP_CALLBACK.TITLES), btn("📦 My Titles", SHOP_CALLBACK.MINE)],
    [btn("⬅️ Back", "phub:back")],
  ]);
}

function titlesKeyboard() {
  const rows = getTitleCatalog()
    .filter((title) => title.active)
    .map((title) => [btn(formatTitleLabel(title), `shop:title:${title.id}`)]);
  rows.push([btn("⬅️ Back", SHOP_CALLBACK.HOME)]);
  return keyboard(rows);
}

function titleDetailKeyboard(progress) {
  const rows = [];
  if (progress.available) {
    rows.push([btn("🛒 Buy Title", `shop:buy:${progress.title.id}`)]);
  }
  if (progress.owned && !progress.active) {
    rows.push([btn("🏷️ Use Title", `shop:use:${progress.title.id}`)]);
  }
  rows.push([btn("⬅️ Titles", SHOP_CALLBACK.TITLES)]);
  return keyboard(rows);
}

function purchaseKeyboard(title) {
  return keyboard([
    [btn("🏷️ Use Title", `shop:use:${title.id}`)],
    [btn("📦 My Titles", SHOP_CALLBACK.MINE), btn("⬅️ Shop", SHOP_CALLBACK.HOME)],
  ]);
}

function myTitlesKeyboard(ownedIds, hasActive) {
  const rows = ownedIds.map((titleId) => {
    const title = getTitleById(titleId);
    return title ? [btn(formatTitleLabel(title), `shop:title:${title.id}`)] : [];
  }).filter((row) => row.length);
  if (hasActive) {
    rows.push([btn("❌ Remove Active Title", SHOP_CALLBACK.CLEAR)]);
  }
  rows.push([btn("⬅️ Back", SHOP_CALLBACK.HOME)]);
  return keyboard(rows);
}

function buildHomeText(userId, options) {
  const model = getShopHomeModel(userId, options);
  const lines = [
    "🏪 ManGo Shop",
    "",
    "Your balance:",
    `🥭 ManGo Loot: ${model.loot.balance}`,
    "",
    "Progress:",
    `⭐ XP: ${model.xp}`,
    `🤝 BP: ${model.bp}`,
    "",
    "Choose a category:",
  ];
  if (model.next && !model.next.owned) {
    const title = model.next.title;
    lines.push(
      "",
      "🏷️ Next Title Progress",
      "",
      formatTitleLabel(title),
      `XP: ${model.next.xp} / ${title.requiredXp}`,
      `BP: ${model.next.bp} / ${title.requiredBp}`,
      `Loot: ${model.next.loot} / ${title.lootPrice}`
    );
  }
  return lines.join("\n");
}

function buildTitlesText() {
  return ["🏷️ Titles", "", "Choose a community title to view."].join("\n");
}

function buildTitleDetailText(progress) {
  const title = progress.title;
  const lines = [
    formatTitleLabel(title),
    "",
    title.description,
    "",
    "Requirements:",
    "",
    `${mark(progress.xpOk)} XP: ${progress.xp} / ${progress.requiredXp}`,
    `${mark(progress.bpOk)} BP: ${progress.bp} / ${progress.requiredBp}`,
    `${mark(progress.lootOk)} Loot: ${progress.loot} / ${progress.price}`,
    "",
  ];
  if (progress.owned) {
    lines.push("Status:", progress.active ? "🟢 Active" : "Owned: ✅");
    lines.push(`Active: ${progress.active ? "✅" : "❌"}`);
  } else if (progress.available) {
    lines.push("Price:", `${progress.price} 🥭 ManGo Loot`, "", "Status:", "🟢 Available");
  } else {
    lines.push("Status:", "🔒 Not unlocked", "", "Need:");
    const need = missingNeeds(progress);
    if (!need.length) {
      lines.push("This title is not available.");
    } else {
      for (const row of need) {
        lines.push(row);
      }
    }
  }
  return lines.join("\n");
}

function buildMyTitlesText(userId, options) {
  const owned = getOwnedTitleIds(userId, options.shopFile);
  if (!owned.length) {
    return [
      "📦 My Titles",
      "",
      "You haven't unlocked any titles yet.",
      "",
      "Visit the Shop and keep building your ManGo reputation. 🥭",
    ].join("\n");
  }
  const active = getActiveTitle(userId, options.shopFile);
  return [
    "📦 My Titles",
    "",
    "Active:",
    active ? formatTitleLabel(active) : "None",
    "",
    "Owned:",
  ].join("\n");
}

function lockedBuyText(result) {
  const progress = result.progress || {};
  const need = missingNeeds({
    xpOk: progress.xpOk,
    bpOk: progress.bpOk,
    lootOk: progress.lootOk,
    xp: progress.xp || 0,
    bp: progress.bp || 0,
    loot: progress.loot || 0,
    requiredXp: progress.requiredXp || 0,
    requiredBp: progress.requiredBp || 0,
    price: progress.price || 0,
  });
  const lines = ["🔒 Title not unlocked yet.", "", "Need:"];
  if (!need.length) {
    lines.push("This title cannot be purchased.");
  } else {
    for (const row of need) {
      lines.push(`• ${row}`);
    }
  }
  return lines.join("\n");
}

function purchaseSuccessText(result) {
  return [
    "🎉 Title unlocked!",
    "",
    formatTitleLabel(result.title),
    "",
    `${result.lootSpent} 🥭 ManGo Loot spent.`,
    "",
    "Remaining:",
    `${result.balance} 🥭 ManGo Loot`,
  ].join("\n");
}

async function showShopView(ctx, text, extra) {
  if (ctx && ctx.callbackQuery && typeof ctx.editMessageText === "function") {
    try {
      await ctx.editMessageText(text, extra || undefined);
      return;
    } catch (err) {
      logError("[shop] edit failed:", err && err.message ? err.message : err);
    }
  }
  if (ctx && typeof ctx.reply === "function") {
    await ctx.reply(text, extra || undefined);
  }
}

async function answerCb(ctx, text) {
  if (ctx && typeof ctx.answerCbQuery === "function") {
    await ctx.answerCbQuery(text || "").catch(() => {});
  }
}

function handleShop(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (isGroupChat(ctx) || !isPrivateChat(ctx)) {
    return ctx.reply(GROUP_SHOP_TEXT, groupShopExtra(ctx));
  }
  const text = buildHomeText(ctx.from.id, shopOptions(options));
  return ctx.reply(text, homeKeyboard());
}

async function handleShopCallback(ctx, options = {}) {
  if (!ctx || !ctx.from || !ctx.callbackQuery) {
    return;
  }
  const parsed = parseShopCallback(ctx.callbackQuery.data);
  if (!parsed) {
    await answerCb(ctx, "This action is no longer available.");
    return;
  }
  if (!isPrivateChat(ctx)) {
    await answerCb(ctx);
    return ctx.reply(GROUP_SHOP_TEXT, groupShopExtra(ctx));
  }

  const opts = shopOptions(options);
  const userId = ctx.from.id;

  try {
    if (parsed.action === "home") {
      await answerCb(ctx);
      return showShopView(ctx, buildHomeText(userId, opts), homeKeyboard());
    }
    if (parsed.action === "titles") {
      await answerCb(ctx);
      return showShopView(ctx, buildTitlesText(), titlesKeyboard());
    }
    if (parsed.action === "mine") {
      await answerCb(ctx);
      const owned = getOwnedTitleIds(userId, opts.shopFile);
      const active = getActiveTitle(userId, opts.shopFile);
      return showShopView(
        ctx,
        buildMyTitlesText(userId, opts),
        myTitlesKeyboard(owned, Boolean(active))
      );
    }
    if (parsed.action === "clear") {
      clearActiveTitle(userId, opts);
      await answerCb(ctx, "Active title removed.");
      const owned = getOwnedTitleIds(userId, opts.shopFile);
      return showShopView(
        ctx,
        buildMyTitlesText(userId, opts),
        myTitlesKeyboard(owned, false)
      );
    }
    if (parsed.action === "title") {
      const title = getTitleById(parsed.titleId);
      if (!title) {
        await answerCb(ctx, "This action is no longer available.");
        return;
      }
      await answerCb(ctx);
      const progress = titleProgress(userId, title, opts);
      return showShopView(ctx, buildTitleDetailText(progress), titleDetailKeyboard(progress));
    }
    if (parsed.action === "buy") {
      const result = purchaseTitle(userId, parsed.titleId, opts);
      if (!result.ok && result.reason === "locked") {
        await answerCb(ctx, "Title not unlocked yet.");
        return showShopView(
          ctx,
          lockedBuyText(result),
          keyboard([[btn("⬅️ Titles", SHOP_CALLBACK.TITLES)]])
        );
      }
      if (!result.ok) {
        await answerCb(ctx, "Could not buy this title.");
        return;
      }
      if (result.duplicate) {
        await answerCb(ctx, "You already own this title.");
        const title = result.title || getTitleById(parsed.titleId);
        const progress = titleProgress(userId, title, opts);
        return showShopView(ctx, buildTitleDetailText(progress), titleDetailKeyboard(progress));
      }
      await answerCb(ctx, "Title unlocked!");
      return showShopView(ctx, purchaseSuccessText(result), purchaseKeyboard(result.title));
    }
    if (parsed.action === "use") {
      const result = setActiveTitle(userId, parsed.titleId, opts);
      if (!result.ok) {
        await answerCb(ctx, "You do not own this title.");
        return;
      }
      await answerCb(ctx, "Title activated.");
      const progress = titleProgress(userId, result.title, opts);
      return showShopView(ctx, buildTitleDetailText(progress), titleDetailKeyboard(progress));
    }
  } catch (err) {
    logError("[shop] callback failed:", err && err.message ? err.message : err);
    await answerCb(ctx, "Shop is temporarily unavailable.");
  }
}

module.exports = (bot) => {
  bot.action(/^shop:/, (ctx) => handleShopCallback(ctx));
};

module.exports.handleShop = handleShop;
module.exports.handleShopCallback = handleShopCallback;
module.exports.parseShopCallback = parseShopCallback;
module.exports.GROUP_SHOP_TEXT = GROUP_SHOP_TEXT;
module.exports.SHOP_CALLBACK = SHOP_CALLBACK;
module.exports.formatShopProgressBlock = formatShopProgressBlock;
module.exports.buildHomeText = buildHomeText;
module.exports.buildTitleDetailText = buildTitleDetailText;
module.exports.buildMyTitlesText = buildMyTitlesText;
module.exports.titlesKeyboard = titlesKeyboard;
module.exports.titleDetailKeyboard = titleDetailKeyboard;
module.exports.purchaseSuccessText = purchaseSuccessText;
module.exports.lockedBuyText = lockedBuyText;
module.exports.homeKeyboard = homeKeyboard;
