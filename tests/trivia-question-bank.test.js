/**
 * Trivia question bank integrity.
 * Run: node tests/trivia-question-bank.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const {
  TRIVIA_QUESTIONS,
  ACTIVE_CATEGORY_IDS,
  MIN_PER_ACTIVE_CATEGORY,
  pickTriviaQuestion,
  validateTriviaQuestionBank,
  filterQuestionsByCategory,
  countQuestionsByCategory,
  countQuestionsByDifficulty,
  isActiveCategoryId,
} = require("../services/triviaQuestions");
const EXTRA_QUESTIONS = require("../services/triviaQuestionBankExtra");
const { createTriviaService } = require("../services/trivia");
const {
  awardTriviaAttemptXp,
  TRIVIA_DAILY_ATTEMPT_CAP,
  TRIVIA_ATTEMPT_XP,
} = require("../services/points");
const { setMangoShopFileForTests } = require("../services/mangoShopStore");

const COMMUNITY_CHAT = -1001234567890;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);
setMangoShopFileForTests(path.join(os.tmpdir(), "mango-trivia-bank-shop.json"));

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function firstGenOr(gen) {
  return Math.max(0, Number(gen) - 1) || 0;
}

async function main() {
  await runTest("11. all question ids unique", () => {
    const ids = TRIVIA_QUESTIONS.map((q) => q.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  await runTest("12. every question has valid category", () => {
    for (const q of TRIVIA_QUESTIONS) {
      assert.ok(isActiveCategoryId(q.category), q.id);
    }
  });

  await runTest("13. exactly one correct answer", () => {
    for (const q of TRIVIA_QUESTIONS) {
      assert.ok(Number.isInteger(q.correctIndex));
      assert.ok(q.correctIndex >= 0 && q.correctIndex <= 3);
      const correct = q.answers[q.correctIndex];
      assert.ok(typeof correct === "string" && correct.trim());
      const matches = q.answers.filter(
        (a) => a.trim().toLowerCase() === correct.trim().toLowerCase()
      );
      assert.strictEqual(matches.length, 1, q.id);
    }
  });

  await runTest("14. 4 answers where expected", () => {
    for (const q of TRIVIA_QUESTIONS) {
      assert.strictEqual(q.answers.length, 4, q.id);
    }
  });

  await runTest("15. no empty question", () => {
    for (const q of TRIVIA_QUESTIONS) {
      assert.ok(q.question && q.question.trim(), q.id);
      for (const a of q.answers) {
        assert.ok(a && String(a).trim(), q.id);
      }
    }
  });

  await runTest("16. math safe/no eval", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../services/triviaQuestions.js"),
      "utf8"
    );
    assert.ok(!/\beval\s*\(/.test(src));
    assert.ok(!/new Function/.test(src));
    const math = TRIVIA_QUESTIONS.filter((q) => q.category === "math");
    assert.ok(math.length >= MIN_PER_ACTIVE_CATEGORY);
    const twelveTimesEight = math.find((q) => q.question.includes("12 × 8"));
    assert.ok(twelveTimesEight);
    assert.strictEqual(twelveTimesEight.answers[twelveTimesEight.correctIndex], "96");
    const percent = math.find((q) => q.question.includes("25% of 80"));
    assert.ok(percent);
    assert.strictEqual(percent.answers[percent.correctIndex], "20");
  });

  await runTest("17. Random draws active categories", () => {
    const pool = filterQuestionsByCategory(TRIVIA_QUESTIONS, "random");
    assert.ok(pool.length >= 180);
    assert.ok(pool.every((q) => ACTIVE_CATEGORY_IDS.includes(q.category)));
    const seen = new Set();
    let recent = [];
    for (let i = 0; i < 80; i += 1) {
      const picked = pickTriviaQuestion(
        TRIVIA_QUESTIONS,
        recent,
        () => Math.random(),
        10,
        "random"
      );
      recent = picked.recentIds;
      seen.add(picked.question.category);
    }
    assert.ok(seen.size >= 3);
  });

  await runTest("18. category filter correct", () => {
    const counts = countQuestionsByCategory();
    for (const id of ACTIVE_CATEGORY_IDS) {
      assert.ok(counts[id] >= MIN_PER_ACTIVE_CATEGORY, `${id}=${counts[id]}`);
      const filtered = filterQuestionsByCategory(TRIVIA_QUESTIONS, id);
      assert.strictEqual(filtered.length, counts[id]);
      assert.ok(filtered.every((q) => q.category === id));
    }
    const result = validateTriviaQuestionBank();
    assert.strictEqual(result.ok, true, result.errors.join("; "));
  });

  await runTest("19. no immediate repeat where implemented", async () => {
    const geo = filterQuestionsByCategory(TRIVIA_QUESTIONS, "geography");
    let recent = [];
    const first = pickTriviaQuestion(geo, recent, () => 0, 10, "geography");
    recent = first.recentIds;
    const second = pickTriviaQuestion(geo, recent, () => 0, 10, "geography");
    assert.notStrictEqual(second.question.id, first.question.id);

    const service = createTriviaService({
      questions: geo,
      random: () => 0,
      randomIdFn: () => "aa11bb",
    });
    const started = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      hubMode: true,
      category: "geography",
    });
    const q1 = started.session.questionId;
    await service.tryAnswer({
      sessionId: started.session.id,
      userId: 1,
      answerIndex: started.session.correctIndex,
      chatId: COMMUNITY_CHAT,
      displayName: "A",
    });
    const next = service.nextHubQuestion();
    assert.strictEqual(next.ok, true);
    assert.notStrictEqual(next.session.questionId, q1);
    service.reset();
  });

  await runTest("41-47. extra bank and full bank pass schema validation", () => {
    assert.ok(EXTRA_QUESTIONS.length >= 150, `new questions=${EXTRA_QUESTIONS.length}`);
    const extraCheck = validateTriviaQuestionBank(EXTRA_QUESTIONS, {
      isProductionBank: false,
    });
    assert.strictEqual(extraCheck.ok, true, extraCheck.errors.join("; "));
    const full = validateTriviaQuestionBank();
    assert.strictEqual(full.ok, true, full.errors.join("; "));
    const texts = new Set();
    for (const q of TRIVIA_QUESTIONS) {
      assert.ok(["easy", "medium", "hard"].includes(q.difficulty), q.id);
      assert.ok(isActiveCategoryId(q.category), q.id);
      assert.strictEqual(q.answers.length, 4, q.id);
      assert.ok(Number.isInteger(q.correctIndex));
      assert.ok(q.correctIndex >= 0 && q.correctIndex <= 3, q.id);
      const seen = new Set();
      for (const a of q.answers) {
        assert.ok(String(a).trim(), q.id);
        const key = String(a).trim().toLowerCase();
        assert.ok(!seen.has(key), q.id);
        seen.add(key);
      }
      const t = q.question.trim().toLowerCase();
      assert.ok(!texts.has(t), q.id);
      texts.add(t);
    }
  });

  await runTest("48-51. easy/medium/hard are selectable and drawn in normal Trivia", () => {
    const counts = countQuestionsByDifficulty();
    assert.ok(counts.easy >= 1);
    assert.ok(counts.medium >= 1);
    assert.ok(counts.hard >= 1);
    const pickAt = (roll) => {
      let n = 0;
      return pickTriviaQuestion(
        TRIVIA_QUESTIONS,
        [],
        () => {
          n += 1;
          return n === 1 ? roll : 0;
        },
        10,
        "random"
      ).question;
    };
    assert.strictEqual(pickAt(0).difficulty, "easy");
    assert.strictEqual(pickAt(0.4).difficulty, "medium");
    assert.strictEqual(pickAt(0.9).difficulty, "hard");
    const seen = new Set();
    for (let i = 0; i < 40; i += 1) {
      const picked = pickTriviaQuestion(
        TRIVIA_QUESTIONS,
        [],
        () => Math.random(),
        10,
        "random"
      );
      seen.add(picked.question.difficulty);
    }
    assert.ok(seen.has("easy") && seen.has("medium") && seen.has("hard"));
  });

  await runTest("52. category filtering still works after expansion", () => {
    for (const id of ACTIVE_CATEGORY_IDS) {
      const filtered = filterQuestionsByCategory(TRIVIA_QUESTIONS, id);
      assert.ok(filtered.length >= MIN_PER_ACTIVE_CATEGORY, id);
      assert.ok(filtered.every((q) => q.category === id));
    }
  });

  await runTest("53-55. session uniqueness and questionGen work across difficulties", async () => {
    const mixed = [
      {
        id: "e1",
        category: "math",
        question: "easy q",
        answers: ["1", "2", "3", "4"],
        correctIndex: 0,
        difficulty: "easy",
      },
      {
        id: "m1",
        category: "math",
        question: "medium q",
        answers: ["a", "b", "c", "d"],
        correctIndex: 1,
        difficulty: "medium",
      },
      {
        id: "h1",
        category: "math",
        question: "hard q",
        answers: ["w", "x", "y", "z"],
        correctIndex: 2,
        difficulty: "hard",
      },
    ];
    const service = createTriviaService({
      questions: mixed,
      random: () => 0,
      randomIdFn: () => "aa11bb",
    });
    const started = service.startTrivia({
      chatId: COMMUNITY_CHAT,
      hubMode: true,
      category: "math",
      userId: 1,
    });
    const seen = new Set([started.session.questionId]);
    let gen = started.session.questionGen;
    for (let i = 0; i < 2; i += 1) {
      const snap = service.getSnapshot(started.session.id);
      const answered = await service.tryAnswer({
        sessionId: started.session.id,
        userId: 1,
        answerIndex: snap.correctIndex,
        chatId: COMMUNITY_CHAT,
        displayName: "A",
        questionGen: snap.questionGen,
      });
      assert.strictEqual(answered.ok, true);
      const next = service.nextHubQuestion(started.session.id, 1, snap.questionGen);
      assert.strictEqual(next.ok, true);
      assert.ok(!seen.has(next.session.questionId));
      seen.add(next.session.questionId);
      assert.strictEqual(next.session.questionGen, gen + 1);
      gen = next.session.questionGen;
      const stale = await service.tryAnswer({
        sessionId: started.session.id,
        userId: 1,
        answerIndex: 0,
        chatId: COMMUNITY_CHAT,
        displayName: "A",
        questionGen: firstGenOr(snap.questionGen),
      });
      assert.strictEqual(stale.ok, false);
    }
    service.reset();
  });

  await runTest("56-58. difficulty does not change XP, cap, or Daily Quest rules", async () => {
    assert.strictEqual(TRIVIA_DAILY_ATTEMPT_CAP, 5);
    assert.strictEqual(TRIVIA_ATTEMPT_XP, 1);
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "mango-trivia-diff-")),
      "points.json"
    );
    const hardBank = [
      {
        id: "hard-xp",
        category: "science",
        question: "hard xp q",
        answers: ["a", "b", "c", "d"],
        correctIndex: 0,
        difficulty: "hard",
      },
    ];
    const easyBank = [
      {
        id: "easy-xp",
        category: "science",
        question: "easy xp q",
        answers: ["a", "b", "c", "d"],
        correctIndex: 0,
        difficulty: "easy",
      },
    ];
    async function play(questions, userId) {
      const service = createTriviaService({
        questions,
        random: () => 0,
        randomIdFn: () => `id${userId}`,
      });
      service.setAwardXpHandler((uid, name, payload) =>
        awardTriviaAttemptXp(uid, name, payload, file)
      );
      const started = service.startTrivia({
        chatId: COMMUNITY_CHAT,
        hubMode: true,
        category: "science",
        userId,
        displayName: "P",
      });
      const result = await service.tryAnswer({
        sessionId: started.session.id,
        userId,
        answerIndex: started.session.correctIndex,
        chatId: COMMUNITY_CHAT,
        displayName: "P",
        questionGen: started.session.questionGen,
      });
      service.reset();
      return result.xpResult;
    }
    const easyXp = await play(easyBank, 11);
    const hardXp = await play(hardBank, 12);
    assert.strictEqual(easyXp.awarded, true);
    assert.strictEqual(hardXp.awarded, true);
    assert.strictEqual(easyXp.pointsToAdd, TRIVIA_ATTEMPT_XP);
    assert.strictEqual(hardXp.pointsToAdd, TRIVIA_ATTEMPT_XP);
    assert.strictEqual(easyXp.attemptsUsed, 1);
    assert.strictEqual(hardXp.attemptsUsed, 1);
  });

  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  console.log("\nAll trivia-question-bank tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
