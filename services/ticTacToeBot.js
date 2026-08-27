/**
 * Server-side Tic-Tac-Toe bot: win, block, center, corner, then any free cell.
 */

const crypto = require("crypto");

const CENTER = 4;
const CORNERS = Object.freeze([0, 2, 6, 8]);
const WIN_LINES = Object.freeze([
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]);

function defaultRandomInt(minInclusive, maxExclusive) {
  return crypto.randomInt(minInclusive, maxExclusive);
}

function checkWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) {
      return v;
    }
  }
  return null;
}

function emptyCells(board) {
  const cells = [];
  for (let i = 0; i < 9; i += 1) {
    if (board[i] == null) {
      cells.push(i);
    }
  }
  return cells;
}

function wouldWin(board, cell, mark) {
  if (board[cell] != null) {
    return false;
  }
  const next = board.slice();
  next[cell] = mark;
  return checkWinner(next) === mark;
}

function pickRandom(cells, randomIntFn) {
  if (!cells.length) {
    return null;
  }
  return cells[randomIntFn(0, cells.length)];
}

function winningCells(board, mark) {
  return emptyCells(board).filter((cell) => wouldWin(board, cell, mark));
}

/**
 * @param {Array<string|null>} board
 * @param {"X"|"O"} botMark
 * @param {(min: number, max: number) => number} [randomIntFn]
 * @returns {number|null}
 */
function chooseTicTacToeBotCell(board, botMark, randomIntFn = defaultRandomInt) {
  const mark = botMark === "O" ? "O" : "X";
  const human = mark === "X" ? "O" : "X";
  const rng = typeof randomIntFn === "function" ? randomIntFn : defaultRandomInt;

  const wins = winningCells(board, mark);
  if (wins.length) {
    return pickRandom(wins, rng);
  }

  const blocks = winningCells(board, human);
  if (blocks.length) {
    return pickRandom(blocks, rng);
  }

  if (board[CENTER] == null) {
    return CENTER;
  }

  const freeCorners = CORNERS.filter((cell) => board[cell] == null);
  if (freeCorners.length) {
    return pickRandom(freeCorners, rng);
  }

  return pickRandom(emptyCells(board), rng);
}

function isLegalTicTacToeBotMove(board, cell) {
  return Number.isInteger(cell) && cell >= 0 && cell <= 8 && board[cell] == null;
}

module.exports = {
  chooseTicTacToeBotCell,
  isLegalTicTacToeBotMove,
  winningCells,
  CENTER,
  CORNERS,
};
