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
} = require("../utils/botMenu");

function handleStreak(ctx, options = {}) {
  const data = loadPoints(options.pointsFile);
  const top = getCurrentStreakTop(data.users);
  let text;
  if (top.length === 0) {
    text = `🔥 ManGo Active Streaks

No active streaks yet.

Keep the streak alive by being active in the community every day. 🥭`;
  } else {
    const lines = formatCurrentStreakLines(top);
    text = `🔥 ManGo Active Streaks

${lines.join("\n")}

Keep the streak alive by being active in the community every day. 🥭`;
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getPrivateMenuKeyboard());
  }
  return ctx.reply(text);
}

function handleStreakRecord(ctx, options = {}) {
  const data = loadPoints(options.pointsFile);
  const top = getLongestStreakTop(data.users);
  let text;
  if (top.length === 0) {
    text = `🏆 Longest ManGo Streaks

No streak records yet.`;
  } else {
    const lines = formatLongestStreakLines(top);
    text = `🏆 Longest ManGo Streaks

${lines.join("\n")}`;
  }

  if (isPrivateChat(ctx)) {
    return ctx.reply(text, getPrivateMenuKeyboard());
  }
  return ctx.reply(text);
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
