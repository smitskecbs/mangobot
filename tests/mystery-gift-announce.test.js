/**
 * Mystery Gift community-group announcement.
 * Run: node tests/mystery-gift-announce.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const {
  createReward,
  getReward,
  markRewardSent,
  loadRewardsStore,
} = require("../services/memberRewards");
const {
  ANONYMOUS_CONGRATS,
  resolveAnnouncementIdentity,
  buildMysteryGiftDeliveredMessage,
  visibleAnnouncementText,
  announceMysteryGiftDelivered,
} = require("../services/mysteryGiftAnnounce");
const {
  RECIPIENT_MESSAGE,
  notifyMysteryGiftRecipient,
} = require("../services/mysteryGiftNotify");
const { handleReward } = require("../commands/reward");
const { getReplyTargetUser } = require("../utils/telegramReplyTarget");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const { mutatePoints } = require("../services/points");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-mg-announce-"));
const pointsFile = path.join(tempDir, "points.json");
const prodRewards = path.resolve(__dirname, "..", "data", "member-rewards.json");
let n = 0;
const TX_SIG = `${"1".repeat(32)}${"2".repeat(32)}${"3".repeat(24)}`;

function files() {
  n += 1;
  return {
    walletFile: path.join(tempDir, `w-${n}.json`),
    rewardsFile: path.join(tempDir, `r-${n}.json`),
  };
}

function runTest(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result
      .then(() => console.log(`✓ ${name}`))
      .catch((err) => {
        console.error(`✗ ${name}`);
        throw err;
      });
  }
  console.log(`✓ ${name}`);
  return undefined;
}

function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    address: encodeBase58(publicKeyRaw),
    sign(message) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      return signEd25519Detached(buf, privateKey);
    },
  };
}

function connectUser(walletFile, userId, wallet, now) {
  const created = createLinkToken(userId, { walletFile, now });
  const limiter = createMemoryRateLimiter();
  const challenge = createChallenge(
    { token: created.token, wallet: wallet.address },
    { walletFile, now: now + 1, rateLimiter: limiter }
  );
  const verified = verifyWalletSignature(
    {
      token: created.token,
      wallet: wallet.address,
      challengeId: challenge.challengeId,
      signature: wallet.sign(challenge.message).toString("base64"),
    },
    { walletFile, now: now + 2, rateLimiter: limiter }
  );
  assert.strictEqual(verified.ok, true, verified.error);
}

function recordingTelegram(ok = true) {
  const posts = [];
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    posts.push({ url: String(url), body });
    return { ok, json: async () => ({ ok }) };
  }
  return { posts, fetchImpl };
}

function assertMessageSafe(text, extra = {}) {
  const blob = String(text || "");
  assert.ok(blob.includes("🎁 Mystery Gift delivered!"));
  assert.ok(blob.includes("✅ Delivered"));
  if (extra.wallet) {
    assert.ok(!blob.includes(extra.wallet));
  }
  if (extra.rewardId) {
    assert.ok(!blob.includes(extra.rewardId));
  }
  if (extra.signature) {
    assert.ok(!blob.includes(extra.signature));
  }
  assert.ok(!/amount/i.test(blob));
  assert.ok(!/reward id/i.test(blob));
  assert.ok(!blob.includes("txSignature"));
}

fs.writeFileSync(pointsFile, JSON.stringify({ users: {} }, null, 2), "utf8");
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = "9001";
const pending = [];

pending.push(
  runTest("username present uses @username", () => {
    const html = buildMysteryGiftDeliveredMessage({
      kind: "username",
      username: "PippiMango",
      telegramUserId: "441122",
    });
    assert.ok(html.includes("Congrats @PippiMango! 🥭"));
    assert.ok(!html.includes("tg://user?id="));
    assert.ok(!html.includes("441122"));
    assertMessageSafe(html);
  })
);

pending.push(
  runTest("no username uses tg://user?id mention with escaped display name", () => {
    const uid = "99887766";
    const html = buildMysteryGiftDeliveredMessage({
      kind: "mention",
      displayName: "Ada",
      telegramUserId: uid,
    });
    assert.ok(html.includes(`<a href="tg://user?id=${uid}">Ada</a>`));
    const visible = visibleAnnouncementText(html);
    assert.ok(visible.includes("Congrats Ada! 🥭"));
    assert.ok(!visible.includes(uid));
    assertMessageSafe(html);
  })
);

pending.push(
  runTest("no identity snapshot uses anonymous fallback", () => {
    const html = buildMysteryGiftDeliveredMessage({ kind: "anonymous" });
    assert.ok(html.includes(ANONYMOUS_CONGRATS));
    assert.ok(!html.includes("tg://user?id="));
    assert.ok(!html.includes("@"));
    assertMessageSafe(html);
  })
);

pending.push(
  runTest("malicious display name is escaped", () => {
    const uid = "123456789";
    const dirty = `<img src=x onerror=alert(1)> & "Ada"`;
    const html = buildMysteryGiftDeliveredMessage({
      kind: "mention",
      displayName: dirty,
      telegramUserId: uid,
    });
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(!/<img\b/i.test(html));
    const visible = visibleAnnouncementText(html);
    assert.ok(!visible.includes(uid));
  })
);

pending.push(
  runTest("createReward snapshots telegram username and display name", () => {
    const { walletFile, rewardsFile } = files();
    const wallet = generateSolanaWallet();
    connectUser(walletFile, 44, wallet, 1000);
    const created = createReward({
      telegramUserId: 44,
      walletFile,
      rewardsFile,
      telegramUsername: "@PippiMango",
      displayName: "Pippi",
      now: 2,
    });
    assert.strictEqual(created.reward.telegramUsername, "PippiMango");
    assert.strictEqual(created.reward.displayNameSnapshot, "Pippi");
    const identity = resolveAnnouncementIdentity(created.reward);
    assert.strictEqual(identity.kind, "username");
    assert.strictEqual(identity.username, "PippiMango");
  })
);

pending.push(
  runTest("createReward snapshots points display name; old records still resolve at announce time", () => {
    const { walletFile, rewardsFile } = files();
    const wallet = generateSolanaWallet();
    connectUser(walletFile, 55, wallet, 1000);
    mutatePoints((data) => {
      data.users["55"] = { name: "LegacyPippi", points: 1 };
    }, pointsFile);
    const created = createReward({
      telegramUserId: 55,
      walletFile,
      rewardsFile,
      pointsFile,
      now: 3,
    });
    assert.strictEqual(created.reward.telegramUsername, null);
    assert.strictEqual(created.reward.displayNameSnapshot, "LegacyPippi");
    mutatePoints((data) => {
      data.users["56"] = { name: "OldMember", points: 2 };
    }, pointsFile);
    const old = resolveAnnouncementIdentity(
      { telegramUserId: "56" },
      { pointsFile }
    );
    assert.strictEqual(old.kind, "mention");
    assert.strictEqual(old.displayName, "OldMember");
    const anonymous = resolveAnnouncementIdentity({ telegramUserId: "57" }, { pointsFile });
    assert.strictEqual(anonymous.kind, "anonymous");
  })
);

pending.push(
  runTest("old reward without identity uses anonymous fallback", () => {
    const identity = resolveAnnouncementIdentity({
      telegramUserId: "66",
    });
    assert.strictEqual(identity.kind, "anonymous");
    const html = buildMysteryGiftDeliveredMessage(identity);
    assert.ok(html.includes(ANONYMOUS_CONGRATS));
  })
);

pending.push(
  runTest("/reward snapshots username from Telegram reply, not frontend", () => {
    const { walletFile, rewardsFile } = files();
    const wallet = generateSolanaWallet();
    connectUser(walletFile, 77, wallet, 1000);
    const ctx = {
      from: { id: 9001 },
      chat: { type: "private", id: 9001 },
      message: {
        text: "/reward mystery",
        reply_to_message: {
          from: {
            id: 77,
            first_name: "Pippi",
            username: "PippiMango",
            is_bot: false,
          },
        },
      },
      replies: [],
      reply(text) {
        this.replies.push({ text });
      },
    };
    const target = getReplyTargetUser(ctx);
    assert.strictEqual(target.username, "PippiMango");
    handleReward(ctx, { walletFile, rewardsFile, now: 4 });
    const stored = loadRewardsStore(rewardsFile);
    const reward = Object.values(stored.rewards)[0];
    assert.strictEqual(reward.telegramUsername, "PippiMango");
    assert.strictEqual(reward.displayNameSnapshot, "Pippi");
  })
);

pending.push(
  runTest("group announcement exact once; retry does not duplicate", async () => {
    const { walletFile, rewardsFile } = files();
    const wallet = generateSolanaWallet();
    connectUser(walletFile, 88, wallet, 1000);
    const created = createReward({
      telegramUserId: 88,
      walletFile,
      rewardsFile,
      telegramUsername: "MangoFan",
      displayName: "Fan",
      now: 5,
    });
    markRewardSent(created.reward.rewardId, TX_SIG, { rewardsFile, now: 6 });
    const telegram = recordingTelegram(true);
    const first = await announceMysteryGiftDelivered(created.reward.rewardId, {
      announceMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      chatId: "-1003916996602",
      fetchImpl: telegram.fetchImpl,
      now: 7,
    });
    assert.strictEqual(first.sent, true);
    const second = await announceMysteryGiftDelivered(created.reward.rewardId, {
      announceMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      chatId: "-1003916996602",
      fetchImpl: telegram.fetchImpl,
      now: 8,
    });
    assert.strictEqual(second.sent, false);
    assert.strictEqual(second.announced, true);
    assert.strictEqual(telegram.posts.length, 1);
    assert.strictEqual(telegram.posts[0].body.chat_id, "-1003916996602");
    assert.strictEqual(telegram.posts[0].body.parse_mode, "HTML");
    assert.strictEqual(telegram.posts[0].body.message_thread_id, undefined);
    assert.ok(telegram.posts[0].body.text.includes("@MangoFan"));
    assert.ok(!JSON.stringify(telegram.posts[0].body).includes("message_thread_id"));
    const stored = getReward(created.reward.rewardId, rewardsFile);
    assert.strictEqual(stored.status, "sent");
    assert.ok(stored.groupAnnouncedAt);
    assertMessageSafe(telegram.posts[0].body.text, {
      wallet: wallet.address,
      rewardId: created.reward.rewardId,
      signature: TX_SIG,
    });
  })
);

pending.push(
  runTest("telegram failure does not roll back sent; later retry can send once", async () => {
    const { walletFile, rewardsFile } = files();
    const wallet = generateSolanaWallet();
    connectUser(walletFile, 99, wallet, 1000);
    const created = createReward({
      telegramUserId: 99,
      walletFile,
      rewardsFile,
      displayName: "Ada",
      now: 9,
    });
    markRewardSent(created.reward.rewardId, TX_SIG, { rewardsFile, now: 10 });
    const failing = recordingTelegram(false);
    const failed = await announceMysteryGiftDelivered(created.reward.rewardId, {
      announceMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      chatId: "-1003916996602",
      fetchImpl: failing.fetchImpl,
      now: 11,
    });
    assert.strictEqual(failed.sent, false);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).groupAnnouncedAt, null);

    const ok = recordingTelegram(true);
    const recovered = await announceMysteryGiftDelivered(created.reward.rewardId, {
      announceMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      chatId: "-1003916996602",
      fetchImpl: ok.fetchImpl,
      now: 12,
    });
    assert.strictEqual(recovered.sent, true);
    const again = await announceMysteryGiftDelivered(created.reward.rewardId, {
      announceMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      chatId: "-1003916996602",
      fetchImpl: ok.fetchImpl,
      now: 13,
    });
    assert.strictEqual(again.sent, false);
    assert.strictEqual(ok.posts.length, 1);
    const visible = visibleAnnouncementText(ok.posts[0].body.text);
    assert.ok(!visible.includes("99"));
    assert.ok(ok.posts[0].body.text.includes("tg://user?id=99"));
  })
);

pending.push(
  runTest("private DM exact once; telegram failure does not roll back sent", async () => {
    const { walletFile, rewardsFile } = files();
    const wallet = generateSolanaWallet();
    connectUser(walletFile, 202, wallet, 1000);
    const created = createReward({
      telegramUserId: 202,
      walletFile,
      rewardsFile,
      telegramUsername: "MangoFan",
      now: 20,
    });
    markRewardSent(created.reward.rewardId, TX_SIG, { rewardsFile, now: 21 });
    const failing = recordingTelegram(false);
    const failed = await notifyMysteryGiftRecipient(created.reward.rewardId, {
      notifyMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      fetchImpl: failing.fetchImpl,
      now: 22,
    });
    assert.strictEqual(failed.sent, false);
    assert.strictEqual(getReward(created.reward.rewardId, rewardsFile).status, "sent");
    const ok = recordingTelegram(true);
    const recovered = await notifyMysteryGiftRecipient(created.reward.rewardId, {
      notifyMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      fetchImpl: ok.fetchImpl,
      now: 23,
    });
    assert.strictEqual(recovered.sent, true);
    const again = await notifyMysteryGiftRecipient(created.reward.rewardId, {
      notifyMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      fetchImpl: ok.fetchImpl,
      now: 24,
    });
    assert.strictEqual(again.sent, false);
    assert.strictEqual(ok.posts.length, 1);
    assert.strictEqual(String(ok.posts[0].body.chat_id), "202");
    assert.strictEqual(ok.posts[0].body.text, RECIPIENT_MESSAGE);
    assert.ok(!/amount/i.test(ok.posts[0].body.text));
    assert.ok(!ok.posts[0].body.text.includes(wallet.address));
    assert.ok(!ok.posts[0].body.text.includes(TX_SIG));
    assert.ok(!ok.posts[0].body.text.includes(created.reward.rewardId));
  })
);

pending.push(
  runTest("airdrop is not announced as a Mystery Gift", async () => {
    const { walletFile, rewardsFile } = files();
    const wallet = generateSolanaWallet();
    connectUser(walletFile, 101, wallet, 1000);
    const created = createReward({
      telegramUserId: 101,
      type: "airdrop",
      walletFile,
      rewardsFile,
      now: 14,
    });
    markRewardSent(created.reward.rewardId, TX_SIG, { rewardsFile, now: 15 });
    const telegram = recordingTelegram(true);
    const result = await announceMysteryGiftDelivered(created.reward.rewardId, {
      announceMysteryGift: true,
      rewardsFile,
      botToken: "TESTTOKEN",
      chatId: "-1003916996602",
      fetchImpl: telegram.fetchImpl,
      now: 16,
    });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(telegram.posts.length, 0);
  })
);

pending.push(
  runTest("announce source has no Games topic and no secrets", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "services", "mysteryGiftAnnounce.js"),
      "utf8"
    );
    assert.ok(!src.includes("TELEGRAM_GAMES_TOPIC_ID"));
    assert.ok(!src.includes("message_thread"));
    assert.ok(!src.toLowerCase().includes("privatekey"));
    assert.ok(!src.toLowerCase().includes("seed phrase"));
    const delivery = fs.readFileSync(
      path.join(__dirname, "..", "services", "rewardDelivery.js"),
      "utf8"
    );
    assert.ok(delivery.includes("announceMysteryGiftDelivered"));
    assert.ok(!delivery.includes("message_thread_id"));
    const { rewardsFile } = files();
    assert.notStrictEqual(path.resolve(rewardsFile), prodRewards);
  })
);

Promise.all(pending.filter(Boolean)).then(() => {
  if (originalAdmin === undefined) {
    delete process.env.ADMIN_USER_ID;
  } else {
    process.env.ADMIN_USER_ID = originalAdmin;
  }
  console.log("mystery-gift-announce tests passed");
});
