/**
 * Load .env with clear precedence for ManGo app config.
 *
 * Policy: /home/adje/mangobot/.env is source of truth for app tunables.
 * systemd may set BOT_TOKEN / WorkingDirectory, but must not silently pin
 * stale AUTO_* / COMMUNITY_* values over .env.
 *
 * Flow:
 * 1. dotenv.config() fills missing keys (default, no override)
 * 2. Force-apply APP_CONFIG_KEYS from the .env file (override)
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

/** Keys that must follow the project .env file when present. */
const APP_CONFIG_KEYS = Object.freeze([
  "AUTO_CHATFIGHT_ENABLED",
  "AUTO_CHATFIGHT_INTERVAL_MINUTES",
  "AUTO_CHATFIGHT_MIN_GAP_MINUTES",
  "AUTO_CHATFIGHT_MIN_ACTIVITY_GAP_MINUTES",
  "AUTO_CHATFIGHT_CHANCE_PERCENT",
  "AUTO_CHATFIGHT_TYPES",
  "COMMUNITY_AUTO_MESSAGES_ENABLED",
  "COMMUNITY_ACTIVITY_ENGINE_ENABLED",
  "COMMUNITY_ACTIVITY_24_7",
  "COMMUNITY_ACTIVITY_INTERVAL_MINUTES",
  "COMMUNITY_ACTIVE_START_HOUR",
  "COMMUNITY_ACTIVE_END_HOUR",
  "COMMUNITY_TIMEZONE",
  "COMMUNITY_SKIP_IF_RECENT_ACTIVITY_MINUTES",
  "COMMUNITY_QUESTION_MIN_GAP_MINUTES",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_GAMES_TOPIC_ID",
  "ADMIN_USER_ID",
]);

/**
 * @param {object} [options]
 * @param {string} [options.envPath]
 * @param {NodeJS.ProcessEnv} [options.processEnv]
 * @returns {{ parsed: object, injected: number, overridden: string[], envPath: string }}
 */
function loadAppEnv(options = {}) {
  const processEnv = options.processEnv || process.env;
  const envPath =
    options.envPath || path.join(options.cwd || process.cwd(), ".env");

  const initial = dotenv.config({ path: envPath, processEnv });

  const overridden = [];
  let parsed = {};
  if (fs.existsSync(envPath)) {
    try {
      parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
    } catch (_err) {
      parsed = {};
    }
    for (const key of APP_CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        const next = parsed[key];
        if (processEnv[key] !== next) {
          overridden.push(key);
        }
        processEnv[key] = next;
      }
    }
  }

  return {
    parsed,
    injected:
      initial && initial.parsed ? Object.keys(initial.parsed).length : 0,
    overridden,
    envPath,
    error: initial && initial.error ? initial.error : null,
  };
}

module.exports = {
  APP_CONFIG_KEYS,
  loadAppEnv,
};
