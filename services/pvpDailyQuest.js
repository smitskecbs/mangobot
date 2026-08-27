/**
 * Daily Quest "Play a Bot Game" for resolved TTT/C4 matches.
 * Independent of XP award / cap / wallet XP eligibility.
 */

const { error: logError } = require("../utils/logger");

function takeResolvedQuestUsers(session, isBotPlayerFn) {
  if (!session || session.questNoted) {
    return [];
  }
  if (session.status !== "won" && session.status !== "draw") {
    return [];
  }
  session.questNoted = true;
  const ids = [];
  const players = session.players || {};
  for (const seat of Object.keys(players)) {
    const player = players[seat];
    if (!player || player.userId == null) {
      continue;
    }
    if (typeof isBotPlayerFn === "function" && isBotPlayerFn(player)) {
      continue;
    }
    ids.push(String(player.userId));
  }
  return ids;
}

function warnQuest(prefix, err) {
  try {
    logError(prefix, err && err.message ? err.message : err);
  } catch (_err) {
    /* never break match resolution */
  }
}

function emitResolvedPvpDailyQuest(userIds, game, options = {}) {
  if (!Array.isArray(userIds) || !userIds.length) {
    return;
  }
  let noteFn = options.noteDailyQuestGameFn;
  if (typeof noteFn !== "function") {
    try {
      noteFn = require("./dailyQuest").noteDailyQuestGame;
    } catch (err) {
      warnQuest("[pvp] daily quest load failed:", err);
      return;
    }
  }
  for (const uid of userIds) {
    try {
      noteFn(uid, game, {
        shopFile: options.shopFile,
        walletFile: options.walletFile,
      });
    } catch (err) {
      warnQuest("[pvp] daily quest failed:", err);
    }
  }
}

module.exports = {
  takeResolvedQuestUsers,
  emitResolvedPvpDailyQuest,
};
