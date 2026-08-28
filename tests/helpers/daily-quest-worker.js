/**
 * Worker for Daily Quest concurrency.
 * node tests/helpers/daily-quest-worker.js <mode> <shopFile> <walletFile> <userId> <now> [amountOrQuestId]
 * mode: community | game | xp | fill | complete
 */

const {
  noteDailyQuestCommunity,
  noteDailyQuestGame,
  noteDailyQuestXp,
  fillDailyQuest,
  completeSelectedQuests,
} = require("../../services/dailyQuest");

const mode = process.argv[2];
const shopFile = process.argv[3];
const walletFile = process.argv[4];
const userId = process.argv[5];
const now = Number(process.argv[6]);
const extra = process.argv[7];

if (!mode || !shopFile || !walletFile || !userId || !Number.isFinite(now)) {
  process.exit(2);
}

const options = { shopFile, walletFile, now };

try {
  let result;
  if (mode === "community") {
    result = noteDailyQuestCommunity(userId, options);
  } else if (mode === "game") {
    result = noteDailyQuestGame(userId, "trivia", options);
  } else if (mode === "xp") {
    result = noteDailyQuestXp(userId, Number(extra || "1"), options);
  } else if (mode === "fill") {
    result = fillDailyQuest(userId, extra, options);
  } else if (mode === "complete") {
    result = completeSelectedQuests(userId, options);
  } else {
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exit(1);
}
