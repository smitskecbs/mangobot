/**
 * Optional signed game-token identity for highscore submits.
 * Never throws on untrusted input; missing/invalid token → unverified.
 */

const { verifyGameToken } = require("./gameToken");

/**
 * @param {unknown} token
 * @param {string} expectedGame
 * @param {{ secret?: string, now?: number }} [options]
 * @returns {{ verified: true, uid: string } | { verified: false }}
 */
function verifyOptionalGameIdentity(token, expectedGame, options = {}) {
  if (typeof token !== "string" || token.length === 0) {
    return { verified: false };
  }

  let result;

  try {
    result = verifyGameToken(token, expectedGame, options);
  } catch {
    return { verified: false };
  }

  if (!result || result.ok !== true) {
    return { verified: false };
  }

  return {
    verified: true,
    uid: result.uid,
  };
}

/**
 * Attach public identity metadata to a successful API response.
 * Never includes uid (or any other token fields).
 *
 * @param {Record<string, unknown>} response
 * @param {{ verified?: boolean } | null | undefined} identity
 * @returns {Record<string, unknown>}
 */
function withIdentity(response, identity) {
  return {
    ...response,
    identity: {
      verified: Boolean(identity && identity.verified),
    },
  };
}

module.exports = {
  verifyOptionalGameIdentity,
  withIdentity,
};
