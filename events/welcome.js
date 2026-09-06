/**
 * Welcome new members when they join the group chat.
 * Also opens a First Welcome Builder window and stores message ids for targeting.
 */

const { error: logError } = require("../utils/logger");
const {
  registerWelcomeOpportunity,
  noteBotWelcomeMessage,
  safeDisplayName,
} = require("../services/communityBuilder");
const {
  NOTICE_STATE,
  getWalletGraceNoticeState,
  tryClaimWalletGraceNotice,
  releaseWalletGraceNoticeClaim,
  markWalletGraceNoticeSent,
} = require("../services/knownMembers");

const WALLET_REQUIREMENT_LINES = [
  "To stay in the community, connect your Solana wallet within 48 hours.",
  "Use /menu → Wallet to link your wallet.",
  "No wallet connected after 48 hours = automatic removal.",
  "You can always rejoin later and connect one.",
];

const WELCOME_TEXT = (name) => `🥭 Welcome ${name}!

Welcome to the ManGo community.

${WALLET_REQUIREMENT_LINES.join("\n")}

📌 Please read the pinned message
🌐 Use /links for official links
🚀 Use /launch for project status

Enjoy the build!`;

const WELCOME_TEXT_NO_WALLET_WARNING = (name) => `🥭 Welcome ${name}!

Welcome to the ManGo community.

📌 Please read the pinned message
🌐 Use /links for official links
🚀 Use /launch for project status

Enjoy the build!`;

async function sendWalletAwareWelcome(input = {}) {
  const userId = input.userId;
  const name = input.name || "friend";
  const reply = input.reply;
  if (typeof reply !== "function") {
    return undefined;
  }
  const membersFile = input.membersFile;
  const now = input.now;
  let includeWarning = false;
  try {
    const state = getWalletGraceNoticeState(userId, membersFile);
    if (state === NOTICE_STATE.PENDING) {
      const claim = tryClaimWalletGraceNotice(userId, { membersFile, now });
      includeWarning = Boolean(claim && claim.ok);
    }
  } catch (err) {
    logError(
      "[welcome] wallet grace notice claim failed:",
      err && err.message ? err.message : err
    );
  }
  const text = includeWarning
    ? WELCOME_TEXT(name)
    : WELCOME_TEXT_NO_WALLET_WARNING(name);
  try {
    const sent = await reply(text);
    if (includeWarning) {
      if (sent && sent.message_id) {
        markWalletGraceNoticeSent(userId, { membersFile, now });
      } else {
        releaseWalletGraceNoticeClaim(userId, { membersFile });
      }
    }
    return sent;
  } catch (err) {
    if (includeWarning) {
      try {
        releaseWalletGraceNoticeClaim(userId, { membersFile });
      } catch (_releaseErr) {
        /* leave sending until stale retry */
      }
    }
    throw err;
  }
}

module.exports = (bot) => {
  bot.on("new_chat_members", async (ctx, next) => {
    const continueChain =
      typeof next === "function" ? next : () => undefined;
    const members =
      ctx && ctx.message && Array.isArray(ctx.message.new_chat_members)
        ? ctx.message.new_chat_members
        : [];
    const chatId = ctx && ctx.chat ? ctx.chat.id : undefined;
    const joinMessageId = ctx && ctx.message ? ctx.message.message_id : undefined;

    for (const member of members) {
      if (!member || member.is_bot) {
        continue;
      }
      const name = member.first_name || "friend";
      try {
        registerWelcomeOpportunity({
          chatId,
          userId: member.id,
          isBot: Boolean(member.is_bot),
          username: member.username,
          displayName: safeDisplayName(member),
          joinMessageId,
        });
      } catch (_err) {
        /* fail closed; public welcome still sends */
      }
      try {
        const sent = await sendWalletAwareWelcome({
          userId: member.id,
          name,
          reply: (text) => ctx.reply(text),
        });
        if (sent && sent.message_id) {
          noteBotWelcomeMessage(member.id, sent.message_id, { chatId });
        }
      } catch (_err) {
        /* welcome send failed */
      }
    }
    return continueChain();
  });
};

module.exports.WELCOME_TEXT = WELCOME_TEXT;
module.exports.WELCOME_TEXT_NO_WALLET_WARNING = WELCOME_TEXT_NO_WALLET_WARNING;
module.exports.sendWalletAwareWelcome = sendWalletAwareWelcome;
