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

module.exports = { log, error };
