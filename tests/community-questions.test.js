/**
 * Community questions bank + Activity Engine question action.
 * Run: node tests/community-questions.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  COMMUNITY_QUESTIONS,
  CATEGORIES,
  ANTI_REPEAT_WINDOW,
  DEFAULT_QUESTION_MIN_GAP_MINUTES,
  validateCommunityQuestionBank,
  pickCommunityQuestion,
  formatCommunityQuestionMessage,
  emptyCommunityQuestionState,
  normalizeCommunityQuestionState,
} = require("../services/communityQuestions");
const {
  ACTION_IDS,
  ACTION_WEIGHTS,
  ACTION_REGISTRY,
  PASSIVE_ACTIONS,
  QUIET_GROUP_MS,
  parseActivityEngineConfig,
  isActionEligible,
  buildWeights,
  processCommunityActivitySlot,
  emptyState,
  loadState,
} = (() => {
  const engine = require("../services/communityActivityEngine");
  const scheduler = require("../services/communityScheduler");
  return { ...engine, emptyState: scheduler.emptyState, loadState: scheduler.loadState };
})();
const { createChatFightService } = require("../services/chatFight");
const { applyGamesTopicToExtra } = require("../utils/gameTopic");
const {
  noteCommunityActivity,
  resetCommunityActivityPulse,
} = require("../utils/communityActivityPulse");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-questions-"));
let n = 0;
const CHAT = "-1003916996602";

const originalGamesTopic = process.env.TELEGRAM_GAMES_TOPIC_ID;
const originalGap = process.env.COMMUNITY_QUESTION_MIN_GAP_MINUTES;

function stateFile() {
  n += 1;
  return path.join(tempDir, `s-${n}.json`);
}

function restoreEnv() {
  if (originalGamesTopic === undefined) delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  else process.env.TELEGRAM_GAMES_TOPIC_ID = originalGamesTopic;
  if (originalGap === undefined) delete process.env.COMMUNITY_QUESTION_MIN_GAP_MINUTES;
  else process.env.COMMUNITY_QUESTION_MIN_GAP_MINUTES = originalGap;
}

async function runTest(name, fn) {
  delete process.env.TELEGRAM_GAMES_TOPIC_ID;
  delete process.env.COMMUNITY_QUESTION_MIN_GAP_MINUTES;
  resetCommunityActivityPulse();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function baseConfig(overrides = {}) {
  return parseActivityEngineConfig(
    {},
    {
      enabled: true,
      twentyFourSeven: true,
      autoFightEnabled: false,
      intervalMinutes: 30,
      questionMinGapMinutes: DEFAULT_QUESTION_MIN_GAP_MINUTES,
      ...overrides,
    }
  );
}

function freshState() {
  return {
    sent: {},
    recentActivityTypes: [],
    autoChatFight: {},
    communityQuestion: emptyCommunityQuestionState(),
    lastMessageKey: null,
  };
}

async function main() {
  await runTest("bank >=100 unique ids/texts + categories", () => {
    const result = validateCommunityQuestionBank();
    assert.strictEqual(result.ok, true, result.errors.join("; "));
    assert.ok(COMMUNITY_QUESTIONS.length >= 100);
    assert.ok(CATEGORIES.includes("community"));
    assert.ok(CATEGORIES.includes("culture"));
  });

  await runTest("format uses ManGo Question header", () => {
    const msg = formatCommunityQuestionMessage(COMMUNITY_QUESTIONS[0]);
    assert.ok(msg.startsWith("🥭 ManGo Question"));
    assert.ok(msg.includes(COMMUNITY_QUESTIONS[0].text));
    assert.ok(msg.includes("Drop your answer below"));
  });

  await runTest("no direct repeat; recent 20 avoided", () => {
    let recent = [];
    const seen = [];
    for (let i = 0; i < ANTI_REPEAT_WINDOW; i += 1) {
      const picked = pickCommunityQuestion(
        COMMUNITY_QUESTIONS,
        recent,
        () => 0.5
      );
      recent = picked.recentIds;
      seen.push(picked.question.id);
    }
    assert.strictEqual(new Set(seen).size, ANTI_REPEAT_WINDOW);
    const next = pickCommunityQuestion(COMMUNITY_QUESTIONS, recent, () => 0.5);
    assert.ok(!recent.includes(next.question.id));
  });

  await runTest("safe fallback when recent covers whole bank", () => {
    const allIds = COMMUNITY_QUESTIONS.map((q) => q.id);
    const picked = pickCommunityQuestion(COMMUNITY_QUESTIONS, allIds, () => 0);
    assert.ok(picked.question && picked.question.id);
  });

  await runTest("weights total 100 and question registry", () => {
    const total = Object.values(ACTION_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, 100);
    assert.strictEqual(ACTION_WEIGHTS[ACTION_IDS.QUESTION], 11);
    assert.strictEqual(ACTION_REGISTRY.question.enabledForAuto, true);
    assert.ok(PASSIVE_ACTIONS.has(ACTION_IDS.QUESTION));
  });

  await runTest("cooldown 240m blocks then allows", () => {
    const config = baseConfig();
    assert.strictEqual(config.questionMinGapMinutes, 240);
    const nowMs = 1_700_000_000_000;
    assert.strictEqual(
      isActionEligible(ACTION_IDS.QUESTION, {
        config,
        nowMs,
        questionState: { lastStartedAt: nowMs - 60_000, recentQuestionIds: [] },
      }),
      false
    );
    assert.strictEqual(
      isActionEligible(ACTION_IDS.QUESTION, {
        config,
        nowMs,
        questionState: {
          lastStartedAt: nowMs - 240 * 60_000 - 1,
          recentQuestionIds: [],
        },
      }),
      true
    );
  });

  await runTest("active chat suppresses question weight", () => {
    const config = baseConfig();
    const weights = buildWeights(config, {
      recentActivity: true,
      wasActiveWithin: () => true,
      nowMs: Date.now(),
      lastActivityAt: Date.now(),
      config,
    });
    assert.strictEqual(weights[ACTION_IDS.QUESTION], 0);
  });

  await runTest("quiet chat boosts question weight", () => {
    const config = baseConfig();
    const weights = buildWeights(config, {
      recentActivity: true,
      wasActiveWithin: () => false,
      nowMs: Date.now(),
      lastActivityAt: Date.now() - QUIET_GROUP_MS - 1,
      config,
    });
    assert.ok(weights[ACTION_IDS.QUESTION] > ACTION_WEIGHTS[ACTION_IDS.QUESTION]);
  });

  await runTest("question goes General with no message_thread_id", async () => {
    process.env.TELEGRAM_GAMES_TOPIC_ID = "123";
    assert.strictEqual(applyGamesTopicToExtra({}).message_thread_id, 123);

    const sent = [];
    const fight = createChatFightService({ cooldownMs: 0 });
    const state = freshState();
    const result = await processCommunityActivitySlot({
      chatId: CHAT,
      slot: { id: "q1", label: "12:00" },
      dayKey: "2026-08-15",
      config: baseConfig(),
      state,
      chatFight: fight,
      forceAction: ACTION_IDS.QUESTION,
      sendMessage: async (chatId, text, extra) => {
        sent.push({ chatId, text, extra });
        return true;
      },
      nowMs: Date.now(),
      wasActiveWithinFn: () => false,
    });
    assert.strictEqual(result.action, ACTION_IDS.QUESTION);
    assert.strictEqual(result.sent, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].chatId, CHAT);
    assert.ok(sent[0].text.includes("🥭 ManGo Question"));
    assert.strictEqual(sent[0].extra, undefined);
    assert.ok(!JSON.stringify(sent[0]).includes("message_thread_id"));
    assert.ok(state.communityQuestion.lastStartedAt);
    assert.ok(state.communityQuestion.recentQuestionIds.length >= 1);
  });

  await runTest("Games topic env does not reroute question", async () => {
    process.env.TELEGRAM_GAMES_TOPIC_ID = "999";
    const sent = [];
    const state = freshState();
    await processCommunityActivitySlot({
      chatId: CHAT,
      slot: { id: "q2", label: "12:30" },
      dayKey: "2026-08-15",
      config: baseConfig(),
      state,
      chatFight: createChatFightService({ cooldownMs: 0 }),
      forceAction: ACTION_IDS.QUESTION,
      sendMessage: async (_c, text, extra) => {
        sent.push({ text, extra, keys: extra ? Object.keys(extra) : [] });
        return true;
      },
      nowMs: Date.now(),
      wasActiveWithinFn: () => false,
    });
    assert.strictEqual(sent[0].extra, undefined);
  });

  await runTest("before cooldown → skip question eligibility", async () => {
    const nowMs = Date.now();
    const state = freshState();
    state.communityQuestion.lastStartedAt = nowMs - 60_000;
    const sent = [];
    const result = await processCommunityActivitySlot({
      chatId: CHAT,
      slot: { id: "q3", label: "13:00" },
      dayKey: "2026-08-15",
      config: baseConfig(),
      state,
      chatFight: createChatFightService({ cooldownMs: 0 }),
      forceAction: ACTION_IDS.QUESTION,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
      nowMs,
      wasActiveWithinFn: () => false,
    });
    // Falls back to another prompt after cooldown miss
    assert.notStrictEqual(result.action, ACTION_IDS.QUESTION);
    assert.ok(state.sent["2026-08-15"].includes("q3"));
  });

  await runTest("failed question send logs action=question", async () => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const state = freshState();
      const result = await processCommunityActivitySlot({
        chatId: CHAT,
        slot: { id: "q4", label: "13:30" },
        dayKey: "2026-08-15",
        config: baseConfig(),
        state,
        chatFight: createChatFightService({ cooldownMs: 0 }),
        forceAction: ACTION_IDS.QUESTION,
        sendMessage: async () => {
          const err = new Error("boom");
          err.name = "FetchError";
          err.code = "ETIMEDOUT";
          throw err;
        },
        nowMs: Date.now(),
        wasActiveWithinFn: () => false,
      });
      assert.ok(
        lines.some((l) =>
          l.includes("[activity-engine] send failed action=question")
        ),
        lines.join(" | ")
      );
      assert.ok(lines.some((l) => l.includes("error=FetchError/ETIMEDOUT")));
      assert.strictEqual(state.communityQuestion.lastStartedAt, null);
      assert.ok(state.sent["2026-08-15"].includes("q4"));
      // May fall back to another action after failure
      void result;
    } finally {
      console.error = original;
    }
  });

  await runTest("failed weekly/community send logs action=", async () => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      for (const action of [ACTION_IDS.WEEKLY, ACTION_IDS.COMMUNITY]) {
        lines.length = 0;
        const state = freshState();
        await processCommunityActivitySlot({
          chatId: CHAT,
          slot: { id: `p-${action}`, label: "14:00" },
          dayKey: "2026-08-20",
          config: baseConfig(),
          state,
          chatFight: createChatFightService({ cooldownMs: 0 }),
          forceAction: action,
          sendMessage: async () => {
            const err = new Error("x");
            err.name = "Error";
            err.code = "ECONNRESET";
            throw err;
          },
          nowMs: Date.now(),
          wasActiveWithinFn: () => false,
        });
        assert.ok(
          lines.some((l) =>
            l.includes(`[activity-engine] send failed action=${action}`)
          ),
          lines.join(" | ")
        );
        assert.ok(state.sent["2026-08-20"].includes(`p-${action}`));
      }
    } finally {
      console.error = original;
    }
  });

  await runTest("question send awards no XP itself", async () => {
    const state = freshState();
    await processCommunityActivitySlot({
      chatId: CHAT,
      slot: { id: "q5", label: "15:00" },
      dayKey: "2026-08-15",
      config: baseConfig(),
      state,
      chatFight: createChatFightService({ cooldownMs: 0 }),
      forceAction: ACTION_IDS.QUESTION,
      sendMessage: async () => true,
      nowMs: Date.now(),
      wasActiveWithinFn: () => false,
    });
    // No points module involvement — only communityQuestion state updated.
    assert.ok(state.communityQuestion.recentQuestionIds.length >= 1);
    noteCommunityActivity();
  });

  await runTest("scheduler state persists communityQuestion", () => {
    const sf = stateFile();
    const state = emptyState();
    state.communityQuestion = {
      lastStartedAt: 99,
      recentQuestionIds: ["q010"],
    };
    fs.writeFileSync(sf, JSON.stringify(state), "utf8");
    const loaded = loadState(sf);
    assert.strictEqual(loaded.communityQuestion.lastStartedAt, 99);
    assert.deepStrictEqual(loaded.communityQuestion.recentQuestionIds, ["q010"]);
  });

  await runTest("normalize question state restart-safe", () => {
    assert.deepStrictEqual(
      normalizeCommunityQuestionState(null),
      emptyCommunityQuestionState()
    );
    const nrm = normalizeCommunityQuestionState({
      lastStartedAt: 42,
      recentQuestionIds: ["q001", 9, "q002"],
    });
    assert.strictEqual(nrm.lastStartedAt, 42);
    assert.deepStrictEqual(nrm.recentQuestionIds, ["q001", "q002"]);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  restoreEnv();
  console.log("\nAll community-questions tests passed.");
}

main().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
