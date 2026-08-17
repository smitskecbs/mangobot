/**
 * Prune timestamp maps so rate-limit / cooldown keys cannot grow forever.
 */

function pruneTimestampMap(map, now, maxAgeMs, maxKeys) {
  if (!map || typeof map.forEach !== "function") {
    return 0;
  }
  const ts = Number.isFinite(now) ? now : Date.now();
  const age = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 0;
  let removed = 0;

  if (age > 0) {
    for (const [key, value] of map.entries()) {
      const stamp = Array.isArray(value)
        ? value.length
          ? Math.max(...value)
          : 0
        : Number(value);
      if (!Number.isFinite(stamp) || stamp <= ts - age) {
        map.delete(key);
        removed += 1;
      } else if (Array.isArray(value)) {
        const recent = value.filter((t) => t > ts - age);
        if (!recent.length) {
          map.delete(key);
          removed += 1;
        } else if (recent.length !== value.length) {
          map.set(key, recent);
        }
      }
    }
  }

  const cap = Number.isFinite(maxKeys) && maxKeys > 0 ? Math.floor(maxKeys) : 0;
  if (cap > 0 && map.size > cap) {
    const overflow = map.size - cap;
    const keys = map.keys();
    for (let i = 0; i < overflow; i += 1) {
      const next = keys.next();
      if (next.done) {
        break;
      }
      map.delete(next.value);
      removed += 1;
    }
  }

  return removed;
}

module.exports = {
  pruneTimestampMap,
};
