/**
 * Focused tests for signed game-link tokens.
 * Uses injected secret/now — never touches production env secrets.
 */

const assert = require("assert");
const crypto = require("node:crypto");

const {
  createGameToken,
  verifyGameToken,
  ALLOWED_GAMES,
  DEFAULT_TTL_SECONDS,
} = require("../utils/gameToken");

const TEST_SECRET = "test-game-link-secret-do-not-use-in-prod";
const FIXED_NOW = 1_700_000_000;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signPayloadPart(payloadPart, secret = TEST_SECRET) {
  return crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest();
}

function craftToken(payload, secret = TEST_SECRET) {
  const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = base64UrlEncode(signPayloadPart(payloadPart, secret));
  return `${payloadPart}.${signature}`;
}

function splitToken(token) {
  const [payloadPart, signaturePart] = token.split(".");
  return { payloadPart, signaturePart };
}

function decodePayload(payloadPart) {
  const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

function retokenizeWithOldSignature(newPayload, oldSignaturePart) {
  const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(newPayload), "utf8"));
  return `${payloadPart}.${oldSignaturePart}`;
}

assert.deepStrictEqual([...ALLOWED_GAMES], ["snake", "bounch"]);
assert.strictEqual(DEFAULT_TTL_SECONDS, 86400);

runTest("valid snake token", () => {
  const token = createGameToken("123456", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, {
    ok: true,
    uid: "123456",
    game: "snake",
    exp: FIXED_NOW + DEFAULT_TTL_SECONDS,
  });
});

runTest("valid bounch token", () => {
  const token = createGameToken("999", "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const result = verifyGameToken(token, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, {
    ok: true,
    uid: "999",
    game: "bounch",
    exp: FIXED_NOW + DEFAULT_TTL_SECONDS,
  });
});

runTest("uid stays string when created from number", () => {
  const token = createGameToken(123456, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.uid, "123456");
  assert.strictEqual(typeof result.uid, "string");
});

