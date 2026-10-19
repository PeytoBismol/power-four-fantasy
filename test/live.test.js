'use strict';

// Score freshness: which games are live, the live-week refresh, the refresh schedule, and the "scores updated" fields.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, getMeta, setMeta } = require('../src/db');
const season = require('../src/season');
const { ingestAll, refreshLiveWeek } = require('../ingest/ingest');
const { createDemoSource } = require('../ingest/source-demo');
const { settingsFrom, createScoreScheduler } = require('../src/maintenance');
const { createApp } = require('../src/server');
const { SEASON } = require('../src/config');

process.env.ADMIN_TOKEN = 'test-admin-token-0123456789';

const quiet = () => {};
const T = Date.parse('2026-10-17T19:00:00.000Z');
const TEST_GAME_IDS = 9500000; // every game these tests add has an id above this
let db;
let nextId = TEST_GAME_IDS;

before(async () => {
  db = openDb(':memory:');
  await ingestAll({ db, source: createDemoSource({ year: SEASON }), log: quiet });
  season.setCurrentWeek(db, SEASON, 7);
});

after(() => db.close());

// Removes what the tests added, so each test starts from the demo data
function cleanup() {
  db.prepare('DELETE FROM games WHERE id > ?').run(TEST_GAME_IDS);
  setMeta(db, 'last_ingest_error', '');
  setMeta(db, 'data_source', 'cfbd');
}

function firstTwoTeams() {
  return db.prepare('SELECT id FROM teams ORDER BY id LIMIT 2').all().map((r) => r.id);
}

function addGame(database, { start, completed = 0, week = 7 }) {
  const [home, away] = firstTwoTeams();
  database.prepare(`
    INSERT INTO games (id, season, week, season_type, start_date, completed, home_id, away_id, home_points, away_points)
    VALUES (?, ?, ?, 'regular', ?, ?, ?, ?, NULL, NULL)
  `).run(++nextId, SEASON, week, start, completed, home, away);
  return nextId;
}

const iso = (ms) => new Date(ms).toISOString();
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('live window: kicked off in the last six hours and not final, or kicking off within the hour', () => {
  addGame(db, { start: iso(T - 60 * 60e3) });                    // started an hour ago: window and in progress
  addGame(db, { start: iso(T + 30 * 60e3) });                    // kicks off in 30 minutes: window only
  addGame(db, { start: iso(T - 7 * 60 * 60e3) });                // started seven hours ago: neither
  addGame(db, { start: iso(T - 2 * 60 * 60e3), completed: 1 }); // final: neither
  addGame(db, { start: iso(T + 3 * 60 * 60e3) });                // kicks off in three hours: neither
  const live = season.liveGames(db, SEASON, 7, T);
  assert.equal(live.window, 2);
  assert.equal(live.inProgress, 1);
  cleanup();
});

test('live window: demo games with no kickoff time never count as live', () => {
  const live = season.liveGames(db, SEASON, 7, T);
  assert.equal(live.window, 0);
  assert.equal(live.inProgress, 0);
});

test('live refresh pulls the week in play and leaves other weeks alone', async () => {
  const before3 = db.prepare('SELECT COUNT(*) AS n FROM player_games WHERE season = ? AND week = 3').get(SEASON).n;
  const [home, away] = firstTwoTeams();
  const kickoff = iso(Date.now() - 60 * 60e3);
  const source = {
    kind: 'test',
    requests: () => 2,
    async games(_year, seasonType, week) {
      assert.equal(seasonType, 'regular');
      assert.equal(week, 7);
      return [{ id: nextId + 1000, start_date: kickoff, completed: false, home_id: home, away_id: away, home_points: 14, away_points: 7 }];
    },
    async gamePlayers() {
      return [];
    }
  };
  const result = await refreshLiveWeek({ db, source, autoAdvance: false, log: quiet });
  assert.equal(result.week, 7);
  assert.equal(result.games, 1);
  assert.equal(result.inProgress, 1);
  const row = db.prepare('SELECT home_points, completed FROM games WHERE id = ?').get(nextId + 1000);
  assert.equal(row.home_points, 14);
  assert.equal(row.completed, 0);
  assert.ok(getMeta(db, 'last_ingest_at'), 'the pull time is recorded');
  assert.equal(getMeta(db, 'data_source'), 'test');
  const after3 = db.prepare('SELECT COUNT(*) AS n FROM player_games WHERE season = ? AND week = 3').get(SEASON).n;
  assert.equal(after3, before3, 'weeks other than the one in play are untouched');
  cleanup();
});

