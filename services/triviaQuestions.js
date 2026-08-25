/**
 * Categorized ManGo Trivia bank (no external API, no eval).
 * Stable facts — not politics, crypto prices, or current events.
 */

const ANTI_REPEAT_WINDOW = 10;
const MIN_BANK_SIZE = 50;
const MIN_PER_ACTIVE_CATEGORY = 30;

const ACTIVE_CATEGORY_IDS = Object.freeze([
  "geography",
  "history",
  "math",
  "science",
  "general",
  "entertainment",
]);

const ACTIVE_CATEGORY_SET = new Set(ACTIVE_CATEGORY_IDS);

const TRIVIA_HUB_CATEGORIES = Object.freeze([
  Object.freeze({ id: "geography", emoji: "🌍", label: "Geography" }),
  Object.freeze({ id: "history", emoji: "📜", label: "History" }),
  Object.freeze({ id: "math", emoji: "➗", label: "Math" }),
  Object.freeze({ id: "science", emoji: "🧪", label: "Science" }),
  Object.freeze({ id: "general", emoji: "🧠", label: "General Knowledge" }),
  Object.freeze({ id: "entertainment", emoji: "🎬", label: "Entertainment" }),
  Object.freeze({ id: "random", emoji: "🎲", label: "Random" }),
]);

const CATEGORY_BY_ID = new Map(
  TRIVIA_HUB_CATEGORIES.map((row) => [row.id, row])
);

function q(id, category, question, answers, correctIndex = 0, difficulty = "easy") {
  return Object.freeze({
    id,
    category,
    question,
    answers: Object.freeze(answers.slice()),
    correctIndex,
    difficulty,
  });
}

function threeWrongs(correct) {
  const n = Number(correct);
  const out = [];
  const tryAdd = (value) => {
    if (out.length >= 3) {
      return;
    }
    if (!Number.isFinite(value)) {
      return;
    }
    if (value === n) {
      return;
    }
    const label = String(value);
    if (label === String(correct)) {
      return;
    }
    if (out.includes(label)) {
      return;
    }
    out.push(label);
  };
  tryAdd(n + 1);
  tryAdd(n - 1);
  tryAdd(n + 2);
  tryAdd(n - 2);
  tryAdd(n + 10);
  tryAdd(n - 10);
  tryAdd(n + 5);
  tryAdd(n * 2);
  tryAdd(Math.floor(n / 2));
  tryAdd(0);
  let bump = 3;
  while (out.length < 3) {
    tryAdd(n + bump);
    bump += 1;
  }
  return out;
}

function mathQ(id, question, correct, difficulty = "easy") {
  return q(id, "math", question, [String(correct), ...threeWrongs(correct)], 0, difficulty);
}

function buildMathQuestions() {
  return [
    mathQ("mat-01", "What is 9 × 9?", 81),
    q(
      "mat-02",
      "math",
      "How many sides does a hexagon have?",
      ["6", "5", "7", "8"]
    ),
    mathQ("mat-03", "What is 12 + 15?", 27),
    mathQ("mat-04", "What is 100 ÷ 4?", 25),
    mathQ("mat-05", "How many degrees are in a right angle?", 90),
    q(
      "mat-06",
      "math",
      "What is the next number in the sequence: 2, 4, 6, 8, …?",
      ["10", "9", "12", "16"]
    ),
    mathQ("mat-07", "What is 12 × 8?", 96),
    mathQ("mat-08", "What is 25% of 80?", 20),
    mathQ("mat-09", "What is 3/4 of 40?", 30),
    mathQ("mat-10", "What is (8 + 4) × 3?", 36),
    mathQ("mat-11", "What is 15 × 4?", 60),
    mathQ("mat-12", "What is 81 ÷ 9?", 9),
    mathQ("mat-13", "What is 7 × 6?", 42),
    mathQ("mat-14", "What is 50% of 90?", 45, "medium"),
    mathQ("mat-15", "What is 18 + 27?", 45),
    mathQ("mat-16", "What is 11 × 11?", 121),
    mathQ("mat-17", "What is 5² (5 squared)?", 25),
    mathQ("mat-18", "What is 100 − 37?", 63),
    mathQ("mat-19", "What is 9 × 7?", 63),
    mathQ("mat-20", "What is 2/5 of 50?", 20, "medium"),
    mathQ("mat-21", "What is 16 ÷ 2?", 8),
    mathQ("mat-22", "What is 3 × (5 + 7)?", 36),
    mathQ("mat-23", "What is 10% of 250?", 25),
    mathQ("mat-24", "What is 14 + 28?", 42),
    mathQ("mat-25", "What is 8 × 7?", 56),
    mathQ("mat-26", "What is 120 ÷ 6?", 20),
    mathQ("mat-27", "What is 1/2 of 86?", 43),
    mathQ("mat-28", "What is 4³ (4 cubed)?", 64, "medium"),
    mathQ("mat-29", "What is 19 + 21?", 40),
    mathQ("mat-30", "What is 6 × 12?", 72),
    mathQ("mat-31", "What is 75% of 40?", 30, "medium"),
    mathQ("mat-32", "What is 13 × 3?", 39),
  ];
}

