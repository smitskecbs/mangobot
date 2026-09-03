/**
 * Simple timestamp logger for ManGo Bot.
 */

function timestamp() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${timestamp()}]`, ...args);
}

function error(...args) {
  console.error(`[${timestamp()}]`, ...args);
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

function formatErrorForLog(err) {
  if (!err || typeof err !== "object") {
    const message = redactSecrets(err == null ? "" : String(err)).slice(0, 500);
    return { name: "Error", message, stack: "" };
  }
  const name =
    typeof err.name === "string" && err.name ? err.name.slice(0, 64) : "Error";
  const message = redactSecrets(
    typeof err.message === "string" ? err.message : ""
  ).slice(0, 500);
  const stack = redactSecrets(typeof err.stack === "string" ? err.stack : "").slice(
    0,
    4000
  );
  return { name, message, stack };
}

module.exports = { log, error, formatErrorForLog, redactSecrets };
