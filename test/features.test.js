'use strict';

// Rules for the league features added after the first release: lineup locks, lineup warnings, FAAB,
// trade deadlines and counter-offers, draft queue and order, points and best ball leagues, power rankings,
// recaps and awards, transfers and departures, league history, recovery codes, sign-in limits, reactions, backups.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, backupDatabase, listBackups } = require('../src/db');
const L = require('../src/league');
const flow = require('../src/flow');
const draft = require('../src/draft');
const season = require('../src/season');
const { createLimiter, createLimits } = require('../src/limiter');
const { ingestAll, reconcileRosters } = require('../ingest/ingest');
const { createDemoSource } = require('../ingest/source-demo');
const { SEASON, BENCH, SLOT_ELIGIBLE } = require('../src/config');
const { createApp } = require('../src/server');

process.env.ADMIN_TOKEN = 'test-admin-token-0123456789';

const quiet = () => {};
let db;
let userCount = 0;

before(async () => {
  db = openDb(':memory:');
  await ingestAll({ db, source: createDemoSource({ year: SEASON }), log: quiet });
});

after(() => db.close());

function seedUser(name) {
  userCount += 1;
  const email = `feature${userCount}@test.dev`;
  const info = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, name, 'not-used', new Date().toISOString());
  return { id: Number(info.lastInsertRowid), name, email };
}

// Two human coaches (commissioner and a joiner) and CPU teams, drafted to the end.
// startWeek sets where the league begins; the demo data has weeks 1-6 final.
function draftedLeague(settings = {}, startWeek = 7) {
  season.setCurrentWeek(db, SEASON, startWeek);
  const commish = seedUser('Cam Owner');
  const joiner = seedUser('Jo Joiner');
  const league = L.createLeague(db, commish, { name: `Rules ${userCount}`, team_count: 4, pick_seconds: 60, ...settings });
  L.joinLeague(db, joiner, league.invite_code);
  draft.startDraft(db, L.getLeague(db, league.id), commish);
  const byUser = new Map([[commish.id, commish], [joiner.id, joiner]]);
  for (let i = 0; i < 2000; i++) {
    const current = L.getLeague(db, league.id);
    if (current.status !== 'drafting') break;
    const state = draft.draftState(db, current, commish.id);
    if (!state.on_clock) break;
    const team = L.teamOf(db, current, state.on_clock.id);
    const user = byUser.get(team.user_id);
    const pid = draft.autopick(db, current, team.id, state.round, season.currentWeek(db));
    draft.makePick(db, current, user, pid);
  }
  return { league: L.getLeague(db, league.id), commish, joiner, byUser };
}

function teamOfUser(league, user) {
  return L.myTeamOf(db, league, user.id);
}

// Makes one school's game in a week already kicked off (and not final)
function kickOff(schoolId, week) {
  db.prepare(`
    UPDATE games SET start_date = '2000-01-01T00:00:00.000Z', completed = 0
    WHERE season = ? AND season_type = 'regular' AND week = ? AND (home_id = ? OR away_id = ?)
  `).run(SEASON, week, schoolId, schoolId);
}

test('demo kickoffs: unplayed games have no start time, so nothing is locked', () => {
  const rows = db.prepare("SELECT start_date, completed FROM games WHERE week = 7 AND season_type = 'regular'").all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.start_date === null && r.completed === 0));
  const kick = L.kickoffsForWeek(db, SEASON, 7);
  assert.equal(L.hasKickedOff(kick.values().next().value), false);
  assert.equal(L.hasKickedOff(null), false);
});

test('lineup locks: a player whose game has kicked off cannot move, drop or be traded', () => {
  const { league, commish, joiner } = draftedLeague();
  const team = teamOfUser(league, commish);
  const roster = L.rosterRows(db, team.id);
  const starter = roster.find((r) => r.slot !== BENCH);
  kickOff(starter.team_id, 7);
  try {
    lockChecks(league, team, roster, starter, commish, joiner);
  } finally {
    db.prepare("UPDATE games SET start_date = NULL, completed = 0 WHERE season = ? AND season_type = 'regular' AND week = 7").run(SEASON);
  }
});

