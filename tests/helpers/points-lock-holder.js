/**
 * Hold a proper-lockfile lock on a points file, then release.
 *
 * Usage:
 *   node tests/helpers/points-lock-holder.js <pointsFile> <holdMs>
 *
 * Prints LOCKED then RELEASED on stdout. Does not mutate the JSON contents.
 */

const lockfile = require("proper-lockfile");

const pointsFile = process.argv[2];
const holdMs = Number.parseInt(process.argv[3], 10);

if (!pointsFile || !Number.isInteger(holdMs) || holdMs < 0) {
  console.error(
    "Usage: node tests/helpers/points-lock-holder.js <pointsFile> <holdMs>"
  );
  process.exit(2);
}

try {
  const release = lockfile.lockSync(pointsFile, {
    stale: 10_000,
    realpath: false,
  });
  process.stdout.write("LOCKED\n");
  setTimeout(() => {
    try {
      release();
      process.stdout.write("RELEASED\n");
      process.exit(0);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
  }, holdMs);
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
