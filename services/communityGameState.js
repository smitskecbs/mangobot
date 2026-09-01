/**
 * Shared community exclusive busy flag (ChatFight + community Trivia + ManGo Bomb).
 * Personal Trivia hub sessions do not occupy the group.
 * Parallel PvP (Tic-Tac-Toe, Connect Four, Checkers, Blackjack) does not occupy the group.
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

function isCheckersBusy() {
  try {
    const checkers = require("./checkers");
    return typeof checkers.isCheckersOpen === "function"
      ? Boolean(checkers.isCheckersOpen())
      : false;
  } catch (_err) {
    return false;
  }
}

function isTriviaBusy() {
  try {
    const trivia = require("./trivia");
    if (typeof trivia.isCommunityTriviaOpen === "function") {
      return Boolean(trivia.isCommunityTriviaOpen());
    }
    return typeof trivia.isTriviaOpen === "function"
      ? Boolean(trivia.isTriviaOpen())
      : false;
  } catch (_err) {
    return false;
  }
}

function isMangoBombBusy() {
  try {
    const mangoBomb = require("./mangoBomb");
    return typeof mangoBomb.isMangoBombOpen === "function"
      ? Boolean(mangoBomb.isMangoBombOpen())
      : false;
  } catch (_err) {
    return false;
  }
}

function isBlackjackBusy() {
  try {
    const blackjack = require("./blackjack");
    return typeof blackjack.isBlackjackOpen === "function"
      ? Boolean(blackjack.isBlackjackOpen())
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
  const chkOpen =
    typeof options.isCheckersOpenFn === "function"
      ? options.isCheckersOpenFn()
      : isCheckersBusy();
  return Boolean(tttOpen || c4Open || chkOpen);
}

function isCommunityExclusiveBusy(options = {}) {
  const fightOpen =
    typeof options.isChatFightOpenFn === "function"
      ? options.isChatFightOpenFn()
      : isChatFightBusy();
  const triviaOpen =
    typeof options.isTriviaOpenFn === "function"
      ? options.isTriviaOpenFn()
      : isTriviaBusy();
  const bombOpen =
    typeof options.isMangoBombOpenFn === "function"
      ? options.isMangoBombOpenFn()
      : isMangoBombBusy();
  return Boolean(fightOpen || triviaOpen || bombOpen);
}

/**
 * Community-wide exclusive activities only (not parallel PvP).
 * @param {object} [options]
 * @param {() => boolean} [options.isChatFightOpenFn]
 * @param {() => boolean} [options.isTriviaOpenFn]
 * @param {() => boolean} [options.isMangoBombOpenFn]
 */
function isCommunityChallengeBusy(options = {}) {
  return isCommunityExclusiveBusy(options);
}

/**
 * @returns {"chatfight"|"trivia"|"mangobomb"|null}
 */
function getCommunityBusyReason(options = {}) {
  const fightOpen =
    typeof options.isChatFightOpenFn === "function"
      ? options.isChatFightOpenFn()
      : isChatFightBusy();
  if (fightOpen) {
    return "chatfight";
  }
  const triviaOpen =
    typeof options.isTriviaOpenFn === "function"
      ? options.isTriviaOpenFn()
      : isTriviaBusy();
  if (triviaOpen) {
    return "trivia";
  }
  const bombOpen =
    typeof options.isMangoBombOpenFn === "function"
      ? options.isMangoBombOpenFn()
      : isMangoBombBusy();
  if (bombOpen) {
    return "mangobomb";
  }
  return null;
}

function formatCommunityBusyReply(reason) {
  if (reason === "chatfight") {
    return "⚔️ A ChatFight is already running.";
  }
  if (reason === "trivia") {
    return "🧠 A Trivia challenge is already open.";
  }
  if (reason === "mangobomb") {
    return "🥭💣 A ManGo Bomb round is already running.";
  }
  return "🎮 A community game is already running.";
}

module.exports = {
  isCommunityChallengeBusy,
  isCommunityExclusiveBusy,
  getCommunityBusyReason,
  formatCommunityBusyReply,
  isChatFightBusy,
  isTicTacToeBusy,
  isConnectFourBusy,
  isCheckersBusy,
  isTriviaBusy,
  isMangoBombBusy,
  isBlackjackBusy,
  isPvpBusy,
};