function lockChecks(league, team, roster, starter, commish, joiner) {
  const locked = L.lockedPlayerIds(db, league, 7, L.rosterRows(db, team.id));
  assert.ok(locked.has(starter.player_id), 'starter with a started game is locked');

  const assignments = { [starter.player_id]: BENCH };
  assert.throws(() => L.setLineup(db, league, team, assignments), /game has started/);
  assert.throws(() => L.dropPlayer(db, league, team, starter.player_id), /locked until it ends/);

  const other = roster.find((r) => r.team_id !== starter.team_id);
  if (other) {
    L.dropPlayer(db, league, team, other.player_id);
    assert.equal(L.rosterHas(db, team.id, other.player_id), false, 'a player with no started game can still go');
    L.addPlayer(db, league, team, other.player_id, null); // put him back
  }

  const counterparty = teamOfUser(league, joiner);
  const theirs = L.rosterRows(db, counterparty.id)[0];
  assert.throws(() => L.proposeTrade(db, league, team, counterparty.id, [starter.player_id], [theirs.player_id]), /locked until it ends/);

  // Auto lineup keeps a locked player in his slot
  L.autoLineup(db, league, team, 7);
  const after = db.prepare('SELECT slot FROM roster WHERE team_id = ? AND player_id = ?').get(team.id, starter.player_id);
  assert.equal(after.slot, starter.slot);
}

test('lineup warnings: an empty starting slot is flagged, with the bench player who could fill it', () => {
  const { league, commish } = draftedLeague();
  const team = teamOfUser(league, commish);
  L.autoLineup(db, league, team, 7);
  assert.deepEqual(L.lineupWarnings(db, league, team, 7).filter((w) => w.kind === 'empty'), []);
  const qb = db.prepare(`
    SELECT r.player_id FROM roster r JOIN players p ON p.id = r.player_id
    WHERE r.team_id = ? AND r.slot = 'QB'
  `).get(team.id);
  db.prepare("UPDATE roster SET slot = 'BN' WHERE team_id = ? AND player_id = ?").run(team.id, qb.player_id);
  const warnings = L.lineupWarnings(db, league, team, 7);
  const empty = warnings.find((w) => w.kind === 'empty' && w.slot === 'QB');
  assert.ok(empty, 'QB slot is flagged');
  assert.match(empty.message, /QB slot is empty/);
});

test('FAAB: a bid cannot exceed the balance, the higher bid wins, and the winner pays', () => {
  const { league, commish, joiner } = draftedLeague({ waiver_mode: 'faab', faab_budget: 50 });
  const alice = teamOfUser(league, commish);
  const bob = teamOfUser(league, joiner);
  assert.equal(alice.faab, 50);
  const free = L.listPlayers(db, league, commish.id, { pos: 'RB', status: 'free', limit: 1 })[0];
  assert.ok(free, 'a free running back exists');
  const aliceDrop = L.rosterRows(db, alice.id)[0].player_id;
  const bobDrop = L.rosterRows(db, bob.id)[0].player_id;
  assert.throws(() => L.createClaim(db, league, alice, free.id, aliceDrop, 60), /more than your FAAB balance/);
  L.createClaim(db, league, alice, free.id, aliceDrop, 20);
  L.createClaim(db, league, bob, free.id, bobDrop, 30);
  L.processClaims(db, league);
  assert.equal(L.ownerMap(db, league.id).get(free.id), bob.id);
  assert.equal(db.prepare('SELECT faab FROM fantasy_teams WHERE id = ?').get(bob.id).faab, 20);
  assert.equal(db.prepare('SELECT faab FROM fantasy_teams WHERE id = ?').get(alice.id).faab, 50);
  const lost = db.prepare("SELECT status, note FROM waiver_claims WHERE team_id = ? AND player_id = ?").get(alice.id, free.id);
  assert.equal(lost.status, 'lost');
});

