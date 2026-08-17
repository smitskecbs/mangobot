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
 * Never overwrites the file. Mutating stores must fail closed on corrupt JSON.
 */
function readJsonFile(filePath, defaultValue, label = filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return resolveDefault(defaultValue);
    }

    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      logError(`${label} is empty; using in-memory default (file not overwritten)`);
      return resolveDefault(defaultValue);
    }

    return JSON.parse(raw);
  } catch (err) {
    logError(`Error reading ${label}:`, err);
    return resolveDefault(defaultValue);
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

    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is best-effort; not supported on every platform.
    }
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
