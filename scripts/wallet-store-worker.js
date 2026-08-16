/**
 * Isolated wallet-store worker for cross-process tests.
 * argv must NOT contain /tests/ so test-file isolation does not apply.
 *
 * Protocol: JSON line in, JSON line out.
 * Env: WALLET_LINKS_FILE = shared store path
 */

"use strict";

process.env.MANGO_FORCE_TEST_WALLET_LINKS = "";

const {
  createLinkToken,
  createChallenge,
  hashToken,
} = require("../services/walletVerification");
const {
  loadWalletStore,
  resolveWalletFile,
} = require("../services/walletLinks");

const file = process.env.WALLET_LINKS_FILE;
if (!file) {
  process.stderr.write("WALLET_LINKS_FILE is required\n");
  process.exit(1);
}

console.log = (...args) => {
  process.stderr.write(`${args.map(String).join(" ")}\n`);
};
console.error = (...args) => {
  process.stderr.write(`${args.map(String).join(" ")}\n`);
};

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

send({
  event: "ready",
  file: resolveWalletFile(),
  pid: process.pid,
});

function handle(msg) {
  if (msg.op === "warmup") {
    const store = loadWalletStore(file);
    return {
      ok: true,
      linkTokens: Object.keys(store.linkTokens || {}).length,
      challenges: Object.keys(store.challenges || {}).length,
      file: resolveWalletFile(file),
    };
  }
  if (msg.op === "createLink") {
    const created = createLinkToken(msg.uid, { walletFile: file });
    return {
      ok: true,
      token: created.token,
      tokenHash: created.tokenHash,
      expiresAt: created.expiresAt,
    };
  }
  if (msg.op === "challenge") {
    const result = createChallenge(
      { token: msg.token, wallet: msg.wallet },
      { walletFile: file }
    );
    return {
      ok: result.ok === true,
      error: result.error || null,
      challengeId: result.challengeId || null,
      status: result.status || null,
    };
  }
  if (msg.op === "load") {
    const store = loadWalletStore(file);
    return {
      ok: true,
      tokenHashes: Object.keys(store.linkTokens || {}),
      challengeIds: Object.keys(store.challenges || {}),
      users: Object.keys(store.users || {}),
    };
  }
  if (msg.op === "hash") {
    return { ok: true, hash: hashToken(msg.token) };
  }
  if (msg.op === "quit") {
    send({ ok: true, op: "quit" });
    process.exit(0);
  }
  return { ok: false, error: `unknown op ${msg.op}` };
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) {
      continue;
    }
    try {
      send(handle(JSON.parse(line)));
    } catch (err) {
      send({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  }
});
