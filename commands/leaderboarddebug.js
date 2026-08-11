/**
 * /leaderboarddebug — admin-only privacy linkage status (no raw user ids).
 */

const { isAdmin, loadPoints } = require("../services/points");
const { isPrivateChat } = require("../utils/botMenu");
const {
  shouldHideFromLeaderboards,
  shouldHideScoreLeaderboardEntry,
} = require("../utils/admin");
const {
  getScoresFilePath: getSnakePath,
  readScoresFile: readSnake,
} = require("../services/snakeScores");
const bounchScores = require("../services/bounchScores");

function linkedYesNo(value) {
  return value ? "yes" : "no";
}

function handleLeaderboardDebug(ctx, options = {}) {
  const isAdminFn =
    typeof options.isAdminFn === "function" ? options.isAdminFn : isAdmin;

  if (!ctx || !ctx.from) {
    return;
  }

  if (!isAdminFn(ctx.from.id)) {
    return ctx.reply("This command is admin only.");
  }

  const adminConfigured = Boolean(
    process.env.ADMIN_USER_ID && String(process.env.ADMIN_USER_ID).trim()
  );

  const pointsFile = options.pointsFile;
  const data = loadPoints(pointsFile);
  let lifetimeOwnerLinked = false;
  if (adminConfigured) {
    for (const userId of Object.keys(data.users || {})) {
      if (shouldHideFromLeaderboards(userId)) {
        lifetimeOwnerLinked = true;
        break;
      }
    }
  }

  let snakeOwnerLinked = false;
  let bounchOwnerLinked = false;
  try {
    const snakeFile = options.snakeFile || getSnakePath();
    const snake = readSnake(snakeFile);
    snakeOwnerLinked = (snake.leaderboard || []).some((entry) =>
      shouldHideScoreLeaderboardEntry(entry)
    );
  } catch (_err) {
    snakeOwnerLinked = false;
  }
  try {
    const bounchFile = options.bounchFile || bounchScores.getScoresFilePath();
    const bounch = bounchScores.readScoresFile(bounchFile);
    bounchOwnerLinked = (bounch.leaderboard || []).some((entry) =>
      shouldHideScoreLeaderboardEntry(entry)
    );
  } catch (_err) {
    bounchOwnerLinked = false;
  }

  const text = `🥭 Leaderboard privacy debug

Owner configured: ${linkedYesNo(adminConfigured)}
Lifetime owner linked: ${linkedYesNo(lifetimeOwnerLinked)}
Snake owner linked: ${linkedYesNo(snakeOwnerLinked)}
Bounch owner linked: ${linkedYesNo(bounchOwnerLinked)}

Tip: play Snake/Bounch once via your private verified link to attach your uid to legacy score rows.`;

  return ctx.reply(text);
}

module.exports = (bot) => {
  bot.command("leaderboarddebug", (ctx) => {
    if (!isPrivateChat(ctx) && !isAdmin(ctx.from && ctx.from.id)) {
      // Still allow in group for admins; prefer private use.
    }
    return handleLeaderboardDebug(ctx);
  });
};

module.exports.handleLeaderboardDebug = handleLeaderboardDebug;
