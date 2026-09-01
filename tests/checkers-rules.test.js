/**
 * English / American Checkers rules engine.
 * Run: node tests/checkers-rules.test.js
 */

const assert = require("assert");
const {
  BLACK,
  WHITE,
  BLACK_KING,
  WHITE_KING,
  SQUARE_COUNT,
  emptyBoard,
  initialBoard,
  initialState,
  countPieces,
  legalMoves,
  destinations,
  isLegalMove,
  applyMove,
  resultOf,
  sqToRowCol,
  rowColToSq,
  isDark,
  chooseCheckersBotMove,
} = (() => {
  const rules = require("../services/checkersRules");
  const bot = require("../services/checkersBot");
  return { ...rules, ...bot };
})();

function boardOf(map) {
  const board = emptyBoard();
  for (const [sq, piece] of Object.entries(map)) {
    board[Number(sq)] = piece;
  }
  return board;
}

function stateOf(map, current = BLACK, pendingFrom = null) {
  return { board: boardOf(map), current, pendingFrom };
}

function moveKeys(moves) {
  return moves.map((m) => `${m.from}->${m.to}`).sort();
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("start position is 12+12 on dark squares", () => {
    const board = initialBoard();
    assert.strictEqual(board.length, SQUARE_COUNT);
    assert.strictEqual(countPieces(board, BLACK), 12);
    assert.strictEqual(countPieces(board, WHITE), 12);
    for (let sq = 0; sq < 12; sq += 1) {
      assert.strictEqual(board[sq], WHITE);
    }
    for (let sq = 12; sq < 20; sq += 1) {
      assert.strictEqual(board[sq], null);
    }
    for (let sq = 20; sq < 32; sq += 1) {
      assert.strictEqual(board[sq], BLACK);
    }
    const bottomLeft = sqToRowCol(28);
    assert.deepStrictEqual(bottomLeft, { row: 7, col: 0 });
    assert.strictEqual(isDark(7, 0), true);
    assert.strictEqual(rowColToSq(7, 0), 28);
  });

  await runTest("legal normal forward move", () => {
    const state = initialState();
    assert.strictEqual(isLegalMove(state, 20, 16), true);
    const applied = applyMove(state, 20, 16);
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.state.board[20], null);
    assert.strictEqual(applied.state.board[16], BLACK);
    assert.strictEqual(applied.state.current, WHITE);
    assert.strictEqual(applied.state.pendingFrom, null);
  });

  await runTest("wrong direction is illegal", () => {
    const state = stateOf({ 20: BLACK });
    const applied = applyMove(state, 20, 24);
    assert.strictEqual(applied.ok, false);
    assert.ok(["illegal", "bad-square"].includes(applied.reason));
    assert.strictEqual(isLegalMove(state, 20, 24), false);
  });

  await runTest("occupied destination is illegal", () => {
    const state = stateOf({ 20: BLACK, 16: BLACK });
    const applied = applyMove(state, 20, 16);
    assert.strictEqual(applied.ok, false);
    assert.strictEqual(applied.reason, "occupied");
  });

  await runTest("moving opponent piece is illegal", () => {
    const state = stateOf({ 8: WHITE, 20: BLACK }, BLACK);
    const applied = applyMove(state, 8, 12);
    assert.strictEqual(applied.ok, false);
    assert.strictEqual(applied.reason, "opponent-piece");
  });

  await runTest("wrong player turn is illegal", () => {
    const state = stateOf({ 20: BLACK, 8: WHITE }, WHITE);
    const applied = applyMove(state, 20, 16);
    assert.strictEqual(applied.ok, false);
    assert.strictEqual(applied.reason, "opponent-piece");
  });

  await runTest("capture", () => {
    const state = stateOf({ 20: BLACK, 16: WHITE });
    const applied = applyMove(state, 20, 13);
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.captured, 16);
    assert.strictEqual(applied.state.board[20], null);
    assert.strictEqual(applied.state.board[16], null);
    assert.strictEqual(applied.state.board[13], BLACK);
    assert.strictEqual(applied.winner, BLACK);
    assert.strictEqual(applied.ended, true);
  });

  await runTest("mandatory capture", () => {
    const state = stateOf({ 20: BLACK, 21: BLACK, 16: WHITE });
    const moves = legalMoves(state);
    assert.ok(moves.every((m) => m.captured != null));
    assert.ok(moves.some((m) => m.from === 20 && m.to === 13));
    const quiet = applyMove(state, 21, 17);
    assert.strictEqual(quiet.ok, false);
    assert.strictEqual(quiet.reason, "must-capture");
  });

  await runTest("normal move rejected when capture exists", () => {
    const state = initialState();
    state.board[16] = WHITE;
    state.board[8] = null;
    const quiet = applyMove(state, 21, 17);
    assert.strictEqual(quiet.ok, false);
    assert.strictEqual(quiet.reason, "must-capture");
  });

  await runTest("multiple capture choices are allowed", () => {
    const state = stateOf({ 20: BLACK, 22: BLACK, 16: WHITE, 18: WHITE });
    const moves = legalMoves(state);
    const keys = moveKeys(moves);
    assert.ok(keys.includes("20->13"));
    assert.ok(keys.includes("22->15"));
    assert.strictEqual(applyMove(state, 20, 13).ok, true);
    assert.strictEqual(applyMove(state, 22, 15).ok, true);
  });

  await runTest("multi-jump and same piece forced", () => {
    const state = stateOf({ 20: BLACK, 16: WHITE, 9: WHITE, 0: WHITE });
    const first = applyMove(state, 20, 13);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.ended, false);
    assert.strictEqual(first.state.current, BLACK);
    assert.strictEqual(first.state.pendingFrom, 13);
    const other = applyMove(first.state, 13, 6);
    assert.strictEqual(other.ok, true);
    assert.strictEqual(other.state.board[9], null);
    assert.strictEqual(other.state.board[6], BLACK);
    assert.strictEqual(other.state.pendingFrom, null);
    assert.strictEqual(other.state.current, WHITE);

    const mid = applyMove(first.state, 20, 16);
    assert.strictEqual(mid.ok, false);
    assert.ok(["must-continue", "empty", "illegal"].includes(mid.reason));
  });

  await runTest("promotion to king", () => {
    const ontoKingRow = stateOf({ 5: BLACK });
    const dests = destinations(ontoKingRow, 5);
    const promoteMove = dests.find((m) => m.promoted);
    assert.ok(promoteMove);
    const result = applyMove(ontoKingRow, promoteMove.from, promoteMove.to);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.promoted, true);
    assert.strictEqual(result.state.board[promoteMove.to], BLACK_KING);
  });

  await runTest("promotion ends the turn even if king could capture", () => {
    const state = stateOf({ 8: BLACK, 5: WHITE, 6: WHITE });
    const applied = applyMove(state, 8, 1);
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.promoted, true);
    assert.strictEqual(applied.state.board[1], BLACK_KING);
    assert.strictEqual(applied.state.pendingFrom, null);
    assert.strictEqual(applied.state.current, WHITE);
    assert.strictEqual(applied.state.board[6], WHITE);
  });

  await runTest("king movement both directions", () => {
    const state = stateOf({ 16: BLACK_KING }, BLACK);
    const moves = legalMoves(state);
    const keys = moveKeys(moves);
    assert.ok(keys.includes("16->12") || keys.includes("16->13"));
    assert.ok(keys.includes("16->20") || keys.includes("16->21"));
    assert.ok(isLegalMove(state, 16, 13));
    assert.ok(isLegalMove(state, 16, 21));
  });

  await runTest("king captures both directions", () => {
    const forward = stateOf({ 16: BLACK_KING, 13: WHITE });
    const f = applyMove(forward, 16, 9);
    assert.strictEqual(f.ok, true);
    assert.strictEqual(f.captured, 13);

    const back = stateOf({ 16: BLACK_KING, 21: WHITE });
    const b = applyMove(back, 16, 25);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.captured, 21);
  });

  await runTest("no pieces win", () => {
    const state = stateOf({ 20: BLACK }, WHITE);
    assert.strictEqual(resultOf(state), BLACK);
    const after = applyMove(stateOf({ 20: BLACK, 16: WHITE }), 20, 13);
    assert.strictEqual(after.winner, BLACK);
  });

  await runTest("no legal moves win", () => {
    const state = stateOf({ 20: BLACK, 31: WHITE }, WHITE);
    assert.strictEqual(resultOf(state), BLACK);
    const blackMoves = stateOf({ 20: BLACK, 31: WHITE }, BLACK);
    const applied = applyMove(blackMoves, 20, 16);
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.ended, true);
    assert.strictEqual(applied.winner, BLACK);
  });

  await runTest("bot only chooses legal moves and prefers capture", () => {
    const start = Date.now();
    const initial = initialState();
    const quiet = chooseCheckersBotMove(initial, () => 0);
    assert.ok(quiet);
    assert.strictEqual(isLegalMove(initial, quiet.from, quiet.to), true);

    const cap = stateOf({ 20: BLACK, 21: BLACK, 16: WHITE });
    const chosen = chooseCheckersBotMove(cap, () => 0);
    assert.ok(chosen);
    const legal = legalMoves(cap).find(
      (m) => m.from === chosen.from && m.to === chosen.to
    );
    assert.ok(legal);
    assert.ok(legal.captured != null);
    assert.ok(Date.now() - start < 50);
  });

  await runTest("bot completes multi-jump using the same piece", () => {
    let state = stateOf({ 20: BLACK, 16: WHITE, 9: WHITE, 0: WHITE });
    const first = chooseCheckersBotMove(state, () => 0);
    assert.deepStrictEqual(first, { from: 20, to: 13 });
    const after = applyMove(state, first.from, first.to);
    state = after.state;
    assert.strictEqual(state.pendingFrom, 13);
    const second = chooseCheckersBotMove(state, () => 0);
    assert.deepStrictEqual(second, { from: 13, to: 6 });
  });

  await runTest("bot can use a king", () => {
    const state = stateOf({ 16: BLACK_KING, 13: WHITE });
    const chosen = chooseCheckersBotMove(state, () => 0);
    assert.deepStrictEqual(chosen, { from: 16, to: 9 });
  });

  console.log("\nAll checkers rules tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