test('trade deadline: trades are refused after the deadline week', () => {
  const { league, commish, joiner } = draftedLeague({ trade_deadline_week: 6 }, 7);
  const alice = teamOfUser(league, commish);
  const bob = teamOfUser(league, joiner);
  const give = [L.rosterRows(db, alice.id)[0].player_id];
  const get = [L.rosterRows(db, bob.id)[0].player_id];
  assert.throws(() => L.proposeTrade(db, league, alice, bob.id, give, get), /Trades closed after week 6/);
});

test('counter-offers: the receiving team answers with its own offer, and the first is closed', () => {
  const { league, commish, joiner } = draftedLeague({ trade_deadline_week: 0 });
  const alice = teamOfUser(league, commish);
  const bob = teamOfUser(league, joiner);
  const give = [L.rosterRows(db, alice.id)[0].player_id];
  const get = [L.rosterRows(db, bob.id)[0].player_id];
  const first = L.proposeTrade(db, league, alice, bob.id, give, get);
  const counterId = L.counterTrade(db, league, joiner, first, [get[0]], [give[0]]);
  assert.equal(L.loadTrade(db, league, first).status, 'countered');
  const counter = L.loadTrade(db, league, counterId);
  assert.equal(counter.status, 'pending');
  assert.equal(counter.from_team_id, bob.id);
  assert.equal(counter.to_team_id, alice.id);
  assert.throws(() => L.acceptTrade(db, league, commish, first), /no longer open/);
});

test('trade analyzer: a trade for a better player favors the proposing team', () => {
  const values = new Map([['good', { value: 12, projection: 20 }], ['meh', { value: 2, projection: 6 }]]);
  const s = L.tradeSummary(values, ['meh'], ['good']);
  assert.equal(s.value_change, 10);
  assert.equal(s.projection_change, 14);
});

test('draft queue: a timed-out pick takes the first queued player who is still available', () => {
  season.setCurrentWeek(db, SEASON, 7);
  const coach = seedUser('Queue Coach');
  const league = L.createLeague(db, coach, { name: 'Queue', team_count: 4, pick_seconds: 60 });
  const team = L.teamsOf(db, league.id).find((t) => t.user_id === coach.id);
  const pool = L.listPlayers(db, L.getLeague(db, league.id), coach.id, { status: 'free', limit: 3 });
  assert.throws(() => draft.setQueue(db, league, team, ['not-a-player']), /not in the pool/);
  draft.setQueue(db, league, team, [pool[0].id, pool[1].id]);
  assert.equal(draft.queuedPick(db, league, team.id), pool[0].id);
  // Another team takes the first player: the queue skips him and offers the next one
  const other = L.teamsOf(db, league.id).find((t) => t.id !== team.id);
  db.prepare("INSERT INTO roster (team_id, player_id, slot) VALUES (?, ?, 'BN')").run(other.id, pool[0].id);
  assert.equal(draft.queuedPick(db, league, team.id), pool[1].id);
});

test('draft order: the commissioner sets it, and the draft starts in that order', () => {
  season.setCurrentWeek(db, SEASON, 7);
  const commish = seedUser('Order Owner');
  const league = L.createLeague(db, commish, { name: 'Order', team_count: 4 });
  const ids = L.teamsOf(db, league.id).map((t) => t.id);
  const reversed = [...ids].reverse();
  draft.setDraftOrder(db, L.getLeague(db, league.id), commish, reversed);
  draft.startDraft(db, L.getLeague(db, league.id), commish);
  const order = JSON.parse(db.prepare('SELECT draft_order FROM drafts WHERE league_id = ?').get(league.id).draft_order);
  assert.deepEqual(order, reversed);
  assert.throws(() => draft.setDraftOrder(db, L.getLeague(db, league.id), commish, ids), /already starts|set before/);
});

