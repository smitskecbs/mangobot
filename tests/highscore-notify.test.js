/**
 * Highscore Telegram notify payload, logging, and send-failure semantics.
 * Run: node tests/highscore-notify.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  missingTelegramNotifyKeys,
  formatTelegramNotifyDisabledLog,
  redactTelegramSecrets,
  summarizeTelegramApiError,
  formatTelegramNotifyFailureLog,
  buildHighscoreSendMessagePayload,
  sendHighscoreTelegramMessage,
} = require("../services/highscoreNotify");
const {
  submitScore,
  writeScoresFile,
  createEmptyScores,
  readScoresFile,
  buildApiResponse,
  buildPersonalBestMessage,
} = require("../services/snakeScores");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-hs-notify-"));
const scoresFile = path.join(tempDir, "snake-highscores.json");

const originalTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;

function runTest(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result
      .then(() => {
        console.log(`✓ ${name}`);
      })
      .catch((err) => {
        console.error(`✗ ${name}`);
        throw err;
      });
  }
  console.log(`✓ ${name}`);
  return Promise.resolve();
}

function restoreTopic() {
  if (originalTopic === undefined) {
    delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  } else {
    process.env.TELEGRAM_GAMES_TOPIC_ID = originalTopic;
  }
}

async function main() {
  writeScoresFile(scoresFile, createEmptyScores());

  await runTest("missing config lists key names only", () => {
    assert.deepStrictEqual(missingTelegramNotifyKeys("", ""), [
      "BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
    ]);
    assert.deepStrictEqual(missingTelegramNotifyKeys("tok", ""), ["TELEGRAM_CHAT_ID"]);
    const line = formatTelegramNotifyDisabledLog(["BOT_TOKEN"]);
    assert.ok(line.includes("missing=BOT_TOKEN"));
    assert.ok(!line.includes("tok"));
    assert.ok(!line.includes("123:ABC"));
  });

  await runTest("Telegram error body is logged without secrets", () => {
    const summary = summarizeTelegramApiError(
      400,
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found bot123456:AASECRETTOKENVALUEHERE",
      })
    );
    assert.strictEqual(summary.status, 400);
    assert.strictEqual(summary.errorCode, "400");
    assert.ok(summary.description.includes("chat not found"));
    assert.ok(!summary.description.includes("AASECRETTOKENVALUEHERE"));
    const line = formatTelegramNotifyFailureLog(summary);
    assert.ok(line.includes("status=400"));
    assert.ok(line.includes("error_code=400"));
    assert.ok(!line.includes("AASECRETTOKENVALUEHERE"));
    assert.ok(!redactTelegramSecrets("bot111:AASECRETTOKENVALUEHERE").includes("AASECRET"));
  });

  await runTest("topic id is omitted when TELEGRAM_GAMES_TOPIC_ID is unset", () => {
    delete process.env.TELEGRAM_GAMES_TOPIC_ID;
    const payload = buildHighscoreSendMessagePayload("hello", "-1001");
    assert.strictEqual(payload.chat_id, "-1001");
    assert.strictEqual(payload.text, "hello");
    assert.strictEqual(payload.disable_web_page_preview, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, "message_thread_id"));
  });

  await runTest("topic id is sent only when TELEGRAM_GAMES_TOPIC_ID is set", () => {
    process.env.TELEGRAM_GAMES_TOPIC_ID = "12345";
    const payload = buildHighscoreSendMessagePayload("hello", "-1001");
    assert.strictEqual(payload.message_thread_id, 12345);
    delete process.env.TELEGRAM_GAMES_TOPIC_ID;
    const without = buildHighscoreSendMessagePayload("hello", "-1001");
    assert.ok(!Object.prototype.hasOwnProperty.call(without, "message_thread_id"));
  });

  await runTest("successful Telegram announcement returns posted true", async () => {
    const calls = [];
    const posted = await sendHighscoreTelegramMessage("🏆 NEW", {
      botToken: "111:testtoken",
      chatId: "-1001",
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
      },
      log() {},
      logError() {},
    });
    assert.strictEqual(posted, true);
    assert.strictEqual(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.chat_id, "-1001");
    assert.strictEqual(body.text, "🏆 NEW");
  });

  await runTest("Telegram send failure keeps saved score and telegram_send_failed", async () => {
    writeScoresFile(scoresFile, createEmptyScores());
    const { data, result } = submitScore(scoresFile, "Ada", 420);
    assert.strictEqual(result.personalBest, true);
    assert.strictEqual(readScoresFile(scoresFile).leaderboard[0].score, 420);

    const logs = [];
    const posted = await sendHighscoreTelegramMessage(
      buildPersonalBestMessage(result.name, result.score, result.rank, "ManGoTestBot"),
      {
        botToken: "111:testtoken",
        chatId: "-1001",
        fetchFn: async () => ({
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({
              ok: false,
              error_code: 403,
              description: "Forbidden: bot is not a member of the chat",
            }),
        }),
        log() {},
        logError(line) {
          logs.push(String(line));
        },
      }
    );

    assert.strictEqual(posted, false);
    assert.strictEqual(readScoresFile(scoresFile).leaderboard[0].score, 420);
    const response = buildApiResponse(data, {
      posted: false,
      personalBest: true,
      personalBestImproved: true,
      score: result.score,
      personalBestScore: result.personalBestScore,
      isNewGlobal: result.isNewGlobal,
      rank: result.rank,
      reason: "telegram_send_failed",
    });
    assert.strictEqual(response.posted, false);
    assert.strictEqual(response.reason, "telegram_send_failed");
    assert.strictEqual(response.personalBest, true);
    assert.ok(logs.some((line) => line.includes("status=403")));
    assert.ok(logs.some((line) => line.includes("error_code=403")));
    assert.ok(logs.every((line) => !line.includes("111:testtoken")));
  });

  await runTest("missing Telegram config does not log token values", async () => {
    const info = [];
    const posted = await sendHighscoreTelegramMessage("hi", {
      botToken: "",
      chatId: "",
      log(line) {
        info.push(String(line));
      },
      logError() {},
      fetchFn: async () => {
        throw new Error("must not send");
      },
    });
    assert.strictEqual(posted, false);
    assert.ok(info.some((line) => line.includes("missing=BOT_TOKEN,TELEGRAM_CHAT_ID")));
    assert.ok(info.every((line) => !/bot\d+:/i.test(line)));
  });

  restoreTopic();
  console.log("\nAll highscore notify tests passed.");
}

main().catch((err) => {
  restoreTopic();
  console.error(err);
  process.exit(1);
});
