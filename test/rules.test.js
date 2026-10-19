'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const L = require('../src/league');
const { pickTeamId } = require('../src/draft');
const { playerPoints, defensePoints, pointsAllowedPoints } = require('../src/scoring');
const { DEFAULT_SCORING } = require('../src/config');
const { ingestAll } = require('../ingest/ingest');
const { createDemoSource } = require('../ingest/source-demo');
const T = require('../ingest/transform');

const quiet = () => {};

function seedUser(db, name, email) {
  const info = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, name, 'not-used', new Date().toISOString());
  return { id: Number(info.lastInsertRowid), name, email };
}

test('snake draft order reverses every round', () => {
  const order = [1, 2, 3, 4];
  const got = Array.from({ length: 8 }, (_, i) => pickTeamId(order, i + 1));
  assert.deepEqual(got, [1, 2, 3, 4, 4, 3, 2, 1]);
});

test('player scoring matches the default table', () => {
  const qb = {
    pass_yd: 250, pass_td: 2, pass_int: 1, rush_yd: 10, rush_td: 0,
    rec: 0, rec_yd: 0, rec_td: 0, fum_lost: 0, fgm: 0, xpm: 0
  };
  // 250 x 0.04 + 2 x 4 - 2 + 10 x 0.1 = 17
  assert.equal(playerPoints(qb, DEFAULT_SCORING), 17);
  const k = { pass_yd: 0, pass_td: 0, pass_int: 0, rush_yd: 0, rush_td: 0, rec: 0, rec_yd: 0, rec_td: 0, fum_lost: 0, fgm: 2, xpm: 3 };
  assert.equal(playerPoints(k, DEFAULT_SCORING), 9);
});

test('defense scoring uses the points-allowed brackets', () => {
  // 3 sacks + 1 INT x 2 + 17 allowed (bracket +1) = 6
  assert.equal(defensePoints({ sacks: 3, def_int: 1, def_td: 0, points_allowed: 17 }, DEFAULT_SCORING), 6);
  const edges = [[0, 10], [6, 7], [7, 4], [13, 4], [14, 1], [20, 1], [21, 0], [27, 0], [28, -1], [34, -1], [35, -4]];
  for (const [allowed, pts] of edges) assert.equal(pointsAllowedPoints(allowed), pts, `allowed ${allowed}`);
});

test('transform: positions, colors and league weeks', () => {
  assert.equal(T.normalizePosition('PK'), 'K');
  assert.equal(T.normalizePosition('FB'), 'RB');
  assert.equal(T.normalizePosition('wr'), 'WR');
  assert.equal(T.normalizePosition('OL'), null);
  assert.equal(T.normalizeColor('#0c2340'), '#0C2340');
  assert.equal(T.normalizeColor('0C2340'), '#0C2340');
  assert.equal(T.normalizeColor('navy'), null);
  assert.equal(T.leagueWeekOf('regular', 9), 9);
  assert.equal(T.leagueWeekOf('postseason', 2), 17);
});

test('transform: box score sides, including unknown stat types', () => {
  const side = {
    school: 'Alabama',
    categories: [
      { name: 'passing', types: [
        { name: 'C/ATT', athletes: [{ id: 7, name: 'A Qb', stat: '20/30' }] },
        { name: 'YDS', athletes: [{ id: 7, name: 'A Qb', stat: '250' }] },
        { name: 'TD', athletes: [{ id: 7, name: 'A Qb', stat: '2' }] },
        { name: 'SOMETHING_NEW', athletes: [{ id: 7, name: 'A Qb', stat: '9' }] }
      ] },
      { name: 'punting', types: [{ name: 'NO', athletes: [{ id: 9, name: 'P', stat: '4' }] }] },
      { name: 'defensive', types: [{ name: 'SACKS', athletes: [{ id: 20, name: 'D', stat: '2.0' }] }] },
      { name: 'interceptions', types: [
        { name: 'INT', athletes: [{ id: 21, name: 'DB', stat: '1' }] },
        { name: 'TD', athletes: [{ id: 21, name: 'DB', stat: '1' }] }
      ] }
    ]
  };
  const { athletes, defense } = T.parseSide(side);
  assert.equal(athletes.length, 1);
  assert.equal(athletes[0].id, '7');
  assert.equal(athletes[0].stats.pass_cmp, 20);
  assert.equal(athletes[0].stats.pass_att, 30);
  assert.equal(athletes[0].stats.pass_yd, 250);
  assert.deepEqual(defense, { sacks: 2, def_int: 1, def_td: 1 });
});

