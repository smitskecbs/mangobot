/**
 * Curated ManGo community questions for General (social retention).
 * Not games — conversation prompts only. No XP award on send.
 */

const ANTI_REPEAT_WINDOW = 20;
const DEFAULT_QUESTION_MIN_GAP_MINUTES = 240;

/** @typedef {{ id: string, category: string, text: string }} CommunityQuestion */

/** @type {ReadonlyArray<CommunityQuestion>} */
const COMMUNITY_QUESTIONS = Object.freeze([
  // community
  Object.freeze({ id: "q001", category: "community", text: "What’s one thing that makes you stay in a community?" }),
  Object.freeze({ id: "q002", category: "community", text: "What makes a Telegram community actually worth staying in?" }),
  Object.freeze({ id: "q003", category: "community", text: "What makes you mute a Telegram group?" }),
  Object.freeze({ id: "q004", category: "community", text: "What makes you come back to one chat every day?" }),
  Object.freeze({ id: "q005", category: "community", text: "What’s the friendliest vibe you’ve seen in a community?" }),
  Object.freeze({ id: "q006", category: "community", text: "What should every healthy community protect?" }),
  Object.freeze({ id: "q007", category: "community", text: "Would you rather have a smaller active chat or a huge quiet one?" }),
  Object.freeze({ id: "q008", category: "community", text: "What’s one rule that secretly improves group chat?" }),
  Object.freeze({ id: "q009", category: "community", text: "How do you welcome someone new without making it awkward?" }),
  Object.freeze({ id: "q010", category: "community", text: "What community moment still makes you smile?" }),
  Object.freeze({ id: "q011", category: "community", text: "What’s better: deep threads or quick banter?" }),
  Object.freeze({ id: "q012", category: "community", text: "What would make ManGo feel more like home?" }),
  Object.freeze({ id: "q013", category: "community", text: "Who do you think carries the chat energy the most — and why?" }),
  Object.freeze({ id: "q014", category: "community", text: "What’s one tradition this community should invent?" }),

  // fun
  Object.freeze({ id: "q015", category: "fun", text: "Morning builder or night builder?" }),
  Object.freeze({ id: "q016", category: "fun", text: "Coffee, tea, or pure chaos fuel?" }),
  Object.freeze({ id: "q017", category: "fun", text: "What’s your go-to comfort show or playlist?" }),
  Object.freeze({ id: "q018", category: "fun", text: "Would you rather have unlimited snacks or unlimited free time?" }),
  Object.freeze({ id: "q019", category: "fun", text: "What’s a tiny habit that weirdly improves your day?" }),
  Object.freeze({ id: "q020", category: "fun", text: "Describe your current mood in three emojis." }),
  Object.freeze({ id: "q021", category: "fun", text: "What’s a skill you’d learn for fun, not for work?" }),
  Object.freeze({ id: "q022", category: "fun", text: "Beach day, mountain day, or city day?" }),
  Object.freeze({ id: "q023", category: "fun", text: "What’s the most underrated snack on earth?" }),
  Object.freeze({ id: "q024", category: "fun", text: "If ManGo had a mascot personality, what would it be like?" }),
  Object.freeze({ id: "q025", category: "fun", text: "What’s your chaotic-good Monday strategy?" }),
  Object.freeze({ id: "q026", category: "fun", text: "Would you rather time-travel one day or pause time for one hour?" }),

  // builder
  Object.freeze({ id: "q027", category: "builder", text: "What’s one feature you’d add to ManGo?" }),
  Object.freeze({ id: "q028", category: "builder", text: "What’s one small win you had this week?" }),
  Object.freeze({ id: "q029", category: "builder", text: "What are you building or learning right now?" }),
  Object.freeze({ id: "q030", category: "builder", text: "What’s your favorite way to ship something imperfect but useful?" }),
  Object.freeze({ id: "q031", category: "builder", text: "Which tool do you open first when you start working?" }),
  Object.freeze({ id: "q032", category: "builder", text: "What’s a builder lesson you learned the hard way?" }),
  Object.freeze({ id: "q033", category: "builder", text: "Solo deep work or collaborative brainstorms?" }),
  Object.freeze({ id: "q034", category: "builder", text: "What’s one process you’d automate tomorrow if you could?" }),
  Object.freeze({ id: "q035", category: "builder", text: "How do you decide what to build next?" }),
  Object.freeze({ id: "q036", category: "builder", text: "What’s a feedback style that actually helps you improve?" }),
  Object.freeze({ id: "q037", category: "builder", text: "Prototype fast or polish first — what’s your default?" }),
  Object.freeze({ id: "q038", category: "builder", text: "What’s the last thing you shipped that made you proud?" }),
  Object.freeze({ id: "q039", category: "builder", text: "If ManGo had a creator toolkit, what must be in it?" }),

  // memes
  Object.freeze({ id: "q040", category: "memes", text: "What’s your favorite meme format right now?" }),
  Object.freeze({ id: "q041", category: "memes", text: "Which meme energy describes this chat best?" }),
  Object.freeze({ id: "q042", category: "memes", text: "Caption this community in one meme line." }),
  Object.freeze({ id: "q043", category: "memes", text: "What’s a meme that aged surprisingly well?" }),
  Object.freeze({ id: "q044", category: "memes", text: "Would you rather invent a meme or be in one forever?" }),
  Object.freeze({ id: "q045", category: "memes", text: "What’s the most wholesome meme genre?" }),
  Object.freeze({ id: "q046", category: "memes", text: "If ManGo had an official meme template, what would it look like?" }),
  Object.freeze({ id: "q047", category: "memes", text: "What’s your go-to reaction sticker vibe?" }),
  Object.freeze({ id: "q048", category: "memes", text: "Old-school image macros or modern short clips?" }),
  Object.freeze({ id: "q049", category: "memes", text: "Name a meme that always gets a reply in group chats." }),

  // games
  Object.freeze({ id: "q050", category: "games", text: "Which ManGo game should we improve next?" }),
  Object.freeze({ id: "q051", category: "games", text: "What game should ManGo build next?" }),
  Object.freeze({ id: "q052", category: "games", text: "Would you rather win XP through games or community activity?" }),
  Object.freeze({ id: "q053", category: "games", text: "Snake skill or Bounch patience — which is more you?" }),
  Object.freeze({ id: "q054", category: "games", text: "What’s more fun: racing the board or chatting about the race?" }),
  Object.freeze({ id: "q055", category: "games", text: "Co-op vibes or competitive vibes in ManGo?" }),
  Object.freeze({ id: "q056", category: "games", text: "What’s one mini-game that always sparks conversation?" }),
  Object.freeze({ id: "q057", category: "games", text: "If Trivia had a theme night, what theme wins?" }),
  Object.freeze({ id: "q058", category: "games", text: "Would you join a weekly ManGo tournament night?" }),
  Object.freeze({ id: "q059", category: "games", text: "What’s your favorite way to challenge a friend here?" }),
  Object.freeze({ id: "q060", category: "games", text: "Casual play session or ranked grind — pick one mood." }),
  Object.freeze({ id: "q061", category: "games", text: "What should a perfect ManGo game night include?" }),

  // everyday
  Object.freeze({ id: "q062", category: "everyday", text: "What’s one small win from today so far?" }),
  Object.freeze({ id: "q063", category: "everyday", text: "How do you reset after a messy morning?" }),
  Object.freeze({ id: "q064", category: "everyday", text: "What’s on your desk or workspace right now?" }),
  Object.freeze({ id: "q065", category: "everyday", text: "What’s one thing you’re looking forward to this week?" }),
  Object.freeze({ id: "q066", category: "everyday", text: "Walk outside or stay cozy indoors today?" }),
  Object.freeze({ id: "q067", category: "everyday", text: "What’s a song that always lifts your energy?" }),
  Object.freeze({ id: "q068", category: "everyday", text: "What’s your favorite simple dinner when you’re busy?" }),
  Object.freeze({ id: "q069", category: "everyday", text: "How do you celebrate tiny progress?" }),
  Object.freeze({ id: "q070", category: "everyday", text: "What’s one boundary that protects your focus?" }),
  Object.freeze({ id: "q071", category: "everyday", text: "Phone-free hour or notification batching — what works for you?" }),
  Object.freeze({ id: "q072", category: "everyday", text: "What’s a local place you’d recommend to a friend?" }),
  Object.freeze({ id: "q073", category: "everyday", text: "What’s your ideal low-stress Sunday?" }),

  // creativity
  Object.freeze({ id: "q074", category: "creativity", text: "If you designed a ManGo sticker pack, what’s the first sticker?" }),
  Object.freeze({ id: "q075", category: "creativity", text: "What’s a creative project you’d start with zero pressure?" }),
  Object.freeze({ id: "q076", category: "creativity", text: "Words, images, or audio — how do you like to create?" }),
  Object.freeze({ id: "q077", category: "creativity", text: "What’s an underrated creative tool you love?" }),
  Object.freeze({ id: "q078", category: "creativity", text: "Name a color palette that feels like ManGo." }),
  Object.freeze({ id: "q079", category: "creativity", text: "Would you rather write captions or design thumbnails?" }),
  Object.freeze({ id: "q080", category: "creativity", text: "What’s a story this community should tell together?" }),
  Object.freeze({ id: "q081", category: "creativity", text: "If ManGo had a short film vibe, what genre is it?" }),
  Object.freeze({ id: "q082", category: "creativity", text: "What’s one creative challenge you’d join weekly?" }),
  Object.freeze({ id: "q083", category: "creativity", text: "How do you get unstuck when ideas feel flat?" }),
  Object.freeze({ id: "q084", category: "creativity", text: "What’s cooler: remixing an idea or inventing from scratch?" }),

  // light crypto / community culture
  Object.freeze({ id: "q085", category: "culture", text: "What does “good community culture” mean to you in web3 chats?" }),
  Object.freeze({ id: "q086", category: "culture", text: "What’s more valuable long-term: hype moments or consistent people?" }),
  Object.freeze({ id: "q087", category: "culture", text: "How do you spot a community that actually cares about members?" }),
  Object.freeze({ id: "q088", category: "culture", text: "What’s one onboarding tip every project chat should copy?" }),
  Object.freeze({ id: "q089", category: "culture", text: "Would you rather collect memories or collect badges?" }),
  Object.freeze({ id: "q090", category: "culture", text: "What’s a healthy way communities celebrate wins together?" }),
  Object.freeze({ id: "q091", category: "culture", text: "How should chats handle quiet days without forcing noise?" }),
  Object.freeze({ id: "q092", category: "culture", text: "What’s one signal that a community is aging well?" }),
  Object.freeze({ id: "q093", category: "culture", text: "Builders, players, lurkers — which mix makes the best chat?" }),
  Object.freeze({ id: "q094", category: "culture", text: "What’s a respectful way to disagree in public chats?" }),
  Object.freeze({ id: "q095", category: "culture", text: "If ManGo culture had a slogan, what would you write?" }),
  Object.freeze({ id: "q096", category: "culture", text: "What community ritual feels welcoming instead of spammy?" }),

  // extra mix to clear 100
  Object.freeze({ id: "q097", category: "community", text: "What’s one compliment you’d give this chat anonymously?" }),
  Object.freeze({ id: "q098", category: "fun", text: "Pineapple on pizza: yes, no, or only in parallel universes?" }),
  Object.freeze({ id: "q099", category: "builder", text: "What’s your favorite “done is better than perfect” story?" }),
  Object.freeze({ id: "q100", category: "games", text: "If ManGo added a co-op mode, what should players do together?" }),
  Object.freeze({ id: "q101", category: "everyday", text: "What’s one thing you’re grateful for this week?" }),
  Object.freeze({ id: "q102", category: "creativity", text: "Describe ManGo in a six-word story." }),
  Object.freeze({ id: "q103", category: "culture", text: "What should never be the main topic of a community chat?" }),
  Object.freeze({ id: "q104", category: "community", text: "How do you keep conversations going after a good first reply?" }),
  Object.freeze({ id: "q105", category: "fun", text: "What’s your personal definition of a perfect chill evening?" }),
  Object.freeze({ id: "q106", category: "builder", text: "What documentation do you wish more products shipped with?" }),
  Object.freeze({ id: "q107", category: "memes", text: "Which emoji currently overperforms in this chat?" }),
  Object.freeze({ id: "q108", category: "games", text: "What’s more exciting: a close loss or an easy win?" }),
  Object.freeze({ id: "q109", category: "everyday", text: "What’s a tiny luxury that improves your week?" }),
  Object.freeze({ id: "q110", category: "creativity", text: "If you hosted a ManGo creative jam, what’s the brief?" }),
]);

