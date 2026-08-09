/**
 * Cross-process worker: increment a counter user under mutatePoints lock.
 *
 * Usage:
 *   node tests/helpers/points-lock-worker.js <pointsFile> <iterations> [userId]
 */

const path = require("path");
const { mutatePoints } = require("../../services/points");

const pointsFile = process.argv[2];
const iterations = Number.parseInt(process.argv[3], 10);
const userId = String(process.argv[4] || "1");

if (!pointsFile || !Number.isInteger(iterations) || iterations < 0) {
  console.error(
    "Usage: node tests/helpers/points-lock-worker.js <pointsFile> <iterations> [userId]"
  );
  process.exit(2);
}

try {
  for (let i = 0; i < iterations; i += 1) {
    mutatePoints((data) => {
      if (!data.users[userId]) {
        data.users[userId] = {
          points: 0,
          weeklyPoints: 0,
          weekId: new Date().toISOString().slice(0, 10),
          name: "Worker",
          triggerDate: null,
          triggersUsed: [],
          activityDate: null,
        };
      }
      data.users[userId].points += 1;
      data.users[userId].weeklyPoints += 1;
    }, pointsFile);
  }
  process.exit(0);
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
