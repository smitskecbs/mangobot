/**
 * Highscore/wallet/presale API health payload. No secrets, ids, or file contents.
 */

const fs = require("fs");
const { getPresaleConfig } = require("./presaleConfig");
const { resolveWalletFile, readWalletSnapshot } = require("./walletLinks");
const { classifyRuntimeHealth, getRuntimeHealthSnapshot } = require("../utils/runtimeHealth");

function probeWalletStoreAccessible(walletFile) {
  try {
    const file = resolveWalletFile(walletFile);
    if (!fs.existsSync(file)) {
      return true;
    }
    readWalletSnapshot(file, { strict: true });
    return true;
  } catch {
    return false;
  }
}

function buildApiHealthPayload(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const snapshot = getRuntimeHealthSnapshot(now, {
    schedulerWanted: false,
  });
  const walletStoreAccessible =
    options.walletStoreAccessible !== undefined
      ? Boolean(options.walletStoreAccessible)
      : probeWalletStoreAccessible(options.walletFile);
  const presale = getPresaleConfig(options.env);
  let status = snapshot.shuttingDown ? "unhealthy" : classifyRuntimeHealth(now, {
    schedulerWanted: false,
  });
  if (status === "healthy" && !walletStoreAccessible) {
    status = "degraded";
  }

  return {
    ok: status !== "unhealthy",
    status,
    uptimeSeconds: snapshot.uptimeSeconds,
    walletStoreAccessible,
    presaleEnabled: Boolean(presale.enabled),
  };
}

module.exports = {
  probeWalletStoreAccessible,
  buildApiHealthPayload,
};