test('settings: live refresh defaults to 10 minutes with a key, is off without one, and rejects values under 5', () => {
  const saved = { key: process.env.CFBD_API_KEY, live: process.env.LIVE_SCORE_MINUTES, hours: process.env.INGEST_HOURS };
  try {
    delete process.env.LIVE_SCORE_MINUTES;
    delete process.env.INGEST_HOURS;
    process.env.CFBD_API_KEY = 'test-key';
    assert.equal(settingsFrom(':memory:').liveMinutes, 10);
    assert.equal(settingsFrom(':memory:').ingestHours, 12);
    delete process.env.CFBD_API_KEY;
    assert.equal(settingsFrom(':memory:').liveMinutes, 0);
    process.env.CFBD_API_KEY = 'test-key';
    process.env.LIVE_SCORE_MINUTES = '0';
    assert.equal(settingsFrom(':memory:').liveMinutes, 0);
    process.env.LIVE_SCORE_MINUTES = '3';
    assert.throws(() => settingsFrom(':memory:'), /at least 5 minutes/);
    process.env.LIVE_SCORE_MINUTES = 'soon';
    assert.throws(() => settingsFrom(':memory:'), /must be a number of minutes/);
  } finally {
    for (const [name, value] of [['CFBD_API_KEY', saved.key], ['LIVE_SCORE_MINUTES', saved.live], ['INGEST_HOURS', saved.hours]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('scheduler: refreshes only the live week during a game window, at the set interval, and never on demo data', async () => {
  const calls = [];
  let clock = T;
  const run = async (kind) => { calls.push(kind); };
  const s = { ingestHours: 0, liveMinutes: 10, backupHours: 0, keep: 14, backupDir: '' };
  const scheduler = createScoreScheduler({ db, s, log: quiet, now: () => clock, run });
  // No game in a window yet: nothing is pulled
  assert.equal(scheduler.tick(), null);
  addGame(db, { start: iso(T - 30 * 60e3) });
  assert.equal(scheduler.tick(), 'live');
  await nextTick();
  // Within the interval, nothing more
  clock += 5 * 60e3;
  assert.equal(scheduler.tick(), null);
  clock += 6 * 60e3;
  assert.equal(scheduler.tick(), 'live');
  await nextTick();
  // Once the games are final, the window closes and nothing is pulled
  db.prepare('UPDATE games SET completed = 1 WHERE id > ?').run(TEST_GAME_IDS);
  clock += 60 * 60e3;
  assert.equal(scheduler.tick(), null);
  // Demo data is never refreshed from CFBD
  setMeta(db, 'data_source', 'demo');
  addGame(db, { start: iso(clock - 60e3) });
  assert.equal(scheduler.tick(), null);
  assert.deepEqual(calls, ['live', 'live']);
  cleanup();
});

test('scheduler: a full refresh runs when its hours are up, without waiting for a game', async () => {
  const calls = [];
  let clock = T;
  const run = async (kind) => { calls.push(kind); };
  const s = { ingestHours: 12, liveMinutes: 0, backupHours: 0, keep: 14, backupDir: '' };
  const scheduler = createScoreScheduler({ db, s, log: quiet, now: () => clock, run });
  assert.equal(scheduler.tick(), null);
  clock += 12 * 60 * 60e3;
  assert.equal(scheduler.tick(), 'full');
  await nextTick();
  assert.deepEqual(calls, ['full']);
  cleanup();
});

test('scheduler: a failed refresh is recorded for the status check', async () => {
  const run = async () => { throw new Error('CFBD is down for the test'); };
  addGame(db, { start: iso(T - 30 * 60e3) });
  const s = { ingestHours: 0, liveMinutes: 10, backupHours: 0, keep: 14, backupDir: '' };
  const scheduler = createScoreScheduler({ db, s, log: quiet, now: () => T, run });
  assert.equal(scheduler.tick(), 'live');
  await nextTick();
  assert.match(getMeta(db, 'last_ingest_error'), /CFBD is down for the test/);
  cleanup();
});

test('matchups report when scores were pulled and how many games are under way', async () => {
  const app = createApp({ dbFile: ':memory:' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await ingestAll({ db: app.db, source: createDemoSource({ year: SEASON }), log: quiet });
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stamp Tester', email: 'stamp@test.dev', password: 'password123' })
    }).then((r) => r.json());
    const headers = { Authorization: `Bearer ${signup.token}`, 'Content-Type': 'application/json' };
    const league = await fetch(`${base}/api/leagues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Stamp League', team_count: 4 })
    }).then((r) => r.json());
    const first = await fetch(`${base}/api/leagues/${league.league.id}/matchups`, { headers }).then((r) => r.json());
    assert.ok(first.as_of, 'as_of is the last pull time');
    assert.equal(first.live_games, 0);
    const [home, away] = app.db.prepare('SELECT id FROM teams ORDER BY id LIMIT 2').all().map((r) => r.id);
    app.db.prepare(`
      INSERT INTO games (id, season, week, season_type, start_date, completed, home_id, away_id)
      VALUES (9700001, ?, ?, 'regular', ?, 0, ?, ?)
    `).run(SEASON, first.week, iso(Date.now() - 45 * 60e3), home, away);
    const during = await fetch(`${base}/api/leagues/${league.league.id}/matchups`, { headers }).then((r) => r.json());
    assert.equal(during.live_games, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
