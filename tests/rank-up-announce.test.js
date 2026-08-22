/**
 * Automatic General-chat rank-up announcements.
 * Run: node tests/rank-up-announce.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  getRank,
  awardDailyActivityPoint,
  awardTriggerPoints,
  awardMangoBombXp,
  awardPvpWinXp,
  awardCommunityBuilderXp,
  mutatePoints,
  loadPoints,
} = require("../services/points");
const {
  configureRankUpAnnounceForTests,
  noteRankUpIdentity,
  resolveRankUpIdentity,
  buildRankUpAnnouncementHtml,
  visibleAnnouncementText,
  isTrueRankUp,
  maybeAnnounceRankUp,
  whenRankUpIdle,
  ANNOUNCE_RANK_TITLES,
  FALLBACK_MEMBER,
} = require("../services/rankUpAnnounce");
const {
  loadRankUpStore,
  rankUpEventId,
} = require("../services/rankUpAnnounceStore");
const {
  configureCommunityBuilderForTests,
  grantManualBuilderAward,
} = require("../services/communityBuilder");
const { setWalletFileForTests } = require("../services/walletLinks");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(true);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-rank-up-"));
const COMMUNITY_CHAT = "-1003916996602";
const USER = "41001";
const ADMIN_ID = "9001";

const originalChat = process.env.TELEGRAM_CHAT_ID;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.TELEGRAM_CHAT_ID = COMMUNITY_CHAT;
process.env.ADMIN_USER_ID = ADMIN_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
  path.join(__dirname, "..", "data", "rank-up-announcements.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

let n = 0;
function harness(extra = {}) {
  n += 1;
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  const storeFile = path.join(tempDir, `rank-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  const builderFile = path.join(tempDir, `builder-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(walletFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  const posts = [];
  const fetchImpl =
    extra.fetchImpl ||
    (async (_url, init) => {
      posts.push(JSON.parse(init.body));
      return { ok: true };
    });
  configureRankUpAnnounceForTests({
    enabled: extra.enabled !== false,
    storeFile,
    pointsFile,
    chatId: COMMUNITY_CHAT,
    botToken: "TESTTOKEN",
    fetchImpl,
    now: extra.now,
  });
  setWalletFileForTests(walletFile);
  configureCommunityBuilderForTests({
    storeFile: builderFile,
    pointsFile,
    walletFile,
    chatId: COMMUNITY_CHAT,
    notify: () => Promise.resolve({ sent: true }),
  });
  return { pointsFile, storeFile, walletFile, builderFile, posts };
}

function seedPoints(pointsFile, userId, points, name = "Ada") {
  mutatePoints((data) => {
    data.users[String(userId)] = {
      points,
      weeklyPoints: 0,
      weekId: "2000-W01",
      name,
      triggerDate: "2000-01-01",
      triggersUsed: [],
      activityDate: null,
      streak: { current: 0, longest: 0, lastActiveDate: null },
    };
  }, pointsFile);
}

function fakeResult(previousTitle, nextTitle, extra = {}) {
  return {
    awarded: extra.awarded !== false,
    rankUp: extra.rankUp !== false,
    pointsToAdd: extra.pointsToAdd != null ? extra.pointsToAdd : 1,
    rank: getRank(
      nextTitle === "Sprout"
        ? 25
        : nextTitle === "Tree"
          ? 75
          : nextTitle === "Mango Tree"
            ? 150
            : nextTitle === "Guardian"
              ? 300
              : nextTitle === "Legend"
                ? 600
                : 0
    ),
    previousRank: getRank(
      previousTitle === "Sprout"
        ? 25
        : previousTitle === "Tree"
          ? 75
          : previousTitle === "Mango Tree"
            ? 150
            : previousTitle === "Guardian"
              ? 300
              : previousTitle === "Legend"
                ? 600
                : 0
    ),
  };
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

async function main() {
  await runTest("1-4. Seed/Sprout/Tree/Legend/Guardian each send one", async () => {
    const cases = [
      ["Seed", "Sprout", "You reached Sprout"],
      ["Sprout", "Tree", "You reached Tree"],
      ["Tree", "Mango Tree", "You reached Mango Tree"],
      ["Mango Tree", "Guardian", "reached Guardian"],
      ["Guardian", "Legend", "just reached Legend"],
    ];
    for (const [prev, next, snippet] of cases) {
      const h = harness();
      const result = fakeResult(prev, next);
      assert.strictEqual(result.rank.title, next);
      assert.strictEqual(result.previousRank.title, prev === "Seed" ? "Seed" : prev);
      await maybeAnnounceRankUp({
        telegramUserId: USER,
        username: "adafruit",
        result,
      });
      assert.strictEqual(h.posts.length, 1);
      assert.ok(h.posts[0].text.includes(snippet));
      assert.strictEqual(h.posts[0].parse_mode, "HTML");
    }
  });

  await runTest("5-8. same rank, 0 XP, wallet lock, initial create do not post", async () => {
    const h = harness();
    await maybeAnnounceRankUp({
      telegramUserId: USER,
      result: fakeResult("Sprout", "Sprout", { rankUp: false }),
    });
    await maybeAnnounceRankUp({
      telegramUserId: USER,
      result: {
        awarded: false,
        rankUp: false,
        pointsToAdd: 0,
        rank: getRank(24),
        previousRank: getRank(24),
      },
    });
    await maybeAnnounceRankUp({
      telegramUserId: USER,
      result: {
        awarded: false,
        reason: "wallet-required",
        rankUp: false,
        pointsToAdd: 0,
        rank: getRank(24),
        previousRank: getRank(24),
      },
    });
    seedPoints(h.pointsFile, USER, 0);
    assert.strictEqual(getRank(0).title, "Seed");
    assert.strictEqual(h.posts.length, 0);
  });

  await runTest("9-13. mention identity, escape, fallback, no uid plaintext", async () => {
    noteRankUpIdentity({
      id: USER,
      is_bot: false,
      username: "adafruit",
      first_name: "Ada",
    });
    const named = resolveRankUpIdentity({ telegramUserId: USER });
    assert.strictEqual(named.kind, "username");
    const htmlUser = buildRankUpAnnouncementHtml("Sprout", named);
    assert.ok(htmlUser.includes("@adafruit"));
    assert.ok(!visibleAnnouncementText(htmlUser).includes(USER));

    const mention = resolveRankUpIdentity({
      telegramUserId: "41002",
      displayName: "Ada <b>Hack</b>",
    });
    assert.strictEqual(mention.kind, "mention");
    const htmlMention = buildRankUpAnnouncementHtml("Tree", mention);
    assert.ok(htmlMention.includes('tg://user?id=41002'));
    assert.ok(htmlMention.includes("Ada &lt;b&gt;Hack&lt;/b&gt;"));
    assert.ok(!htmlMention.includes("<b>Hack</b>"));
    assert.ok(!visibleAnnouncementText(htmlMention).includes("41002"));

    const display = resolveRankUpIdentity({
      displayName: "Ada",
    });
    assert.ok(display.kind === "display" || display.kind === "anonymous");
    const anon = resolveRankUpIdentity({});
    assert.strictEqual(anon.kind, "anonymous");
    const htmlAnon = buildRankUpAnnouncementHtml("Sprout", anon);
    assert.ok(htmlAnon.includes(FALLBACK_MEMBER));
    assert.ok(!visibleAnnouncementText(htmlAnon).includes("tg://user"));
  });

  await runTest("14-16. TELEGRAM_CHAT_ID General, no topic/thread", async () => {
    const h = harness();
    await maybeAnnounceRankUp({
      telegramUserId: USER,
      username: "adafruit",
      result: fakeResult("Seed", "Sprout"),
    });
    assert.strictEqual(String(h.posts[0].chat_id), COMMUNITY_CHAT);
    assert.strictEqual(h.posts[0].message_thread_id, undefined);
    assert.ok(!JSON.stringify(h.posts[0]).includes("message_thread_id"));
    const src = fs.readFileSync(
      path.join(__dirname, "..", "services", "rankUpAnnounce.js"),
      "utf8"
    );
    assert.ok(!src.includes("TELEGRAM_GAMES_TOPIC_ID"));
    assert.ok(!src.includes("gameTopic"));
  });

  await runTest("17-20. duplicates, restart, concurrent claim exactly one", async () => {
    const h = harness();
    const payload = {
      telegramUserId: USER,
      username: "adafruit",
      result: fakeResult("Seed", "Sprout"),
    };
    await maybeAnnounceRankUp(payload);
    await maybeAnnounceRankUp(payload);
    configureRankUpAnnounceForTests({
      enabled: true,
      storeFile: h.storeFile,
      chatId: COMMUNITY_CHAT,
      botToken: "TESTTOKEN",
      fetchImpl: async (_url, init) => {
        h.posts.push(JSON.parse(init.body));
        return { ok: true };
      },
    });
    await maybeAnnounceRankUp(payload);
    const [a, b] = await Promise.all([
      maybeAnnounceRankUp({
        telegramUserId: "41009",
        username: "otheruser",
        result: fakeResult("Seed", "Sprout"),
      }),
      maybeAnnounceRankUp({
        telegramUserId: "41009",
        username: "otheruser",
        result: fakeResult("Seed", "Sprout"),
      }),
    ]);
    const wins = [a, b].filter((row) => row.sent).length;
    assert.strictEqual(wins, 1);
    const sproutPosts = h.posts.filter((row) => row.text.includes("You reached Sprout"));
    assert.strictEqual(sproutPosts.length, 2);
    const store = loadRankUpStore(h.storeFile);
    assert.strictEqual(store.announcements[rankUpEventId(USER, "Sprout")].state, "sent");
  });

  await runTest("21-24. send failure no XP rollback, retry after pending", async () => {
    let fail = true;
    const h = harness({
      fetchImpl: async () => {
        if (fail) {
          throw new Error("network");
        }
        return { ok: true };
      },
    });
    seedPoints(h.pointsFile, USER, 24);
    const before = loadPoints(h.pointsFile).users[USER].points;
    const awarded = awardDailyActivityPoint(USER, "Ada", h.pointsFile);
    assert.strictEqual(awarded.rankUp, true);
    await whenRankUpIdle();
    assert.strictEqual(loadPoints(h.pointsFile).users[USER].points, before + 1);
    const pending = loadRankUpStore(h.storeFile).announcements[rankUpEventId(USER, "Sprout")];
    assert.strictEqual(pending.state, "pending");
    fail = false;
    const again = awardDailyActivityPoint(USER, "Ada", h.pointsFile);
    assert.strictEqual(again.awarded, false);
    assert.strictEqual(again.rankUp, false);
    await maybeAnnounceRankUp({
      telegramUserId: USER,
      username: "adafruit",
      result: { awarded: true, rankUp: false, rank: getRank(25), previousRank: getRank(25) },
    });
    const sent = loadRankUpStore(h.storeFile).announcements[rankUpEventId(USER, "Sprout")];
    assert.strictEqual(sent.state, "sent");
  });

  await runTest("25-30. XP sources trigger; Builder Points do not", async () => {
    const h = harness();
    seedPoints(h.pointsFile, USER, 24);
    noteRankUpIdentity({
      id: USER,
      is_bot: false,
      username: "adafruit",
      first_name: "Ada",
    });
    const gm = awardTriggerPoints(USER, "Ada", "gm", h.pointsFile);
    assert.strictEqual(gm.rankUp, true);
    await whenRankUpIdle();
    assert.strictEqual(h.posts.length, 1);

    const h2 = harness();
    seedPoints(h2.pointsFile, USER, 24);
    awardDailyActivityPoint(USER, "Ada", h2.pointsFile);
    await whenRankUpIdle();
    assert.strictEqual(h2.posts.length, 1);

    const h3 = harness();
    seedPoints(h3.pointsFile, USER, 24);
    awardPvpWinXp(USER, "Ada", h3.pointsFile);
    await whenRankUpIdle();
    assert.strictEqual(h3.posts.length, 1);

    const h4 = harness();
    seedPoints(h4.pointsFile, USER, 24);
    awardMangoBombXp(USER, "Ada", 1, "round-1", h4.pointsFile);
    await whenRankUpIdle();
    assert.strictEqual(h4.posts.length, 1);

    const h5 = harness();
    seedPoints(h5.pointsFile, USER, 24);
    awardCommunityBuilderXp(USER, "Ada", 1, h5.pointsFile);
    await whenRankUpIdle();
    assert.strictEqual(h5.posts.length, 1);

    const h6 = harness();
    const before = JSON.stringify(loadPoints(h6.pointsFile));
    grantManualBuilderAward(
      {
        adminUserId: ADMIN_ID,
        targetUserId: USER,
        targetDisplayName: "Ada",
        rawArg: "5 Builder contribution",
        chatId: COMMUNITY_CHAT,
        messageId: 77,
      },
      { storeFile: h6.builderFile, pointsFile: h6.pointsFile, walletFile: h6.walletFile }
    );
    await whenRankUpIdle();
    assert.strictEqual(h6.posts.length, 0);
    assert.strictEqual(JSON.stringify(loadPoints(h6.pointsFile)), before);
  });

  await runTest("31. large XP award announces only final rank", async () => {
    const h = harness();
    seedPoints(h.pointsFile, USER, 0);
    const result = awardCommunityBuilderXp(USER, "Ada", 80, h.pointsFile);
    assert.strictEqual(result.previousRank.title, "Seed");
    assert.strictEqual(result.rank.title, "Tree");
    await whenRankUpIdle();
    assert.strictEqual(h.posts.length, 1);
    assert.ok(h.posts[0].text.includes("You reached Tree"));
    assert.ok(!h.posts[0].text.includes("You reached Sprout"));
  });

  await runTest("32-36. thresholds, wallet skip, no production files", async () => {
    assert.strictEqual(getRank(0).title, "Seed");
    assert.strictEqual(getRank(24).title, "Seed");
    assert.strictEqual(getRank(25).title, "Sprout");
    assert.strictEqual(getRank(75).title, "Tree");
    assert.strictEqual(getRank(150).title, "Mango Tree");
    assert.strictEqual(getRank(300).title, "Guardian");
    assert.strictEqual(getRank(600).title, "Legend");
    assert.deepStrictEqual(
      [...ANNOUNCE_RANK_TITLES],
      ["Sprout", "Tree", "Mango Tree", "Guardian", "Legend"]
    );
    const src = fs.readFileSync(path.join(__dirname, "..", "services", "points.js"), "utf8");
    assert.ok(src.includes("if (points >= 600) return { emoji: \"👑\", title: \"Legend\" }"));
    assert.ok(src.includes("if (points >= 25) return { emoji: \"🌿\", title: \"Sprout\" }"));
    assert.strictEqual(isTrueRankUp({ awarded: false, rankUp: true, rank: getRank(25) }), false);
    configureRankUpAnnounceForTests({});
    for (const file of prodRoots) {
      if (!fs.existsSync(file)) continue;
      assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
    }
  });
}

main()
  .then(() => {
    configureRankUpAnnounceForTests({});
    configureCommunityBuilderForTests({});
    setWalletFileForTests(null);
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll rank-up-announce tests passed.");
  })
  .catch((err) => {
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    console.error(err);
    process.exit(1);
  });