runTest("default TTL is 86400", () => {
  const token = createGameToken("1", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const payload = decodePayload(splitToken(token).payloadPart);

  assert.strictEqual(DEFAULT_TTL_SECONDS, 86400);
  assert.strictEqual(payload.exp, FIXED_NOW + 86400);
});

runTest("custom ttlSeconds", () => {
  const token = createGameToken("1", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
    ttlSeconds: 3600,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.exp, FIXED_NOW + 3600);
});

runTest("exp === now is valid", () => {
  const token = craftToken({
    uid: "1",
    game: "snake",
    exp: FIXED_NOW,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, {
    ok: true,
    uid: "1",
    game: "snake",
    exp: FIXED_NOW,
  });
});

runTest("exp < now is expired", () => {
  const token = craftToken({
    uid: "1",
    game: "snake",
    exp: FIXED_NOW - 1,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "expired" });
});

runTest("wrong expected game", () => {
  const token = createGameToken("1", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const result = verifyGameToken(token, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "wrong-game" });
});

runTest("tampered uid with old signature", () => {
  const token = createGameToken("123456", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { payloadPart, signaturePart } = splitToken(token);
  const payload = decodePayload(payloadPart);
  payload.uid = "999999";
  const tampered = retokenizeWithOldSignature(payload, signaturePart);
  const result = verifyGameToken(tampered, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-signature" });
});

runTest("tampered game with old signature", () => {
  const token = createGameToken("123456", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { payloadPart, signaturePart } = splitToken(token);
  const payload = decodePayload(payloadPart);
  payload.game = "bounch";
  const tampered = retokenizeWithOldSignature(payload, signaturePart);
  const result = verifyGameToken(tampered, "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-signature" });
});

runTest("tampered exp with old signature", () => {
  const token = createGameToken("123456", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { payloadPart, signaturePart } = splitToken(token);
  const payload = decodePayload(payloadPart);
  payload.exp = payload.exp + 999999;
  const tampered = retokenizeWithOldSignature(payload, signaturePart);
  const result = verifyGameToken(tampered, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-signature" });
});

runTest("changed signature", () => {
  const token = createGameToken("123456", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { payloadPart, signaturePart } = splitToken(token);
  const flipped = Buffer.from(signPayloadPart(payloadPart));
  flipped[0] ^= 0xff;
  const badSig = base64UrlEncode(flipped);
  assert.notStrictEqual(badSig, signaturePart);

  const result = verifyGameToken(`${payloadPart}.${badSig}`, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-signature" });
});

runTest("malformed empty token", () => {
  assert.deepStrictEqual(
    verifyGameToken("", "snake", { secret: TEST_SECRET, now: FIXED_NOW }),
    { ok: false, reason: "missing-token" }
  );
  assert.deepStrictEqual(
    verifyGameToken(null, "snake", { secret: TEST_SECRET, now: FIXED_NOW }),
    { ok: false, reason: "missing-token" }
  );
  assert.deepStrictEqual(
    verifyGameToken(undefined, "snake", { secret: TEST_SECRET, now: FIXED_NOW }),
    { ok: false, reason: "missing-token" }
  );
});

runTest("malformed one-part token", () => {
  const result = verifyGameToken("onlyonepart", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "malformed-token" });
});

runTest("malformed three-part token", () => {
  const result = verifyGameToken("a.b.c", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "malformed-token" });
});

runTest("invalid base64 signature", () => {
  const token = createGameToken("1", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const { payloadPart } = splitToken(token);
  const result = verifyGameToken(`${payloadPart}.!!!not-base64!!!`, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-signature" });
});

runTest("invalid JSON payload with valid signature", () => {
  const payloadPart = base64UrlEncode(Buffer.from("{not-json", "utf8"));
  const signature = base64UrlEncode(signPayloadPart(payloadPart));
  const result = verifyGameToken(`${payloadPart}.${signature}`, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-payload" });
});

runTest("non-object JSON payload with valid signature", () => {
  const payloadPart = base64UrlEncode(Buffer.from('"just-a-string"', "utf8"));
  const signature = base64UrlEncode(signPayloadPart(payloadPart));
  const result = verifyGameToken(`${payloadPart}.${signature}`, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-payload" });
});

runTest("missing uid", () => {
  const token = craftToken({
    game: "snake",
    exp: FIXED_NOW + 100,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-user" });
});

runTest("empty uid", () => {
  const token = craftToken({
    uid: "",
    game: "snake",
    exp: FIXED_NOW + 100,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-user" });
});

runTest("unsupported game in payload", () => {
  const token = craftToken({
    uid: "1",
    game: "tetris",
    exp: FIXED_NOW + 100,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-game" });
});

runTest("unsupported expectedGame", () => {
  const token = createGameToken("1", "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });
  const result = verifyGameToken(token, "tetris", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-game" });
});

runTest("create rejects unsupported game", () => {
  assert.throws(
    () =>
      createGameToken("1", "tetris", {
        secret: TEST_SECRET,
        now: FIXED_NOW,
      }),
    /snake|bounch/
  );
});

runTest("missing exp", () => {
  const token = craftToken({
    uid: "1",
    game: "snake",
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-expiry" });
});

runTest("non-integer exp", () => {
  const token = craftToken({
    uid: "1",
    game: "snake",
    exp: 1.5,
  });
  const result = verifyGameToken(token, "snake", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
  });

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-expiry" });
});

runTest("create without secret fails clearly", () => {
  const previous = process.env.GAME_LINK_SECRET;
  delete process.env.GAME_LINK_SECRET;

  try {
    assert.throws(() => createGameToken("1", "snake", { now: FIXED_NOW }), /GAME_LINK_SECRET/);
    assert.throws(
      () => createGameToken("1", "snake", { secret: "", now: FIXED_NOW }),
      /GAME_LINK_SECRET/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.GAME_LINK_SECRET;
    } else {
      process.env.GAME_LINK_SECRET = previous;
    }
  }
});

runTest("verify without secret fails safely", () => {
  const previous = process.env.GAME_LINK_SECRET;
  delete process.env.GAME_LINK_SECRET;

  try {
    const token = createGameToken("1", "snake", {
      secret: TEST_SECRET,
      now: FIXED_NOW,
    });

    assert.deepStrictEqual(verifyGameToken(token, "snake", { now: FIXED_NOW }), {
      ok: false,
      reason: "missing-secret",
    });
    assert.deepStrictEqual(
      verifyGameToken(token, "snake", { secret: "", now: FIXED_NOW }),
      { ok: false, reason: "missing-secret" }
    );
  } finally {
    if (previous === undefined) {
      delete process.env.GAME_LINK_SECRET;
    } else {
      process.env.GAME_LINK_SECRET = previous;
    }
  }
});

runTest("invalid ttlSeconds rejected", () => {
  assert.throws(
    () =>
      createGameToken("1", "snake", {
        secret: TEST_SECRET,
        now: FIXED_NOW,
        ttlSeconds: 0,
      }),
    /ttlSeconds/
  );
  assert.throws(
    () =>
      createGameToken("1", "snake", {
        secret: TEST_SECRET,
        now: FIXED_NOW,
        ttlSeconds: -10,
      }),
    /ttlSeconds/
  );
  assert.throws(
    () =>
      createGameToken("1", "snake", {
        secret: TEST_SECRET,
        now: FIXED_NOW,
        ttlSeconds: 1.5,
      }),
    /ttlSeconds/
  );
});

runTest("same payload/secret/now produces deterministic token", () => {
  const a = createGameToken("42", "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
    ttlSeconds: 1000,
  });
  const b = createGameToken("42", "bounch", {
    secret: TEST_SECRET,
    now: FIXED_NOW,
    ttlSeconds: 1000,
  });

  assert.strictEqual(a, b);
});

console.log("\nAll game-token tests passed.");
