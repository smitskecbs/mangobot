/**
 * Community Builder manual /builderaward grants.
 * Run: node tests/community-builder-awards.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  configureCommunityBuilderForTests,
  grantManualBuilderAward,
  parseManualBuilderAwardArgs,
  builderSummary,
  getBuilderLeaderboard,
  formatBuilderLeaderboard,
  BUILDER_EVENT_REASON,
} = require("../services/communityBuilder");
const { loadBuilderStore } = require("../services/communityBuilderStore");
const { loadPoints } = require("../services/points");
const { setWalletFileForTests } = require("../services/walletLinks");
const {
  handleBuilderAward,
  USAGE,
  ADMIN_ONLY,
  POINTS_TEXT,
  REASON_TEXT,
} = require("../commands/builderaward");

require("../services/xpWalletGate").setXpWalletAutoLinkForTests(false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-builder-awards-"));
const COMMUNITY_CHAT = "-1003916996602";
const TARGET = "1001";
const ADMIN_ID = "9001";
const OTHER = "3003";

const originalChat = process.env.TELEGRAM_CHAT_ID;
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.TELEGRAM_CHAT_ID = COMMUNITY_CHAT;
process.env.ADMIN_USER_ID = ADMIN_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

let n = 0;
function harness(now, extra = {}) {
  n += 1;
  const storeFile = path.join(tempDir, `builder-${n}.json`);
  const pointsFile = path.join(tempDir, `points-${n}.json`);
  const walletFile = path.join(tempDir, `wallet-${n}.json`);
  fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  fs.writeFileSync(walletFile, JSON.stringify({ users: {} }, null, 2), "utf8");
  const notifications = [];
  configureCommunityBuilderForTests({
    storeFile,
    pointsFile,
    walletFile,
    chatId: COMMUNITY_CHAT,
    now,
    notify: extra.notify || ((kind, payload) => {
      notifications.push({ kind, payload });
      return Promise.resolve({ sent: true });
    }),
  });
  setWalletFileForTests(walletFile);
  return {
    storeFile,
    pointsFile,
    walletFile,
    notifications,
    opts: { storeFile, pointsFile, walletFile, chatId: COMMUNITY_CHAT, now },
  };
}

function mockCtx(extra = {}) {
  const replies = [];
  return {
    chat: {
      type: extra.chatType || "supergroup",
      id: extra.chatId != null ? extra.chatId : Number(COMMUNITY_CHAT),
    },
    from: {
      id: extra.userId != null ? extra.userId : Number(ADMIN_ID),
      first_name: extra.name || "Kevin",
      is_bot: false,
    },
    message: {
      message_id: extra.messageId != null ? extra.messageId : 501,
      text: extra.text || "/builderaward 1 Helpful testing",
      reply_to_message: extra.noReply
        ? undefined
        : {
            message_id: 400,
            from: {
              id: extra.targetId != null ? extra.targetId : Number(TARGET),
              first_name: extra.targetName || "Alice",
              username: extra.targetUsername || "aliceuser",
              is_bot: Boolean(extra.targetIsBot),
            },
          },
    },
    replies,
    reply(text) {
      replies.push(text);
      return Promise.resolve();
    },
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
  await runTest("25-26. admin reply /builderaward 1 and +5 work", () => {
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now);
    const one = mockCtx({ text: "/builderaward 1 Helpful testing", messageId: 501 });
    handleBuilderAward(one, h.opts);
    assert.ok(one.replies[0].includes("Alice received +1 BP"));
    assert.ok(one.replies[0].includes("Helpful testing"));
    assert.ok(!one.replies[0].includes(TARGET));
    assert.strictEqual(builderSummary(TARGET, h.opts).builderPoints, 1);

    const five = mockCtx({
      text: "/builderaward 5 Builder contribution",
      messageId: 502,
    });
    handleBuilderAward(five, h.opts);
    assert.ok(five.replies[0].includes("+5 BP"));
    assert.strictEqual(builderSummary(TARGET, h.opts).builderPoints, 6);
  });

  await runTest("27-32. invalid points and reason rejected", () => {
    assert.strictEqual(parseManualBuilderAwardArgs("0 Helpful testing").reason, "points");
    assert.strictEqual(parseManualBuilderAwardArgs("-1 Helpful testing").reason, "points");
    assert.strictEqual(parseManualBuilderAwardArgs("6 Helpful testing").reason, "points");
    assert.strictEqual(parseManualBuilderAwardArgs("2.5 Helpful testing").reason, "points");
    assert.strictEqual(parseManualBuilderAwardArgs("1").reason, "reason");
    assert.strictEqual(parseManualBuilderAwardArgs("1 ab").reason, "reason");
    assert.strictEqual(
      parseManualBuilderAwardArgs(`1 ${"x".repeat(121)}`).reason,
      "reason-length"
    );
    assert.strictEqual(parseManualBuilderAwardArgs("2 Helpful testing").ok, true);

    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now);
    const zero = mockCtx({ text: "/builderaward 0 Helpful testing" });
    handleBuilderAward(zero, h.opts);
    assert.strictEqual(zero.replies[0], POINTS_TEXT);
    const missing = mockCtx({ text: "/builderaward 1" });
    handleBuilderAward(missing, h.opts);
    assert.strictEqual(missing.replies[0], REASON_TEXT);
    const long = mockCtx({ text: `/builderaward 1 ${"x".repeat(121)}` });
    handleBuilderAward(long, h.opts);
    assert.strictEqual(long.replies[0], REASON_TEXT);
    assert.strictEqual(builderSummary(TARGET, h.opts).builderPoints, 0);
  });

  await runTest("33-34. non-admin and no reply target reject", () => {
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now);
    const group = mockCtx({
      userId: Number(OTHER),
      chatType: "supergroup",
    });
    const groupResult = handleBuilderAward(group, h.opts);
    assert.strictEqual(groupResult, undefined);
    assert.strictEqual(group.replies.length, 0);

    const priv = mockCtx({
      userId: Number(OTHER),
      chatType: "private",
      chatId: Number(OTHER),
    });
    handleBuilderAward(priv, h.opts);
    assert.strictEqual(priv.replies[0], ADMIN_ONLY);

    const noReply = mockCtx({ noReply: true });
    handleBuilderAward(noReply, h.opts);
    assert.strictEqual(noReply.replies[0], USAGE);
    assert.strictEqual(builderSummary(TARGET, h.opts).builderPoints, 0);
  });

  await runTest("35-36. target BP and weekly/monthly/all-time reflect award", () => {
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now);
    handleBuilderAward(
      mockCtx({ text: "/builderaward 3 Builder contribution", messageId: 700 }),
      h.opts
    );
    assert.strictEqual(builderSummary(TARGET, h.opts).builderPoints, 3);
    const weekly = getBuilderLeaderboard({ ...h.opts, period: "weekly", now });
    const monthly = getBuilderLeaderboard({ ...h.opts, period: "monthly", now });
    const alltime = getBuilderLeaderboard({ ...h.opts, period: "alltime", now });
    assert.strictEqual(weekly[0].points, 3);
    assert.strictEqual(monthly[0].points, 3);
    assert.strictEqual(alltime[0].points, 3);
    const event = Object.values(loadBuilderStore(h.storeFile).builderEvents)[0];
    assert.strictEqual(event.reason, BUILDER_EVENT_REASON.MANUAL_AWARD);
    assert.strictEqual(event.note, "Builder contribution");
  });

  await runTest("37. DM failure does not rollback award", () => {
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now, {
      notify: () => {
        throw new Error("dm-failed");
      },
    });
    handleBuilderAward(
      mockCtx({ text: "/builderaward 2 Helpful testing", messageId: 800 }),
      {
        ...h.opts,
        notify: () => {
          throw new Error("dm-failed");
        },
      }
    );
    assert.strictEqual(builderSummary(TARGET, h.opts).builderPoints, 2);
  });

  await runTest("38-39. distinct awards allowed; same command retry does not duplicate", () => {
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now);
    const first = mockCtx({
      text: "/builderaward 1 Helpful testing",
      messageId: 900,
    });
    handleBuilderAward(first, h.opts);
    handleBuilderAward(first, h.opts);
    assert.strictEqual(builderSummary(TARGET, h.opts).builderPoints, 1);
    handleBuilderAward(
      mockCtx({ text: "/builderaward 1 Translation help", messageId: 901 }),
      h.opts
    );
    assert.strictEqual(builderSummary(TARGET, h.opts).builderPoints, 2);
    const events = Object.values(loadBuilderStore(h.storeFile).builderEvents);
    assert.strictEqual(events.length, 2);
  });

  await runTest("40-42. no XP/wallet mutation; leaderboard privacy preserved", () => {
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now);
    const pointsBefore = JSON.stringify(loadPoints(h.pointsFile));
    const walletBefore = fs.readFileSync(h.walletFile, "utf8");
    handleBuilderAward(
      mockCtx({ text: "/builderaward 2 Helpful testing", messageId: 910 }),
      h.opts
    );
    assert.strictEqual(JSON.stringify(loadPoints(h.pointsFile)), pointsBefore);
    assert.strictEqual(fs.readFileSync(h.walletFile, "utf8"), walletBefore);
    const board = getBuilderLeaderboard({ ...h.opts, period: "alltime", now });
    const text = formatBuilderLeaderboard(board, "alltime");
    assert.ok(text.includes("Alice — 2 BP"));
    assert.ok(!text.includes(TARGET));
    assert.ok(!text.includes(ADMIN_ID));
    assert.ok(!/wallet/i.test(text));
    assert.ok(!text.includes("Helpful testing"));
    assert.ok(!JSON.stringify(board).includes(TARGET));
  });

  await runTest("direct grantManualBuilderAward validates admin", () => {
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    const h = harness(now);
    const denied = grantManualBuilderAward(
      {
        adminUserId: OTHER,
        targetUserId: TARGET,
        targetDisplayName: "Alice",
        rawArg: "1 Helpful testing",
        chatId: COMMUNITY_CHAT,
        messageId: 1,
      },
      h.opts
    );
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, "not-admin");
  });

  for (const file of prodRoots) {
    if (!fs.existsSync(file)) continue;
    assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file], file);
  }
}

main()
  .then(() => {
    configureCommunityBuilderForTests({});
    setWalletFileForTests(null);
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\nAll community-builder-awards tests passed.");
  })
  .catch((err) => {
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdmin;
    console.error(err);
    process.exit(1);
  });
