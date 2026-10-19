'use strict';

// Counts failed attempts per key (an email, an IP) inside a rolling window. Kept in memory: a restart clears it,
// which is acceptable for a single-instance app.
function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();

  function prune() {
    const t = now();
    for (const [key, entry] of hits) if (t >= entry.reset) hits.delete(key);
  }

  return {
    // Seconds until the key may try again, or 0 when it may
    blocked(key) {
      const entry = hits.get(key);
      if (!entry) return 0;
      if (now() >= entry.reset) {
        hits.delete(key);
        return 0;
      }
      return entry.count >= max ? Math.ceil((entry.reset - now()) / 1000) : 0;
    },
    fail(key) {
      const t = now();
      if (hits.size > 5000) prune();
      let entry = hits.get(key);
      if (!entry || t >= entry.reset) {
        entry = { count: 0, reset: t + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
    },
    clear(key) {
      hits.delete(key);
    },
    size() {
      return hits.size;
    }
  };
}

// The limits the app uses. Each running app gets its own set.
function createLimits(overrides = {}) {
  const minutes = (m) => m * 60 * 1000;
  return {
    loginEmail: createLimiter({ max: 8, windowMs: minutes(15), ...overrides.loginEmail }),
    loginIp: createLimiter({ max: 40, windowMs: minutes(15), ...overrides.loginIp }),
    resetEmail: createLimiter({ max: 5, windowMs: minutes(60), ...overrides.resetEmail }),
    resetIp: createLimiter({ max: 30, windowMs: minutes(60), ...overrides.resetIp })
  };
}

module.exports = { createLimiter, createLimits };
