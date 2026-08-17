/**
 * Bounded fetch. No request may hang forever.
 * Callers must not retry payment confirmation mutations.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const TELEGRAM_TIMEOUT_MS = 8_000;

function abortError(timeoutMs) {
  const err = new Error("request-timeout");
  err.name = "AbortError";
  err.code = "ETIMEDOUT";
  err.timeoutMs = timeoutMs;
  return err;
}

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const fetchFn = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const { timeoutMs: _ignored, fetchImpl: _fetchImpl, signal: outerSignal, ...init } =
    options;

  if (outerSignal && outerSignal.aborted) {
    throw abortError(timeoutMs);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (outerSignal) {
    outerSignal.addEventListener("abort", onAbort, { once: true });
  }

  let timeoutId;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(abortError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([
      fetchFn(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } catch (err) {
    if (err && (err.name === "AbortError" || err.code === "ETIMEDOUT")) {
      throw abortError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    clearTimeout(timeoutId);
    if (outerSignal) {
      outerSignal.removeEventListener("abort", onAbort);
    }
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  TELEGRAM_TIMEOUT_MS,
  fetchWithTimeout,
};
