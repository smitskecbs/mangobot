/**
 * Server-side Connect Four bot: win, block, then columns nearest center.
 * Lazy-requires connectFour to avoid a circular load.
 */

const crypto = require("crypto");

function defaultRandomInt(minInclusive, maxExclusive) {
  return crypto.randomInt(minInclusive, maxExclusive);
}

function rules() {
  return require("./connectFour");
}

function isColumnOpen(board, column) {
  return board[0][column] == null;
}

function openColumns(board) {
  const { COLS } = rules();
  const cols = [];
  for (let c = 0; c < COLS; c += 1) {
    if (isColumnOpen(board, c)) {
      cols.push(c);
    }
  }
  return cols;
}

function columnWins(board, column, mark) {
  const { cloneBoard, dropToken, checkConnectFourWinner } = rules();
  if (!isColumnOpen(board, column)) {
    return false;
  }
  const next = cloneBoard(board);
  const dropped = dropToken(next, column, mark);
  if (!dropped.ok) {
    return false;
  }
  return checkConnectFourWinner(next) === mark;
}

function pickRandom(cols, randomIntFn) {
  if (!cols.length) {
    return null;
  }
  return cols[randomIntFn(0, cols.length)];
}

/**
 * @param {Array<Array<string|null>>} board
 * @param {"R"|"Y"} botMark
 * @param {(min: number, max: number) => number} [randomIntFn]
 * @returns {number|null}
 */
function chooseConnectFourBotColumn(board, botMark, randomIntFn = defaultRandomInt) {
  const { COLS } = rules();
  const mark = botMark === "Y" ? "Y" : "R";
  const human = mark === "R" ? "Y" : "R";
  const rng = typeof randomIntFn === "function" ? randomIntFn : defaultRandomInt;
  const open = openColumns(board);
  if (!open.length) {
    return null;
  }

  const wins = open.filter((col) => columnWins(board, col, mark));
  if (wins.length) {
    return pickRandom(wins, rng);
  }

  const blocks = open.filter((col) => columnWins(board, col, human));
  if (blocks.length) {
    return pickRandom(blocks, rng);
  }

  const groups = [[3], [2, 4], [1, 5], [0, 6]];
  for (const group of groups) {
    const available = group.filter((col) => open.includes(col) && col < COLS);
    if (available.length) {
      return pickRandom(available, rng);
    }
  }

  return pickRandom(open, rng);
}

function isLegalConnectFourBotMove(board, column) {
  const { COLS } = rules();
  return Number.isInteger(column) && column >= 0 && column < COLS && isColumnOpen(board, column);
}

module.exports = {
  chooseConnectFourBotColumn,
  isLegalConnectFourBotMove,
  openColumns,
  columnWins,
};