const CATEGORIES = Object.freeze([
  "community",
  "fun",
  "builder",
  "memes",
  "games",
  "everyday",
  "creativity",
  "culture",
]);

/**
 * @param {ReadonlyArray<CommunityQuestion>} [bank]
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateCommunityQuestionBank(bank = COMMUNITY_QUESTIONS) {
  const errors = [];
  if (!Array.isArray(bank) || bank.length < 100) {
    errors.push(`bank must have >=100 questions, got ${bank && bank.length}`);
  }
  const ids = new Set();
  const texts = new Set();
  for (const q of bank || []) {
    if (!q || typeof q !== "object") {
      errors.push("invalid question entry");
      continue;
    }
    if (typeof q.id !== "string" || !/^q\d{3,}$/.test(q.id)) {
      errors.push(`bad id: ${q && q.id}`);
    }
    if (ids.has(q.id)) {
      errors.push(`duplicate id: ${q.id}`);
    }
    ids.add(q.id);
    if (typeof q.category !== "string" || !CATEGORIES.includes(q.category)) {
      errors.push(`bad category for ${q.id}: ${q && q.category}`);
    }
    if (typeof q.text !== "string" || q.text.trim().length < 20) {
      errors.push(`text too short for ${q.id}`);
    }
    const normalized = String(q.text || "")
      .trim()
      .toLowerCase();
    if (texts.has(normalized)) {
      errors.push(`duplicate text for ${q.id}`);
    }
    texts.add(normalized);
    if (/^\s*(gm|gn|lfg|bullish)\??\s*$/i.test(q.text)) {
      errors.push(`low-quality prompt: ${q.id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * @param {ReadonlyArray<CommunityQuestion>} bank
 * @param {string[]} recentIds
 * @param {() => number} [random]
 * @param {number} [windowSize]
 * @returns {{ question: CommunityQuestion, recentIds: string[] }}
 */
