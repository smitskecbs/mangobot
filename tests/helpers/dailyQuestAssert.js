/**
 * Assertions for rotating Daily Quest game slots in TTT/C4/Blackjack tests.
 */

const assert = require("assert");
const { QUEST_IDS, ACTIVITY_LOOT } = require("../../services/dailyQuest");

function selectedGameQuest(snap) {
  return (snap.questList || []).find((q) => q.category === "game") || null;
}

function expectedPvpGameLoot(snap, { vsBot = false, linked = true } = {}) {
  if (!linked) {
    return 0;
  }
  const g = selectedGameQuest(snap);
  if (!g) {
    return 0;
  }
  if (g.id === QUEST_IDS.TRIVIA_1) {
    return 0;
  }
  if (g.id === QUEST_IDS.PVP_GAME_1 && vsBot) {
    return 0;
  }
  return ACTIVITY_LOOT;
}

function assertEligibleBotGameProgress(snap, { trivia = false } = {}) {
  const g = selectedGameQuest(snap);
  assert.ok(g, "selected game quest");
  if (g.id === QUEST_IDS.PVP_GAME_1) {
    assert.strictEqual(g.completed, false);
    return g;
  }
  if (g.id === QUEST_IDS.TRIVIA_1) {
    assert.strictEqual(g.completed, Boolean(trivia));
    return g;
  }
  assert.strictEqual(g.completed, true);
  return g;
}

function assertPvpFillsGameQuest(snap, { vsBot = false } = {}) {
  const g = selectedGameQuest(snap);
  assert.ok(g, "selected game quest");
  if (g.id === QUEST_IDS.TRIVIA_1) {
    assert.strictEqual(g.completed, false);
    return g;
  }
  if (g.id === QUEST_IDS.PVP_GAME_1) {
    assert.strictEqual(g.completed, !vsBot);
    return g;
  }
  assert.strictEqual(g.completed, true);
  return g;
}

module.exports = {
  selectedGameQuest,
  expectedPvpGameLoot,
  assertPvpFillsGameQuest,
  assertEligibleBotGameProgress,
};