test('draft order must list every team exactly once', () => {
  season.setCurrentWeek(db, SEASON, 7);
  const commish = seedUser('Order Check');
  const league = L.createLeague(db, commish, { name: 'Order check', team_count: 4 });
  const ids = L.teamsOf(db, league.id).map((t) => t.id);
  assert.throws(() => draft.setDraftOrder(db, L.getLeague(db, league.id), commish, ids.slice(1)), /every team exactly once/);
  assert.throws(() => draft.setDraftOrder(db, L.getLeague(db, league.id), commish, [ids[0], ids[0], ids[1], ids[2]]), /every team exactly once/);
});

test('points league: no schedule, standings by points, no playoffs', () => {
  const settings = L.normalizeSettings({ format: 'points', playoff_teams: 4 });
  assert.equal(settings.format, 'points');
  assert.equal(settings.playoff_teams, 0, 'points leagues have no playoffs');
  const { league } = draftedLeague({ format: 'points' }, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matchups WHERE league_id = ?').get(league.id).n, 0);
  for (let i = 0; i < 6; i++) flow.advanceWeek(db, SEASON);
  const rows = flow.standings(db, L.getLeague(db, league.id), season.currentWeek(db));
  assert.equal(rows.length, 4);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].points_for >= rows[i].points_for, 'sorted by points');
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4]);
});

test('head-to-head league after six closed weeks: matchups, recap, power rankings, awards and history', () => {
  const { league, commish } = draftedLeague({}, 1);
  assert.equal(season.currentWeek(db), 1);
  for (let i = 0; i < 6; i++) flow.advanceWeek(db, SEASON);
  assert.equal(season.currentWeek(db), 7);
  const fresh = L.getLeague(db, league.id);
  const matchups = flow.matchupsForWeek(db, fresh, 3, 7);
  assert.equal(matchups.length, 2, 'four teams play two games a week');
  assert.ok(matchups.every((m) => m.home.points >= 0 && m.away.points >= 0));

  const recap = flow.weekRecap(db, fresh, 3, 7);
  assert.equal(recap.ready, true);
  assert.equal(recap.games.length, 2);
  assert.ok(recap.top_player && recap.top_player.points >= 0);
  assert.ok(recap.closest.margin <= recap.blowout.margin);
  assert.equal(flow.weekRecap(db, fresh, 7, 7).ready, false, 'a week that is not final has no recap');

  const power = flow.powerRankings(db, fresh, 7);
  assert.deepEqual(power.map((r) => r.power_rank), [1, 2, 3, 4]);

  const awards = flow.seasonAwards(db, fresh, 7);
  assert.ok(awards.top_player && awards.top_player.points > 0);
  assert.ok(awards.best_team && awards.best_week.points >= 0);

  const rows = flow.standings(db, fresh, 7);
  assert.equal(rows.reduce((sum, r) => sum + r.wins, 0), rows.reduce((sum, r) => sum + r.losses, 0));

  const owned = L.myTeamOf(db, fresh, commish.id);
  assert.ok(owned);
});

test('best ball: lineups are set by the app, so manual lineup changes are refused', () => {
  const { league, commish } = draftedLeague({ best_ball: true }, 7);
  const team = teamOfUser(league, commish);
  assert.throws(() => L.setLineup(db, league, team, {}), /set your lineup automatically/);
  const starters = db.prepare("SELECT COUNT(*) AS n FROM roster WHERE team_id = ? AND slot != 'BN'").get(team.id).n;
  assert.equal(starters, Object.values(league.settings.roster).reduce((a, b) => a + b, 0) - league.settings.roster.BN);
});