const CORE_QUESTIONS = [
  // geography
  q("geo-01", "geography", "What is the capital of France?", ["Paris", "Lyon", "Marseille", "Nice"]),
  q("geo-02", "geography", "Which is the largest ocean on Earth?", ["Pacific Ocean", "Atlantic Ocean", "Indian Ocean", "Arctic Ocean"]),
  q("geo-03", "geography", "Mount Everest is located in which mountain range?", ["Himalayas", "Alps", "Andes", "Rockies"]),
  q("geo-04", "geography", "Which country has the city of Cairo as its capital?", ["Egypt", "Morocco", "Turkey", "Greece"]),
  q("geo-05", "geography", "Which continent is Australia part of?", ["Oceania", "Asia", "Africa", "Europe"]),
  q("geo-06", "geography", "What is the longest river in the world by most traditional measures?", ["Nile", "Amazon", "Yangtze", "Mississippi"]),
  q("geo-07", "geography", "What is the capital of Canada?", ["Ottawa", "Toronto", "Vancouver", "Montreal"]),
  q("geo-08", "geography", "What is the capital of Japan?", ["Tokyo", "Osaka", "Kyoto", "Nagoya"]),
  q("geo-09", "geography", "What is the capital of Italy?", ["Rome", "Milan", "Naples", "Venice"]),
  q("geo-10", "geography", "What is the capital of Spain?", ["Madrid", "Barcelona", "Seville", "Valencia"]),
  q("geo-11", "geography", "What is the capital of Germany?", ["Berlin", "Munich", "Hamburg", "Frankfurt"]),
  q("geo-12", "geography", "What is the capital of Australia?", ["Canberra", "Sydney", "Melbourne", "Perth"]),
  q("geo-13", "geography", "What is the capital of Brazil?", ["Brasília", "Rio de Janeiro", "São Paulo", "Salvador"]),
  q("geo-14", "geography", "The Sahara Desert is mainly on which continent?", ["Africa", "Asia", "Australia", "South America"]),
  q("geo-15", "geography", "The Amazon rainforest is mainly on which continent?", ["South America", "Africa", "Asia", "Australia"]),
  q("geo-16", "geography", "Which country has the largest land area?", ["Russia", "Canada", "China", "United States"]),
  q("geo-17", "geography", "Which is the smallest ocean on Earth?", ["Arctic Ocean", "Indian Ocean", "Atlantic Ocean", "Pacific Ocean"]),
  q("geo-18", "geography", "What is the capital of Kenya?", ["Nairobi", "Mombasa", "Kisumu", "Nakuru"]),
  q("geo-19", "geography", "What is the capital of India?", ["New Delhi", "Mumbai", "Kolkata", "Chennai"]),
  q("geo-20", "geography", "The Andes mountains are mainly on which continent?", ["South America", "Europe", "Africa", "Asia"]),
  q("geo-21", "geography", "What is the capital of Mexico?", ["Mexico City", "Guadalajara", "Monterrey", "Cancún"]),
  q("geo-22", "geography", "The Great Barrier Reef is off the coast of which country?", ["Australia", "Indonesia", "Philippines", "Japan"]),
  q("geo-23", "geography", "What is the capital of South Korea?", ["Seoul", "Busan", "Incheon", "Daegu"]),
  q("geo-24", "geography", "Egypt is on which continent?", ["Africa", "Asia", "Europe", "South America"]),
  q("geo-25", "geography", "What is the capital of Argentina?", ["Buenos Aires", "Córdoba", "Rosario", "Mendoza"]),
  q("geo-26", "geography", "Mount Kilimanjaro is in which country?", ["Tanzania", "Kenya", "Ethiopia", "Uganda"]),
  q("geo-27", "geography", "What is the capital of Sweden?", ["Stockholm", "Gothenburg", "Malmö", "Uppsala"]),
  q("geo-28", "geography", "The Mediterranean is a:", ["Sea", "Lake", "River", "Desert"]),
  q("geo-29", "geography", "What is the capital of Norway?", ["Oslo", "Bergen", "Trondheim", "Stavanger"]),
  q("geo-30", "geography", "What is the capital of Portugal?", ["Lisbon", "Porto", "Coimbra", "Braga"]),
  q("geo-31", "geography", "Which continent is the largest by land area?", ["Asia", "Africa", "North America", "Europe"]),
  q("geo-32", "geography", "What is the capital of Egypt?", ["Cairo", "Alexandria", "Giza", "Luxor"]),

  // history
  q("his-01", "history", "In which year did World War II end?", ["1945", "1918", "1939", "1969"]),
  q("his-02", "history", "Who was the first person to walk on the Moon?", ["Neil Armstrong", "Buzz Aldrin", "Yuri Gagarin", "John Glenn"]),
  q("his-03", "history", "The ancient pyramids of Giza are in which country?", ["Egypt", "Mexico", "Italy", "India"]),
  q("his-04", "history", "Which ancient civilization built Machu Picchu?", ["Inca", "Maya", "Aztec", "Olmec"]),
  q("his-05", "history", "The Great Wall is most closely associated with which country?", ["China", "Japan", "India", "Mongolia"]),
  q("his-06", "history", "In which year did Christopher Columbus first reach the Americas?", ["1492", "1519", "1607", "1776"]),
  q("his-07", "history", "Who was the first President of the United States?", ["George Washington", "Thomas Jefferson", "John Adams", "Abraham Lincoln"]),
  q("his-08", "history", "In which year did World War I end?", ["1918", "1914", "1939", "1945"]),
  q("his-09", "history", "The French Revolution began in which year?", ["1789", "1815", "1776", "1848"]),
  q("his-10", "history", "Which language was commonly spoken in ancient Rome?", ["Latin", "Greek", "Italian", "French"]),
  q("his-11", "history", "In which year did the Berlin Wall fall?", ["1989", "1961", "1991", "1979"]),
  q("his-12", "history", "Who is credited with inventing the movable-type printing press in Europe?", ["Johannes Gutenberg", "Isaac Newton", "Galileo Galilei", "James Watt"]),
  q("his-13", "history", "The Wright brothers made their first powered flight in which year?", ["1903", "1899", "1914", "1927"]),
  q("his-14", "history", "The Colosseum is in which city?", ["Rome", "Athens", "Paris", "Istanbul"]),
  q("his-15", "history", "Cleopatra ruled as queen of which ancient kingdom?", ["Egypt", "Persia", "Rome", "Greece"]),
  q("his-16", "history", "The Industrial Revolution began in which country?", ["Britain", "France", "Germany", "United States"]),
  q("his-17", "history", "In which year did the Titanic sink?", ["1912", "1905", "1918", "1929"]),
  q("his-18", "history", "The United States Declaration of Independence was adopted in which year?", ["1776", "1789", "1812", "1607"]),
  q("his-19", "history", "Who was the first woman in space?", ["Valentina Tereshkova", "Sally Ride", "Mae Jemison", "Kalpana Chawla"]),
  q("his-20", "history", "Julius Caesar was a leader in which ancient civilization?", ["Rome", "Greece", "Egypt", "Persia"]),
  q("his-21", "history", "Nelson Mandela was a leader in which country?", ["South Africa", "Kenya", "Nigeria", "Ghana"]),
  q("his-22", "history", "The Magna Carta was signed in which century?", ["13th", "11th", "15th", "17th"]),
  q("his-23", "history", "Napoleon was defeated at Waterloo in which year?", ["1815", "1789", "1804", "1848"]),
  q("his-24", "history", "The first modern Olympic Games were held in which city?", ["Athens", "Paris", "London", "Rome"]),
  q("his-25", "history", "William Shakespeare lived and wrote in which country?", ["England", "France", "Italy", "Spain"]),
  q("his-26", "history", "The Great Fire of London happened in which year?", ["1666", "1588", "1707", "1812"]),
  q("his-27", "history", "The Silk Road mainly connected Europe with which region?", ["Asia", "South America", "Australia", "Antarctica"]),
  q("his-28", "history", "Vikings originally came from which region?", ["Scandinavia", "Iberia", "the Balkans", "North Africa"]),
  q("his-29", "history", "The ancient city of Troy is associated with which sea region?", ["the Aegean", "the Caribbean", "the Baltic", "the Red Sea"]),
  q("his-30", "history", "Who was the first person to travel into space?", ["Yuri Gagarin", "Neil Armstrong", "Alan Shepard", "John Glenn"]),
  q("his-31", "history", "The Rosetta Stone helped scholars understand which writing system?", ["Egyptian hieroglyphs", "Cuneiform only", "Runic letters", "Ogham"]),
  q("his-32", "history", "Machu Picchu is in which modern country?", ["Peru", "Chile", "Bolivia", "Ecuador"]),

  // science
  q("sci-01", "science", "What is the chemical symbol for water?", ["H2O", "CO2", "O2", "NaCl"]),
  q("sci-02", "science", "How many planets are in the Solar System?", ["8", "7", "9", "10"]),
  q("sci-03", "science", "What gas do plants primarily absorb for photosynthesis?", ["Carbon dioxide", "Oxygen", "Nitrogen", "Hydrogen"]),
  q("sci-04", "science", "What is the hardest natural substance on Earth?", ["Diamond", "Gold", "Iron", "Quartz"]),
  q("sci-05", "science", "At what Celsius temperature does water freeze at standard pressure?", ["0", "32", "100", "-10"]),
  q("sci-06", "science", "Which particle has a negative electric charge?", ["Electron", "Proton", "Neutron", "Photon"]),
  q("spa-01", "science", "Which planet is known as the Red Planet?", ["Mars", "Venus", "Jupiter", "Mercury"]),
  q("spa-02", "science", "What is the name of our galaxy?", ["Milky Way", "Andromeda", "Whirlpool", "Sombrero"]),
  q("spa-03", "science", "Which planet is closest to the Sun?", ["Mercury", "Venus", "Earth", "Mars"]),
  q("spa-04", "science", "What force keeps planets in orbit around the Sun?", ["Gravity", "Magnetism", "Friction", "Electricity"]),
  q("spa-05", "science", "How many Moons does Earth have?", ["1", "2", "0", "4"]),
  q("spa-06", "science", "Which is the largest planet in the Solar System?", ["Jupiter", "Saturn", "Neptune", "Earth"]),
  q("sci-07", "science", "What is the chemical symbol for oxygen?", ["O", "Ox", "Og", "On"]),
  q("sci-08", "science", "What is the boiling point of water in Celsius at standard pressure?", ["100", "90", "80", "120"]),
  q("sci-09", "science", "Humans breathe in which gas that the body needs?", ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"]),
  q("sci-10", "science", "What organ pumps blood through the human body?", ["Heart", "Lungs", "Liver", "Kidney"]),
  q("sci-11", "science", "What is the center of an atom called?", ["Nucleus", "Electron", "Orbit", "Shell"]),
  q("sci-12", "science", "Which planet is famous for its prominent rings?", ["Saturn", "Mars", "Venus", "Mercury"]),
  q("sci-13", "science", "What is H2O more commonly called?", ["Water", "Salt", "Air", "Ice only"]),
  q("sci-14", "science", "Which vitamin is mainly produced when skin is exposed to sunlight?", ["Vitamin D", "Vitamin C", "Vitamin A", "Vitamin B12"]),
  q("sci-15", "science", "What do you call an animal that eats only plants?", ["Herbivore", "Carnivore", "Omnivore", "Insectivore"]),
  q("sci-16", "science", "Sound travels fastest through which of these?", ["Steel", "Air", "Water vapor", "Outer space"]),
  q("sci-17", "science", "What is the main gas in Earth's atmosphere?", ["Nitrogen", "Oxygen", "Carbon dioxide", "Hydrogen"]),
  q("sci-18", "science", "Which part of the plant conducts photosynthesis?", ["Leaf", "Root", "Seed", "Bark"]),
  q("sci-19", "science", "What is the chemical symbol for gold?", ["Au", "Ag", "Gd", "Go"]),
  q("sci-20", "science", "How many bones does an adult human body typically have?", ["206", "180", "300", "120"]),
  q("sci-21", "science", "What is the nearest star to Earth?", ["the Sun", "Proxima Centauri", "Sirius", "Polestar"]),
  q("sci-22", "science", "Which blood cells help the body fight infection?", ["White blood cells", "Red blood cells", "Platelets", "Plasma only"]),
  q("sci-23", "science", "What type of energy is stored in a battery?", ["Chemical", "Sound", "Nuclear", "Wind"]),
  q("sci-24", "science", "Ice is water in which state of matter?", ["Solid", "Liquid", "Gas", "Plasma"]),
  q("sci-25", "science", "Which planet is known for its Great Red Spot?", ["Jupiter", "Mars", "Neptune", "Earth"]),
  q("sci-26", "science", "What is the process by which plants make food using sunlight?", ["Photosynthesis", "Respiration", "Fermentation", "Distillation"]),

  // general
  q("gen-01", "general", "How many days are in a leap year?", ["366", "365", "364", "360"]),
  q("gen-02", "general", "How many colors are in a rainbow?", ["7", "5", "6", "8"]),
  q("gen-03", "general", "What is the opposite of north?", ["South", "East", "West", "Up"]),
  q("gen-04", "general", "How many minutes are in one hour?", ["60", "30", "100", "24"]),
  q("gen-05", "general", "Which instrument has 88 keys in its standard form?", ["Piano", "Guitar", "Violin", "Flute"]),
  q("gen-06", "general", "What do you call a shape with three sides?", ["Triangle", "Square", "Circle", "Pentagon"]),
  q("nat-01", "general", "What is a baby frog called?", ["Tadpole", "Cub", "Chick", "Pup"]),
  q("nat-02", "general", "Which animal is known as the king of the jungle?", ["Lion", "Tiger", "Elephant", "Bear"]),
  q("nat-03", "general", "How many legs does a spider typically have?", ["8", "6", "10", "4"]),
  q("nat-04", "general", "Which bird is famous for being unable to fly and living in Antarctica?", ["Penguin", "Ostrich", "Emu", "Kiwi"]),
  q("nat-05", "general", "What do bees collect to make honey?", ["Nectar", "Pollen only", "Sap", "Dew"]),
  q("nat-06", "general", "Which is the largest living land animal?", ["African elephant", "White rhinoceros", "Hippopotamus", "Giraffe"]),
  q("tec-01", "general", "What does CPU stand for?", ["Central Processing Unit", "Computer Personal Utility", "Core Power Unit", "Central Program Utility"]),
  q("tec-02", "general", "What does WWW stand for?", ["World Wide Web", "Wide World Web", "Web World Wide", "Wireless Web Wave"]),
  q("tec-03", "general", "Which company created the iPhone?", ["Apple", "Microsoft", "Google", "Samsung"]),
  q("tec-04", "general", "What does USB stand for?", ["Universal Serial Bus", "United System Board", "Ultra Speed Byte", "Universal Storage Box"]),
  q("tec-05", "general", "In computing, what does RAM stand for?", ["Random Access Memory", "Read Access Module", "Rapid Application Memory", "Remote Access Machine"]),
  q("tec-06", "general", "HTML is primarily used to:", ["Structure web pages", "Edit photos", "Send emails", "Compress videos"]),
  q("spo-01", "general", "How many players are on the field for one soccer team?", ["11", "10", "9", "12"]),
  q("spo-02", "general", "In tennis, what is a score of zero called?", ["Love", "Nil", "Blank", "Void"]),
  q("spo-03", "general", "How many rings are on the Olympic flag?", ["5", "4", "6", "7"]),
  q("spo-04", "general", "In basketball, how many points is a free throw worth?", ["1", "2", "3", "4"]),
  q("spo-05", "general", "Which sport uses a shuttlecock?", ["Badminton", "Tennis", "Squash", "Table tennis"]),
  q("spo-06", "general", "How many bases are on a baseball diamond?", ["4", "3", "5", "2"]),
  q("gen-07", "general", "How many hours are in one day?", ["24", "12", "10", "48"]),
  q("gen-08", "general", "How many months have 31 days?", ["7", "6", "5", "12"]),
  q("gen-09", "general", "What do you call a baby cat?", ["Kitten", "Puppy", "Calf", "Cub"]),
  q("gen-10", "general", "Which direction does the sun rise from?", ["East", "West", "North", "South"]),
  q("gen-11", "general", "How many continents are there on Earth?", ["7", "5", "6", "8"]),
  q("gen-12", "general", "What is the tallest type of great ape?", ["Gorilla", "Chimpanzee", "Orangutan", "Gibbon"]),

  // entertainment
  q("foo-01", "entertainment", "Sushi originated in which country?", ["Japan", "China", "Korea", "Thailand"]),
  q("foo-02", "entertainment", "Which fruit is typically used to make guacamole?", ["Avocado", "Tomato", "Mango", "Banana"]),
  q("foo-03", "entertainment", "What is tofu mainly made from?", ["Soybeans", "Rice", "Wheat", "Corn"]),
  q("foo-04", "entertainment", "Which language is primarily spoken in Brazil?", ["Portuguese", "Spanish", "French", "English"]),
  q("foo-05", "entertainment", "Pasta is most strongly associated with which country?", ["Italy", "France", "Spain", "Greece"]),
  q("foo-06", "entertainment", "Which drink is made from fermented grapes?", ["Wine", "Beer", "Tea", "Coffee"]),
  q("ent-01", "entertainment", "Who painted the Mona Lisa?", ["Leonardo da Vinci", "Michelangelo", "Raphael", "Vincent van Gogh"]),
  q("ent-02", "entertainment", "In the Mario games, what is the name of Mario's brother?", ["Luigi", "Wario", "Yoshi", "Toad"]),
  q("ent-03", "entertainment", "Hogwarts is a school in which book series?", ["Harry Potter", "The Hobbit", "Narnia", "Percy Jackson"]),
  q("ent-04", "entertainment", "Who directed the original Jurassic Park film?", ["Steven Spielberg", "James Cameron", "George Lucas", "Ridley Scott"]),
  q("ent-05", "entertainment", "The Beatles formed in which city?", ["Liverpool", "London", "Manchester", "Dublin"]),
  q("ent-06", "entertainment", "Mickey Mouse was created by which company?", ["Disney", "Warner Bros.", "Pixar", "DreamWorks"]),
  q("ent-07", "entertainment", "Sherlock Holmes was created by which author?", ["Arthur Conan Doyle", "Agatha Christie", "Charles Dickens", "Jules Verne"]),
  q("ent-08", "entertainment", "In Frozen, what is the name of Elsa's sister?", ["Anna", "Belle", "Ariel", "Moana"]),
  q("ent-09", "entertainment", "Which instrument does a typical rock drummer play?", ["Drums", "Violin", "Harp", "Flute"]),
  q("ent-10", "entertainment", "Pikachu is a creature from which franchise?", ["Pokémon", "Digimon", "Yu-Gi-Oh!", "Sonic"]),
  q("ent-11", "entertainment", "The Lion King is set mainly on which continent?", ["Africa", "Asia", "Australia", "Europe"]),
  q("ent-12", "entertainment", "Who wrote the play Romeo and Juliet?", ["William Shakespeare", "Oscar Wilde", "George Bernard Shaw", "Jane Austen"]),
  q("ent-13", "entertainment", "A standard chess set has how many pieces at the start?", ["32", "16", "24", "64"]),
  q("ent-14", "entertainment", "Tetris is best described as which type of game?", ["Puzzle", "Racing", "Sports", "Platformer"]),
  q("ent-15", "entertainment", "Which of these is a wind instrument?", ["Flute", "Violin", "Piano", "Drum"]),
  q("ent-16", "entertainment", "The character James Bond is also known by which code number?", ["007", "099", "001", "777"]),
  q("ent-17", "entertainment", "In chess, which piece can move any number of squares diagonally?", ["Bishop", "Knight", "Rook", "King"]),
  q("ent-18", "entertainment", "Which studio is famous for Toy Story?", ["Pixar", "Aardman", "Studio Ghibli", "Illumination"]),
  q("ent-19", "entertainment", "A haiku is a form of poetry from which country?", ["Japan", "Italy", "Russia", "Egypt"]),
  q("ent-20", "entertainment", "Which board game uses black and white stones on a grid?", ["Go", "Monopoly", "Clue", "Risk"]),
  q("ent-21", "entertainment", "The Nutcracker is a famous:", ["Ballet", "Opera only", "Rock album", "Sitcom"]),
  q("ent-22", "entertainment", "Who is the hero of The Hobbit?", ["Bilbo Baggins", "Harry Potter", "Luke Skywalker", "Katniss Everdeen"]),
  q("ent-23", "entertainment", "Pac-Man is known for eating:", ["Dots", "Coins only", "Stars only", "Mushrooms only"]),
  q("ent-24", "entertainment", "A clarinet is typically made to be played by:", ["Blowing air", "Plucking strings", "Hitting keys only", "Bowing strings"]),
  q("ent-25", "entertainment", "Olympia is the setting of which ancient games that inspired a modern event?", ["the Olympic Games", "the World Cup", "Wimbledon", "the Super Bowl"]),
  q("ent-26", "entertainment", "Which of these is a string instrument?", ["Guitar", "Trumpet", "Flute", "Timpani"]),
];

const TRIVIA_QUESTIONS = Object.freeze(CORE_QUESTIONS.concat(buildMathQuestions()));

function getCategoryMeta(categoryId) {
  const id = String(categoryId || "");
  if (CATEGORY_BY_ID.has(id)) {
    return CATEGORY_BY_ID.get(id);
  }
  return { id: id || "trivia", emoji: "🧠", label: "Trivia" };
}

function isActiveCategoryId(categoryId) {
  return ACTIVE_CATEGORY_SET.has(String(categoryId || ""));
}

function isHubCategoryId(categoryId) {
  return CATEGORY_BY_ID.has(String(categoryId || ""));
}

function filterQuestionsByCategory(questions, categoryId) {
  const bank = Array.isArray(questions) ? questions : [];
  const id = String(categoryId || "");
  if (!id) {
    return bank.slice();
  }
  if (id === "random") {
    const active = bank.filter((row) => row && isActiveCategoryId(row.category));
    return active.length > 0 ? active : bank.slice();
  }
  return bank.filter((row) => row && row.category === id);
}

function countQuestionsByCategory(questions = TRIVIA_QUESTIONS) {
  const counts = {};
  for (const id of ACTIVE_CATEGORY_IDS) {
    counts[id] = 0;
  }
  for (const row of questions || []) {
    if (row && Object.prototype.hasOwnProperty.call(counts, row.category)) {
      counts[row.category] += 1;
    }
  }
  return counts;
}

/**
 * Pick a question avoiding recent IDs. Safe fallback when the pool is empty.
 * @param {ReadonlyArray<object>} questions
 * @param {string[]} recentIds
 * @param {() => number} random
 * @param {number} [windowSize]
 * @param {string} [category]
 */
function pickTriviaQuestion(
  questions,
  recentIds,
  random,
  windowSize = ANTI_REPEAT_WINDOW,
  category
) {
  const bank = filterQuestionsByCategory(questions, category);
  if (bank.length === 0) {
    return { question: null, recentIds: Array.isArray(recentIds) ? recentIds.slice() : [] };
  }
  const recent = Array.isArray(recentIds) ? recentIds.slice() : [];
  const windowed = recent.slice(-Math.max(0, windowSize));
  const recentSet = new Set(windowed);
  let pool = bank.filter((item) => item && !recentSet.has(item.id));
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
  const isProductionBank = questions === TRIVIA_QUESTIONS;
  if (!Array.isArray(questions) || questions.length < MIN_BANK_SIZE) {
    errors.push(`expected at least ${MIN_BANK_SIZE} questions, got ${questions ? questions.length : 0}`);
  }
  const ids = new Set();
  const texts = new Set();
  for (let i = 0; i < (questions || []).length; i += 1) {
    const item = questions[i];
    const label = item && item.id ? item.id : `index-${i}`;
    if (!item || typeof item !== "object") {
      errors.push(`${label}: not an object`);
      continue;
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      errors.push(`${label}: missing id`);
    } else if (ids.has(item.id)) {
      errors.push(`${label}: duplicate id`);
    } else {
      ids.add(item.id);
    }
    if (typeof item.question !== "string" || !item.question.trim()) {
      errors.push(`${label}: empty question`);
    } else {
      const key = item.question.trim().toLowerCase();
      if (texts.has(key)) {
        errors.push(`${label}: duplicate question text`);
      } else {
        texts.add(key);
      }
    }
    if (!isActiveCategoryId(item.category)) {
      errors.push(`${label}: invalid category "${item.category}"`);
    }
    if (!Array.isArray(item.answers) || item.answers.length !== 4) {
      errors.push(`${label}: must have exactly 4 answers`);
    } else {
      const seen = new Set();
      for (const answer of item.answers) {
        if (typeof answer !== "string" || !answer.trim()) {
          errors.push(`${label}: empty answer`);
          break;
        }
        const answerKey = answer.trim().toLowerCase();
        if (seen.has(answerKey)) {
          errors.push(`${label}: duplicate answer "${answer}"`);
          break;
        }
        seen.add(answerKey);
      }
    }
    if (
      !Number.isInteger(item.correctIndex) ||
      item.correctIndex < 0 ||
      item.correctIndex > 3
    ) {
      errors.push(`${label}: correctIndex must be integer 0..3`);
    } else if (Array.isArray(item.answers) && item.answers.length === 4) {
      const chosen = item.answers[item.correctIndex];
      if (typeof chosen !== "string" || !chosen.trim()) {
        errors.push(`${label}: correct answer is empty`);
      }
    }
    if (
      item.difficulty != null &&
      item.difficulty !== "easy" &&
      item.difficulty !== "medium" &&
      item.difficulty !== "hard"
    ) {
      errors.push(`${label}: invalid difficulty`);
    }
  }
  if (isProductionBank) {
    const counts = countQuestionsByCategory(questions);
    for (const id of ACTIVE_CATEGORY_IDS) {
      if (counts[id] < MIN_PER_ACTIVE_CATEGORY) {
        errors.push(`${id}: expected at least ${MIN_PER_ACTIVE_CATEGORY} questions, got ${counts[id]}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  TRIVIA_QUESTIONS,
  TRIVIA_HUB_CATEGORIES,
  ACTIVE_CATEGORY_IDS,
  ANTI_REPEAT_WINDOW,
  MIN_PER_ACTIVE_CATEGORY,
  getCategoryMeta,
  isActiveCategoryId,
  isHubCategoryId,
  filterQuestionsByCategory,
  countQuestionsByCategory,
  pickTriviaQuestion,
  validateTriviaQuestionBank,
};
