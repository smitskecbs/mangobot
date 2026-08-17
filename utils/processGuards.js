/**
 * Fatal process guards. Log safely, attempt graceful shutdown, then exit.
 * systemd restarts the process. Node never restarts itself.
 */

const { error: defaultLogError } = require("./logger");
const { noteRuntimeEvent } = require("./runtimeHealth");

function safeErrorMeta(err) {
  if (!err || typeof err !== "object") {
    return { name: "Error", code: "Error" };
  }
  const name = typeof err.name === "string" && err.name ? err.name : "Error";
  const code = typeof err.code === "string" && err.code ? err.code : name;
  return { name: name.slice(0, 64), code: String(code).slice(0, 64) };
}

function installProcessGuards(options = {}) {
  const name = typeof options.name === "string" && options.name ? options.name : "mango";
  const logError = typeof options.logError === "function" ? options.logError : defaultLogError;
  const exitFn = typeof options.exit === "function" ? options.exit : (code) => process.exit(code);
  const shutdown =
    typeof options.shutdown === "function" ? options.shutdown : () => undefined;

  let stopping = false;

  function crash(kind, err) {
    if (stopping) {
      return;
    }
    stopping = true;
    const meta = safeErrorMeta(err);
    noteRuntimeEvent("crash", { code: meta.code });
    logError(`[crash] ${name} ${kind} name=${meta.name} code=${meta.code}`);
    try {
      shutdown(kind);
    } catch (shutdownErr) {
      const shutdownMeta = safeErrorMeta(shutdownErr);
      logError(
        `[crash] ${name} shutdown failed name=${shutdownMeta.name} code=${shutdownMeta.code}`
      );
    }
    exitFn(1);
  }

  process.on("uncaughtException", (err) => crash("uncaughtException", err));
  process.on("unhandledRejection", (reason) => crash("unhandledRejection", reason));

  return {
    crash,
    isStopping: () => stopping,
  };
}

module.exports = {
  safeErrorMeta,
  installProcessGuards,
};
