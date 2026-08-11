/**
 * Lightweight pulse of recent group community activity (in-memory).
 * Used by the community scheduler to skip reminders during active chat.
 */

let lastCommunityActivityAtMs = 0;

function noteCommunityActivity(atMs = Date.now()) {
  const ts = typeof atMs === "number" && Number.isFinite(atMs) ? atMs : Date.now();
  lastCommunityActivityAtMs = ts;
}

function getLastCommunityActivityAtMs() {
  return lastCommunityActivityAtMs;
}

function resetCommunityActivityPulse() {
  lastCommunityActivityAtMs = 0;
}

function wasActiveWithin(ms, nowMs = Date.now()) {
  if (!lastCommunityActivityAtMs || !ms || ms <= 0) {
    return false;
  }
  return nowMs - lastCommunityActivityAtMs < ms;
}

module.exports = {
  noteCommunityActivity,
  getLastCommunityActivityAtMs,
  resetCommunityActivityPulse,
  wasActiveWithin,
};
