/**
 * Curated general-knowledge trivia bank (no external API).
 * International, stable facts — not politics, crypto prices, or current events.
 */

const ANTI_REPEAT_WINDOW = 10;

const TRIVIA_QUESTIONS = Object.freeze([
  // geography
  Object.freeze({
    id: "geo-01",
    category: "geography",
    question: "What is the capital of France?",
    answers: Object.freeze(["Paris", "Lyon", "Marseille", "Nice"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "geo-02",
    category: "geography",
    question: "Which is the largest ocean on Earth?",
    answers: Object.freeze(["Pacific Ocean", "Atlantic Ocean", "Indian Ocean", "Arctic Ocean"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "geo-03",
    category: "geography",
    question: "Mount Everest is located in which mountain range?",
    answers: Object.freeze(["Himalayas", "Alps", "Andes", "Rockies"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "geo-04",
    category: "geography",
    question: "Which country has the city of Cairo as its capital?",
    answers: Object.freeze(["Egypt", "Morocco", "Turkey", "Greece"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "geo-05",
    category: "geography",
    question: "Which continent is Australia part of?",
    answers: Object.freeze(["Oceania", "Asia", "Africa", "Europe"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "geo-06",
    category: "geography",
    question: "What is the longest river in the world by most traditional measures?",
    answers: Object.freeze(["Nile", "Amazon", "Yangtze", "Mississippi"]),
    correctIndex: 0,
  }),
  // science
  Object.freeze({
    id: "sci-01",
    category: "science",
    question: "What is the chemical symbol for water?",
    answers: Object.freeze(["H2O", "CO2", "O2", "NaCl"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "sci-02",
    category: "science",
    question: "How many planets are in the Solar System?",
    answers: Object.freeze(["8", "7", "9", "10"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "sci-03",
    category: "science",
    question: "What gas do plants primarily absorb for photosynthesis?",
    answers: Object.freeze(["Carbon dioxide", "Oxygen", "Nitrogen", "Hydrogen"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "sci-04",
    category: "science",
    question: "What is the hardest natural substance on Earth?",
    answers: Object.freeze(["Diamond", "Gold", "Iron", "Quartz"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "sci-05",
    category: "science",
    question: "At what Celsius temperature does water freeze at standard pressure?",
    answers: Object.freeze(["0", "32", "100", "-10"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "sci-06",
    category: "science",
    question: "Which particle has a negative electric charge?",
    answers: Object.freeze(["Electron", "Proton", "Neutron", "Photon"]),
    correctIndex: 0,
  }),
  // history
  Object.freeze({
    id: "his-01",
    category: "history",
    question: "In which year did World War II end?",
    answers: Object.freeze(["1945", "1918", "1939", "1969"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "his-02",
    category: "history",
    question: "Who was the first person to walk on the Moon?",
    answers: Object.freeze([
      "Neil Armstrong",
      "Buzz Aldrin",
      "Yuri Gagarin",
      "John Glenn",
    ]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "his-03",
    category: "history",
    question: "The ancient pyramids of Giza are in which country?",
    answers: Object.freeze(["Egypt", "Mexico", "Italy", "India"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "his-04",
    category: "history",
    question: "Which ancient civilization built Machu Picchu?",
    answers: Object.freeze(["Inca", "Maya", "Aztec", "Olmec"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "his-05",
    category: "history",
    question: "The Great Wall is most closely associated with which country?",
    answers: Object.freeze(["China", "Japan", "India", "Mongolia"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "his-06",
    category: "history",
    question: "Who painted the Mona Lisa?",
    answers: Object.freeze([
      "Leonardo da Vinci",
      "Michelangelo",
      "Raphael",
      "Vincent van Gogh",
    ]),
    correctIndex: 0,
  }),
  // animals/nature
  Object.freeze({
    id: "nat-01",
    category: "animals/nature",
    question: "What is a baby frog called?",
    answers: Object.freeze(["Tadpole", "Cub", "Chick", "Pup"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "nat-02",
    category: "animals/nature",
    question: "Which animal is known as the king of the jungle?",
    answers: Object.freeze(["Lion", "Tiger", "Elephant", "Bear"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "nat-03",
    category: "animals/nature",
    question: "How many legs does a spider typically have?",
    answers: Object.freeze(["8", "6", "10", "4"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "nat-04",
    category: "animals/nature",
    question: "Which bird is famous for being unable to fly and living in Antarctica?",
    answers: Object.freeze(["Penguin", "Ostrich", "Emu", "Kiwi"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "nat-05",
    category: "animals/nature",
    question: "What do bees collect to make honey?",
    answers: Object.freeze(["Nectar", "Pollen only", "Sap", "Dew"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "nat-06",
    category: "animals/nature",
    question: "Which is the largest living land animal?",
    answers: Object.freeze([
      "African elephant",
      "White rhinoceros",
      "Hippopotamus",
      "Giraffe",
    ]),
    correctIndex: 0,
  }),
  // technology
  Object.freeze({
    id: "tec-01",
    category: "technology",
    question: "What does CPU stand for?",
    answers: Object.freeze([
      "Central Processing Unit",
      "Computer Personal Utility",
      "Core Power Unit",
      "Central Program Utility",
    ]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "tec-02",
    category: "technology",
    question: "What does WWW stand for?",
    answers: Object.freeze([
      "World Wide Web",
      "Wide World Web",
      "Web World Wide",
      "Wireless Web Wave",
    ]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "tec-03",
    category: "technology",
    question: "Which company created the iPhone?",
    answers: Object.freeze(["Apple", "Microsoft", "Google", "Samsung"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "tec-04",
    category: "technology",
    question: "What does USB stand for?",
    answers: Object.freeze([
      "Universal Serial Bus",
      "United System Board",
      "Ultra Speed Byte",
      "Universal Storage Box",
    ]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "tec-05",
    category: "technology",
    question: "In computing, what does RAM stand for?",
    answers: Object.freeze([
      "Random Access Memory",
      "Read Access Module",
      "Rapid Application Memory",
      "Remote Access Machine",
    ]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "tec-06",
    category: "technology",
    question: "HTML is primarily used to:",
    answers: Object.freeze([
      "Structure web pages",
      "Edit photos",
      "Send emails",
      "Compress videos",
    ]),
    correctIndex: 0,
  }),
  // space
  Object.freeze({
    id: "spa-01",
    category: "space",
    question: "Which planet is known as the Red Planet?",
    answers: Object.freeze(["Mars", "Venus", "Jupiter", "Mercury"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spa-02",
    category: "space",
    question: "What is the name of our galaxy?",
    answers: Object.freeze(["Milky Way", "Andromeda", "Whirlpool", "Sombrero"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spa-03",
    category: "space",
    question: "Which planet is closest to the Sun?",
    answers: Object.freeze(["Mercury", "Venus", "Earth", "Mars"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spa-04",
    category: "space",
    question: "What force keeps planets in orbit around the Sun?",
    answers: Object.freeze(["Gravity", "Magnetism", "Friction", "Electricity"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spa-05",
    category: "space",
    question: "How many Moons does Earth have?",
    answers: Object.freeze(["1", "2", "0", "4"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spa-06",
    category: "space",
    question: "Which is the largest planet in the Solar System?",
    answers: Object.freeze(["Jupiter", "Saturn", "Neptune", "Earth"]),
    correctIndex: 0,
  }),
  // sports
  Object.freeze({
    id: "spo-01",
    category: "sports",
    question: "How many players are on the field for one soccer team?",
    answers: Object.freeze(["11", "10", "9", "12"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spo-02",
    category: "sports",
    question: "In tennis, what is a score of zero called?",
    answers: Object.freeze(["Love", "Nil", "Blank", "Void"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spo-03",
    category: "sports",
    question: "How many rings are on the Olympic flag?",
    answers: Object.freeze(["5", "4", "6", "7"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spo-04",
    category: "sports",
    question: "In basketball, how many points is a free throw worth?",
    answers: Object.freeze(["1", "2", "3", "4"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spo-05",
    category: "sports",
    question: "Which sport uses a shuttlecock?",
    answers: Object.freeze(["Badminton", "Tennis", "Squash", "Table tennis"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "spo-06",
    category: "sports",
    question: "How many bases are on a baseball diamond?",
    answers: Object.freeze(["4", "3", "5", "2"]),
    correctIndex: 0,
  }),
  // food/culture
  Object.freeze({
    id: "foo-01",
    category: "food/culture",
    question: "Sushi originated in which country?",
    answers: Object.freeze(["Japan", "China", "Korea", "Thailand"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "foo-02",
    category: "food/culture",
    question: "Which fruit is typically used to make guacamole?",
    answers: Object.freeze(["Avocado", "Tomato", "Mango", "Banana"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "foo-03",
    category: "food/culture",
    question: "What is tofu mainly made from?",
    answers: Object.freeze(["Soybeans", "Rice", "Wheat", "Corn"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "foo-04",
    category: "food/culture",
    question: "Which language is primarily spoken in Brazil?",
    answers: Object.freeze(["Portuguese", "Spanish", "French", "English"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "foo-05",
    category: "food/culture",
    question: "Pasta is most strongly associated with which country?",
    answers: Object.freeze(["Italy", "France", "Spain", "Greece"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "foo-06",
    category: "food/culture",
    question: "Which drink is made from fermented grapes?",
    answers: Object.freeze(["Wine", "Beer", "Tea", "Coffee"]),
    correctIndex: 0,
  }),
  // simple math/logic
  Object.freeze({
    id: "mat-01",
    category: "simple math/logic",
    question: "What is 9 × 9?",
    answers: Object.freeze(["81", "72", "99", "18"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "mat-02",
    category: "simple math/logic",
    question: "How many sides does a hexagon have?",
    answers: Object.freeze(["6", "5", "7", "8"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "mat-03",
    category: "simple math/logic",
    question: "What is 12 + 15?",
    answers: Object.freeze(["27", "25", "30", "17"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "mat-04",
    category: "simple math/logic",
    question: "What is 100 ÷ 4?",
    answers: Object.freeze(["25", "20", "40", "50"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "mat-05",
    category: "simple math/logic",
    question: "How many degrees are in a right angle?",
    answers: Object.freeze(["90", "45", "180", "360"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "mat-06",
    category: "simple math/logic",
    question: "What is the next number in the sequence: 2, 4, 6, 8, …?",
    answers: Object.freeze(["10", "9", "12", "16"]),
    correctIndex: 0,
  }),
  // general knowledge
  Object.freeze({
    id: "gen-01",
    category: "general knowledge",
    question: "How many days are in a leap year?",
    answers: Object.freeze(["366", "365", "364", "360"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "gen-02",
    category: "general knowledge",
    question: "How many colors are in a rainbow?",
    answers: Object.freeze(["7", "5", "6", "8"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "gen-03",
    category: "general knowledge",
    question: "What is the opposite of north?",
    answers: Object.freeze(["South", "East", "West", "Up"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "gen-04",
    category: "general knowledge",
    question: "How many minutes are in one hour?",
    answers: Object.freeze(["60", "30", "100", "24"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "gen-05",
    category: "general knowledge",
    question: "Which instrument has 88 keys in its standard form?",
    answers: Object.freeze(["Piano", "Guitar", "Violin", "Flute"]),
    correctIndex: 0,
  }),
  Object.freeze({
    id: "gen-06",
    category: "general knowledge",
    question: "What do you call a shape with three sides?",
    answers: Object.freeze(["Triangle", "Square", "Circle", "Pentagon"]),
    correctIndex: 0,
  }),
]);

/**
 * Pick a question avoiding recent IDs. Safe fallback when the pool is empty.
 * @param {ReadonlyArray<object>} questions
 * @param {string[]} recentIds
 * @param {() => number} random
 * @param {number} [windowSize]
 */
function pickTriviaQuestion(
  questions,
  recentIds,
  random,
  windowSize = ANTI_REPEAT_WINDOW
) {
  const bank = Array.isArray(questions) ? questions : [];
  if (bank.length === 0) {
    return { question: null, recentIds: [] };
  }
  const recent = Array.isArray(recentIds) ? recentIds.slice() : [];
  const windowed = recent.slice(-Math.max(0, windowSize));
  const recentSet = new Set(windowed);
  let pool = bank.filter((q) => q && !recentSet.has(q.id));
  if (pool.length === 0) {
    pool = bank.slice();
  }
  const roll = typeof random === "function" ? random() : Math.random();
  const idx = Math.min(
    pool.length - 1,
    Math.max(0, Math.floor(roll * pool.length))
  );
  const picked = pool[idx];
  const nextRecent = windowed.concat(picked.id);
  while (nextRecent.length > windowSize) {
    nextRecent.shift();
  }
  return { question: picked, recentIds: nextRecent };
}

/**
 * Validate the full bank for CI. Returns { ok, errors }.
 * @param {ReadonlyArray<object>} [questions]
 */
function validateTriviaQuestionBank(questions = TRIVIA_QUESTIONS) {
  const errors = [];
  if (!Array.isArray(questions) || questions.length < 50) {
    errors.push(`expected at least 50 questions, got ${questions ? questions.length : 0}`);
  }
  const ids = new Set();
  const texts = new Set();
  for (let i = 0; i < (questions || []).length; i += 1) {
    const q = questions[i];
    const label = q && q.id ? q.id : `index-${i}`;
    if (!q || typeof q !== "object") {
      errors.push(`${label}: not an object`);
      continue;
    }
    if (typeof q.id !== "string" || !q.id.trim()) {
      errors.push(`${label}: missing id`);
    } else if (ids.has(q.id)) {
      errors.push(`${label}: duplicate id`);
    } else {
      ids.add(q.id);
    }
    if (typeof q.question !== "string" || !q.question.trim()) {
      errors.push(`${label}: empty question`);
    } else {
      const key = q.question.trim().toLowerCase();
      if (texts.has(key)) {
        errors.push(`${label}: duplicate question text`);
      } else {
        texts.add(key);
      }
    }
    if (!Array.isArray(q.answers) || q.answers.length !== 4) {
      errors.push(`${label}: must have exactly 4 answers`);
    } else {
      const seen = new Set();
      for (const a of q.answers) {
        if (typeof a !== "string" || !a.trim()) {
          errors.push(`${label}: empty answer`);
          break;
        }
        const ak = a.trim().toLowerCase();
        if (seen.has(ak)) {
          errors.push(`${label}: duplicate answer "${a}"`);
          break;
        }
        seen.add(ak);
      }
    }
    if (
      !Number.isInteger(q.correctIndex) ||
      q.correctIndex < 0 ||
      q.correctIndex > 3
    ) {
      errors.push(`${label}: correctIndex must be integer 0..3`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  TRIVIA_QUESTIONS,
  ANTI_REPEAT_WINDOW,
  pickTriviaQuestion,
  validateTriviaQuestionBank,
};
