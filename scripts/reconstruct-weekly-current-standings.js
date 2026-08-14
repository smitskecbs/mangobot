#!/usr/bin/env node
/**
 * One-shot maintenance: rebuild data/weekly-winners.json current.standings
 * from points.json for the current UTC week.
 *
 * Preserves: latest, lastFinalizedWeek, announced.
 * Does NOT award XP. Does NOT post to Telegram.
 *
 * Usage (from repo root, as the bot user):
 *   node scripts/reconstruct-weekly-current-standings.js
 *
 * Optional:
 *   WEEKLY_WINNERS_FILE=/path/to/weekly-winners.json \
 *   POINTS_FILE=/path/to/points.json \
 *   node scripts/reconstruct-weekly-current-standings.js
 */

const path = require("path");
const {
  reconstructCurrentStandingsFromPoints,
  DEFAULT_WINNERS_FILE,
  readWinnersState,
} = require("../services/weeklyWinners");

const winnersFile =
  (process.env.WEEKLY_WINNERS_FILE &&
    String(process.env.WEEKLY_WINNERS_FILE).trim()) ||
  DEFAULT_WINNERS_FILE;
const pointsFile =
  (process.env.POINTS_FILE && String(process.env.POINTS_FILE).trim()) ||
  path.resolve(__dirname, "..", "points.json");

const result = reconstructCurrentStandingsFromPoints({
  winnersFile,
  pointsFile,
});

if (!result.ok) {
  console.error("[reconstruct-weekly] FAILED:", result.reason || "unknown");
  process.exit(1);
}

const state = readWinnersState(winnersFile);
console.log(
  `[reconstruct-weekly] ok week=${result.week} standings=${result.standingCount}`
);
console.log(
  `[reconstruct-weekly] preservedLatest=${result.preservedLatest} lastFinalizedWeek=${
    state.lastFinalizedWeek || "(none)"
  }`
);
process.exit(0);