test('transfers and departures: a player who leaves the Power Four is dropped from rosters and logged', () => {
  const { league, commish } = draftedLeague({}, 7);
  const team = teamOfUser(league, commish);
  const [keep, gone] = L.rosterRows(db, team.id);
  const schoolOf = (id) => (db.prepare('SELECT team_id FROM players WHERE id = ?').get(id) || {}).team_id;
  const before = new Map([[keep.player_id, schoolOf(keep.player_id)], [gone.player_id, schoolOf(gone.player_id)]]);
  const rosterCounts = new Map([[schoolOf(keep.player_id), 9], [schoolOf(gone.player_id), 9]]);
  // keep is still on his school's roster; gone is not on any roster any more
  const seen = new Map([[keep.player_id, schoolOf(keep.player_id)]]);
  const schools = new Map();
  const result = reconcileRosters(db, { before, seen, rosterCounts, schools });
  assert.equal(result.departures, 1);
  assert.equal(db.prepare('SELECT departed FROM players WHERE id = ?').get(gone.player_id).departed, 1);
  assert.equal(L.rosterHas(db, team.id, gone.player_id), false);
  const logged = db.prepare("SELECT detail FROM transactions WHERE league_id = ? AND kind = 'departed'").all(league.id);
  assert.ok(logged.some((row) => JSON.parse(row.detail).player_id === gone.player_id));
  const pool = L.listPlayers(db, league, commish.id, { status: 'free', limit: 500 });
  assert.ok(!pool.some((p) => p.id === gone.player_id), 'departed players leave the pool');
});

test('transfers between Power Four schools are logged and the player stays on his fantasy team', () => {
  const { league, commish } = draftedLeague({}, 7);
  const team = teamOfUser(league, commish);
  const mover = L.rosterRows(db, team.id)[0];
  const fromSchool = db.prepare('SELECT team_id FROM players WHERE id = ?').get(mover.player_id).team_id;
  const toSchool = fromSchool === 100 ? 101 : 100;
  const before = new Map([[mover.player_id, fromSchool]]);
  const seen = new Map([[mover.player_id, toSchool]]);
  const rosterCounts = new Map([[fromSchool, 9], [toSchool, 9]]);
  const result = reconcileRosters(db, { before, seen, rosterCounts, schools: new Map() });
  assert.equal(result.transfers, 1);
  assert.equal(L.rosterHas(db, team.id, mover.player_id), true);
  const logged = db.prepare("SELECT detail FROM transactions WHERE league_id = ? AND kind = 'transfer'").all(league.id);
  assert.ok(logged.length >= 1);
});

test('a school whose roster came back empty is not trusted, so its players stay put', () => {
  const { league, commish } = draftedLeague({}, 7);
  const team = teamOfUser(league, commish);
  const player = L.rosterRows(db, team.id)[0];
  const school = db.prepare('SELECT team_id FROM players WHERE id = ?').get(player.player_id).team_id;
  const result = reconcileRosters(db, {
    before: new Map([[player.player_id, school]]),
    seen: new Map(),
    rosterCounts: new Map([[school, 0]]),
    schools: new Map()
  });
  assert.equal(result.departures, 0);
  assert.equal(L.rosterHas(db, team.id, player.player_id), true);
});

test('settings: new options are validated and defaults fill in for older leagues', () => {
  assert.throws(() => L.normalizeSettings({ format: 'auction' }), /head-to-head or points/);
  assert.throws(() => L.normalizeSettings({ waiver_mode: 'lottery' }), /priority or FAAB/);
  assert.throws(() => L.normalizeSettings({ faab_budget: 5000 }), /FAAB budget/);
  assert.throws(() => L.normalizeSettings({ trade_deadline_week: 30 }), /Trade deadline/);
  const old = L.parseLeague({ id: 1, settings: JSON.stringify({ team_count: 6, roster: {}, scoring: {} }) });
  assert.equal(old.settings.format, 'h2h');
  assert.equal(old.settings.waiver_mode, 'priority');
  assert.equal(old.settings.best_ball, false);
  assert.equal(old.settings.trade_deadline_week, 0);
});

