/**
 * Community scheduler — slot crossing, dedupe, disabled/missing env.
 * Run: node tests/community-scheduler.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  createCommunityScheduler,
  parseEnabledFlag,
  getZonedClock,
  didCrossSlot,
  pickMessage,
  MESSAGE_POOLS,
  DEFAULT_SLOTS,
} = require("../services/communityScheduler");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-community-sched-"));
let testCounter = 0;

function stateFile() {
  testCounter += 1;
  return path.join(tempDir, `state-${testCounter}.json`);
}

function utcDate(iso) {
  return new Date(iso);
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
  await runTest("parseEnabledFlag defaults false-ish", () => {
    assert.strictEqual(parseEnabledFlag(undefined), false);
    assert.strictEqual(parseEnabledFlag(""), false);
    assert.strictEqual(parseEnabledFlag("false"), false);
    assert.strictEqual(parseEnabledFlag("true"), true);
    assert.strictEqual(parseEnabledFlag("1"), true);
  });

  await runTest("disabled scheduler verstuurt niets", async () => {
    const sent = [];
    const sched = createCommunityScheduler({
      enabled: false,
      chatId: "123",
      stateFile: stateFile(),
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return true;
      },
      now: () => utcDate("2026-08-10T07:00:00.000Z"),
    });
    sched.setLastChecked(utcDate("2026-08-10T06:59:00.000Z"));
    const result = await sched.tick();
    assert.strictEqual(result.skipped, "disabled");
    assert.strictEqual(sent.length, 0);
  });

  await runTest("ontbrekende TELEGRAM_CHAT_ID → geen crash", async () => {
    const sent = [];
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "",
      stateFile: stateFile(),
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return true;
      },
      now: () => utcDate("2026-08-10T07:00:00.000Z"),
    });
    sched.start();
    const result = await sched.tick();
    assert.strictEqual(result.skipped, "missing-chat-id");
    assert.strictEqual(sent.length, 0);
    sched.stop();
  });

  await runTest("morning slot stuurt morning message", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "999",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return true;
      },
    });

    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["morning"]);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].chatId, "999");
    assert.ok(MESSAGE_POOLS.morning.includes(sent[0].text));
    assert.ok(!sent[0].text.includes("?t="));
    assert.ok(!sent[0].text.includes("uid="));
    assert.ok(!sent[0].text.includes("GAME_LINK_SECRET"));
  });

  await runTest("afternoon slot stuurt game message", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T11:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T12:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["afternoon"]);
    assert.ok(MESSAGE_POOLS.afternoon.includes(sent[0]));
  });

  await runTest("evening slot stuurt ranking message", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T17:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T18:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["evening"]);
    assert.ok(MESSAGE_POOLS.evening.includes(sent[0]));
  });

  await runTest("zelfde slot/dag geen duplicate", async () => {
    const sent = [];
    const file = stateFile();
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(sent.length, 1);

    sched.setLastChecked(utcDate("2026-08-10T06:59:00.000Z"));
    now = utcDate("2026-08-10T07:05:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.strictEqual(sent.length, 1);
  });

  await runTest("andere dag mag opnieuw", async () => {
    const sent = [];
    const file = stateFile();
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(sent.length, 1);

    sched.setLastChecked(utcDate("2026-08-11T06:59:00.000Z"));
    now = utcDate("2026-08-11T07:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, ["morning"]);
    assert.strictEqual(sent.length, 2);
  });

  await runTest("restart met persisted slot stuurt niet opnieuw", async () => {
    const file = stateFile();
    const sent1 = [];
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const first = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent1.push(text);
        return true;
      },
    });
    await first.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await first.tick();
    assert.strictEqual(sent1.length, 1);
    first.stop();

    const sent2 = [];
    now = utcDate("2026-08-10T07:30:00.000Z");
    const second = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async (_c, text) => {
        sent2.push(text);
        return true;
      },
    });
    await second.tick();
    assert.strictEqual(sent2.length, 0);
    second.setLastChecked(utcDate("2026-08-10T06:59:00.000Z"));
    now = utcDate("2026-08-10T07:31:00.000Z");
    const result = await second.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.strictEqual(sent2.length, 0);
  });

  await runTest("gemist oud slot wordt niet ingehaald", async () => {
    const sent = [];
    let now = utcDate("2026-08-10T10:00:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async (_c, text) => {
        sent.push(text);
        return true;
      },
    });
    const seed = await sched.tick();
    assert.strictEqual(seed.skipped, "startup-seed");
    assert.strictEqual(sent.length, 0);
    now = utcDate("2026-08-10T10:01:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.strictEqual(sent.length, 0);
  });

  await runTest("statefile blijft valide JSON", async () => {
    const file = stateFile();
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: file,
      now: () => now,
      sendMessage: async () => true,
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(parsed.sent["2026-08-10"].includes("morning"));
  });

  await runTest("send failure crasht bot niet", async () => {
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async () => {
        throw new Error("network down");
      },
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    const result = await sched.tick();
    assert.deepStrictEqual(result.fired, []);
    assert.ok(!sched.getState().sent["2026-08-10"]);
  });

  await runTest("geen points.json writes", async () => {
    const pointsProbe = path.join(tempDir, "points.json");
    fs.writeFileSync(pointsProbe, '{"users":{}}\n', "utf8");
    const before = fs.readFileSync(pointsProbe, "utf8");
    let now = utcDate("2026-08-10T06:59:00.000Z");
    const sched = createCommunityScheduler({
      enabled: true,
      chatId: "1",
      timeZone: "Europe/Amsterdam",
      stateFile: stateFile(),
      now: () => now,
      sendMessage: async () => true,
    });
    await sched.tick();
    now = utcDate("2026-08-10T07:00:00.000Z");
    await sched.tick();
    assert.strictEqual(fs.readFileSync(pointsProbe, "utf8"), before);
  });

  await runTest("didCrossSlot helpers", () => {
    const tz = "Europe/Amsterdam";
    const prev = getZonedClock(utcDate("2026-08-10T06:59:00.000Z"), tz);
    const now = getZonedClock(utcDate("2026-08-10T07:00:00.000Z"), tz);
    assert.strictEqual(didCrossSlot(prev, now, DEFAULT_SLOTS[0]), true);
    assert.strictEqual(didCrossSlot(prev, now, DEFAULT_SLOTS[1]), false);
    // Different local days must not catch up (22:00 UTC Aug9 = 00:00 Aug10 Amsterdam).
    assert.strictEqual(
      didCrossSlot(
        getZonedClock(utcDate("2026-08-09T21:59:00.000Z"), tz),
        getZonedClock(utcDate("2026-08-10T07:00:00.000Z"), tz),
        DEFAULT_SLOTS[0]
      ),
      false
    );
  });

  await runTest("pickMessage rotates by day/slot without secrets", () => {
    const a = pickMessage("morning", "2026-08-10");
    const b = pickMessage("morning", "2026-08-11");
    assert.ok(typeof a === "string" && a.length > 0);
    assert.ok(MESSAGE_POOLS.morning.includes(a));
    assert.ok(MESSAGE_POOLS.morning.includes(b));
    assert.ok(!a.includes("uid="));
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("\nAll community-scheduler tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
