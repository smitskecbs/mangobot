/**
 * Trivia question bank integrity.
 * Run: node tests/trivia-question-bank.test.js
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const {
  TRIVIA_QUESTIONS,
  ACTIVE_CATEGORY_IDS,
  MIN_PER_ACTIVE_CATEGORY,
  pickTriviaQuestion,
  validateTriviaQuestionBank,
  filterQuestionsByCategory,
  countQuestionsByCategory,
  isActiveCategoryId,
} = require("../services/triviaQuestions");
const { createTriviaService } = require("../services/trivia");

const COMMUNITY_CHAT = -1001234567890;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
process.env.TELEGRAM_CHAT_ID = String(COMMUNITY_CHAT);

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function main() {
  runTest("11. all question ids unique", () => {
    const ids = TRIVIA_QUESTIONS.map((q) => q.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  runTest("12. every question has valid category", () => {
    for (const q of TRIVIA_QUESTIONS) {
      assert.ok(isActiveCategoryId(q.category), q.id);
    }
  });

  runTest("13. exactly one correct answer", () => {
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

  runTest("14. 4 answers where expected", () => {
    for (const q of TRIVIA_QUESTIONS) {
      assert.strictEqual(q.answers.length, 4, q.id);
    }
  });

  runTest("15. no empty question", () => {
    for (const q of TRIVIA_QUESTIONS) {
      assert.ok(q.question && q.question.trim(), q.id);
      for (const a of q.answers) {
        assert.ok(a && String(a).trim(), q.id);
      }
    }
  });

  runTest("16. math safe/no eval", () => {
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

  runTest("17. Random draws active categories", () => {
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

  runTest("18. category filter correct", () => {
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

  runTest("19. no immediate repeat where implemented", () => {
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
    service.tryAnswer({
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

  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
  console.log("\nAll trivia-question-bank tests passed.");
}

main();