test('history: finished league results are kept per team and per owner', () => {
  const { league, commish } = draftedLeague({}, 1);
  for (let i = 0; i < 6; i++) flow.advanceWeek(db, SEASON);
  flow.recordSeasonResults(db, L.getLeague(db, league.id));
  const rows = db.prepare('SELECT * FROM season_results WHERE league_id = ? ORDER BY place').all(league.id);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.place), [1, 2, 3, 4]);
  assert.equal(rows[0].champion, 1);
  const mine = rows.find((r) => r.user_id === commish.id);
  assert.ok(mine, 'the commissioner\'s finish is recorded against their user');
});

test('backups: a copy is written, and only the newest are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-backup-'));
  const pause = () => { const until = Date.now() + 3; while (Date.now() < until) { /* wait so names differ */ } };
  try {
    const first = backupDatabase(db, dir, 2);
    pause();
    backupDatabase(db, dir, 2);
    pause();
    backupDatabase(db, dir, 2);
    const kept = listBackups(dir);
    assert.equal(kept.length, 2);
    assert.equal(fs.existsSync(first), false, 'the oldest copy was removed');
    const copy = openDb(kept[0]);
    try {
      assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM teams').get().n > 0, 'the copy has the data');
    } finally {
      copy.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('limiter: blocks after the maximum, then lets the key through once the window passes', () => {
  let t = 0;
  const limiter = createLimiter({ max: 2, windowMs: 1000, now: () => t });
  limiter.fail('a');
  assert.equal(limiter.blocked('a'), 0);
  limiter.fail('a');
  assert.ok(limiter.blocked('a') > 0);
  assert.equal(limiter.blocked('b'), 0, 'other keys are not affected');
  t = 1001;
  assert.equal(limiter.blocked('a'), 0);
  limiter.fail('a');
  limiter.clear('a');
  assert.equal(limiter.blocked('a'), 0);
  assert.ok(createLimits().loginEmail);
});

// ---- HTTP ----------------------------------------------------------------------

let app;
let base;

before(async () => {
  app = createApp({ dbFile: ':memory:' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await ingestAll({ db: app.db, source: createDemoSource({ year: SEASON }), log: quiet });
});

after(() => new Promise((resolve) => app.server.close(resolve)));

async function call(method, route, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('recovery code: shown at sign-up, resets the password once, and signs out old sessions', async () => {
  const signup = await call('POST', '/api/auth/signup', { body: { name: 'Rec Overy', email: 'rec@test.dev', password: 'password123' } });
  assert.equal(signup.status, 200);
  const code = signup.body.recovery_code;
  assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

  const bad = await call('POST', '/api/auth/reset', { body: { email: 'rec@test.dev', recovery_code: 'AAAA-AAAA-AAAA-AAAA', password: 'brandnew123' } });
  assert.equal(bad.status, 401);

  const reset = await call('POST', '/api/auth/reset', { body: { email: 'rec@test.dev', recovery_code: code.toLowerCase().replace(/-/g, ''), password: 'brandnew123' } });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.notEqual(reset.body.recovery_code, code, 'a fresh code is issued');
  assert.equal((await call('GET', '/api/me', { token: signup.body.token })).body.user, null, 'the old session is gone');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'rec@test.dev', password: 'password123' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'rec@test.dev', password: 'brandnew123' } })).status, 200);
  const oldCode = await call('POST', '/api/auth/reset', { body: { email: 'rec@test.dev', recovery_code: code, password: 'another123' } });
  assert.equal(oldCode.status, 401, 'the used code no longer works');
});

test('sign-in limit: repeated wrong passwords are refused for a while, then the account is still blocked', async () => {
  const statuses = [];
  for (let i = 0; i < 9; i++) {
    statuses.push((await call('POST', '/api/auth/login', { body: { email: 'nobody@test.dev', password: 'wrong-guess' } })).status);
  }
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(401));
  assert.equal(statuses[8], 429);
  const again = await call('POST', '/api/auth/login', { body: { email: 'nobody@test.dev', password: 'wrong-guess' } });
  assert.equal(again.status, 429);
  assert.match(again.body.error, /Too many sign-in attempts/);
});

