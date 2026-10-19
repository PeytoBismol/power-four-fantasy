'use strict';

// End-to-end: two coaches, a snake draft, lineups, free agency, claims, trades, chat and a week close.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { ingestAll } = require('../ingest/ingest');
const { createDemoSource } = require('../ingest/source-demo');
const { DEFAULT_ROSTER, SLOT_ELIGIBLE, BENCH } = require('../src/config');

process.env.ADMIN_TOKEN = 'test-admin-token-0123456789';

let app;
let base;

before(async () => {
  app = createApp({ dbFile: ':memory:' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await ingestAll({ db: app.db, source: createDemoSource({ year: 2026 }), log: () => {} });
});

after(() => new Promise((resolve) => app.server.close(resolve)));

async function call(method, path, { token, body, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Token'] = admin;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function signup(name, email) {
  const r = await call('POST', '/api/auth/signup', { body: { name, email, password: 'password123' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.token, user: r.body.user };
}

const enc = encodeURIComponent;

test('auth: validation, duplicates, bad password, logout', async () => {
  const short = await call('POST', '/api/auth/signup', { body: { name: 'X', email: 'x@test.dev', password: 'short' } });
  assert.equal(short.status, 400);
  const solo = await signup('Solo Tester', 'solo@test.dev');
  const dup = await call('POST', '/api/auth/signup', { body: { name: 'Again', email: 'solo@test.dev', password: 'password123' } });
  assert.equal(dup.status, 409);
  const wrong = await call('POST', '/api/auth/login', { body: { email: 'solo@test.dev', password: 'nope-nope' } });
  assert.equal(wrong.status, 401);
  const right = await call('POST', '/api/auth/login', { body: { email: 'solo@test.dev', password: 'password123' } });
  assert.equal(right.status, 200);
  await call('POST', '/api/auth/logout', { token: solo.token });
  const after = await call('GET', '/api/leagues', { token: solo.token });
  assert.equal(after.status, 401);
});

test('a league from invite to finished draft, lineups, moves and a closed week', async () => {
  const alice = await signup('Alice Smith', 'alice@test.dev');
  const bob = await signup('Bob Jones', 'bob@test.dev');
  const carl = await signup('Carl Diaz', 'carl@test.dev');

  const created = await call('POST', '/api/leagues', { token: alice.token, body: { name: 'Test League', team_count: 4, pick_seconds: 30 } });
  assert.equal(created.status, 200);
  const lid = created.body.league.id;

  assert.equal((await call('GET', `/api/leagues/${lid}`, { token: carl.token })).status, 403);

  const joined = await call('POST', '/api/leagues/join', { token: bob.token, body: { code: created.body.league.invite_code } });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.joined, true);

  assert.equal((await call('PATCH', `/api/leagues/${lid}`, { token: bob.token, body: { pick_seconds: 60 } })).status, 403);
  assert.equal((await call('PATCH', `/api/leagues/${lid}`, { token: alice.token, body: { pick_seconds: 5 } })).status, 400);
  const tuned = await call('PATCH', `/api/leagues/${lid}`, { token: alice.token, body: { pick_seconds: 60 } });
  assert.equal(tuned.body.league.settings.pick_seconds, 60);

  const pending = await call('GET', `/api/leagues/${lid}/draft`, { token: alice.token });
  assert.equal(pending.body.draft.status, 'pending');
  assert.equal((await call('POST', `/api/leagues/${lid}/draft/start`, { token: bob.token })).status, 403);
  assert.equal((await call('POST', `/api/leagues/${lid}/draft/start`, { token: alice.token })).status, 200);

  for (const coach of [alice, bob]) {
    coach.teamId = (await call('GET', `/api/leagues/${lid}`, { token: coach.token })).body.league.my_team.id;
  }
  const coaches = [alice, bob];
  let picks = 0;
  let wrongTurnChecked = false;
  const positionsSeen = new Map();
  for (let guard = 0; guard < 200; guard++) {
    const state = (await call('GET', `/api/leagues/${lid}/draft`, { token: alice.token })).body.draft;
    if (state.status === 'complete') break;
    const turn = coaches.find((c) => c.teamId === state.on_clock.id);
    assert.ok(turn, 'a CPU team should never be left on the clock');
    if (!wrongTurnChecked) {
      const other = coaches.find((c) => c !== turn);
      const early = await call('POST', `/api/leagues/${lid}/draft/pick`, { token: other.token, body: { player_id: 'x' } });
      assert.equal(early.status, 409);
      wrongTurnChecked = true;
    }
    // Coaches fill a kicker, a defense, a QB and a TE first, then take the best available player.
    // This keeps the test's roster complete no matter what order the random draft produces.
    const seen = positionsSeen.get(turn.teamId) || new Set();
    const need = ['K', 'DEF', 'QB', 'TE'].find((pos) => !seen.has(pos));
    let avail = need
      ? await call('GET', `/api/leagues/${lid}/draft/available?pos=${need}`, { token: turn.token })
      : { body: { players: [] } };
    if (!avail.body.players.length) avail = await call('GET', `/api/leagues/${lid}/draft/available?pos=ALL`, { token: turn.token });
    const pick = avail.body.players[0];
    seen.add(pick.position);
    positionsSeen.set(turn.teamId, seen);
    const made = await call('POST', `/api/leagues/${lid}/draft/pick`, { token: turn.token, body: { player_id: pick.id } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    picks++;
  }
  assert.equal(picks, 2 * 15, "two coaches make 15 picks each; the CPU teams make the other 30");
  assert.equal((await call('GET', `/api/leagues/${lid}`, { token: alice.token })).body.league.status, 'season');

  // Lineups
  let aliceTeam = await call('GET', `/api/leagues/${lid}/teams/${alice.teamId}`, { token: alice.token });
  assert.equal(aliceTeam.body.roster.length, 15);
  // The auto lineup never leaves a slot open while an eligible bench player is sitting there
  const lineupRows = aliceTeam.body.roster;
  const benchRows = lineupRows.filter((r) => r.slot === BENCH);
  for (const [slot, want] of Object.entries(DEFAULT_ROSTER)) {
    if (slot === BENCH || lineupRows.filter((r) => r.slot === slot).length >= want) continue;
    for (const r of benchRows) {
      assert.ok(!SLOT_ELIGIBLE[slot].includes(r.player.position), `${slot} is open but ${r.player.name} could fill it`);
    }
  }
  assert.ok(lineupRows.some((r) => r.slot === 'K'), 'the kicker starts');
  const kicker = aliceTeam.body.roster.find((r) => r.player.position === 'K');
  const bad = await call('PUT', `/api/leagues/${lid}/teams/${alice.teamId}/lineup`, { token: alice.token, body: { slots: { [kicker.player.id]: 'QB' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /cannot play QB/);
  assert.equal((await call('PUT', `/api/leagues/${lid}/teams/${bob.teamId}/lineup`, { token: alice.token, body: { slots: {} } })).status, 403);
  assert.equal((await call('POST', `/api/leagues/${lid}/teams/${alice.teamId}/auto-lineup`, { token: alice.token })).status, 200);

  // Free agency: a full roster needs a drop
  aliceTeam = await call('GET', `/api/leagues/${lid}/teams/${alice.teamId}`, { token: alice.token });
  const free = await call('GET', `/api/leagues/${lid}/players?status=free&pos=WR&limit=4`, { token: alice.token });
  const [wantA, wantB, wantC] = free.body.players;
  const fullErr = await call('POST', `/api/leagues/${lid}/players/${enc(wantA.id)}/add`, { token: alice.token, body: {} });
  assert.equal(fullErr.status, 400);
  assert.match(fullErr.body.error, /roster is full/);
  const aliceBench = aliceTeam.body.roster.find((r) => r.slot === 'BN');
  const swap = await call('POST', `/api/leagues/${lid}/players/${enc(wantA.id)}/add`, { token: alice.token, body: { drop_player_id: aliceBench.player.id } });
  assert.equal(swap.status, 200, JSON.stringify(swap.body));

  // Waiver claims: placed, then cancelled
  let bobTeam = await call('GET', `/api/leagues/${lid}/teams/${bob.teamId}`, { token: bob.token });
  const bobBench = bobTeam.body.roster.filter((r) => r.slot === 'BN');
  await call('POST', `/api/leagues/${lid}/players/${enc(wantB.id)}/claim`, { token: bob.token, body: { drop_player_id: bobBench[0].player.id } });
  await call('POST', `/api/leagues/${lid}/players/${enc(wantC.id)}/claim`, { token: bob.token, body: { drop_player_id: bobBench[1].player.id } });
  bobTeam = await call('GET', `/api/leagues/${lid}/teams/${bob.teamId}`, { token: bob.token });
  const cancelMe = bobTeam.body.claims.find((c) => c.player.id === wantC.id);
  assert.equal(cancelMe.status, 'pending');
  assert.equal((await call('DELETE', `/api/leagues/${lid}/claims/${cancelMe.id}`, { token: bob.token })).status, 200);

  // Trades: Alice offers a bench player for one of Bob's bench players
  aliceTeam = await call('GET', `/api/leagues/${lid}/teams/${alice.teamId}`, { token: alice.token });
  const giveId = aliceTeam.body.roster.filter((r) => r.slot === 'BN')[1].player.id;
  const getId = bobBench[2].player.id;
  const notMine = await call('POST', `/api/leagues/${lid}/trades`, { token: alice.token, body: { to_team_id: bob.teamId, give: [getId], get: [] } });
  assert.equal(notMine.status, 400);
  const offer = await call('POST', `/api/leagues/${lid}/trades`, { token: alice.token, body: { to_team_id: bob.teamId, give: [giveId], get: [getId] } });
  assert.equal(offer.status, 200, JSON.stringify(offer.body));
  assert.equal((await call('POST', `/api/leagues/${lid}/trades/${offer.body.trade_id}/accept`, { token: alice.token })).status, 403);
  assert.equal((await call('POST', `/api/leagues/${lid}/trades/${offer.body.trade_id}/accept`, { token: bob.token })).status, 200);
  aliceTeam = await call('GET', `/api/leagues/${lid}/teams/${alice.teamId}`, { token: alice.token });
  assert.equal(aliceTeam.body.roster.length, 15, 'a 1-for-1 trade keeps roster sizes');
  assert.ok(aliceTeam.body.roster.some((r) => r.player.id === getId));

  // Chat
  await call('POST', `/api/leagues/${lid}/messages`, { token: alice.token, body: { body: 'Hook em' } });
  const feed = await call('GET', `/api/leagues/${lid}/messages?after=0`, { token: bob.token });
  assert.equal(feed.body.messages.at(-1).body, 'Hook em');
  assert.equal(feed.body.messages.at(-1).mine, false);

  // Player pages: a defense shows one line per completed week
  const defense = aliceTeam.body.roster.find((r) => r.player.position === 'DEF');
  if (defense) {
    const dpage = await call('GET', `/api/players/${enc(defense.player.id)}?league=${lid}`, { token: alice.token });
    assert.equal(dpage.body.games.length, 6, 'weeks 1-6 are final in the demo data');
    assert.equal(dpage.body.owner.id, alice.teamId);
  }

  // Closing the week needs the admin token
  assert.equal((await call('POST', '/api/admin/advance', { token: alice.token })).status, 403);
  assert.equal((await call('POST', '/api/admin/advance', { admin: 'wrong-token-wrong-token' })).status, 403);
  const closed = await call('POST', '/api/admin/advance', { admin: process.env.ADMIN_TOKEN });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.from, 7);
  assert.equal(closed.body.to, 8);

  // The claim Bob placed is processed when the week closes
  bobTeam = await call('GET', `/api/leagues/${lid}/teams/${bob.teamId}`, { token: bob.token });
  assert.equal(bobTeam.body.claims.find((c) => c.player.id === wantB.id).status, 'won');
  assert.ok(bobTeam.body.roster.some((r) => r.player.id === wantB.id));

  const scores = await call('GET', `/api/leagues/${lid}/matchups?week=8`, { token: alice.token });
  assert.equal(scores.body.matchups.length, 2, 'four teams play two games a week');
  const table = await call('GET', `/api/leagues/${lid}/standings`, { token: alice.token });
  assert.equal(table.body.standings.length, 4);

  const log = await call('GET', `/api/leagues/${lid}/activity`, { token: alice.token });
  assert.ok(log.body.activity.some((a) => a.kind === 'trade'));
  assert.ok(log.body.activity.some((a) => a.kind === 'waiver'));
});
