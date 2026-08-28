/**
 * Private admin Control Center — keyboard visibility, callbacks, reuse of
 * existing Phase 2 / cleanup / retry flows. Temp files only.
 * Run: node tests/admin-menu.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  MENU_LABELS,
  PRIVATE_MENU_HINT,
  getPrivateMenuKeyboard,
  getGroupMenuExtra,
} = require("../utils/botMenu");
const { handleMenu } = require("../commands/menu");
const { handleHelp, HELP_MESSAGE } = require("../commands/help");
const {
  handleAdminOpen,
  handleAdminMenu,
  handleAdminCallback,
} = require("../commands/admin");
const { handlePhase2Menu } = require("../commands/phase2");
const {
  handleClearPendingGifts,
  handleRetryMysteryAnnounce,
  CPG_GO,
  CPG_X,
} = require("../commands/clearpendinggifts");
const { formatClearConfirmText } = require("../services/mysteryGiftCleanup");
const {
  ADMIN_CALLBACK,
  REJECT_TEXT,
  HOME_TEXT,
  PHASE2_TEXT,
  COMMANDS_TEXT,
  collectAdminCallbackData,
  parseAdminCallback,
} = require("../services/adminControlCenter");
const { PHASE2_CALLBACK } = require("../services/phase2ControlCenter");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-admin-menu-"));
const ADMIN_ID = "9001";
const MEMBER_ID = "8001";
const originalAdmin = process.env.ADMIN_USER_ID;
process.env.ADMIN_USER_ID = ADMIN_ID;

const prodRoots = [
  path.join(__dirname, "..", "points.json"),
  path.join(__dirname, "..", "data", "wallet-links.json"),
  path.join(__dirname, "..", "data", "community-builders.json"),
  path.join(__dirname, "..", "data", "member-rewards.json"),
  path.join(__dirname, "..", "data", "mango-shop.json"),
];
const prodMtimes = {};
for (const file of prodRoots) {
  if (fs.existsSync(file)) {
    prodMtimes[file] = fs.statSync(file).mtimeMs;
  }
}

let n = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function mockCtx({
  chatType = "private",
  userId = Number(ADMIN_ID),
  callbackData,
  chatId,
} = {}) {
  const replies = [];
  const edits = [];
  const answered = [];
  return {
    chat: {
      type: chatType,
      id: chatId !== undefined ? chatId : chatType === "private" ? userId : -1003916996602,
    },
    from: { id: userId, first_name: "Admin" },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    replies,
    edits,
    answered,
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve();
    },
    editMessageText(text, extra) {
      edits.push({ text, extra });
      return Promise.resolve();
    },
    answerCbQuery(text) {
      answered.push(text === undefined ? true : text);
      return Promise.resolve();
    },
  };
}

function files() {
  n += 1;
  return {
    pointsFile: path.join(tempDir, `p-${n}.json`),
    walletFile: path.join(tempDir, `w-${n}.json`),
    rewardsFile: path.join(tempDir, `r-${n}.json`),
    storeFile: path.join(tempDir, `b-${n}.json`),
    shopFile: path.join(tempDir, `s-${n}.json`),
    now: Date.UTC(2026, 7, 28, 12, 0, 0),
  };
}

function viewText(ctx) {
  const last = ctx.edits[ctx.edits.length - 1] || ctx.replies[ctx.replies.length - 1];
  return last && last.text ? last.text : "";
}

function viewExtra(ctx) {
  const last = ctx.edits[ctx.edits.length - 1] || ctx.replies[ctx.replies.length - 1];
  return last && last.extra;
}

function findButton(ctx, label) {
  const extra = viewExtra(ctx);
  const rows =
    extra && extra.reply_markup && extra.reply_markup.inline_keyboard
      ? extra.reply_markup.inline_keyboard
      : [];
  for (const row of rows) {
    for (const button of row) {
      if (button && button.text === label) {
        return button;
      }
    }
  }
  return null;
}

function assertNoSecrets(ctx) {
  const blob = `${viewText(ctx)}\n${JSON.stringify(viewExtra(ctx) || {})}`;
  assert.ok(!blob.includes(ADMIN_ID));
  assert.ok(!blob.includes(MEMBER_ID));
  for (const data of collectAdminCallbackData(viewExtra(ctx))) {
    assert.ok(!data.includes(ADMIN_ID), data);
    assert.ok(!data.includes(MEMBER_ID), data);
    assert.ok(data.startsWith("adm:") || data.startsWith("p2:") || data.startsWith("cpg:"), data);
  }
}

function assertProdUntouched() {
  for (const file of prodRoots) {
    if (!fs.existsSync(file)) {
      continue;
    }
    assert.strictEqual(fs.statSync(file).mtimeMs, prodMtimes[file]);
  }
}

async function main() {
  await runTest("admin sees Admin button", () => {
    const kb = getPrivateMenuKeyboard({ from: { id: Number(ADMIN_ID) } });
    const rows = kb.reply_markup.keyboard;
    assert.ok(rows.some((row) => row.includes(MENU_LABELS.ADMIN)));
    assert.ok(rows.every((row) => !row.includes(MENU_LABELS.PHASE2)));
    const ctx = mockCtx();
    handleMenu(ctx);
    assert.strictEqual(ctx.replies[0].text, PRIVATE_MENU_HINT);
    assert.ok(
      ctx.replies[0].extra.reply_markup.keyboard.some((row) =>
        row.includes(MENU_LABELS.ADMIN)
      )
    );
  });

  await runTest("normal member does not see Admin button", () => {
    const kb = getPrivateMenuKeyboard({ from: { id: Number(MEMBER_ID) } });
    const rows = kb.reply_markup.keyboard;
    assert.ok(rows.every((row) => !row.includes(MENU_LABELS.ADMIN)));
    assert.ok(rows.every((row) => !row.includes(MENU_LABELS.PHASE2)));
    const ctx = mockCtx({ userId: Number(MEMBER_ID) });
    handleMenu(ctx);
    const menuRows = ctx.replies[0].extra.reply_markup.keyboard;
    assert.ok(menuRows.every((row) => !row.includes(MENU_LABELS.ADMIN)));
    const group = getGroupMenuExtra(mockCtx({ chatType: "group" }));
    const labels = group.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(!labels.includes(MENU_LABELS.ADMIN));
  });

  await runTest("admin keyboard opens Control Center", async () => {
    const ctx = mockCtx();
    await handleAdminMenu(ctx, files());
    assert.strictEqual(viewText(ctx), HOME_TEXT);
    assert.ok(findButton(ctx, "🎁 Phase 2 / Mystery Gifts"));
    assert.ok(findButton(ctx, "👥 Community"));
    assert.ok(findButton(ctx, "💳 Wallets"));
    assert.ok(findButton(ctx, "🏆 Rewards"));
    assert.ok(findButton(ctx, "📊 Status"));
    assert.ok(findButton(ctx, "⌨️ Commands"));
    assert.ok(findButton(ctx, "⬅️ Back"));
    assertNoSecrets(ctx);
  });

  await runTest("member typing Admin is ignored", async () => {
    const ctx = mockCtx({ userId: Number(MEMBER_ID) });
    await handleAdminMenu(ctx, files());
    assert.strictEqual(ctx.replies.length, 0);
    assert.strictEqual(ctx.edits.length, 0);
  });

  await runTest("admin can open Phase 2 from hub", async () => {
    const opts = files();
    const ctx = mockCtx({ callbackData: ADMIN_CALLBACK.PHASE2_OPEN });
    await handleAdminCallback(ctx, opts);
    assert.ok(viewText(ctx).includes("🚀 Phase 2 Control Center"));
    assert.ok(findButton(ctx, "➕ Create Reward"));
    assert.ok(findButton(ctx, "🏆 XP Leaders"));
  });

  await runTest("normal member callback is rejected", async () => {
    const opts = files();
    for (const data of [
      ADMIN_CALLBACK.HOME,
      ADMIN_CALLBACK.PHASE2,
      ADMIN_CALLBACK.PHASE2_OPEN,
      ADMIN_CALLBACK.PHASE2_CLEAR,
      ADMIN_CALLBACK.PHASE2_RETRY,
      ADMIN_CALLBACK.WALLET_LIST,
      "adm:hack",
    ]) {
      const ctx = mockCtx({
        userId: Number(MEMBER_ID),
        callbackData: data,
      });
      await handleAdminCallback(ctx, opts);
      assert.ok(ctx.answered.includes(REJECT_TEXT), data);
      assert.strictEqual(ctx.edits.length, 0);
      assert.ok(
        ctx.replies.every(
          (row) =>
            !String(row.text).includes("ManGo Admin") &&
            !String(row.text).includes("Control Center")
        )
      );
    }
  });

  await runTest("group callback is rejected", async () => {
    const ctx = mockCtx({
      chatType: "supergroup",
      callbackData: ADMIN_CALLBACK.HOME,
    });
    await handleAdminCallback(ctx, files());
    assert.ok(ctx.edits.length === 0);
    assert.ok(ctx.replies.every((row) => !String(row.text).includes("ManGo Admin")));
  });

  await runTest("Clear Pending uses existing confirm flow", async () => {
    const opts = files();
    const viaCommand = mockCtx();
    handleClearPendingGifts(viaCommand, opts);
    const viaMenu = mockCtx({ callbackData: ADMIN_CALLBACK.PHASE2_CLEAR });
    await handleAdminCallback(viaMenu, opts);
    assert.strictEqual(viaMenu.replies[0].text, viaCommand.replies[0].text);
    assert.strictEqual(viaMenu.replies[0].text, formatClearConfirmText(0));
    const data = collectAdminCallbackData(viaMenu.replies[0].extra);
    assert.ok(data.includes(CPG_GO));
    assert.ok(data.includes(CPG_X));
    const src = fs.readFileSync(
      path.join(__dirname, "..", "commands", "admin.js"),
      "utf8"
    );
    assert.ok(src.includes("handleClearPendingGifts"));
    assert.ok(!src.includes("clearPendingMysteryGifts"));
  });

  await runTest("Retry Announcement uses existing handler", async () => {
    const opts = files();
    const viaCommand = mockCtx();
    await handleRetryMysteryAnnounce(viaCommand, opts);
    const viaMenu = mockCtx({ callbackData: ADMIN_CALLBACK.PHASE2_RETRY });
    await handleAdminCallback(viaMenu, opts);
    assert.strictEqual(viaMenu.replies[0].text, viaCommand.replies[0].text);
    assert.strictEqual(
      viaMenu.replies[0].text,
      "No Mystery Gift notifications need a retry."
    );
    const src = fs.readFileSync(
      path.join(__dirname, "..", "commands", "admin.js"),
      "utf8"
    );
    assert.ok(src.includes("handleRetryMysteryAnnounce"));
  });

  await runTest("Phase 2 submenu and back navigation", async () => {
    const opts = files();
    const home = mockCtx({ callbackData: ADMIN_CALLBACK.PHASE2 });
    await handleAdminCallback(home, opts);
    assert.strictEqual(viewText(home), PHASE2_TEXT);
    assert.ok(findButton(home, "🚀 Open Phase 2"));
    assert.ok(findButton(home, "🗑 Clear Pending"));
    assert.strictEqual(
      findButton(home, "🗑 Clear Pending").callback_data,
      ADMIN_CALLBACK.PHASE2_CLEAR
    );
    assert.strictEqual(
      findButton(home, "📣 Retry Announcement").callback_data,
      ADMIN_CALLBACK.PHASE2_RETRY
    );
    const back = mockCtx({ callbackData: ADMIN_CALLBACK.HOME });
    await handleAdminCallback(back, opts);
    assert.strictEqual(viewText(back), HOME_TEXT);
    const leave = mockCtx({ callbackData: ADMIN_CALLBACK.BACK });
    await handleAdminCallback(leave, opts);
    assert.strictEqual(leave.replies[0].text, PRIVATE_MENU_HINT);
    assert.ok(
      leave.replies[0].extra.reply_markup.keyboard.some((row) =>
        row.includes(MENU_LABELS.ADMIN)
      )
    );
  });

  await runTest("Create Reward and Pending reuse Phase 2", async () => {
    const opts = files();
    const create = mockCtx({ callbackData: ADMIN_CALLBACK.PHASE2_CREATE });
    await handleAdminCallback(create, opts);
    assert.ok(viewText(create).includes("Create Mystery Gift"));
    const pending = mockCtx({ callbackData: ADMIN_CALLBACK.PHASE2_PENDING });
    await handleAdminCallback(pending, opts);
    assert.ok(viewText(pending).includes("Pending Mystery Gifts"));
    const src = fs.readFileSync(
      path.join(__dirname, "..", "commands", "admin.js"),
      "utf8"
    );
    assert.ok(src.includes("PHASE2_CALLBACK.CREATE"));
    assert.ok(src.includes("PHASE2_CALLBACK.REWARDS_PENDING"));
  });

  await runTest("Commands cheatsheet and remaining /menu", async () => {
    const opts = files();
    const ctx = mockCtx({ callbackData: ADMIN_CALLBACK.COMMANDS });
    await handleAdminCallback(ctx, opts);
    assert.strictEqual(viewText(ctx), COMMANDS_TEXT);
    assert.ok(COMMANDS_TEXT.includes("/clearpendinggifts"));
    assert.ok(COMMANDS_TEXT.includes("/retrymysteryannounce"));
    const menu = mockCtx({ userId: Number(MEMBER_ID) });
    handleMenu(menu);
    assert.strictEqual(menu.replies[0].text, PRIVATE_MENU_HINT);
    handleHelp(menu);
    assert.strictEqual(menu.replies[1].text, HELP_MESSAGE);
    assert.ok(
      menu.replies[1].extra.reply_markup.keyboard.every(
        (row) => !row.includes(MENU_LABELS.ADMIN)
      )
    );
  });

  await runTest("existing commands still work as fallback", async () => {
    const opts = files();
    const clear = mockCtx();
    handleClearPendingGifts(clear, opts);
    assert.ok(clear.replies[0].text.includes("Clear all pending Mystery Gifts"));
    const retry = mockCtx();
    await handleRetryMysteryAnnounce(retry, opts);
    assert.ok(retry.replies[0].text.includes("No Mystery Gift notifications"));
    const leftover = mockCtx();
    await handlePhase2Menu(leftover, opts);
    assert.ok(viewText(leftover).includes("🚀 Phase 2 Control Center"));
    assert.strictEqual(parseAdminCallback("adm:nope"), null);
    assert.strictEqual(parseAdminCallback(PHASE2_CALLBACK.HOME), null);
  });

  assertProdUntouched();
}

main()
  .then(() => {
    if (originalAdmin === undefined) {
      delete process.env.ADMIN_USER_ID;
    } else {
      process.env.ADMIN_USER_ID = originalAdmin;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_err) {
      /* ignore */
    }
  })
  .catch((err) => {
    if (originalAdmin === undefined) {
      delete process.env.ADMIN_USER_ID;
    } else {
      process.env.ADMIN_USER_ID = originalAdmin;
    }
    console.error(err);
    process.exit(1);
  });
