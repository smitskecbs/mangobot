/**
 * Daily Quest game progress for resolved TTT/C4 matches.
 * Bot-game slot is independent of XP. Human PvP is a separate counter.
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

async function emitResolvedPvpDailyQuest(userIds, game, options = {}) {
  if (!Array.isArray(userIds) || !userIds.length) {
    return;
  }
  let noteFn = options.noteDailyQuestGameFn;
  if (typeof noteFn !== "function") {
    try {
      noteFn = require("./dailyQuest").noteDailyQuestGame;
    } catch (err) {
      warnQuest("[pvp] daily quest load failed:", err);
      noteFn = null;
    }
  }
  const humanPvp = String(options.opponentType || "").toLowerCase() === "human";
  let notePvpFn = options.noteHumanPvpMatchFn;
  if (humanPvp && typeof notePvpFn !== "function") {
    try {
      notePvpFn = require("./pvpProgress").noteHumanPvpMatch;
    } catch (err) {
      warnQuest("[pvp] pvp progress load failed:", err);
      notePvpFn = null;
    }
  }
  for (const uid of userIds) {
    if (typeof noteFn === "function") {
      try {
        noteFn(uid, game, {
          shopFile: options.shopFile,
          walletFile: options.walletFile,
        });
      } catch (err) {
        warnQuest("[pvp] daily quest failed:", err);
      }
    }
    if (humanPvp && typeof notePvpFn === "function") {
      try {
        await Promise.resolve(
          notePvpFn(
            uid,
            {
              game,
              matchId: options.matchId,
              opponentType: "human",
              shopFile: options.shopFile,
              walletFile: options.walletFile,
              pointsFile: options.pointsFile,
            },
            options.pointsFile
          )
        );
      } catch (err) {
        warnQuest("[pvp] human match progress failed:", err);
      }
    }
  }
}

module.exports = {
  takeResolvedQuestUsers,
  emitResolvedPvpDailyQuest,
};
