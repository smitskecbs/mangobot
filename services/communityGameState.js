/**
 * Shared community challenge busy flag (ChatFight + PvP + Trivia).
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

function isConnectFourBusy() {
  try {
    const c4 = require("./connectFour");
    return typeof c4.isConnectFourOpen === "function"
      ? Boolean(c4.isConnectFourOpen())
      : false;
  } catch (_err) {
    return false;
  }
}

function isTriviaBusy() {
  try {
    const trivia = require("./trivia");
    return typeof trivia.isTriviaOpen === "function"
      ? Boolean(trivia.isTriviaOpen())
      : false;
  } catch (_err) {
    return false;
  }
}

function isPvpBusy(options = {}) {
  const tttOpen =
    typeof options.isTicTacToeOpenFn === "function"
      ? options.isTicTacToeOpenFn()
      : isTicTacToeBusy();
  const c4Open =
    typeof options.isConnectFourOpenFn === "function"
      ? options.isConnectFourOpenFn()
      : isConnectFourBusy();
  return Boolean(tttOpen || c4Open);
}

/**
 * @param {object} [options]
 * @param {() => boolean} [options.isChatFightOpenFn]
 * @param {() => boolean} [options.isTicTacToeOpenFn]
 * @param {() => boolean} [options.isConnectFourOpenFn]
 * @param {() => boolean} [options.isTriviaOpenFn]
 */
function isCommunityChallengeBusy(options = {}) {
  const fightOpen =
    typeof options.isChatFightOpenFn === "function"
      ? options.isChatFightOpenFn()
      : isChatFightBusy();
  const triviaOpen =
    typeof options.isTriviaOpenFn === "function"
      ? options.isTriviaOpenFn()
      : isTriviaBusy();
  return Boolean(fightOpen || isPvpBusy(options) || triviaOpen);
}

/**
 * @returns {"chatfight"|"tictactoe"|"connect4"|"trivia"|null}
 */
function getCommunityBusyReason(options = {}) {
  const fightOpen =
    typeof options.isChatFightOpenFn === "function"
      ? options.isChatFightOpenFn()
      : isChatFightBusy();
  if (fightOpen) {
    return "chatfight";
  }
  const tttOpen =
    typeof options.isTicTacToeOpenFn === "function"
      ? options.isTicTacToeOpenFn()
      : isTicTacToeBusy();
  if (tttOpen) {
    return "tictactoe";
  }
  const c4Open =
    typeof options.isConnectFourOpenFn === "function"
      ? options.isConnectFourOpenFn()
      : isConnectFourBusy();
  if (c4Open) {
    return "connect4";
  }
  const triviaOpen =
    typeof options.isTriviaOpenFn === "function"
      ? options.isTriviaOpenFn()
      : isTriviaBusy();
  if (triviaOpen) {
    return "trivia";
  }
  return null;
}

function formatCommunityBusyReply(reason) {
  if (reason === "chatfight") {
    return "⚔️ A ChatFight is already running.";
  }
  if (reason === "tictactoe") {
    return "🎮 A Tic-Tac-Toe challenge is already open.";
  }
  if (reason === "connect4") {
    return "🟡 A Connect Four challenge is already open.";
  }
  if (reason === "trivia") {
    return "🧠 A Trivia challenge is already open.";
  }
  return "🎮 A PvP challenge is already open.";
}

module.exports = {
  isCommunityChallengeBusy,
  getCommunityBusyReason,
  formatCommunityBusyReply,
  isChatFightBusy,
  isTicTacToeBusy,
  isConnectFourBusy,
  isTriviaBusy,
  isPvpBusy,
};
