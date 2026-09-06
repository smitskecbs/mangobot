/**
 * Known-member registry: join recording, protection, source union.
 * Run: node tests/known-members.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  setKnownMembersFileForTests,
  recordObservedJoin,
  recordObservedLeave,
  recordChatMemberTransition,
  addProtectedUser,
  removeProtectedUser,
  isExplicitlyProtected,
  collectKnownTelegramIds,
  loadKnownMembersStore,
  mutateKnownMembersStore,
  WALLET_GRACE_MS,
  SOURCE,
} = require("../services/knownMembers");
const { mutatePoints } = require("../services/points");
const { registerManualWallet, setWalletFileForTests } = require("../services/walletLinks");
const { mutateBuilderStore, setCommunityBuilderFileForTests } = require("../services/communityBuilderStore");
const { registerKnownMemberListeners } = require("../events/known-members");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-known-members-test-"));
let n = 0;
const originalAdmin = process.env.ADMIN_USER_ID;
const originalChat = process.env.TELEGRAM_CHAT_ID;
process.env.ADMIN_USER_ID = "9001";
process.env.TELEGRAM_CHAT_ID = "-100111";

function files() {
  n += 1;
  const membersFile = path.join(tempDir, `m-${n}.json`);
  const pointsFile = path.join(tempDir, `p-${n}.json`);
  const walletFile = path.join(tempDir, `w-${n}.json`);
  const builderFile = path.join(tempDir, `b-${n}.json`);
  setKnownMembersFileForTests(membersFile);
  setWalletFileForTests(walletFile);
  setCommunityBuilderFileForTests(builderFile);
  return { membersFile, pointsFile, walletFile, builderFile };
}

async function runTest(name, fn) {
  await fn();
  console.log(`✓ ${name}`);
}

async function main() {
  await runTest("new join is recorded into the known-member registry", () => {
    const { membersFile } = files();
    const result = recordObservedJoin(
      {
        chatId: "-100111",
        userId: 55,
        username: "spammy",
        displayName: "Spam",
        source: SOURCE.NEW_CHAT_MEMBERS,
      },
      { membersFile, now: 1_700_000_000_000 }
    );
    assert.strictEqual(result.ok, true);
    const store = loadKnownMembersStore(membersFile);
    const row = store.members["55"];
    assert.ok(row);
    assert.strictEqual(row.telegramUserId, "55");
    assert.strictEqual(row.username, "spammy");
    assert.strictEqual(row.displayName, "Spam");
    assert.strictEqual(row.joinedAt, 1_700_000_000_000);
    assert.strictEqual(row.leftAt, 0);
    assert.ok(row.sources.includes(SOURCE.NEW_CHAT_MEMBERS));
    assert.strictEqual(row.walletGraceDeadline, 1_700_000_000_000 + WALLET_GRACE_MS);
    assert.strictEqual(row.reminderState, "pending");
    assert.strictEqual(row.walletGraceNoticeState, "pending");
    assert.strictEqual(result.graceStarted, true);
  });

  await runTest("historical in-group member does not receive a retroactive grace deadline", () => {
    const { membersFile } = files();
    mutateKnownMembersStore((store) => {
      store.members["66"] = {
        telegramUserId: "66",
        username: "oldie",
        displayName: "Oldie",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        joinedAt: 1000,
        leftAt: 0,
        sources: [SOURCE.POINTS],
        walletGraceDeadline: null,
        reminderState: null,
      };
    }, membersFile);
    const result = recordObservedJoin(
      {
        chatId: "-100111",
        userId: 66,
        username: "oldie",
        displayName: "Oldie",
      },
      { membersFile, now: 5_000 }
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.graceStarted, false);
    const row = loadKnownMembersStore(membersFile).members["66"];
    assert.strictEqual(row.walletGraceDeadline, null);
    assert.strictEqual(row.reminderState, null);
    assert.strictEqual(row.walletGraceNoticeState, null);
    assert.strictEqual(row.joinedAt, 1000);
  });

  await runTest("rejoin after leave starts a fresh 48h grace period", () => {
    const { membersFile } = files();
    recordObservedJoin(
      { chatId: "-100111", userId: 70, displayName: "Back" },
      { membersFile, now: 10_000 }
    );
    recordObservedLeave(
      { chatId: "-100111", userId: 70, displayName: "Back" },
      { membersFile, now: 20_000 }
    );
    const again = recordObservedJoin(
      { chatId: "-100111", userId: 70, displayName: "Back" },
      { membersFile, now: 30_000 }
    );
    assert.strictEqual(again.graceStarted, true);
    const row = loadKnownMembersStore(membersFile).members["70"];
    assert.strictEqual(row.joinedAt, 30_000);
    assert.strictEqual(row.leftAt, 0);
    assert.strictEqual(row.walletGraceDeadline, 30_000 + WALLET_GRACE_MS);
    assert.strictEqual(row.reminderState, "pending");
    assert.strictEqual(row.walletGraceNoticeState, "pending");
  });

  await runTest("event listener records new_chat_members and left_chat_member", () => {
    const { membersFile } = files();
    const bot = {
      handlers: {},
      on(type, fn) {
        this.handlers[type] = fn;
      },
    };
    registerKnownMemberListeners(bot);
    let continued = false;
    bot.handlers.new_chat_members(
      {
        chat: { id: "-100111" },
        message: {
          new_chat_members: [
            { id: 77, is_bot: false, username: "joiner", first_name: "Join" },
            { id: 78, is_bot: true, first_name: "Bot" },
          ],
        },
      },
      () => {
        continued = true;
      }
    );
    assert.strictEqual(continued, true);
    const afterJoin = loadKnownMembersStore(membersFile);
    assert.ok(afterJoin.members["77"]);
    assert.strictEqual(afterJoin.members["78"], undefined);
    bot.handlers.left_chat_member(
      {
        chat: { id: "-100111" },
        message: {
          left_chat_member: { id: 77, username: "joiner", first_name: "Join" },
        },
      },
      () => undefined
    );
    const afterLeave = loadKnownMembersStore(membersFile);
    assert.ok(afterLeave.members["77"].leftAt > 0);
  });

  await runTest("chat_member join/leave transitions record; bots skipped", () => {
    const { membersFile } = files();
    const join = recordChatMemberTransition(
      {
        chatId: "-100111",
        userId: 88,
        isBot: false,
        oldStatus: "left",
        newStatus: "member",
        displayName: "New",
      },
      { membersFile, now: 50 }
    );
    assert.strictEqual(join.ok, true);
    const botJoin = recordChatMemberTransition(
      {
        chatId: "-100111",
        userId: 89,
        isBot: true,
        oldStatus: "left",
        newStatus: "member",
      },
      { membersFile, now: 51 }
    );
    assert.strictEqual(botJoin.ok, false);
    recordChatMemberTransition(
      {
        chatId: "-100111",
        userId: 88,
        isBot: false,
        oldStatus: "member",
        newStatus: "kicked",
      },
      { membersFile, now: 60 }
    );
    const store = loadKnownMembersStore(membersFile);
    assert.strictEqual(store.members["88"].joinedAt, 50);
    assert.strictEqual(store.members["88"].leftAt, 60);
    assert.strictEqual(store.members["89"], undefined);
  });

  await runTest("union includes points, wallets, builder, and registry without claiming membership", () => {
    const { membersFile, pointsFile, walletFile, builderFile } = files();
    mutatePoints((data) => {
      data.users["11"] = { name: "Points", points: 4 };
    }, pointsFile);
    registerManualWallet(22, "So11111111111111111111111111111111111111112", walletFile, 1);
    mutateBuilderStore((store) => {
      store.welcomeOpportunities["33"] = { displayName: "Welcome", joinedAt: 1 };
      store.referrals["44"] = { inviterUserId: "11", displayName: "Ref" };
    }, builderFile);
    recordObservedJoin(
      { chatId: "-100111", userId: 55, displayName: "Silent" },
      { membersFile, now: 9 }
    );
    const ids = collectKnownTelegramIds({
      membersFile,
      pointsFile,
      walletFile,
      builderFile,
    });
    assert.deepStrictEqual(ids, ["11", "22", "33", "44", "55"]);
  });

  await runTest("explicit protect list is persistent and removable", () => {
    const { membersFile } = files();
    addProtectedUser("123", { membersFile, now: 1, note: "manual" });
    assert.strictEqual(isExplicitlyProtected("123", membersFile), true);
    const removed = removeProtectedUser("123", { membersFile });
    assert.strictEqual(removed.existed, true);
    assert.strictEqual(isExplicitlyProtected("123", membersFile), false);
  });

  await runTest("existing points.json stays backward-compatible (not rewritten by join record)", () => {
    const { membersFile, pointsFile } = files();
    mutatePoints((data) => {
      data.users["11"] = { name: "Stay", points: 9, weeklyPoints: 1 };
    }, pointsFile);
    const before = fs.readFileSync(pointsFile, "utf8");
    recordObservedJoin(
      { chatId: "-100111", userId: 99, displayName: "New" },
      { membersFile, now: 1 }
    );
    assert.strictEqual(fs.readFileSync(pointsFile, "utf8"), before);
    const points = JSON.parse(before);
    assert.strictEqual(points.users["11"].points, 9);
  });

  setKnownMembersFileForTests(null);
  setWalletFileForTests(null);
  setCommunityBuilderFileForTests(null);
  if (originalAdmin === undefined) delete process.env.ADMIN_USER_ID;
  else process.env.ADMIN_USER_ID = originalAdmin;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
  console.log("known-members tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
