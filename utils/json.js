/**
 * Safe JSON file read/write helpers.
 * Creates missing files, recovers from invalid JSON, and never crashes the process.
 */

const fs = require("fs");
const path = require("path");
const { error: logError } = require("./logger");

function resolveDefault(defaultValue) {
  return typeof defaultValue === "function" ? defaultValue() : defaultValue;
}

/**
 * Read a JSON file, returning defaultValue when the file is missing, empty, or invalid.
 * May rewrite the file when recovering — prefer read-only helpers for shared mutable state.
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
 * Atomically write JSON to filePath (same-directory temp + rename).
 * Throws on failure after best-effort temp cleanup.
 *
 * @param {string} filePath
 * @param {unknown} data
 */
function writeJsonFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempFile = path.join(dir, `${base}.tmp-${unique}`);
  const payload = JSON.stringify(data, null, 2);

  try {
    fs.writeFileSync(tempFile, payload, "utf8");

    try {
      const fd = fs.openSync(tempFile, "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // fsync is best-effort; rename still replaces the target atomically on the same volume.
    }

    fs.renameSync(tempFile, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Write data to a JSON file using atomic temp+rename.
 * Logs errors instead of throwing (legacy helper behavior).
 */
function writeJsonFile(filePath, data) {
  try {
    writeJsonFileAtomic(filePath, data);
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

module.exports = {
  readJsonFile,
  writeJsonFile,
  writeJsonFileAtomic,
  ensureJsonFile,
};
