/**
 * 48-hour wallet grace for new Telegram joins. Temp files only.
 * Run: node tests/wallet-grace.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("node:crypto");

const { encodeBase58 } = require("../utils/base58");
const { signEd25519Detached } = require("../utils/ed25519");
const { mutatePoints } = require("../services/points");
const {
  registerManualWallet,
  setWalletFileForTests,
  disconnectWallet,
  mutateWalletStore,
} = require("../services/walletLinks");
const {
  createLinkToken,
  createChallenge,
  verifyWalletSignature,
  createMemoryRateLimiter,
} = require("../services/walletVerification");
const {
  setKnownMembersFileForTests,
  addProtectedUser,
  recordObservedJoin,
  recordObservedLeave,
  recordChatMemberTransition,
  loadKnownMembersStore,
  mutateKnownMembersStore,
  markWalletGraceNoticeSent,
  getWalletGraceNoticeState,
  tryClaimWalletGraceNotice,
  WALLET_GRACE_MS,
  REMINDER_STATE,
  NOTICE_STATE,
} = require("../services/knownMembers");
const {
  GRACE_MS,
  REMINDER_AFTER_MS,
  processWalletGraceTick,
  formatWalletGraceAdmin,
  maybeSendWalletGraceNotice,
  CONCISE_WALLET_GRACE_NOTICE,
} = require("../services/walletGrace");
const { handleChatMemberUpdate } = require("../services/communityBuilder");
const { registerKnownMemberListeners } = require("../events/known-members");
const {
  scanWalletCleanup,
  confirmWalletCleanup,
} = require("../services/walletCleanup");
const {
  handleWalletCleanup,
  handleWalletCleanupConfirm,
} = require("../commands/walletcleanup");
const { handleWalletGrace } = require("../commands/walletgrace");
const {
  WELCOME_TEXT,
  WELCOME_TEXT_NO_WALLET_WARNING,
  sendWalletAwareWelcome,
} = require("../events/welcome");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-wallet-grace-"));
let n = 0;
const CHAT = "-1003916996602";
const originalAdmin = process.env.ADMIN_USER_ID;
const originalChat = process.env.TELEGRAM_CHAT_ID;
process.env.ADMIN_USER_ID = "9001";
process.env.TELEGRAM_CHAT_ID = CHAT;

function files() {
  n += 1;
  const pack = {
    pointsFile: path.join(tempDir, `p-${n}.json`),
    walletFile: path.join(tempDir, `w-${n}.json`),
    membersFile: path.join(tempDir, `m-${n}.json`),
  };
  setWalletFileForTests(pack.walletFile);
  setKnownMembersFileForTests(pack.membersFile);
  mutateWalletStore((store) => store, pack.walletFile);
  return pack;
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

function verifyUser(walletFile, userId, wallet, now) {
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
  return verified;
}

function memberResult(userId, extra = {}) {
  return {
    status: extra.status || "member",
    user: {
      id: Number(userId),
      is_bot: Boolean(extra.isBot),
      first_name: extra.name || "User",
      username: extra.username || "",
    },
  };
}

function join(pack, userId, now, extra = {}) {
  return recordObservedJoin(
    {
      chatId: CHAT,
      userId,
      displayName: extra.name || "Joiner",
      username: extra.username || "joiner",
      source: extra.source,
      newStatus: extra.newStatus,
    },
    { membersFile: pack.membersFile, walletFile: pack.walletFile, now }
  );
}

function noticeSent(pack, userId, now = 1) {
  return markWalletGraceNoticeSent(userId, {
    membersFile: pack.membersFile,
    now,
  });
}

function joinUpdate(userId, extra = {}) {
  const user = {
    id: Number(userId),
    is_bot: Boolean(extra.isBot),
    first_name: extra.name || "Joiner",
    username: extra.username || "joiner",
  };
  return {
    chat: { id: Number(CHAT) },
    old_chat_member: { status: extra.oldStatus || "left", user },
    new_chat_member: { status: extra.newStatus || "member", user },
  };
}

function welcomeReply(bucket) {
  return async (text) => {
    const msg = { message_id: bucket.length + 1, text };
    bucket.push(msg);
    return msg;
  };
}

function tickApi(pack, membership, extra = {}) {
  const bans = extra.bans || [];
  const unbans = extra.unbans || [];
  const sent = extra.sent || [];
  const getChatMember =
    typeof extra.getChatMember === "function"
      ? extra.getChatMember
      : extra.lookupThrow
        ? async () => {
            throw new Error("getChatMember failed");
          }
        : async (_chatId, userId) => {
            const row = membership[String(userId)];
            if (row === "throw") {
              throw new Error("getChatMember failed");
            }
            if (!row) {
              throw new Error("unknown");
            }
            return row;
          };
  return {
    ...pack,
    chatId: CHAT,
    now: extra.now,
    force: true,
    getChatMember,
    banChatMember:
      extra.banChatMember ||
      (async (chatId, userId) => {
        bans.push({ chatId: String(chatId), userId: String(userId) });
      }),
    unbanChatMember:
      extra.unbanChatMember ||
      (async (chatId, userId, opts) => {
        unbans.push({
          chatId: String(chatId),
          userId: String(userId),
          onlyIfBanned: Boolean(opts && opts.only_if_banned),
        });
      }),
    sendMessage:
      extra.sendMessage ||
      (async (chatId, text) => {
        sent.push({ chatId: String(chatId), text });
      }),
    bans,
    unbans,
    sent,
  };
}

function createMockCtx({ userId = 9001, chatType = "private", text = "/walletgrace" } = {}) {
  const replies = [];
  return {
    chat: { type: chatType, id: chatType === "private" ? userId : -1001 },
    from: { id: userId, first_name: "Admin" },
    message: { text },
    replies,
    reply(msg) {
      replies.push({ text: msg });
      return Promise.resolve(replies[replies.length - 1]);
    },
    telegram: {},
  };
}

async function runTest(name, fn) {
  await fn();
  console.log(`✓ ${name}`);
}

async function main() {
  assert.strictEqual(GRACE_MS, WALLET_GRACE_MS);
  assert.strictEqual(REMINDER_AFTER_MS, 24 * 60 * 60 * 1000);

  await runTest("1. New join → 48h deadline created", () => {
    const pack = files();
    const now = 1_000_000;
    const result = join(pack, 101, now);
    assert.strictEqual(result.graceStarted, true);
    const row = loadKnownMembersStore(pack.membersFile).members["101"];
    assert.strictEqual(row.walletGraceDeadline, now + GRACE_MS);
    assert.strictEqual(row.reminderState, REMINDER_STATE.PENDING);
    assert.strictEqual(row.walletGraceNoticeState, NOTICE_STATE.PENDING);
    assert.strictEqual(row.walletRequirementSatisfiedAt, null);
  });

  await runTest("2. Existing historical member → NO retroactive deadline", () => {
    const pack = files();
    mutateKnownMembersStore((store) => {
      store.members["102"] = {
        telegramUserId: "102",
        username: "old",
        displayName: "Historical",
        firstSeenAt: 10,
        lastSeenAt: 10,
        joinedAt: 10,
        leftAt: 0,
        sources: ["points"],
        walletGraceDeadline: null,
        reminderState: null,
      };
    }, pack.membersFile);
    const result = join(pack, 102, 99_000, { name: "Historical", username: "old" });
    assert.strictEqual(result.graceStarted, false);
    const row = loadKnownMembersStore(pack.membersFile).members["102"];
    assert.strictEqual(row.walletGraceDeadline, null);
    assert.strictEqual(row.reminderState, null);
    assert.strictEqual(row.walletGraceNoticeState, null);
  });

  await runTest("3. Registered wallet before 24h → no reminder/no kick", async () => {
    const pack = files();
    join(pack, 103, 0);
    registerManualWallet(103, generateSolanaWallet().address, pack.walletFile, 10);
    const api = tickApi(pack, { 103: memberResult("103") }, { now: REMINDER_AFTER_MS });
    const mid = await processWalletGraceTick(api);
    assert.strictEqual(mid.reminders.length, 0);
    assert.strictEqual(api.sent.length, 0);
    api.now = GRACE_MS;
    const late = await processWalletGraceTick(api);
    assert.strictEqual(late.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
    const row = loadKnownMembersStore(pack.membersFile).members["103"];
    assert.strictEqual(row.reminderState, REMINDER_STATE.SATISFIED);
  });

  await runTest("4. Verified wallet before 24h → no reminder/no kick", async () => {
    const pack = files();
    join(pack, 104, 0);
    verifyUser(pack.walletFile, 104, generateSolanaWallet(), 20);
    const api = tickApi(pack, { 104: memberResult("104") }, { now: REMINDER_AFTER_MS });
    const mid = await processWalletGraceTick(api);
    assert.strictEqual(mid.reminders.length, 0);
    api.now = GRACE_MS;
    const late = await processWalletGraceTick(api);
    assert.strictEqual(late.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
    const row = loadKnownMembersStore(pack.membersFile).members["104"];
    assert.strictEqual(row.reminderState, REMINDER_STATE.SATISFIED);
  });

  await runTest("5. No wallet after 24h → exactly one reminder", async () => {
    const pack = files();
    join(pack, 105, 0, { username: "newbie" });
    noticeSent(pack, 105, 0);
    const api = tickApi(pack, { 105: memberResult("105", { username: "newbie" }) }, {
      now: REMINDER_AFTER_MS,
    });
    const first = await processWalletGraceTick(api);
    assert.strictEqual(first.reminders.length, 1);
    assert.strictEqual(api.sent.length, 1);
    assert.ok(api.sent[0].text.includes("@newbie"));
    assert.ok(api.sent[0].text.includes("24 hours"));
    const row = loadKnownMembersStore(pack.membersFile).members["105"];
    assert.strictEqual(row.reminderState, REMINDER_STATE.SENT);
    const second = await processWalletGraceTick(api);
    assert.strictEqual(second.reminders.length, 0);
    assert.strictEqual(api.sent.length, 1);
  });

  await runTest("6. Wallet linked after reminder → no kick", async () => {
    const pack = files();
    join(pack, 106, 0);
    noticeSent(pack, 106, 0);
    const api = tickApi(pack, { 106: memberResult("106") }, { now: REMINDER_AFTER_MS });
    await processWalletGraceTick(api);
    registerManualWallet(106, generateSolanaWallet().address, pack.walletFile, REMINDER_AFTER_MS + 5);
    api.now = GRACE_MS;
    const late = await processWalletGraceTick(api);
    assert.strictEqual(late.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("7. No wallet after 48h → eligible", async () => {
    const pack = files();
    join(pack, 107, 0);
    noticeSent(pack, 107, 0);
    const api = tickApi(pack, { 107: memberResult("107") }, { now: GRACE_MS });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 1);
    assert.strictEqual(api.bans.length, 1);
    assert.strictEqual(api.unbans.length, 1);
    const row = loadKnownMembersStore(pack.membersFile).members["107"];
    assert.strictEqual(row.reminderState, REMINDER_STATE.ENFORCED);
  });

  await runTest("8. Admin after 48h → protected/no kick", async () => {
    const pack = files();
    join(pack, 108, 0);
    noticeSent(pack, 108, 0);
    const api = tickApi(
      pack,
      { 108: memberResult("108", { status: "administrator" }) },
      { now: GRACE_MS }
    );
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("9. Creator → no kick", async () => {
    const pack = files();
    join(pack, 109, 0);
    noticeSent(pack, 109, 0);
    const api = tickApi(
      pack,
      { 109: memberResult("109", { status: "creator" }) },
      { now: GRACE_MS }
    );
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("10. ADMIN_USER_ID → no kick", async () => {
    const pack = files();
    join(pack, 9001, 0);
    noticeSent(pack, 9001, 0);
    const api = tickApi(pack, { 9001: memberResult("9001") }, { now: GRACE_MS });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("11. Bot → no kick", async () => {
    const pack = files();
    join(pack, 111, 0);
    noticeSent(pack, 111, 0);
    const api = tickApi(
      pack,
      { 111: memberResult("111", { isBot: true }) },
      { now: GRACE_MS }
    );
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("12. Explicit /walletprotect → no kick", async () => {
    const pack = files();
    join(pack, 112, 0);
    noticeSent(pack, 112, 0);
    addProtectedUser("112", { membersFile: pack.membersFile, now: 1 });
    const api = tickApi(pack, { 112: memberResult("112") }, { now: GRACE_MS });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
    const text = formatWalletGraceAdmin({
      membersFile: pack.membersFile,
      walletFile: pack.walletFile,
      now: GRACE_MS,
    });
    assert.ok(text.includes("Protected: 1"));
  });

  await runTest("13. getChatMember failure → no kick", async () => {
    const pack = files();
    join(pack, 113, 0);
    noticeSent(pack, 113, 0);
    const api = tickApi(pack, {}, { now: GRACE_MS, lookupThrow: true });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("14. wallet store failure → no kick", async () => {
    const pack = files();
    join(pack, 114, 0);
    noticeSent(pack, 114, 0);
    fs.writeFileSync(pack.walletFile, "{not-json", "utf8");
    const api = tickApi(pack, { 114: memberResult("114") }, { now: GRACE_MS });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("15. user left voluntarily → no kick", async () => {
    const pack = files();
    join(pack, 115, 0);
    noticeSent(pack, 115, 0);
    recordObservedLeave(
      { chatId: CHAT, userId: 115, displayName: "Gone" },
      { membersFile: pack.membersFile, now: 50 }
    );
    const api = tickApi(
      pack,
      { 115: memberResult("115", { status: "left" }) },
      { now: GRACE_MS }
    );
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("16. kick succeeds → immediate unban", async () => {
    const pack = files();
    join(pack, 116, 0);
    noticeSent(pack, 116, 0);
    const api = tickApi(pack, { 116: memberResult("116") }, { now: GRACE_MS });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 1);
    assert.strictEqual(result.enforced[0].kicked, true);
    assert.strictEqual(result.enforced[0].unbanned, true);
    assert.deepStrictEqual(api.bans, [{ chatId: CHAT, userId: "116" }]);
    assert.deepStrictEqual(api.unbans, [
      { chatId: CHAT, userId: "116", onlyIfBanned: true },
    ]);
  });

  await runTest("17. kick failure → no false success", async () => {
    const pack = files();
    join(pack, 117, 0);
    noticeSent(pack, 117, 0);
    const api = tickApi(pack, { 117: memberResult("117") }, {
      now: GRACE_MS,
      banChatMember: async () => {
        throw new Error("forbidden");
      },
    });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(result.kickFailed.length, 1);
    const row = loadKnownMembersStore(pack.membersFile).members["117"];
    assert.notStrictEqual(row.reminderState, REMINDER_STATE.ENFORCED);
  });

  await runTest("18. unban failure → prominently recorded (UNBAN FAILED)", async () => {
    const pack = files();
    join(pack, 118, 0);
    noticeSent(pack, 118, 0);
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const api = tickApi(pack, { 118: memberResult("118") }, {
        now: GRACE_MS,
        unbanChatMember: async () => {
          throw new Error("unban exploded");
        },
      });
      const result = await processWalletGraceTick(api);
      assert.strictEqual(result.enforced.length, 1);
      assert.strictEqual(result.unbanFailed.length, 1);
      assert.strictEqual(result.unbanFailed[0].unbanned, false);
      assert.ok(errors.some((line) => line.includes("UNBAN FAILED")));
    } finally {
      console.error = originalError;
    }
  });

  await runTest("19. service restart before deadline → deadline survives", async () => {
    const pack = files();
    join(pack, 119, 1_000);
    const before = loadKnownMembersStore(pack.membersFile).members["119"].walletGraceDeadline;
    setKnownMembersFileForTests(pack.membersFile);
    const after = loadKnownMembersStore(pack.membersFile).members["119"].walletGraceDeadline;
    assert.strictEqual(after, before);
    const api = tickApi(pack, { 119: memberResult("119") }, { now: 1_000 + REMINDER_AFTER_MS - 1 });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(result.reminders.length, 0);
    assert.strictEqual(api.bans.length, 0);
  });

  await runTest("20. service restart after deadline → safe overdue processing", async () => {
    const pack = files();
    join(pack, 120, 0);
    noticeSent(pack, 120, 0);
    const persisted = loadKnownMembersStore(pack.membersFile).members["120"];
    assert.ok(persisted.walletGraceDeadline);
    const api = tickApi(pack, { 120: memberResult("120") }, { now: GRACE_MS + 5 });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 1);
  });

  await runTest("21. scheduler cannot kick same join twice", async () => {
    const pack = files();
    join(pack, 121, 0);
    noticeSent(pack, 121, 0);
    let status = "member";
    const api = tickApi(
      pack,
      {},
      {
        now: GRACE_MS,
        getChatMember: async () => memberResult("121", { status }),
      }
    );
    const first = await processWalletGraceTick(api);
    assert.strictEqual(first.enforced.length, 1);
    status = "left";
    const second = await processWalletGraceTick(api);
    assert.strictEqual(second.enforced.length, 0);
    assert.strictEqual(api.bans.length, 1);
  });

  await runTest("22. reminder cannot send twice", async () => {
    const pack = files();
    join(pack, 122, 0);
    noticeSent(pack, 122, 0);
    const api = tickApi(pack, { 122: memberResult("122") }, { now: REMINDER_AFTER_MS });
    await processWalletGraceTick(api);
    await processWalletGraceTick(api);
    assert.strictEqual(api.sent.length, 1);
    const row = loadKnownMembersStore(pack.membersFile).members["122"];
    assert.strictEqual(row.reminderState, REMINDER_STATE.SENT);
  });

  await runTest("23. kicked user rejoins → fresh 48h grace", async () => {
    const pack = files();
    join(pack, 123, 0);
    noticeSent(pack, 123, 0);
    const api = tickApi(pack, { 123: memberResult("123") }, { now: GRACE_MS });
    await processWalletGraceTick(api);
    const afterKick = loadKnownMembersStore(pack.membersFile).members["123"];
    assert.strictEqual(afterKick.reminderState, REMINDER_STATE.ENFORCED);
    assert.ok(afterKick.leftAt > 0);
    const rejoinNow = GRACE_MS + 10_000;
    const again = join(pack, 123, rejoinNow);
    assert.strictEqual(again.graceStarted, true);
    const row = loadKnownMembersStore(pack.membersFile).members["123"];
    assert.strictEqual(row.walletGraceDeadline, rejoinNow + GRACE_MS);
    assert.strictEqual(row.reminderState, REMINDER_STATE.PENDING);
    assert.strictEqual(row.walletGraceNoticeState, NOTICE_STATE.PENDING);
    assert.strictEqual(row.walletRequirementSatisfiedAt, null);
  });

  await runTest("24. wallet unlink later does NOT reuse an old expired grace period", async () => {
    const pack = files();
    join(pack, 124, 0);
    registerManualWallet(124, generateSolanaWallet().address, pack.walletFile, 5);
    await Promise.resolve();
    const satisfied = loadKnownMembersStore(pack.membersFile).members["124"];
    assert.strictEqual(satisfied.reminderState, REMINDER_STATE.SATISFIED);
    disconnectWallet(124, pack.walletFile);
    const api = tickApi(pack, { 124: memberResult("124") }, { now: GRACE_MS + 1 });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
    const row = loadKnownMembersStore(pack.membersFile).members["124"];
    assert.strictEqual(row.reminderState, REMINDER_STATE.SATISFIED);
    assert.ok(row.walletRequirementSatisfiedAt);
  });

  await runTest("25. manual /walletcleanup behavior remains unchanged", async () => {
    const pack = files();
    mutatePoints((data) => {
      data.users["125"] = {
        points: 0,
        weeklyPoints: 0,
        weekId: "2026-09-06",
        name: "PreviewOnly",
        triggerDate: null,
        triggersUsed: [],
      };
    }, pack.pointsFile);
    let banned = 0;
    const ctx = createMockCtx();
    ctx.telegram.banChatMember = async () => {
      banned += 1;
    };
    ctx.telegram.unbanChatMember = async () => {
      banned += 1;
    };
    ctx.telegram.getChatMember = async (_c, userId) => {
      if (String(userId) !== "125") {
        throw new Error("unknown");
      }
      return memberResult("125", { name: "PreviewOnly" });
    };
    await handleWalletCleanup(ctx, pack);
    assert.strictEqual(banned, 0);
    assert.ok(ctx.replies[0].text.includes("NOBODY was removed"));
    assert.ok(ctx.replies[0].text.includes("eligible: 1"));
    assert.ok(ctx.replies[0].text.includes("/walletcleanup_confirm"));
    assert.ok(ctx.replies[0].text.includes("Wallet grace:"));
  });

  await runTest("26. /walletcleanup_confirm behavior remains unchanged", async () => {
    const pack = files();
    mutatePoints((data) => {
      data.users["126"] = {
        points: 0,
        weeklyPoints: 0,
        weekId: "2026-09-06",
        name: "Confirm",
        triggerDate: null,
        triggersUsed: [],
      };
    }, pack.pointsFile);
    const ctx = createMockCtx();
    const bans = [];
    ctx.telegram.getChatMember = async (_c, userId) => {
      if (String(userId) !== "126") {
        throw new Error("unknown");
      }
      return memberResult("126", { name: "Confirm" });
    };
    ctx.telegram.banChatMember = async (_c, userId) => {
      bans.push(String(userId));
    };
    ctx.telegram.unbanChatMember = async () => undefined;
    await handleWalletCleanupConfirm(ctx, pack);
    assert.deepStrictEqual(bans, ["126"]);
    assert.ok(ctx.replies[0].text.includes("Kicked + unbanned: 1"));
    const only126 = async (_c, userId) => {
      if (String(userId) !== "126") {
        throw new Error("unknown");
      }
      return memberResult("126");
    };
    const scan = await scanWalletCleanup({
      ...pack,
      chatId: CHAT,
      getChatMember: only126,
    });
    assert.strictEqual(scan.removed, false);
    const confirm = await confirmWalletCleanup({
      ...pack,
      chatId: CHAT,
      getChatMember: only126,
      banChatMember: async () => undefined,
      unbanChatMember: async () => undefined,
    });
    assert.strictEqual(confirm.kicked.length, 1);
  });

  await runTest("27. wallet linking/security behavior remains unchanged", () => {
    const pack = files();
    const wallet = generateSolanaWallet();
    const registered = registerManualWallet(127, wallet.address, pack.walletFile, 1);
    assert.strictEqual(registered.ok, true);
    assert.strictEqual(registered.wallet, wallet.address);
    const other = generateSolanaWallet();
    const verified = verifyUser(pack.walletFile, 128, other, 100);
    assert.strictEqual(verified.ok, true);
    const taken = registerManualWallet(129, wallet.address, pack.walletFile, 200);
    assert.strictEqual(taken.ok, false);
    const disconnect = disconnectWallet(127, pack.walletFile);
    assert.strictEqual(disconnect.disconnected, true);
  });

  await runTest("welcome text states the 48h wallet requirement", () => {
    const text = WELCOME_TEXT("Ada");
    assert.ok(text.includes("🥭 Welcome Ada!"));
    assert.ok(text.includes("connect your Solana wallet within 48 hours"));
    assert.ok(text.includes("/menu → Wallet"));
    assert.ok(text.includes("automatic removal"));
    assert.ok(text.includes("rejoin later"));
    assert.ok(text.includes("📌 Please read the pinned message"));
    assert.ok(text.includes("🌐 Use /links for official links"));
    assert.ok(text.includes("🚀 Use /launch for project status"));
    assert.ok(!/buy|profit|token sale/i.test(text));
    const friendly = WELCOME_TEXT_NO_WALLET_WARNING("Ada");
    assert.ok(friendly.includes("🥭 Welcome Ada!"));
    assert.ok(friendly.includes("📌 Please read the pinned message"));
    assert.ok(!friendly.includes("automatic removal"));
    assert.ok(!friendly.includes("48 hours"));
    assert.ok(CONCISE_WALLET_GRACE_NOTICE.includes("connect your Solana wallet within 48 hours"));
    assert.ok(!CONCISE_WALLET_GRACE_NOTICE.includes("📌 Please read the pinned message"));
  });

  await runTest("duplicate join while already in group does not reset grace", () => {
    const pack = files();
    join(pack, 130, 50);
    const first = loadKnownMembersStore(pack.membersFile).members["130"].walletGraceDeadline;
    const again = join(pack, 130, 999);
    assert.strictEqual(again.graceStarted, false);
    const row = loadKnownMembersStore(pack.membersFile).members["130"];
    assert.strictEqual(row.walletGraceDeadline, first);
    assert.strictEqual(row.joinedAt, 50);
  });

  await runTest("/walletgrace lists pending and looks up one id", async () => {
    const pack = files();
    join(pack, 131, 0, { name: "Gracey", username: "gracey" });
    const ctx = createMockCtx({ text: "/walletgrace" });
    await handleWalletGrace(ctx, { ...pack, now: 1_000 });
    assert.ok(ctx.replies[0].text.includes("Pending: 1"));
    assert.ok(ctx.replies[0].text.includes("Gracey"));
    const one = createMockCtx({ text: "/walletgrace 131" });
    await handleWalletGrace(one, { ...pack, now: 1_000 });
    assert.ok(one.replies[0].text.includes("131"));
    assert.ok(one.replies[0].text.includes("pending"));
    const denied = createMockCtx({ userId: 77, text: "/walletgrace" });
    await handleWalletGrace(denied, pack);
    assert.strictEqual(denied.replies[0].text, "This command is admin only.");
  });

  await runTest("disabled community scheduler still runs wallet grace ticks", async () => {
    const pack = files();
    join(pack, 140, Date.now() - GRACE_MS - 1000);
    noticeSent(pack, 140, 1);
    const bans = [];
    const { startCommunityScheduler } = require("../services/communityScheduler");
    const { savePoints } = require("../services/points");
    const {
      writeWinnersState,
      emptyState: emptyWinnersState,
    } = require("../services/weeklyWinners");
    const pointsFile = path.join(tempDir, `sched-points-${n}.json`);
    const weeklyWinnersFile = path.join(tempDir, `sched-winners-${n}.json`);
    savePoints({ users: {} }, pointsFile);
    writeWinnersState(emptyWinnersState(), weeklyWinnersFile);
    const sched = startCommunityScheduler(
      {
        getChatMember: async () => memberResult("140"),
        banChatMember: async (_c, userId) => {
          bans.push(String(userId));
        },
        unbanChatMember: async () => undefined,
        sendMessage: async () => true,
        editMessageText: async () => true,
        deleteMessage: async () => true,
      },
      {
        enabled: false,
        chatId: CHAT,
        stateFile: path.join(tempDir, `sched-state-${n}.json`),
        membersFile: pack.membersFile,
        walletFile: pack.walletFile,
        pointsFile,
        weeklyWinnersFile,
        activityEngineConfig: {
          enabled: false,
          twentyFourSeven: false,
          intervalMinutes: 30,
          slots: [],
          autoFightEnabled: false,
          autoFightMinGapMinutes: 120,
          autoFightMinGapMs: 120 * 60_000,
          skipRecentMs: 0,
          fightTypes: [],
        },
        autoChatFightConfig: {
          enabled: false,
          intervalMinutes: 120,
          chancePercent: 0,
          slots: [],
          types: [],
          startHour: 9,
          endHour: 22,
          minActivityGapMs: 0,
        },
      }
    );
    assert.strictEqual(sched.isTimerRunning(), false);
    for (let i = 0; i < 30 && bans.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(sched.isTimerRunning(), false);
    assert.deepStrictEqual(bans, ["140"]);
    assert.strictEqual(
      loadKnownMembersStore(pack.membersFile).members["140"].reminderState,
      REMINDER_STATE.ENFORCED
    );
    sched.stop();
  });

  await runTest("rejoin with an already-linked wallet is marked satisfied", () => {
    const pack = files();
    join(pack, 132, 0);
    recordObservedLeave(
      { chatId: CHAT, userId: 132 },
      { membersFile: pack.membersFile, now: 10 }
    );
    registerManualWallet(132, generateSolanaWallet().address, pack.walletFile, 11);
    const again = join(pack, 132, 20);
    assert.strictEqual(again.graceStarted, true);
    const row = loadKnownMembersStore(pack.membersFile).members["132"];
    assert.strictEqual(row.reminderState, REMINDER_STATE.SATISFIED);
    assert.strictEqual(row.walletGraceNoticeState, NOTICE_STATE.NOT_REQUIRED);
    assert.strictEqual(row.walletRequirementSatisfiedAt, 20);
  });

  await runTest("N1. new_chat_members join → grace + one wallet-requirement notice", async () => {
    const pack = files();
    const handlers = {};
    const bot = {
      on(type, fn) {
        const prev = handlers[type];
        handlers[type] = prev
          ? (ctx, next) => prev(ctx, () => fn(ctx, next))
          : fn;
      },
    };
    registerKnownMemberListeners(bot);
    require("../events/welcome")(bot);
    const replies = [];
    await handlers.new_chat_members({
      chat: { id: CHAT },
      message: {
        message_id: 9,
        new_chat_members: [
          { id: 201, is_bot: false, first_name: "Ada", username: "ada" },
        ],
      },
      reply: welcomeReply(replies),
    });
    const row = loadKnownMembersStore(pack.membersFile).members["201"];
    assert.ok(row);
    assert.ok(row.walletGraceDeadline);
    assert.strictEqual(row.walletGraceNoticeState, NOTICE_STATE.SENT);
    assert.strictEqual(replies.length, 1);
    assert.ok(replies[0].text.includes("automatic removal"));
    assert.ok(replies[0].text.includes("📌 Please read the pinned message"));
  });

  await runTest("N2. chat_member-only join → grace + one concise notice", async () => {
    const pack = files();
    const sent = [];
    await handleChatMemberUpdate(joinUpdate(202, { name: "Bea" }), {
      membersFile: pack.membersFile,
      walletFile: pack.walletFile,
      now: 5_000,
      sendMessage: async (_chatId, text) => {
        sent.push(text);
        return { message_id: 1 };
      },
    });
    const row = loadKnownMembersStore(pack.membersFile).members["202"];
    assert.ok(row.walletGraceDeadline);
    assert.strictEqual(row.walletGraceNoticeState, NOTICE_STATE.SENT);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0], CONCISE_WALLET_GRACE_NOTICE);
    assert.ok(!sent[0].includes("📌 Please read the pinned message"));
  });

  await runTest("N3. both join updates → only one wallet-requirement notice", async () => {
    const pack = files();
    join(pack, 203, 10, { name: "Cara", username: "cara" });
    const welcomeMsgs = [];
    const concise = [];
    await sendWalletAwareWelcome({
      userId: 203,
      name: "Cara",
      membersFile: pack.membersFile,
      now: 11,
      reply: welcomeReply(welcomeMsgs),
    });
    await maybeSendWalletGraceNotice({
      userId: 203,
      chatId: CHAT,
      membersFile: pack.membersFile,
      now: 12,
      sendMessage: async (_c, text) => {
        concise.push(text);
      },
    });
    assert.strictEqual(welcomeMsgs.length, 1);
    assert.ok(welcomeMsgs[0].text.includes("automatic removal"));
    assert.strictEqual(concise.length, 0);
    assert.strictEqual(getWalletGraceNoticeState(203, pack.membersFile), NOTICE_STATE.SENT);

    const packB = files();
    join(packB, 204, 10, { name: "Drew", username: "drew" });
    const welcomeB = [];
    const conciseB = [];
    await maybeSendWalletGraceNotice({
      userId: 204,
      chatId: CHAT,
      membersFile: packB.membersFile,
      now: 11,
      sendMessage: async (_c, text) => {
        conciseB.push(text);
      },
    });
    await sendWalletAwareWelcome({
      userId: 204,
      name: "Drew",
      membersFile: packB.membersFile,
      now: 12,
      reply: welcomeReply(welcomeB),
    });
    assert.strictEqual(conciseB.length, 1);
    assert.strictEqual(conciseB[0], CONCISE_WALLET_GRACE_NOTICE);
    assert.strictEqual(welcomeB.length, 1);
    assert.ok(welcomeB[0].text.includes("📌 Please read the pinned message"));
    assert.ok(!welcomeB[0].text.includes("automatic removal"));
    assert.strictEqual(getWalletGraceNoticeState(204, packB.membersFile), NOTICE_STATE.SENT);
  });

  await runTest("N4. duplicate updates → no duplicate wallet-requirement notice", async () => {
    const pack = files();
    join(pack, 205, 100);
    const sent = [];
    const send = async (_c, text) => {
      sent.push(text);
    };
    await maybeSendWalletGraceNotice({
      userId: 205,
      chatId: CHAT,
      membersFile: pack.membersFile,
      sendMessage: send,
      now: 1,
    });
    await maybeSendWalletGraceNotice({
      userId: 205,
      chatId: CHAT,
      membersFile: pack.membersFile,
      sendMessage: send,
      now: 2,
    });
    const transition = recordChatMemberTransition(
      {
        chatId: CHAT,
        userId: 205,
        oldStatus: "left",
        newStatus: "member",
        displayName: "Dup",
      },
      { membersFile: pack.membersFile, walletFile: pack.walletFile, now: 3 }
    );
    assert.strictEqual(transition.graceStarted, false);
    await maybeSendWalletGraceNotice({
      userId: 205,
      chatId: CHAT,
      membersFile: pack.membersFile,
      sendMessage: send,
      now: 4,
    });
    assert.strictEqual(sent.length, 1);
    const welcomeMsgs = [];
    await sendWalletAwareWelcome({
      userId: 205,
      name: "Dup",
      membersFile: pack.membersFile,
      now: 5,
      reply: welcomeReply(welcomeMsgs),
    });
    await sendWalletAwareWelcome({
      userId: 205,
      name: "Dup",
      membersFile: pack.membersFile,
      now: 6,
      reply: welcomeReply(welcomeMsgs),
    });
    assert.strictEqual(welcomeMsgs.length, 2);
    assert.ok(!welcomeMsgs[0].text.includes("automatic removal"));
    assert.ok(!welcomeMsgs[1].text.includes("automatic removal"));
  });

  await runTest("N5. notice send failure → grace persists, auto-enforcement blocked", async () => {
    const pack = files();
    join(pack, 206, 0);
    const failed = await maybeSendWalletGraceNotice({
      userId: 206,
      chatId: CHAT,
      membersFile: pack.membersFile,
      now: 1,
      sendMessage: async () => {
        throw new Error("telegram down");
      },
    });
    assert.strictEqual(failed.ok, false);
    const row = loadKnownMembersStore(pack.membersFile).members["206"];
    assert.ok(row.walletGraceDeadline);
    assert.strictEqual(row.walletGraceNoticeState, NOTICE_STATE.PENDING);
    const api = tickApi(pack, { 206: memberResult("206") }, {
      now: GRACE_MS,
      sendMessage: async () => {
        throw new Error("still down");
      },
    });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 0);
    assert.strictEqual(api.bans.length, 0);
    assert.strictEqual(
      loadKnownMembersStore(pack.membersFile).members["206"].walletGraceNoticeState,
      NOTICE_STATE.PENDING
    );
  });

  await runTest("N6. later successful notice → enforcement becomes eligible", async () => {
    const pack = files();
    join(pack, 207, 0);
    await maybeSendWalletGraceNotice({
      userId: 207,
      chatId: CHAT,
      membersFile: pack.membersFile,
      now: 1,
      sendMessage: async () => {
        throw new Error("first fail");
      },
    });
    const blocked = await processWalletGraceTick(
      tickApi(pack, { 207: memberResult("207") }, {
        now: GRACE_MS,
        sendMessage: async () => {
          throw new Error("still fail");
        },
      })
    );
    assert.strictEqual(blocked.enforced.length, 0);
    const delivered = await maybeSendWalletGraceNotice({
      userId: 207,
      chatId: CHAT,
      membersFile: pack.membersFile,
      now: GRACE_MS + 10,
      sendMessage: async () => ({ message_id: 3 }),
    });
    assert.strictEqual(delivered.sent, true);
    assert.strictEqual(getWalletGraceNoticeState(207, pack.membersFile), NOTICE_STATE.SENT);
    const api = tickApi(pack, { 207: memberResult("207") }, { now: GRACE_MS + 20 });
    const result = await processWalletGraceTick(api);
    assert.strictEqual(result.enforced.length, 1);
    assert.strictEqual(api.bans.length, 1);
  });

  await runTest("N7. rejoin → fresh deadline + one-time notice", async () => {
    const pack = files();
    join(pack, 208, 0);
    noticeSent(pack, 208, 0);
    const api = tickApi(pack, { 208: memberResult("208") }, { now: GRACE_MS });
    await processWalletGraceTick(api);
    recordObservedLeave(
      { chatId: CHAT, userId: 208 },
      { membersFile: pack.membersFile, now: GRACE_MS + 5 }
    );
    const rejoinNow = GRACE_MS + 20;
    const again = join(pack, 208, rejoinNow);
    assert.strictEqual(again.graceStarted, true);
    const after = loadKnownMembersStore(pack.membersFile).members["208"];
    assert.strictEqual(after.walletGraceDeadline, rejoinNow + GRACE_MS);
    assert.strictEqual(after.walletGraceNoticeState, NOTICE_STATE.PENDING);
    const sent = [];
    await maybeSendWalletGraceNotice({
      userId: 208,
      chatId: CHAT,
      membersFile: pack.membersFile,
      now: rejoinNow + 1,
      sendMessage: async (_c, text) => {
        sent.push(text);
      },
    });
    await maybeSendWalletGraceNotice({
      userId: 208,
      chatId: CHAT,
      membersFile: pack.membersFile,
      now: rejoinNow + 2,
      sendMessage: async (_c, text) => {
        sent.push(text);
      },
    });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(
      loadKnownMembersStore(pack.membersFile).members["208"].walletGraceNoticeState,
      NOTICE_STATE.SENT
    );
  });

  await runTest("N8. linked wallet on join → satisfied, no enforcement notice", async () => {
    const pack = files();
    registerManualWallet(209, generateSolanaWallet().address, pack.walletFile, 1);
    const result = join(pack, 209, 2);
    assert.strictEqual(result.graceStarted, true);
    const row = loadKnownMembersStore(pack.membersFile).members["209"];
    assert.strictEqual(row.reminderState, REMINDER_STATE.SATISFIED);
    assert.strictEqual(row.walletGraceNoticeState, NOTICE_STATE.NOT_REQUIRED);
    const sent = [];
    await maybeSendWalletGraceNotice({
      userId: 209,
      chatId: CHAT,
      membersFile: pack.membersFile,
      now: 3,
      sendMessage: async (_c, text) => {
        sent.push(text);
      },
    });
    const welcomeMsgs = [];
    await sendWalletAwareWelcome({
      userId: 209,
      name: "Linked",
      membersFile: pack.membersFile,
      now: 4,
      reply: welcomeReply(welcomeMsgs),
    });
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(welcomeMsgs.length, 1);
    assert.ok(!welcomeMsgs[0].text.includes("automatic removal"));
  });

  await runTest("N9. protected user → no removal-warning notice", async () => {
    const pack = files();
    addProtectedUser("210", { membersFile: pack.membersFile, now: 1, note: "vip" });
    join(pack, 210, 2);
    assert.strictEqual(
      getWalletGraceNoticeState(210, pack.membersFile),
      NOTICE_STATE.NOT_REQUIRED
    );
    const admin = join(pack, 9001, 3);
    assert.strictEqual(admin.graceStarted, true);
    assert.strictEqual(
      getWalletGraceNoticeState(9001, pack.membersFile),
      NOTICE_STATE.NOT_REQUIRED
    );
    const staff = recordObservedJoin(
      {
        chatId: CHAT,
        userId: 211,
        displayName: "Mod",
        newStatus: "administrator",
      },
      { membersFile: pack.membersFile, walletFile: pack.walletFile, now: 4 }
    );
    assert.strictEqual(staff.graceStarted, true);
    assert.strictEqual(
      getWalletGraceNoticeState(211, pack.membersFile),
      NOTICE_STATE.NOT_REQUIRED
    );
    const sent = [];
    for (const userId of [210, 9001, 211]) {
      await maybeSendWalletGraceNotice({
        userId,
        chatId: CHAT,
        membersFile: pack.membersFile,
        now: 5,
        sendMessage: async (_c, text) => {
          sent.push(text);
        },
      });
    }
    const welcomeMsgs = [];
    await sendWalletAwareWelcome({
      userId: 210,
      name: "Vip",
      membersFile: pack.membersFile,
      now: 6,
      reply: welcomeReply(welcomeMsgs),
    });
    assert.strictEqual(sent.length, 0);
    assert.ok(!welcomeMsgs[0].text.includes("automatic removal"));
  });

  await runTest("N10. historical member → no notice or deadline", async () => {
    const pack = files();
    mutateKnownMembersStore((store) => {
      store.members["212"] = {
        telegramUserId: "212",
        username: "old",
        displayName: "Old",
        firstSeenAt: 10,
        lastSeenAt: 10,
        joinedAt: 10,
        leftAt: 0,
        sources: ["points"],
        walletGraceDeadline: null,
        reminderState: null,
        walletGraceNoticeState: null,
      };
    }, pack.membersFile);
    join(pack, 212, 99_000, { name: "Old", username: "old" });
    const sent = [];
    await maybeSendWalletGraceNotice({
      userId: 212,
      chatId: CHAT,
      membersFile: pack.membersFile,
      now: 99_001,
      sendMessage: async (_c, text) => {
        sent.push(text);
      },
    });
    const welcomeMsgs = [];
    await sendWalletAwareWelcome({
      userId: 212,
      name: "Old",
      membersFile: pack.membersFile,
      now: 99_002,
      reply: welcomeReply(welcomeMsgs),
    });
    const row = loadKnownMembersStore(pack.membersFile).members["212"];
    assert.strictEqual(row.walletGraceDeadline, null);
    assert.strictEqual(row.walletGraceNoticeState, null);
    assert.strictEqual(sent.length, 0);
    assert.ok(!welcomeMsgs[0].text.includes("automatic removal"));
  });

  await runTest("N11. restart preserves notice/enforcement gating", async () => {
    const pack = files();
    join(pack, 213, 0);
    noticeSent(pack, 213, 0);
    setKnownMembersFileForTests(pack.membersFile);
    const sentReloaded = loadKnownMembersStore(pack.membersFile).members["213"];
    assert.strictEqual(sentReloaded.walletGraceNoticeState, NOTICE_STATE.SENT);
    const kickApi = tickApi(pack, { 213: memberResult("213") }, { now: GRACE_MS });
    const kicked = await processWalletGraceTick(kickApi);
    assert.strictEqual(kicked.enforced.length, 1);

    const packPending = files();
    join(packPending, 214, 0);
    assert.strictEqual(
      getWalletGraceNoticeState(214, packPending.membersFile),
      NOTICE_STATE.PENDING
    );
    setKnownMembersFileForTests(packPending.membersFile);
    const pendingReloaded = loadKnownMembersStore(packPending.membersFile).members["214"];
    assert.strictEqual(pendingReloaded.walletGraceNoticeState, NOTICE_STATE.PENDING);
    const blockedApi = tickApi(
      packPending,
      { 214: memberResult("214") },
      {
        now: GRACE_MS,
        sendMessage: async () => {
          throw new Error("offline after restart");
        },
      }
    );
    const blocked = await processWalletGraceTick(blockedApi);
    assert.strictEqual(blocked.enforced.length, 0);
    assert.strictEqual(blockedApi.bans.length, 0);
    assert.strictEqual(
      loadKnownMembersStore(packPending.membersFile).members["214"].walletGraceNoticeState,
      NOTICE_STATE.PENDING
    );
  });

  await runTest("claim race: only one sender wins pending → sending", () => {
    const pack = files();
    join(pack, 215, 0);
    const first = tryClaimWalletGraceNotice(215, { membersFile: pack.membersFile, now: 10 });
    const second = tryClaimWalletGraceNotice(215, { membersFile: pack.membersFile, now: 11 });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(
      getWalletGraceNoticeState(215, pack.membersFile),
      NOTICE_STATE.SENDING
    );
  });

  setWalletFileForTests(null);
  setKnownMembersFileForTests(null);
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
  console.log("wallet-grace tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
