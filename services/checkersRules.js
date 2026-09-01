/**
 * English / American Checkers (straight checkers) — pure rules engine.
 * 8×8, dark squares only (32 playable), no flying kings, no majority capture.
 * Promotion ends the turn. No Telegram / session code here.
 */

const SQUARE_COUNT = 32;
const BOARD_SIZE = 8;

const BLACK = "b";
const WHITE = "w";
const BLACK_KING = "B";
const WHITE_KING = "W";

/** NW, NE, SW, SE on the display board (row 0 = top / White back rank). */
const DIR_DELTAS = Object.freeze([
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
]);

const BLACK_MAN_DIRS = Object.freeze([0, 1]);
const WHITE_MAN_DIRS = Object.freeze([2, 3]);
const KING_DIRS = Object.freeze([0, 1, 2, 3]);

function isPlayableSquare(sq) {
  return Number.isInteger(sq) && sq >= 0 && sq < SQUARE_COUNT;
}

function isDark(row, col) {
  return (row + col) % 2 === 1;
}

function sqToRowCol(sq) {
  if (!isPlayableSquare(sq)) {
    return null;
  }
  const row = Math.floor(sq / 4);
  const i = sq % 4;
  const col = row % 2 === 0 ? i * 2 + 1 : i * 2;
  return { row, col };
}

function rowColToSq(row, col) {
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    return null;
  }
  if (!isDark(row, col)) {
    return null;
  }
  return row * 4 + Math.floor(col / 2);
}

const JUMPS = Array.from({ length: SQUARE_COUNT }, (_, sq) => {
  const { row, col } = sqToRowCol(sq);
  return DIR_DELTAS.map(([dRow, dCol]) => ({
    mid: rowColToSq(row + dRow, col + dCol),
    land: rowColToSq(row + 2 * dRow, col + 2 * dCol),
    step: rowColToSq(row + dRow, col + dCol),
    dRow,
    dCol,
  }));
});

function emptyBoard() {
  return Array(SQUARE_COUNT).fill(null);
}

function cloneBoard(board) {
  return Array.isArray(board) ? board.slice() : emptyBoard();
}

function initialBoard() {
  const board = emptyBoard();
  for (let sq = 0; sq < 12; sq += 1) {
    board[sq] = WHITE;
  }
  for (let sq = 20; sq < 32; sq += 1) {
    board[sq] = BLACK;
  }
  return board;
}

function initialState() {
  return {
    board: initialBoard(),
    current: BLACK,
    pendingFrom: null,
  };
}

function cloneState(state) {
  return {
    board: cloneBoard(state && state.board),
    current: state && state.current === WHITE ? WHITE : BLACK,
    pendingFrom: isPlayableSquare(state && state.pendingFrom)
      ? state.pendingFrom
      : null,
  };
}

function isKing(piece) {
  return piece === BLACK_KING || piece === WHITE_KING;
}

function sideOf(piece) {
  if (piece === BLACK || piece === BLACK_KING) {
    return BLACK;
  }
  if (piece === WHITE || piece === WHITE_KING) {
    return WHITE;
  }
  return null;
}

function opponentOf(side) {
  return side === WHITE ? BLACK : WHITE;
}

function kingPiece(side) {
  return side === WHITE ? WHITE_KING : BLACK_KING;
}

function manPiece(side) {
  return side === WHITE ? WHITE : BLACK;
}

function dirsFor(piece) {
  if (isKing(piece)) {
    return KING_DIRS;
  }
  return sideOf(piece) === WHITE ? WHITE_MAN_DIRS : BLACK_MAN_DIRS;
}

function wouldPromote(piece, toSq) {
  if (!piece || isKing(piece) || !isPlayableSquare(toSq)) {
    return false;
  }
  const { row } = sqToRowCol(toSq);
  if (sideOf(piece) === BLACK) {
    return row === 0;
  }
  return row === BOARD_SIZE - 1;
}

function countPieces(board, side) {
  let n = 0;
  const cells = Array.isArray(board) ? board : [];
  for (let i = 0; i < cells.length; i += 1) {
    if (sideOf(cells[i]) === side) {
      n += 1;
    }
  }
  return n;
}

function pushQuiet(moves, board, from, piece) {
  const jumps = JUMPS[from];
  const dirs = dirsFor(piece);
  for (let i = 0; i < dirs.length; i += 1) {
    const info = jumps[dirs[i]];
    const to = info && info.step;
    if (!isPlayableSquare(to) || board[to] != null) {
      continue;
    }
    moves.push({
      from,
      to,
      captured: null,
      promoted: wouldPromote(piece, to),
    });
  }
}

function pushCaptures(moves, board, from, piece) {
  const jumps = JUMPS[from];
  const dirs = dirsFor(piece);
  const enemy = opponentOf(sideOf(piece));
  for (let i = 0; i < dirs.length; i += 1) {
    const info = jumps[dirs[i]];
    if (!info || !isPlayableSquare(info.mid) || !isPlayableSquare(info.land)) {
      continue;
    }
    if (sideOf(board[info.mid]) !== enemy) {
      continue;
    }
    if (board[info.land] != null) {
      continue;
    }
    moves.push({
      from,
      to: info.land,
      captured: info.mid,
      promoted: wouldPromote(piece, info.land),
    });
  }
}

function capturesFrom(board, from) {
  const piece = board[from];
  if (!piece) {
    return [];
  }
  const moves = [];
  pushCaptures(moves, board, from, piece);
  return moves;
}