test('transform: a defensive TD type overrides the interception TD count', () => {
  const side = {
    categories: [
      { name: 'defensive', types: [{ name: 'TD', athletes: [{ id: 1, stat: '0' }] }] },
      { name: 'interceptions', types: [{ name: 'TD', athletes: [{ id: 2, stat: '1' }] }] }
    ]
  };
  assert.equal(T.parseSide(side).defense.def_td, 0);
});

test('transform: position inference from stats', () => {
  assert.equal(T.inferPosition({ pass_att: 10 }), 'QB');
  assert.equal(T.inferPosition({ rec: 3 }), 'WR');
  assert.equal(T.inferPosition({ rush_att: 12, rec: 1 }), 'RB');
  assert.equal(T.inferPosition({ fga: 2, xpm: 1 }), 'K');
  assert.equal(T.inferPosition({}), null);
});

test('league settings reject out-of-range values', () => {
  assert.throws(() => L.normalizeSettings({ team_count: 3 }), /between 4 and 16/);
  assert.throws(() => L.normalizeSettings({ playoff_teams: 6 }), /0 \(none\) or 4/);
  assert.throws(() => L.normalizeSettings({ pick_seconds: 5 }), /30 to 600/);
  const ok = L.normalizeSettings({ regular_weeks: 14, scoring: { rec: 0.5, bogus: 9 } });
  assert.equal(ok.regular_weeks, 14);
  assert.equal(ok.scoring.rec, 0.5);
  assert.equal('bogus' in ok.scoring, false);
});

test('ingest is idempotent: running it twice leaves the same rows', async () => {
  const db = openDb(':memory:');
  const source = () => createDemoSource({ year: 2026 });
  await ingestAll({ db, source: source(), log: quiet });
  const counts = () => ['teams', 'players', 'games', 'player_games', 'defense_games']
    .map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const first = counts();
  await ingestAll({ db, source: source(), log: quiet });
  assert.deepEqual(counts(), first);
  assert.equal(first[0], 68, 'Power Four plus Notre Dame');
  db.close();
});

test('waiver priority: the first team in line wins, then goes to the back', async () => {
  const db = openDb(':memory:');
  await ingestAll({ db, source: createDemoSource({ year: 2026 }), log: quiet });
  const alice = seedUser(db, 'Alice Smith', 'alice@rules.test');
  const bob = seedUser(db, 'Bob Jones', 'bob@rules.test');
  const created = L.createLeague(db, alice, { name: 'Waivers', team_count: 4 });
  L.joinLeague(db, bob, created.invite_code);
  db.prepare("UPDATE leagues SET status = 'season', start_week = 7 WHERE id = ?").run(created.id);
  const league = L.getLeague(db, created.id);
  const [ta, tb] = L.teamsOf(db, league.id);

  const wrs = db.prepare("SELECT id FROM players WHERE position = 'WR' AND team_id < 200 ORDER BY id LIMIT 6")
    .all().map((r) => r.id);
  const put = db.prepare("INSERT INTO roster (team_id, player_id, slot) VALUES (?, ?, 'BN')");
  put.run(ta.id, wrs[0]);
  put.run(ta.id, wrs[1]);
  put.run(tb.id, wrs[2]);
  put.run(tb.id, wrs[3]);
  const status = (team, player) => db.prepare('SELECT status FROM waiver_claims WHERE team_id = ? AND player_id = ?')
    .get(team.id, player).status;

  // Round 1: both want wrs[4]. Alice holds priority 1, so she wins.
  L.createClaim(db, league, ta, wrs[4], wrs[0]);
  L.createClaim(db, league, tb, wrs[4], wrs[2]);
  assert.throws(() => L.createClaim(db, league, tb, wrs[0], null), { message: /already on a roster/ });
  L.processClaims(db, league);
  assert.equal(status(ta, wrs[4]), 'won');
  assert.equal(status(tb, wrs[4]), 'lost');
  assert.ok(L.rosterHas(db, ta.id, wrs[4]));
  assert.ok(!L.rosterHas(db, ta.id, wrs[0]), 'the dropped player leaves the roster');
  assert.ok(L.rosterHas(db, tb.id, wrs[2]), 'a lost claim drops nobody');

  // Round 2: Alice has moved to the back, so Bob wins wrs[5]
  L.createClaim(db, league, ta, wrs[5], wrs[1]);
  L.createClaim(db, league, tb, wrs[5], wrs[3]);
  L.processClaims(db, league);
  assert.equal(status(tb, wrs[5]), 'won');
  assert.equal(status(ta, wrs[5]), 'lost');
  db.close();
});
