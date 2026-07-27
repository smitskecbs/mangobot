/**
 * Safe JSON file read/write helpers.
 * Creates missing files, recovers from invalid JSON, and never crashes the process.
 */

const fs = require("fs");
const { error: logError } = require("./logger");

function resolveDefault(defaultValue) {
  return typeof defaultValue === "function" ? defaultValue() : defaultValue;
}

/**
 * Read a JSON file, returning defaultValue when the file is missing, empty, or invalid.
 */
function readJsonFile(filePath, defaultValue, label = filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return resolveDefault(defaultValue);
    }

    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      logError(`${label} is empty, resetting...`);
      const fresh = resolveDefault(defaultValue);
      writeJsonFile(filePath, fresh);
      return fresh;
    }

    return JSON.parse(raw);
  } catch (err) {
    logError(`Error reading ${label}:`, err);
    const fresh = resolveDefault(defaultValue);
    try {
      writeJsonFile(filePath, fresh);
    } catch (saveErr) {
      logError(`Error resetting ${label}:`, saveErr);
    }
    return fresh;
  }
}

/**
 * Write data to a JSON file. Logs errors instead of throwing.
 */
function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    logError(`Error writing ${filePath}:`, err);
  }
}

/**
 * Create a JSON file with default content when it does not exist.
 */
function ensureJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    writeJsonFile(filePath, resolveDefault(defaultValue));
  }
}

module.exports = { readJsonFile, writeJsonFile, ensureJsonFile };
