/**
 * /streak — public current-streak board.
 * /streakrecord | /streaklongest — public longest-streak board.
 * Private /start streak — personal streak (no public dump).
 */

const { loadPoints, formatPersonalStreakMessage, getUserRecord } = require("../services/points");
const {
  getCurrentStreakTop,
  getLongestStreakTop,
  formatCurrentStreakLines,
  formatLongestStreakLines,
} = require("../services/leaderboard");
const {
  isPrivateChat,
  getPrivateMenuKeyboard,
  getRankingsResultExtra,
} = require("../utils/botMenu");

function handleStreak(ctx, options = {}) {
  const data = loadPoints(options.pointsFile);
  const top = getCurrentStreakTop(data.users);
  let text;
  if (top.length === 0) {
    text = `🔥 Activity Streaks

No active streaks yet.

Keep your Activity Streak going by being active in the community every day. 🥭`;
  } else {
    const lines = formatCurrentStreakLines(top);
    text = `🔥 Activity Streaks

${lines.join("\n")}

Keep your Activity Streak going by being active in the community every day. 🥭`;
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getRankingsResultExtra(ctx));
  }
  return ctx.reply(text, getRankingsResultExtra(ctx));
}

function handleStreakRecord(ctx, options = {}) {
  const data = loadPoints(options.pointsFile);
  const top = getLongestStreakTop(data.users);
  let text;
  if (top.length === 0) {
    text = `🏆 Longest Activity Streaks

No streak records yet.`;
  } else {
    const lines = formatLongestStreakLines(top);
    text = `🏆 Longest Activity Streaks

${lines.join("\n")}`;
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getRankingsResultExtra(ctx));
  }
  return ctx.reply(text, getRankingsResultExtra(ctx));
}

function handleMyStreak(ctx, options = {}) {
  if (!isPrivateChat(ctx)) {
    return ctx.reply("Open ManGo Bot privately to see your streak.");
  }
  const data = loadPoints(options.pointsFile);
  const user = getUserRecord(data, ctx.from.id);
  return ctx.reply(formatPersonalStreakMessage(user), getPrivateMenuKeyboard());
}

module.exports = (bot) => {
  bot.command("streak", handleStreak);
  bot.command(["streakrecord", "streaklongest"], handleStreakRecord);
};

module.exports.handleStreak = handleStreak;
module.exports.handleStreakRecord = handleStreakRecord;
module.exports.handleMyStreak = handleMyStreak;
