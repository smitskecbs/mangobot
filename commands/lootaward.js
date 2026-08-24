/**
 * Admin-only /lootaward — reply to a member to grant 1–1000 ManGo Loot.
 * Target comes only from reply-to. Not listed in public /help.
 */

const { isAdmin } = require("../services/points");
const { getReplyTargetUser, parseCommandArg } = require("../utils/telegramReplyTarget");
const { isPrivateChat } = require("../utils/botMenu");
const { awardLoot } = require("../services/mangoLoot");

const ADMIN_ONLY = "This command is admin only.";
const USAGE = "Reply to a member's message with /lootaward <amount> <reason>.";
const AMOUNT_TEXT = "Award 1 to 1000 ManGo Loot as a whole number.";
const REASON_TEXT = "Add a short reason (3–120 characters).";

function parseLootAwardArg(rawArg) {
  const text = typeof rawArg === "string" ? rawArg.trim() : "";
  const match = text.match(/^(\d+)\s+(.+)$/);
  if (!match) {
    return { ok: false, reason: "usage" };
  }
  const amount = Number(match[1]);
  const reason = match[2].trim();
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000) {
    return { ok: false, reason: "amount" };
  }
  if (reason.length < 3 || reason.length > 120) {
    return { ok: false, reason: "reason" };
  }
  return { ok: true, amount, note: reason };
}

function handleLootAward(ctx, options = {}) {
  if (!ctx || !ctx.from) {
    return undefined;
  }
  if (!isAdmin(ctx.from.id)) {
    if (isPrivateChat(ctx)) {
      return ctx.reply(ADMIN_ONLY);
    }
    return undefined;
  }

  const target = getReplyTargetUser(ctx);
  if (!target) {
    return ctx.reply(USAGE);
  }

  const parsed = parseLootAwardArg(parseCommandArg(ctx));
  if (!parsed.ok) {
    if (parsed.reason === "amount") {
      return ctx.reply(AMOUNT_TEXT);
    }
    if (parsed.reason === "reason") {
      return ctx.reply(REASON_TEXT);
    }
    return ctx.reply(USAGE);
  }

  const result = awardLoot(
    target.id,
    parsed.amount,
    "admin-award",
    `admin-award:${ctx.from.id}:${ctx.message && ctx.message.message_id}:${target.id}`,
    { shopFile: options.shopFile, now: options.now }
  );

  if (!result.ok) {
    return ctx.reply(USAGE);
  }

  return ctx.reply(
    [
      "🥭 ManGo Loot Award",
      "",
      `${target.firstName} received +${parsed.amount} 🥭`,
      "",
      "Reason:",
      parsed.note,
    ].join("\n")
  );
}

module.exports = (bot) => {
  bot.command("lootaward", (ctx) => handleLootAward(ctx));
};

module.exports.handleLootAward = handleLootAward;
module.exports.parseLootAwardArg = parseLootAwardArg;
