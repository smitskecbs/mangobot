/**
 * Human-vs-human PvP matches played (UTC day).
 * Separate from rewardedWins (TTT/C4 win XP cap). Blackjack XP is unchanged.
 */

const { recordHumanPvpMatch } = require("./points");
const { error: logError } = require("../utils/logger");

const PVP_MATCH_GAMES = Object.freeze(["tictactoe", "connect4", "blackjack"]);
const BOT_IDS = Object.freeze(["bot"]);

function isTestProcess() {
  for (const arg of process.argv) {
    if (typeof arg !== "string") {
      continue;
    }
    const norm = arg.replace(/\\/g, "/");
    if (norm.includes("/tests/") || /\.test\.js$/i.test(norm)) {
      return true;
    }
  }
  return false;
}

function isBotOpponent(opponentType, opponentUserId) {
  if (String(opponentType || "").toLowerCase() === "bot") {
    return true;
  }
  const opp = String(opponentUserId || "").toLowerCase();
  return BOT_IDS.includes(opp);
}

function noteHumanPvpMatch(userId, payload = {}, pointsFile) {
  const uid = userId == null ? "" : String(userId).trim();
  if (!uid || BOT_IDS.includes(uid.toLowerCase())) {
    return { ok: false, reason: "user" };
  }
  const game = String((payload && payload.game) || "").toLowerCase();
  if (!PVP_MATCH_GAMES.includes(game)) {
    return { ok: false, reason: "game" };
  }
  if (isBotOpponent(payload && payload.opponentType, payload && payload.opponentUserId)) {
    return { ok: false, reason: "bot" };
  }
  const matchId = payload && payload.matchId != null ? String(payload.matchId) : "";
  if (!matchId) {
    return { ok: false, reason: "match" };
  }

  const noteKey = `${game}:${matchId}`;
  const resolvedFile = pointsFile || (payload && payload.pointsFile) || undefined;
  let counted = { ok: false, already: false, matchesToday: 0 };

  if (!resolvedFile && isTestProcess()) {
    counted = { ok: true, already: false, matchesToday: 0, skippedPoints: true };
  } else {
    try {
      counted = recordHumanPvpMatch(
        uid,
        (payload && payload.userName) || "Player",
        noteKey,
        resolvedFile
      );
    } catch (err) {
      logError("[pvp] match progress failed:", err && err.message ? err.message : err);
      return { ok: false, reason: "store" };
    }
  }

  if (counted && counted.ok && !counted.already) {
    try {
      require("./dailyQuest").noteDailyQuestPvp(uid, {
        shopFile: payload && payload.shopFile,
        walletFile: payload && payload.walletFile,
        now: payload && payload.now,
      });
    } catch (err) {
      logError("[pvp] daily quest pvp failed:", err && err.message ? err.message : err);
    }
  }
  return counted;
}

module.exports = {
  PVP_MATCH_GAMES,
  noteHumanPvpMatch,
  isBotOpponent,
};