function pickCommunityQuestion(
  bank = COMMUNITY_QUESTIONS,
  recentIds = [],
  random = Math.random,
  windowSize = ANTI_REPEAT_WINDOW
) {
  const recent = Array.isArray(recentIds)
    ? recentIds.filter((id) => typeof id === "string").slice(-windowSize)
    : [];
  const recentSet = new Set(recent);
  let eligible = (bank || []).filter((q) => q && !recentSet.has(q.id));
  if (!eligible.length) {
    eligible = [...(bank || [])];
  }
  if (!eligible.length) {
    throw new Error("community question bank empty");
  }
  const index = Math.floor(random() * eligible.length);
  const question = eligible[Math.max(0, Math.min(eligible.length - 1, index))];
  const nextRecent = [...recent, question.id].slice(-windowSize);
  return { question, recentIds: nextRecent };
}

/**
 * @param {CommunityQuestion} question
 * @returns {string}
 */
function formatCommunityQuestionMessage(question) {
  const body =
    question && typeof question.text === "string" ? question.text.trim() : "";
  return `🥭 ManGo Question\n\n${body}\n\nDrop your answer below 👇`;
}

function emptyCommunityQuestionState() {
  return {
    lastStartedAt: null,
    recentQuestionIds: [],
  };
}

/**
 * @param {unknown} raw
 */
function normalizeCommunityQuestionState(raw) {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const recent = Array.isArray(src.recentQuestionIds)
    ? src.recentQuestionIds
        .filter((id) => typeof id === "string" && id)
        .slice(-ANTI_REPEAT_WINDOW)
    : [];
  return {
    lastStartedAt:
      typeof src.lastStartedAt === "number" ? src.lastStartedAt : null,
    recentQuestionIds: recent,
  };
}

module.exports = {
  COMMUNITY_QUESTIONS,
  CATEGORIES,
  ANTI_REPEAT_WINDOW,
  DEFAULT_QUESTION_MIN_GAP_MINUTES,
  validateCommunityQuestionBank,
  pickCommunityQuestion,
  formatCommunityQuestionMessage,
  emptyCommunityQuestionState,
  normalizeCommunityQuestionState,
};