test('reactions: toggle an allowed emoji on a chat message, refuse anything else', async () => {
  const user = await call('POST', '/api/auth/signup', { body: { name: 'Reacty Fan', email: 'react@test.dev', password: 'password123' } });
  const token = user.body.token;
  const created = await call('POST', '/api/leagues', { token, body: { name: 'Chat', team_count: 4 } });
  const lid = created.body.league.id;
  const mid = app.db.prepare('INSERT INTO messages (league_id, user_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(lid, user.body.user.id, 'Reacty', 'hello', new Date().toISOString()).lastInsertRowid;

  const bad = await call('POST', `/api/leagues/${lid}/messages/${mid}/react`, { token, body: { emoji: 'X' } });
  assert.equal(bad.status, 400);

  const on = await call('POST', `/api/leagues/${lid}/messages/${mid}/react`, { token, body: { emoji: '🔥' } });
  assert.deepEqual(on.body.reactions, [{ emoji: '🔥', count: 1, mine: true }]);
  const list = await call('GET', `/api/leagues/${lid}/messages?after=0`, { token });
  assert.deepEqual(list.body.messages[0].reactions, [{ emoji: '🔥', count: 1, mine: true }]);

  const off = await call('POST', `/api/leagues/${lid}/messages/${mid}/react`, { token, body: { emoji: '🔥' } });
  assert.deepEqual(off.body.reactions, []);
});

test('history over HTTP: a finished league result appears on the owner\'s history', async () => {
  const user = await call('POST', '/api/auth/signup', { body: { name: 'Hist Ory', email: 'hist@test.dev', password: 'password123' } });
  const token = user.body.token;
  const created = await call('POST', '/api/leagues', { token, body: { name: 'Past', team_count: 4 } });
  const lid = created.body.league.id;
  const teamId = created.body.league.my_team.id;
  app.db.prepare(`
    INSERT INTO season_results (league_id, team_id, season, league_name, team_name, owner, user_id, place, wins, losses, points_for, champion, finished_at)
    VALUES (?, ?, ?, 'Past', 'Hist Ory''s team', 'Hist Ory', ?, 1, 9, 4, 1234.5, 1, ?)
  `).run(lid, teamId, SEASON, user.body.user.id, new Date().toISOString());
  const mine = await call('GET', '/api/history', { token });
  assert.equal(mine.body.seasons.length, 1);
  assert.equal(mine.body.seasons[0].champion, true);
  assert.equal(mine.body.seasons[0].points_for, 1234.5);
  const league = await call('GET', `/api/leagues/${lid}/history`, { token });
  assert.equal(league.body.results[0].place, 1);
});

test('the new routes are guarded: a non-member is refused', async () => {
  const owner = await call('POST', '/api/auth/signup', { body: { name: 'Own Er', email: 'own@test.dev', password: 'password123' } });
  const lid = (await call('POST', '/api/leagues', { token: owner.body.token, body: { name: 'Private', team_count: 4 } })).body.league.id;
  const stranger = await call('POST', '/api/auth/signup', { body: { name: 'Out Sider', email: 'out@test.dev', password: 'password123' } });
  assert.equal((await call('GET', `/api/leagues/${lid}/rankings`, { token: stranger.body.token })).status, 403);
  assert.equal((await call('GET', `/api/leagues/${lid}/recap`, { token: stranger.body.token })).status, 403);
  assert.equal((await call('GET', `/api/leagues/${lid}/trades/preview?give=&get=`, { token: stranger.body.token })).status, 403);
  assert.equal((await call('GET', `/api/leagues/${lid}/draft/queue`, { token: stranger.body.token })).status, 403);
});
