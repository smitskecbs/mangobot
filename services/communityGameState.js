/**
 * Shared community challenge busy flag (ChatFight + PvP).
 * Lazy requires avoid circular init issues.
 */

function isChatFightBusy() {
  try {
    const chatFight = require("./chatFight");
    return typeof chatFight.isFightOpen === "function"
      ? Boolean(chatFight.isFightOpen())
      : false;
  } catch (_err) {
    return false;
  }
}

function isTicTacToeBusy() {
  try {
    const ttt = require("./ticTacToe");
    return typeof ttt.isTicTacToeOpen === "function"
      ? Boolean(ttt.isTicTacToeOpen())
      : false;
  } catch (_err) {
    return false;
  }
}

/**
 * @param {object} [options]
 * @param {() => boolean} [options.isChatFightOpenFn]
 * @param {() => boolean} [options.isTicTacToeOpenFn]
 */
function isCommunityChallengeBusy(options = {}) {
  const fightOpen =
    typeof options.isChatFightOpenFn === "function"
      ? options.isChatFightOpenFn()
      : isChatFightBusy();
  const pvpOpen =
    typeof options.isTicTacToeOpenFn === "function"
      ? options.isTicTacToeOpenFn()
      : isTicTacToeBusy();
  return Boolean(fightOpen || pvpOpen);
}

/**
 * @returns {"chatfight"|"tictactoe"|null}
 */
function getCommunityBusyReason(options = {}) {
  const fightOpen =
    typeof options.isChatFightOpenFn === "function"
      ? options.isChatFightOpenFn()
      : isChatFightBusy();
  if (fightOpen) {
    return "chatfight";
  }
  const pvpOpen =
    typeof options.isTicTacToeOpenFn === "function"
      ? options.isTicTacToeOpenFn()
      : isTicTacToeBusy();
  if (pvpOpen) {
    return "tictactoe";
  }
  return null;
}

module.exports = {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
  isChatFightBusy,
  isTicTacToeBusy,
};
