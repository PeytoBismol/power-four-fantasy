#!/usr/bin/env node
'use strict';

// Game-day load test. Starts the real server as its own process on a throwaway database with demo data,
// signs up coaches, puts them in 8-team leagues, drafts every team through the API, then has each coach
// use the app the way a phone does: a background poll of the league every few seconds, plus scores, team,
// chat, free agents and the Home tab's extra requests. Prints how long each request took.
//
//   npm run load                                  80 coaches for 30 seconds, each polling every 8 seconds
//   node scripts/load-test.js --users 200 --seconds 60 --interval 8
//
// The load generator runs on this PC and shares its CPU, so treat the numbers as a floor, not a Fly measurement.
// Nothing here touches your real data: the server uses a temporary database that is deleted at the end.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.join(__dirname, '..');
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const TEAM_COUNT = 8;
const PASSWORD = 'password123';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const opts = { users: 80, seconds: 30, interval: 8 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = (argv[i] || '').replace(/^--/, '');
    if (!(key in opts)) throw new Error(`Unknown option ${argv[i]}. Use --users, --seconds or --interval.`);
    const n = Number(argv[i + 1]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${argv[i]} needs a positive number`);
    opts[key] = n;
  }
  // Coaches fill whole leagues
  opts.users = Math.max(1, Math.round(opts.users / TEAM_COUNT)) * TEAM_COUNT;
  return opts;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function api(base, method, route, token, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const started = performance.now();
  let status = 0;
  let data = {};
  try {
    const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    status = res.status;
    data = await res.json().catch(() => ({}));
  } catch (err) {
    status = 0;
  }
  return { status, data, ms: performance.now() - started };
}

async function mustOk(base, method, route, token, body) {
  const r = await api(base, method, route, token, body);
  if (r.status !== 200) throw new Error(`${method} ${route} returned ${r.status}: ${(r.data && r.data.error) || 'no answer'}`);
  return r.data;
}

// What a phone asks for. Weights add to 1. "home" is the Home tab's four extra requests, sent together.
const ACTIONS = [
  { name: 'league poll', weight: 0.6, run: (c, base) => [api(base, 'GET', `/api/leagues/${c.leagueId}`, c.token)] },
  { name: 'scores', weight: 0.1, run: (c, base) => [api(base, 'GET', `/api/leagues/${c.leagueId}/matchups`, c.token)] },
  { name: 'team', weight: 0.1, run: (c, base) => [api(base, 'GET', `/api/leagues/${c.leagueId}/teams/${c.teamId}`, c.token)] },
  { name: 'chat', weight: 0.1, run: (c, base) => [api(base, 'GET', `/api/leagues/${c.leagueId}/messages?after=0`, c.token)] },
  { name: 'players', weight: 0.05, run: (c, base) => [api(base, 'GET', `/api/leagues/${c.leagueId}/players?status=free&limit=60`, c.token)] },
  {
    name: 'home tab',
    weight: 0.05,
    run: (c, base) => [
      api(base, 'GET', `/api/leagues/${c.leagueId}/standings`, c.token),
      api(base, 'GET', `/api/leagues/${c.leagueId}/activity`, c.token),
      api(base, 'GET', `/api/leagues/${c.leagueId}/trades`, c.token),
      api(base, 'GET', `/api/leagues/${c.leagueId}/rankings`, c.token)
    ]
  }
];

function pickAction(rand) {
  let x = rand();
  for (const a of ACTIONS) {
    x -= a.weight;
    if (x < 0) return a;
  }
  return ACTIONS[0];
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function summarize(rows) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  return {
    count: rows.length,
    errors: rows.filter((r) => r.status !== 200).length,
    p50: percentile(ms, 0.5),
    p95: percentile(ms, 0.95),
    p99: percentile(ms, 0.99),
    max: ms.length ? ms[ms.length - 1] : 0
  };
}

async function startServer(dbFile) {
  const port = await freePort();
  const logs = [];
  const child = spawn(NODE[0], [NODE[1], 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbFile,
      CFBD_API_KEY: '',
      BACKUP_HOURS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch (err) {
      // Not up yet
    }
    if (Date.now() - started > 20000) {
      child.kill();
      throw new Error(`The server did not start. Its output:\n${logs.join('')}`);
    }
    await sleep(100);
  }
  return { base, child, logs };
}

async function stopServer(server) {
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

async function setUp(base, users) {
  const runId = Date.now().toString(36);
  const coaches = [];
  const batch = 8;
  for (let i = 0; i < users; i += batch) {
    const group = [];
    for (let j = i; j < Math.min(users, i + batch); j++) {
      group.push(mustOk(base, 'POST', '/api/auth/signup', undefined, {
        name: `Coach ${j + 1}`,
        email: `coach${j + 1}.${runId}@load.test`,
        password: PASSWORD
      }).then((r) => ({ token: r.token, userId: r.user.id })));
    }
    coaches.push(...await Promise.all(group));
  }

  const leagues = [];
  for (let l = 0; l < users / TEAM_COUNT; l++) {
    const members = coaches.slice(l * TEAM_COUNT, (l + 1) * TEAM_COUNT);
    const commish = members[0];
    const created = await mustOk(base, 'POST', '/api/leagues', commish.token, { name: `Load league ${l + 1}`, team_count: TEAM_COUNT });
    const league = { id: created.league.id, invite: created.league.invite_code, members: [] };
    members[0].leagueId = league.id;
    members[0].teamId = created.league.my_team.id;
    league.members.push(members[0]);
    for (const m of members.slice(1)) {
      const joined = await mustOk(base, 'POST', '/api/leagues/join', m.token, { code: created.league.invite_code });
      m.leagueId = league.id;
      m.teamId = joined.team.id;
      league.members.push(m);
    }
    leagues.push(league);
  }

  // Draft every team through the API, each coach making its own picks
  await Promise.all(leagues.map(async (league) => {
    const commish = league.members[0];
    await mustOk(base, 'POST', `/api/leagues/${league.id}/draft/start`, commish.token, {});
    const byTeam = new Map(league.members.map((m) => [m.teamId, m]));
    for (let guard = 0; guard < 1000; guard++) {
      const { draft } = await mustOk(base, 'GET', `/api/leagues/${league.id}/draft`, commish.token);
      if (draft.status === 'complete') return;
      const coach = byTeam.get(draft.on_clock.id);
      const { players } = await mustOk(base, 'GET', `/api/leagues/${league.id}/draft/available?pos=ALL`, coach.token);
      await mustOk(base, 'POST', `/api/leagues/${league.id}/draft/pick`, coach.token, { player_id: players[0].id });
    }
    throw new Error(`League ${league.id} did not finish its draft`);
  }));
  return coaches;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-load-'));
  const dbFile = path.join(dir, 'load.sqlite');
  let server = null;
  try {
    const t0 = performance.now();
    console.log(`Preparing ${opts.users} coaches in ${opts.users / TEAM_COUNT} leagues on a temporary database...`);
    execFileSync(NODE[0], [NODE[1], 'ingest/ingest.js', '--demo'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: dbFile, CFBD_API_KEY: '' },
      stdio: 'pipe'
    });
    server = await startServer(dbFile);
    const coaches = await setUp(server.base, opts.users);
    const setupSeconds = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`Ready in ${setupSeconds} s. Every coach polls about every ${opts.interval} s for ${opts.seconds} s.`);
    console.log(`Expected load: about ${(opts.users / opts.interval).toFixed(1)} requests per second before the Home tab extras.`);

    const rows = [];
    const endAt = performance.now() + opts.seconds * 1000;
    const loop = async (coach) => {
      await sleep(Math.random() * opts.interval * 1000);
      while (performance.now() < endAt) {
        const started = performance.now();
        const action = pickAction(Math.random);
        const calls = action.run(coach, server.base);
        const results = await Promise.all(calls);
        for (const r of results) rows.push({ name: action.name, status: r.status, ms: r.ms });
        const elapsed = performance.now() - started;
        const wait = Math.max(0, opts.interval * 1000 - elapsed) * (0.8 + Math.random() * 0.4);
        await sleep(wait);
      }
    };
    const runStart = performance.now();
    await Promise.all(coaches.map(loop));
    const seconds = (performance.now() - runStart) / 1000;

    const overall = summarize(rows);
    const fmt = (n) => n.toFixed(1).padStart(8);
    const line = (name, s) => `${name.padEnd(12)}${String(s.count).padStart(9)}${String(s.errors).padStart(8)}${fmt(s.p50)}${fmt(s.p95)}${fmt(s.p99)}${fmt(s.max)}`;
    console.log('');
    console.log(`${'Request'.padEnd(12)}${'Count'.padStart(9)}${'Errors'.padStart(8)}${'p50 ms'.padStart(8)}${'p95 ms'.padStart(8)}${'p99 ms'.padStart(8)}${'max ms'.padStart(8)}`);
    for (const a of ACTIONS) {
      const picked = rows.filter((r) => r.name === a.name);
      if (picked.length) console.log(line(a.name, summarize(picked)));
    }
    console.log(line('All', overall));
    console.log('');
    console.log(`Requests per second: ${(overall.count / seconds).toFixed(1)} over ${seconds.toFixed(0)} s.`);
    const serverErrors = server.logs.join('').split('\n').filter((l) => /Error|error:/.test(l)).length;
    console.log(`Server error lines in its log: ${serverErrors}`);
    const slow = overall.p95 > 500 || overall.errors > 0;
    console.log(slow
      ? 'Result: NOT READY. Look at the slow or failing requests above before a game day.'
      : 'Result: the p95 is under half a second with no errors at this load.');
    if (slow) process.exitCode = 1;
  } finally {
    if (server) await stopServer(server);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.log(`Could not delete ${dir}. Delete it by hand; it is only test data.`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
