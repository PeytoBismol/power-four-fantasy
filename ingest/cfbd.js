'use strict';

// Client for the CollegeFootballData REST API (https://api.collegefootballdata.com).
// Get a free key at https://collegefootballdata.com/key and put it in .env as CFBD_API_KEY.
// Requests are spaced out, and 429 or 5xx responses are retried with backoff.

const BASE_URL = 'https://api.collegefootballdata.com';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createCfbdClient({ apiKey = process.env.CFBD_API_KEY, minGapMs = 250, log = console.log } = {}) {
  if (!apiKey) throw new Error('CFBD_API_KEY is not set. Copy .env.example to .env and add your key.');
  let lastCall = 0;
  let requests = 0;

  async function get(route, params) {
    const url = new URL(route, BASE_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    for (let attempt = 1; attempt <= 5; attempt++) {
      const wait = lastCall + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      requests++;
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(30000)
        });
      } catch (err) {
        if (attempt === 5) throw new Error(`CFBD request failed: ${err.message}`);
        await sleep(attempt * 2000);
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 401 || res.status === 403) {
        throw new Error(`CFBD rejected the API key (HTTP ${res.status}). Check CFBD_API_KEY in .env.`);
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const delay = Math.max(retryAfter * 1000, attempt * 4000);
        log(`  CFBD answered ${res.status} for ${route}. Retrying in ${Math.round(delay / 1000)}s.`);
        await sleep(delay);
        continue;
      }
      throw new Error(`CFBD answered ${res.status} for ${route}`);
    }
    throw new Error(`CFBD did not answer ${route} after 5 attempts`);
  }

  return {
    requests: () => requests,
    teamsFbs: (year) => get('/teams/fbs', { year }),
    roster: (team, year) => get('/roster', { team, year }),
    games: (year, seasonType, week) => get('/games', { year, seasonType, week }),
    gamePlayers: (year, seasonType, week) => get('/games/players', { year, seasonType, week })
  };
}

module.exports = { createCfbdClient };
