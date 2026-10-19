'use strict';

// Fixes from the Sleeper review: in-app alerts, commissioner removal and joins, the Help message,
// the support address, and injury notes. Score freshness is in live.test.js.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const season = require('../src/season');
const L = require('../src/league');
const draft = require('../src/draft');
const { alertsFor } = require('../src/alerts');
const { ApiError } = require('../src/util');
const { createApp } = require('../src/server');
const { ingestAll } = require('../ingest/ingest');
const { createDemoSource } = require('../ingest/source-demo');
const { SEASON } = require('../src/config');

process.env.ADMIN_TOKEN = 'test-admin-token-0123456789';

const quiet = () => {};
const NOW = Date.parse('2026-10-17T19:00:00.000Z');
const CLI = path.join(__dirname, '..', 'src', 'cli.js');
let db;
let users = 0;

before(async () => {
  db = openDb(':memory:');
  await ingestAll({ db, source: createDemoSource({ year: SEASON }), log: quiet });
  season.setCurrentWeek(db, SEASON, 7);
});

after(() => db.close());

// Injury notes are global, and kickoffs are set per test, so both are put back after each test
afterEach(() => {
  db.prepare('DELETE FROM player_status').run();
  db.prepare('UPDATE games SET start_date = NULL WHERE season = ? AND week = 7').run(SEASON);
});

function makeUser(label) {
  users += 1;
  const info = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(`coach${users}@test.dev`, `${label} ${users}`, 'not-a-real-hash', new Date().toISOString());
  return { id: Number(info.lastInsertRowid), name: `${label} ${users}` };
}

function leagueWith(commissioner, { teams = 4, status = 'predraft' } = {}) {
  const made = L.createLeague(db, commissioner, { name: `League ${++users}`, team_count: teams });
  if (status !== 'predraft') db.prepare('UPDATE leagues SET status = ? WHERE id = ?').run(status, made.id);
  return L.getLeague(db, made.id);
}

const inviteCodeOf = (league) => db.prepare('SELECT invite_code FROM leagues WHERE id = ?').get(league.id).invite_code;
const teamsIn = (league) => db.prepare('SELECT * FROM fantasy_teams WHERE league_id = ? ORDER BY id').all(league.id);
const teamOfUser = (league, user) => db.prepare('SELECT * FROM fantasy_teams WHERE league_id = ? AND user_id = ?').get(league.id, user.id);
const teamRow = (id) => db.prepare('SELECT * FROM fantasy_teams WHERE id = ?').get(id);

function firstPlayer(position, offset = 0) {
  return db.prepare('SELECT id, name, team_id FROM players WHERE departed = 0 AND position = ? ORDER BY id LIMIT 1 OFFSET ?')
    .get(position, offset);
}

function startRoster(team, player, slot) {
  db.prepare('INSERT INTO roster (team_id, player_id, slot) VALUES (?, ?, ?)').run(team.id, player.id, slot);
}

function setInjury(player, status, note = null) {
  db.prepare(`
    INSERT INTO player_status (player_id, status, note, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at
  `).run(player.id, status, note, new Date(NOW).toISOString());
}

// Sets the kickoff of a school's week 7 game (the demo schedule has none yet)
function kickoffFor(schoolId, ms) {
  db.prepare('UPDATE games SET start_date = ? WHERE season = ? AND week = 7 AND (home_id = ? OR away_id = ?)')
    .run(new Date(ms).toISOString(), SEASON, schoolId, schoolId);
}

function addTrade(league, from, to) {
  const now = new Date(NOW).toISOString();
  db.prepare(`
    INSERT INTO trades (league_id, from_team_id, to_team_id, give, get_players, status, created_at, updated_at)
    VALUES (?, ?, ?, '[]', '[]', 'pending', ?, ?)
  `).run(league.id, from.id, to.id, now, now);
}

// ---- Fix 4: alerts ----------------------------------------------------------

test('alerts: a starter listed Out is flagged on the team tab, and a Questionable starter is not', () => {
  const coach = makeUser('Out Starter');
  const league = leagueWith(coach, { status: 'season' });
  const team = teamOfUser(league, coach);
  const qb = firstPlayer('QB');
  startRoster(team, qb, 'QB');
  setInjury(qb, 'Out', 'high ankle sprain');
  const alert = alertsFor(db, league, team, coach, NOW).find((a) => a.kind === 'injured');
  assert.ok(alert, 'an injured alert is shown');
  assert.equal(alert.level, 'warn');
  assert.equal(alert.tab, 'team');
  assert.ok(alert.message.includes(qb.name) && alert.message.includes('listed Out'));
  setInjury(qb, 'Questionable');
  assert.equal(alertsFor(db, league, team, coach, NOW).some((a) => a.kind === 'injured'), false);
});