function allCaptures(board, side) {
  const moves = [];
  for (let sq = 0; sq < SQUARE_COUNT; sq += 1) {
    if (sideOf(board[sq]) !== side) {
      continue;
    }
    pushCaptures(moves, board, sq, board[sq]);
  }
  return moves;
}

function allQuiet(board, side) {
  const moves = [];
  for (let sq = 0; sq < SQUARE_COUNT; sq += 1) {
    if (sideOf(board[sq]) !== side) {
      continue;
    }
    pushQuiet(moves, board, sq, board[sq]);
  }
  return moves;
}

function legalMoves(state) {
  const board = (state && state.board) || emptyBoard();
  const current = state && state.current === WHITE ? WHITE : BLACK;
  const pending = isPlayableSquare(state && state.pendingFrom)
    ? state.pendingFrom
    : null;

  if (pending != null) {
    if (sideOf(board[pending]) !== current) {
      return [];
    }
    return capturesFrom(board, pending);
  }

  const captures = allCaptures(board, current);
  if (captures.length) {
    return captures;
  }
  return allQuiet(board, current);
}

function destinations(state, from) {
  if (!isPlayableSquare(from)) {
    return [];
  }
  return legalMoves(state).filter((m) => m.from === from);
}

function findLegalMove(state, from, to) {
  if (!isPlayableSquare(from) || !isPlayableSquare(to)) {
    return null;
  }
  const moves = legalMoves(state);
  for (let i = 0; i < moves.length; i += 1) {
    if (moves[i].from === from && moves[i].to === to) {
      return moves[i];
    }
  }
  return null;
}

function isLegalMove(state, from, to) {
  return Boolean(findLegalMove(state, from, to));
}

function winnerIfSideToMoveCannotAct(board, sideToMove) {
  if (countPieces(board, sideToMove) === 0) {
    return opponentOf(sideToMove);
  }
  const moves = legalMoves({
    board,
    current: sideToMove,
    pendingFrom: null,
  });
  if (!moves.length) {
    return opponentOf(sideToMove);
  }
  return null;
}

/**
 * Apply a move. Input state is not mutated.
 * Promotion ends the turn even if the new king could capture.
 */
function applyMove(state, from, to) {
  const current = state && state.current === WHITE ? WHITE : BLACK;
  const legal = findLegalMove(state, from, to);
  if (!legal) {
    const board = (state && state.board) || emptyBoard();
    if (!isPlayableSquare(from) || !isPlayableSquare(to)) {
      return { ok: false, reason: "bad-square" };
    }
    if (sideOf(board[from]) == null) {
      return { ok: false, reason: "empty" };
    }
    if (sideOf(board[from]) !== current) {
      return { ok: false, reason: "opponent-piece" };
    }
    if (board[to] != null) {
      return { ok: false, reason: "occupied" };
    }
    const pending = isPlayableSquare(state && state.pendingFrom)
      ? state.pendingFrom
      : null;
    if (pending != null && from !== pending) {
      return { ok: false, reason: "must-continue" };
    }
    if (allCaptures(board, current).length && legal == null) {
      return { ok: false, reason: "must-capture" };
    }
    return { ok: false, reason: "illegal" };
  }

  const board = cloneBoard(state.board);
  const piece = board[from];
  board[from] = null;
  if (legal.captured != null) {
    board[legal.captured] = null;
  }
  const promoted = Boolean(legal.promoted);
  board[to] = promoted ? kingPiece(current) : piece;

  let pendingFrom = null;
  let next = opponentOf(current);
  if (legal.captured != null && !promoted) {
    const further = capturesFrom(board, to);
    if (further.length) {
      pendingFrom = to;
      next = current;
    }
  }

  let winner = null;
  if (countPieces(board, opponentOf(current)) === 0) {
    winner = current;
    pendingFrom = null;
    next = current;
  } else if (pendingFrom == null) {
    winner = winnerIfSideToMoveCannotAct(board, next);
  }

  return {
    ok: true,
    from: legal.from,
    to: legal.to,
    captured: legal.captured,
    promoted,
    ended: winner != null,
    winner,
    state: {
      board,
      current: winner != null ? current : next,
      pendingFrom: winner != null ? null : pendingFrom,
    },
  };
}

function resultOf(state) {
  const board = (state && state.board) || emptyBoard();
  const current = state && state.current === WHITE ? WHITE : BLACK;
  const pending = isPlayableSquare(state && state.pendingFrom)
    ? state.pendingFrom
    : null;
  if (countPieces(board, BLACK) === 0) {
    return WHITE;
  }
  if (countPieces(board, WHITE) === 0) {
    return BLACK;
  }
  if (pending != null) {
    return null;
  }
  return winnerIfSideToMoveCannotAct(board, current);
}

module.exports = {
  SQUARE_COUNT,
  BOARD_SIZE,
  BLACK,
  WHITE,
  BLACK_KING,
  WHITE_KING,
  emptyBoard,
  cloneBoard,
  cloneState,
  initialBoard,
  initialState,
  isPlayableSquare,
  isDark,
  sqToRowCol,
  rowColToSq,
  isKing,
  sideOf,
  opponentOf,
  kingPiece,
  manPiece,
  wouldPromote,
  countPieces,
  legalMoves,
  destinations,
  isLegalMove,
  findLegalMove,
  applyMove,
  resultOf,
  capturesFrom,
  allCaptures,
};
