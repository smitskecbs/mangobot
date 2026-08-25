/**
 * Worker for Daily Quest concurrency.
 * node tests/helpers/daily-quest-worker.js <mode> <shopFile> <walletFile> <userId> <now> [amount]
 * mode: community | game | xp
 */

const {
  noteDailyQuestCommunity,
  noteDailyQuestGame,
  noteDailyQuestXp,
} = require("../../services/dailyQuest");

const mode = process.argv[2];
const shopFile = process.argv[3];
const walletFile = process.argv[4];
const userId = process.argv[5];
const now = Number(process.argv[6]);
const amount = Number(process.argv[7] || "1");

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
    result = noteDailyQuestXp(userId, amount, options);
  } else {
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  process.stderr.write(err && err.message ? err.message : String(err));
  process.exit(1);
}