test('alerts: a starter whose game kicks off within the hour is named once, and a later kickoff is not', () => {
  const coach = makeUser('Soon');
  const league = leagueWith(coach, { status: 'season' });
  const team = teamOfUser(league, coach);
  const qb = firstPlayer('QB', 1);
  startRoster(team, qb, 'QB');
  kickoffFor(qb.team_id, NOW + 30 * 60e3);
  const soon = alertsFor(db, league, team, coach, NOW).filter((a) => a.kind === 'lock_soon');
  assert.equal(soon.length, 1);
  assert.equal(soon[0].level, 'soon');
  assert.ok(soon[0].message.includes(qb.name));
  kickoffFor(qb.team_id, NOW + 3 * 60 * 60e3);
  assert.equal(alertsFor(db, league, team, coach, NOW).some((a) => a.kind === 'lock_soon'), false);
});

test('alerts: on the clock in a live draft, the coach is told to pick', () => {
  const coach = makeUser('Clock');
  const league = leagueWith(coach, { teams: 4 });
  const team = teamOfUser(league, coach);
  // Our team picks first, so the coach is on the clock at pick 1
  db.prepare('UPDATE fantasy_teams SET draft_slot = 1 WHERE id = ?').run(team.id);
  teamsIn(league).filter((t) => t.id !== team.id).forEach((t, i) => {
    db.prepare('UPDATE fantasy_teams SET draft_slot = ? WHERE id = ?').run(i + 2, t.id);
  });
  draft.startDraft(db, L.getLeague(db, league.id), coach);
  const live = L.getLeague(db, league.id);
  assert.equal(draft.draftState(db, live, coach.id).on_clock.is_me, true);
  const alert = alertsFor(db, live, team, coach, NOW).find((a) => a.kind === 'on_clock');
  assert.ok(alert, 'the on-the-clock alert is shown');
  assert.equal(alert.level, 'now');
  assert.equal(alert.tab, 'draft');
});

test('alerts: pending trade offers are counted, and the trade deadline week is flagged', () => {
  const coach = makeUser('Trades');
  const league = leagueWith(coach, { status: 'season' });
  const mine = teamOfUser(league, coach);
  const theirs = teamsIn(league).find((t) => t.id !== mine.id);
  addTrade(league, theirs, mine);
  addTrade(league, theirs, mine);
  const offers = alertsFor(db, league, mine, coach, NOW).find((a) => a.kind === 'trade_offer');
  assert.equal(offers.tab, 'trades');
  assert.equal(offers.message, '2 trade offers are waiting for your answer.');
  db.prepare('UPDATE leagues SET settings = ? WHERE id = ?')
    .run(JSON.stringify({ ...league.settings, trade_deadline_week: 7 }), league.id);
  const deadline = alertsFor(db, L.getLeague(db, league.id), mine, coach, NOW).find((a) => a.kind === 'deadline');
  assert.ok(deadline, 'the deadline alert is shown in the deadline week');
  assert.equal(deadline.level, 'warn');
  assert.equal(deadline.tab, 'trades');
});

// ---- Fix 5: commissioner tools ---------------------------------------------

test('removing a member hands the team to a CPU, cancels its open trades, and logs the removal', () => {
  const commish = makeUser('Boss');
  const member = makeUser('Member');
  const league = leagueWith(commish);
  L.joinLeague(db, member, inviteCodeOf(league));
  const mine = teamOfUser(league, commish);
  const theirs = teamOfUser(league, member);
  addTrade(league, mine, theirs);
  L.releaseMember(db, L.getLeague(db, league.id), commish, theirs);

  const after = teamRow(theirs.id);
  assert.equal(after.user_id, null);
  assert.equal(after.is_cpu, 1);
  assert.equal(after.vacated, 1);
  assert.equal(after.name, 'CPU 1');
  assert.equal(db.prepare('SELECT status FROM trades WHERE league_id = ?').get(league.id).status, 'cancelled');
  const log = db.prepare("SELECT detail FROM transactions WHERE league_id = ? AND kind = 'released'").get(league.id);
  assert.equal(JSON.parse(log.detail).member, member.name);
  assert.equal(JSON.parse(log.detail).by, commish.name);
});

test('only the commissioner removes a member, nobody removes their own team, and an empty seat has nobody to remove', () => {
  const host = makeUser('Host');
  const guest = makeUser('Guest');
  const league = leagueWith(host);
  L.joinLeague(db, guest, inviteCodeOf(league));
  const current = L.getLeague(db, league.id);
  assert.throws(() => L.releaseMember(db, current, host, teamOfUser(league, host)),
    (e) => e instanceof ApiError && e.status === 400 && /cannot remove yourself/.test(e.message));
  assert.throws(() => L.releaseMember(db, current, guest, teamOfUser(league, guest)),
    (e) => e instanceof ApiError && e.status === 403);
  const empty = teamsIn(league).find((t) => t.is_cpu === 1);
  assert.throws(() => L.releaseMember(db, current, host, empty),
    (e) => e instanceof ApiError && e.status === 400 && /no member/.test(e.message));
});

