/**
 * Cross-process worker for mixed chat + game XP concurrency tests.
 *
 * Modes:
 *   chat  — awardDailyActivityPoint for distinct user ids (each +1)
 *   snake — awardSnakeGameXp for distinct user ids (each +1)
 *   trigger — awardTriggerPoints gmango for distinct user ids (each +2)
 *
 * Usage:
 *   node tests/helpers/game-xp-concurrency-worker.js <pointsFile> <mode> <count> <idBase>
 */

const {
  awardDailyActivityPoint,
  awardSnakeGameXp,
  awardTriggerPoints,
} = require("../../services/points");

const pointsFile = process.argv[2];
const mode = process.argv[3];
const count = Number.parseInt(process.argv[4], 10);
const idBase = Number.parseInt(process.argv[5], 10);

if (
  !pointsFile ||
  !mode ||
  !Number.isInteger(count) ||
  count < 0 ||
  !Number.isInteger(idBase)
) {
  console.error(
    "Usage: node tests/helpers/game-xp-concurrency-worker.js <pointsFile> <chat|snake|trigger> <count> <idBase>"
  );
  process.exit(2);
}

try {
  for (let i = 0; i < count; i += 1) {
    const userId = String(idBase + i);
    const name = `User${userId}`;

    if (mode === "chat") {
      awardDailyActivityPoint(userId, name, pointsFile);
    } else if (mode === "snake") {
      awardSnakeGameXp(userId, name, pointsFile);
    } else if (mode === "trigger") {
      awardTriggerPoints(userId, name, "gmango", pointsFile);
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }
  }
  process.exit(0);
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