test('joining: any open seat before the draft, nobody while it is live, and after it only a seat the commissioner freed', () => {
  const host = makeUser('Seats');
  const league = leagueWith(host, { teams: 4 });
  const code = inviteCodeOf(league);
  const first = makeUser('Seat One');
  const second = makeUser('Seat Two');
  const third = makeUser('Seat Three');

  const early = L.joinLeague(db, first, code);
  assert.equal(early.joined, true);
  assert.equal(early.team.is_cpu, 0);

  db.prepare("UPDATE leagues SET status = 'drafting' WHERE id = ?").run(league.id);
  assert.throws(() => L.joinLeague(db, second, code), /The draft is live/);

  db.prepare("UPDATE leagues SET status = 'season' WHERE id = ?").run(league.id);
  assert.throws(() => L.joinLeague(db, second, code), /full and has started/);

  // The commissioner removes the first coach. Their roster stays with the seat for the next coach.
  const seat = teamOfUser(league, first);
  startRoster(seat, firstPlayer('RB'), 'BN');
  L.releaseMember(db, L.getLeague(db, league.id), host, seat);
  const taken = L.joinLeague(db, second, code);
  assert.equal(taken.joined, true);
  assert.equal(taken.team.id, seat.id);
  assert.equal(teamRow(seat.id).vacated, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roster WHERE team_id = ?').get(seat.id).n, 1);

  db.prepare("UPDATE leagues SET status = 'complete' WHERE id = ?").run(league.id);
  assert.throws(() => L.joinLeague(db, third, code), /finished its season/);
  assert.throws(() => L.releaseMember(db, L.getLeague(db, league.id), host, seat), /season is over/);
});

// ---- Fix 6: support and Help -----------------------------------------------

// A server with its own database, for the tests that go over HTTP
async function startApp() {
  const app = createApp({ dbFile: ':memory:' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await ingestAll({ db: app.db, source: createDemoSource({ year: SEASON }), log: quiet });
  const call = async (method, p, { token, body } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const signup = async (name, email) => {
    const r = await call('POST', '/api/auth/signup', { body: { name, email, password: 'password123' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { token: r.body.token, user: r.body.user };
  };
  return { app, call, signup, close: () => new Promise((resolve) => app.server.close(resolve)) };
}

test('support address: /api/meta shows it only when SUPPORT_EMAIL holds a valid address', async () => {
  const saved = process.env.SUPPORT_EMAIL;
  const h = await startApp();
  try {
    delete process.env.SUPPORT_EMAIL;
    assert.equal((await h.call('GET', '/api/meta')).body.support_email, null);
    process.env.SUPPORT_EMAIL = 'not an address';
    assert.equal((await h.call('GET', '/api/meta')).body.support_email, null);
    process.env.SUPPORT_EMAIL = 'support@example.com';
    assert.equal((await h.call('GET', '/api/meta')).body.support_email, 'support@example.com');
  } finally {
    if (saved === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = saved;
    await h.close();
  }
});

test('Help messages: signed in only, 10 to 1000 characters, five a day, and only for leagues you are in', async () => {
  const h = await startApp();
  try {
    const coach = await h.signup('Help Coach', 'help@test.dev');
    const other = await h.signup('Other Coach', 'other@test.dev');
    const league = await h.call('POST', '/api/leagues', { token: other.token, body: { name: 'Their League', team_count: 4 } });
    const send = (token, body) => h.call('POST', '/api/feedback', { token, body });

    assert.equal((await send(undefined, { body: 'A valid note from outside' })).status, 401);
    assert.equal((await send(coach.token, { body: 'too short' })).status, 400);
    assert.equal((await send(coach.token, { body: 'x'.repeat(1001) })).status, 400);
    assert.equal((await send(coach.token, { body: 'A valid note', league_id: league.body.league.id })).status, 403);

    for (let i = 1; i <= 5; i++) {
      const r = await send(coach.token, { body: `Message number ${i} from the coach` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal((await send(coach.token, { body: 'One more message here' })).status, 429);
    assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 5);
  } finally {
    await h.close();
  }
});

test('league screen over HTTP: alerts are included, and only the commissioner can remove a member', async () => {
  const h = await startApp();
  try {
    const host = await h.signup('Host Coach', 'host@test.dev');
    const guest = await h.signup('Guest Coach', 'guest@test.dev');
    const created = await h.call('POST', '/api/leagues', { token: host.token, body: { name: 'Remove League', team_count: 4 } });
    const id = created.body.league.id;
    const code = h.app.db.prepare('SELECT invite_code FROM leagues WHERE id = ?').get(id).invite_code;
    const joined = await h.call('POST', '/api/leagues/join', { token: guest.token, body: { code } });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));

    const detail = await h.call('GET', `/api/leagues/${id}`, { token: host.token });
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.alerts));

    const url = `/api/leagues/${id}/teams/${joined.body.team.id}/release`;
    assert.equal((await h.call('POST', url, { token: guest.token })).status, 403);
    const done = await h.call('POST', url, { token: host.token });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const row = h.app.db.prepare('SELECT user_id, is_cpu FROM fantasy_teams WHERE id = ?').get(joined.body.team.id);
    assert.deepEqual({ ...row }, { user_id: null, is_cpu: 1 });
  } finally {
    await h.close();
  }
});

// Command line tools read the same database as the server. Each test gets its own file.
function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pf-${label}-`));
  return { dir, file: path.join(dir, 'app.sqlite') };
}

function runCli(file, ...args) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    env: { ...process.env, DB_PATH: file },
    encoding: 'utf8'
  });
}

test('command line: Help messages can be read, and injury notes set, refused, and cleared', async () => {
  const { dir, file } = tempDb('cli');
  try {
    const seeded = openDb(file);
    await ingestAll({ db: seeded, source: createDemoSource({ year: SEASON }), log: quiet });
    const player = seeded.prepare('SELECT id, name FROM players WHERE departed = 0 ORDER BY id LIMIT 1').get();
    const author = seeded.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES ('help.reader@test.dev', 'Help Reader', 'x', ?)")
      .run(new Date().toISOString());
    seeded.prepare('INSERT INTO feedback (user_id, league_id, body, created_at) VALUES (?, NULL, ?, ?)')
      .run(Number(author.lastInsertRowid), 'The  scores   lag during games', new Date().toISOString());
    seeded.close();

    const feedback = runCli(file, 'feedback');
    assert.equal(feedback.status, 0, feedback.stderr);
    assert.match(feedback.stdout, /Help Reader <help\.reader@test\.dev>/);
    assert.match(feedback.stdout, /The scores lag during games/);

    const readStatus = () => {
      const d = openDb(file);
      try {
        return d.prepare('SELECT status, note FROM player_status WHERE player_id = ?').get(player.id);
      } finally {
        d.close();
      }
    };
    const set = runCli(file, 'injury', player.id, 'Out', 'hamstring', 'in', 'warm-ups');
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /is now Out: hamstring in warm-ups/);
    assert.deepEqual({ ...readStatus() }, { status: 'Out', note: 'hamstring in warm-ups' });

    const unknown = runCli(file, 'injury', player.id, 'Maybe');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Status must be one of Questionable, Doubtful, Out, Injured reserve, or clear/);

    const ambiguous = runCli(file, 'injury', 'a', 'Out');
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /More than one player matches/);

    const cleared = runCli(file, 'injury', player.id, 'clear');
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(readStatus(), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Fix 7: injury notes and migration ---------------------------------------

test('injury: a starter listed Out gets a warning, while a Questionable starter and a bench player do not', () => {
  const coach = makeUser('Injury');
  const league = leagueWith(coach, { status: 'season' });
  const team = teamOfUser(league, coach);
  const rb = firstPlayer('RB');
  const benched = firstPlayer('RB', 1);
  startRoster(team, rb, 'RB');
  startRoster(team, benched, 'BN');
  setInjury(rb, 'Out');
  setInjury(benched, 'Out');
  const injured = (w) => w.filter((x) => x.kind === 'injured');
  const warnings = injured(L.lineupWarnings(db, league, team, 7));
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].message.includes(rb.name));
  assert.equal(L.rosterRows(db, team.id).find((r) => r.player_id === rb.id).injury, 'Out');
  setInjury(rb, 'Questionable');
  assert.equal(injured(L.lineupWarnings(db, league, team, 7)).length, 0);
});

test('an older database gains the vacated column and keeps its existing teams', () => {
  const { dir, file } = tempDb('old');
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE fantasy_teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT, league_id INTEGER NOT NULL, user_id INTEGER,
        name TEXT NOT NULL, is_cpu INTEGER NOT NULL DEFAULT 0, draft_slot INTEGER,
        waiver_priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      INSERT INTO fantasy_teams (league_id, name, is_cpu, created_at) VALUES (1, 'Old CPU', 1, '2026-08-01T00:00:00.000Z');
    `);
    old.close();
    const upgraded = openDb(file);
    try {
      const columns = upgraded.prepare('PRAGMA table_info(fantasy_teams)').all().map((c) => c.name);
      assert.ok(columns.includes('vacated'));
      assert.equal(upgraded.prepare("SELECT vacated FROM fantasy_teams WHERE name = 'Old CPU'").get().vacated, 0);
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
