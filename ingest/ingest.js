#!/usr/bin/env node
'use strict';

// Pulls teams, rosters, schedules and weekly player stats into the database.
//   node ingest/ingest.js           live data from CollegeFootballData (needs CFBD_API_KEY in .env)
//   node ingest/ingest.js --demo    offline synthetic data in the same shape
//   node ingest/ingest.js --probe   checks the live API and reports stat names the app does not map yet
//   node ingest/ingest.js --live    refreshes only the week in play (games and box scores), for game days
//   Flags: --no-advance (do not close finished weeks automatically)

require('../src/env').loadEnv();

const path = require('path');
const { openDb, tx, getMeta, setMeta } = require('../src/db');
const { SEASON, CFBD_REGULAR_WEEKS, FANTASY_POSITIONS } = require('../src/config');
const { nowIso } = require('../src/util');
const season = require('../src/season');
const flow = require('../src/flow');
const { groupKeyFor } = require('../src/league');
const { createCfbdClient } = require('./cfbd');
const { createDemoSource } = require('./source-demo');
const T = require('./transform');

const POSTSEASON_WEEKS = 4;
const WEEK_PLAN = [
  ...Array.from({ length: CFBD_REGULAR_WEEKS }, (_, i) => ({ seasonType: 'regular', week: i + 1 })),
  ...Array.from({ length: POSTSEASON_WEEKS }, (_, i) => ({ seasonType: 'postseason', week: i + 1 }))
];
const planKey = (p) => `${p.seasonType}:${p.week}`;
const defenseId = (teamId) => `DEF-${teamId}`;

// ---- Writers (each runs inside a transaction) ---------------------------------

function upsertTeams(db, teams) {
  const upTeam = db.prepare(`
    INSERT INTO teams (id, school, mascot, abbreviation, conference, group_key, color, alt_color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET school = excluded.school, mascot = excluded.mascot,
      abbreviation = excluded.abbreviation, conference = excluded.conference, group_key = excluded.group_key,
      color = excluded.color, alt_color = excluded.alt_color
  `);
  const upDefense = db.prepare(`
    INSERT OR IGNORE INTO players (id, first_name, last_name, name, team_id, position, jersey, guessed_position)
    VALUES (?, NULL, NULL, ?, ?, 'DEF', NULL, 0)
  `);
  for (const t of teams) {
    upTeam.run(t.id, t.school, t.mascot ?? null, t.abbreviation ?? null, t.conference, t.group,
      T.normalizeColor(t.color), T.normalizeColor(t.alt_color));
    upDefense.run(defenseId(t.id), `${t.school} Defense`, t.id);
  }
}

function upsertRoster(db, teamId, roster) {
  const up = db.prepare(`
    INSERT INTO players (id, first_name, last_name, name, team_id, position, jersey, guessed_position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name,
      name = excluded.name, team_id = excluded.team_id, position = excluded.position,
      jersey = excluded.jersey, guessed_position = excluded.guessed_position, departed = 0
  `);
  let count = 0;
  for (const r of roster) {
    if (r.id === undefined || r.id === null) continue;
    const mapped = T.normalizePosition(r.position);
    const first = (r.first_name || '').trim();
    const last = (r.last_name || '').trim();
    const name = `${first} ${last}`.trim() || `#${r.jersey ?? r.id}`;
    up.run(String(r.id), first || null, last || null, name, teamId, mapped || 'ATH', r.jersey ?? null, mapped ? 0 : 1);
    count++;
  }
  return count;
}

function upsertGames(db, games, plan) {
  const up = db.prepare(`
    INSERT INTO games (id, season, week, season_type, start_date, completed, home_id, away_id, home_points, away_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET week = excluded.week, season_type = excluded.season_type,
      start_date = excluded.start_date, completed = excluded.completed, home_id = excluded.home_id,
      away_id = excluded.away_id, home_points = excluded.home_points, away_points = excluded.away_points
  `);
  for (const g of games) {
    up.run(Number(g.id), SEASON, plan.week, plan.seasonType, g.start_date ?? null, g.completed ? 1 : 0,
      g.home_id ?? null, g.away_id ?? null, g.home_points ?? null, g.away_points ?? null);
  }
}

// Replaces one CFBD week's player and defense lines. Safe to run again when the data changes.
function writeWeek(db, plan, games, boxScores, teamIdOf) {
  const { seasonType, week } = plan;
  db.prepare('DELETE FROM player_games WHERE season = ? AND season_type = ? AND week = ?').run(SEASON, seasonType, week);
  db.prepare('DELETE FROM defense_games WHERE season = ? AND season_type = ? AND week = ?').run(SEASON, seasonType, week);

  const gameById = new Map(games.map((g) => [Number(g.id), g]));
  const ours = new Set(teamIdOf.values());
  const insPlayer = db.prepare(`
    INSERT OR REPLACE INTO player_games (game_id, player_id, team_id, season, season_type, week,
      pass_att, pass_cmp, pass_yd, pass_td, pass_int, rush_att, rush_yd, rush_td,
      rec, rec_yd, rec_td, fum_lost, fgm, fga, xpm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insDefense = db.prepare(`
    INSERT OR REPLACE INTO defense_games (game_id, team_id, season, season_type, week, points_allowed, sacks, def_int, def_td)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const knownPlayer = db.prepare('SELECT 1 FROM players WHERE id = ?');
  const newPlayer = db.prepare(`
    INSERT INTO players (id, first_name, last_name, name, team_id, position, jersey, guessed_position)
    VALUES (?, NULL, NULL, ?, ?, 'ATH', NULL, 1)
  `);

  // Points allowed are the opponent's points from the schedule, so the defense is scored even without a box score
  const allowed = (game, teamId) => {
    if (!game) return null;
    return teamId === game.home_id ? game.away_points ?? null : game.home_points ?? null;
  };

  const seen = new Set();
  for (const box of boxScores) {
    const gameId = Number(box.id);
    const game = gameById.get(gameId);
    for (const side of box.teams || []) {
      const teamId = teamIdOf.get(side.school);
      if (teamId === undefined) continue;
      const { athletes, defense } = T.parseSide(side);
      for (const a of athletes) {
        if (!T.hasStats(a.stats)) continue;
        if (!knownPlayer.get(a.id)) newPlayer.run(a.id, a.name, teamId);
        const s = a.stats;
        insPlayer.run(gameId, a.id, teamId, SEASON, seasonType, week,
          s.pass_att, s.pass_cmp, s.pass_yd, s.pass_td, s.pass_int,
          s.rush_att, s.rush_yd, s.rush_td,
          s.rec, s.rec_yd, s.rec_td, s.fum_lost, s.fgm, s.fga, s.xpm);
      }
      insDefense.run(gameId, teamId, SEASON, seasonType, week, allowed(game, teamId),
        defense.sacks, defense.def_int, defense.def_td);
      seen.add(`${gameId}:${teamId}`);
    }
  }
  for (const g of games) {
    if (!g.completed) continue;
    for (const teamId of [g.home_id, g.away_id]) {
      if (!ours.has(teamId) || seen.has(`${g.id}:${teamId}`)) continue;
      insDefense.run(Number(g.id), teamId, SEASON, seasonType, week, allowed(g, teamId), 0, 0, 0);
    }
  }
}

// Keeps fantasy rosters in step with CFBD rosters after a full roster pass.
//  - A player who moved to another Power Four school is logged as a transfer. He stays on his fantasy team.
//  - A player missing from his school's roster has left the Power Four: he is marked departed, dropped from
//    every fantasy roster (each drop is logged), and kept out of the pool. His stats stay in the database.
// A school whose roster came back empty is not trusted, so its players are left alone.
function reconcileRosters(db, { before, seen, rosterCounts, schools }) {
  const week = season.currentWeek(db);
  const now = nowIso();
  const logTx = db.prepare('INSERT INTO transactions (league_id, week, kind, team_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const ownersOf = db.prepare(`
    SELECT r.team_id, ft.league_id FROM roster r JOIN fantasy_teams ft ON ft.id = r.team_id WHERE r.player_id = ?
  `);
  const playerName = (id) => (db.prepare('SELECT name FROM players WHERE id = ?').get(id) || { name: id }).name;
  const schoolName = (id) => schools.get(id) || String(id);
  let transfers = 0;
  let departures = 0;
  for (const [id, fromSchool] of before) {
    const toSchool = seen.get(id);
    if (toSchool === undefined) {
      if (!rosterCounts.get(fromSchool)) continue;
      const name = playerName(id);
      for (const o of ownersOf.all(id)) {
        logTx.run(o.league_id, week, 'departed', o.team_id, JSON.stringify({
          player: name, player_id: id, school: schoolName(fromSchool), reason: 'Left the Power Four'
        }), now);
      }
      db.prepare('DELETE FROM roster WHERE player_id = ?').run(id);
      db.prepare('UPDATE players SET departed = 1 WHERE id = ?').run(id);
      departures++;
    } else if (toSchool !== fromSchool) {
      const name = playerName(id);
      for (const o of ownersOf.all(id)) {
        logTx.run(o.league_id, week, 'transfer', o.team_id, JSON.stringify({
          player: name, player_id: id, from: schoolName(fromSchool), to: schoolName(toSchool)
        }), now);
      }
      transfers++;
    }
  }
  return { transfers, departures };
}

// Players with a guessed position take the position their stats point to
function reinferPositions(db) {
  const rows = db.prepare(`
    SELECT player_id, SUM(pass_att) AS pass_att, SUM(rush_att) AS rush_att, SUM(rec) AS rec,
      SUM(fga) AS fga, SUM(xpm) AS xpm
    FROM player_games WHERE season = ? GROUP BY player_id
  `).all(SEASON);
  const up = db.prepare('UPDATE players SET position = ? WHERE id = ? AND guessed_position = 1');
  let changed = 0;
  for (const r of rows) {
    const pos = T.inferPosition(r);
    if (pos) changed += up.run(pos, r.player_id).changes;
  }
  return changed;
}

// Highest league week N where weeks 1..N are fully completed
function lastCompletedWeek(db) {
  const rows = db.prepare(`
    SELECT season_type, week, COUNT(*) AS total, SUM(completed) AS done
    FROM games WHERE season = ? GROUP BY season_type, week
  `).all(SEASON);
  const done = new Set(rows.filter((r) => r.total > 0 && r.done === r.total).map((r) => T.leagueWeekOf(r.season_type, r.week)));
  let w = 0;
  while (done.has(w + 1)) w++;
  return w;
}

// Brings the season clock up to the first week that is not finished yet
function syncSeasonClock(db, target, { autoAdvance, log }) {
  const existing = db.prepare('SELECT current_week FROM season_state WHERE season = ?').get(SEASON);
  if (!autoAdvance) {
    if (!existing) tx(db, () => season.setCurrentWeek(db, SEASON, target));
    else if (existing.current_week < target) {
      log(`  Week ${existing.current_week} is finished in the data. Run \`npm run advance\` to close it.`);
    }
    return;
  }
  let week = season.currentWeek(db);
  if (!existing) tx(db, () => season.setCurrentWeek(db, SEASON, week));
  while (week < target) {
    const r = tx(db, () => flow.advanceWeek(db, SEASON));
    log(`  Closed week ${r.from}; the season is now on week ${r.to}.`);
    week = r.to;
  }
}

// ---- Ingest -------------------------------------------------------------------

async function ingestAll({ db, source, autoAdvance = true, log = console.log }) {
  log('Teams');
  const fbs = await source.teamsFbs(SEASON);
  const teams = fbs.map((t) => ({ ...t, group: groupKeyFor(t.conference, t.school) })).filter((t) => t.group);
  tx(db, () => upsertTeams(db, teams));
  const teamIdOf = new Map(teams.map((t) => [t.school, Number(t.id)]));
  log(`  ${teams.length} Power Four teams, Notre Dame included. ${fbs.length - teams.length} other FBS teams are skipped.`);

  log('Rosters');
  // Who was on which school before this pass, so moves and departures can be seen afterwards
  const pool = FANTASY_POSITIONS.filter((p) => p !== 'DEF');
  const before = new Map(db.prepare(`
    SELECT id, team_id FROM players WHERE departed = 0 AND position IN (${pool.map(() => '?').join(',')})
  `).all(...pool).map((r) => [r.id, r.team_id]));
  const schools = new Map(teams.map((t) => [Number(t.id), t.school]));
  const seen = new Map();
  const rosterCounts = new Map();
  let players = 0;
  for (const t of teams) {
    const roster = await source.roster(t.school, SEASON);
    tx(db, () => { players += upsertRoster(db, Number(t.id), roster); });
    rosterCounts.set(Number(t.id), roster.length);
    for (const r of roster) if (r.id !== undefined && r.id !== null) seen.set(String(r.id), Number(t.id));
  }
  log(`  ${players} roster players`);
  const moves = tx(db, () => reconcileRosters(db, { before, seen, rosterCounts, schools }));
  if (moves.transfers || moves.departures) {
    log(`  ${moves.transfers} transfers between Power Four schools, ${moves.departures} players no longer on a Power Four roster`);
  }

  log('Schedules and scores');
  const gamesByWeek = new Map();
  for (const plan of WEEK_PLAN) {
    const rows = await source.games(SEASON, plan.seasonType, plan.week);
    gamesByWeek.set(planKey(plan), rows);
    if (rows.length) tx(db, () => upsertGames(db, rows, plan));
  }
  const totalGames = [...gamesByWeek.values()].reduce((a, rows) => a + rows.length, 0);
  log(`  ${totalGames} games`);

  log('Weekly player stats');
  let weeks = 0;
  for (const plan of WEEK_PLAN) {
    const rows = gamesByWeek.get(planKey(plan)) || [];
    if (!rows.some((g) => g.completed)) continue;
    const boxScores = await source.gamePlayers(SEASON, plan.seasonType, plan.week);
    tx(db, () => writeWeek(db, plan, rows, boxScores, teamIdOf));
    weeks++;
    log(`  ${plan.seasonType} week ${plan.week}: ${boxScores.length} games`);
  }
  if (!weeks) log('  No completed games yet.');
  const moved = tx(db, () => reinferPositions(db));
  if (moved) log(`  ${moved} players placed by their stats (roster code unknown)`);

  const currentWeek = completeIngest(db, { autoAdvance, log, dataSource: source.kind || 'cfbd' });
  return { teams: teams.length, weeks, currentWeek };
}

// Closes finished weeks (when allowed) and records when the data was pulled. The app shows that time as "scores updated".
function completeIngest(db, { autoAdvance, log, dataSource }) {
  season.clearCache();
  const target = lastCompletedWeek(db) + 1;
  syncSeasonClock(db, target, { autoAdvance, log });
  tx(db, () => {
    setMeta(db, 'data_source', dataSource);
    setMeta(db, 'last_ingest_at', nowIso());
  });
  season.clearCache();
  return season.currentWeek(db);
}

// Pulls only the week in play: its games (kickoffs and scores) and its box scores. That is two CFBD calls,
// so it can run every few minutes while games are on without using up the full refresh's quota.
async function refreshLiveWeek({ db, source, autoAdvance = true, log = console.log }) {
  const week = season.currentWeek(db);
  const ref = season.weekRef(week);
  const plan = { seasonType: ref.seasonType, week: ref.week };
  const teamIdOf = new Map(db.prepare('SELECT id, school FROM teams').all().map((t) => [t.school, Number(t.id)]));
  const games = await source.games(SEASON, plan.seasonType, plan.week);
  const boxScores = await source.gamePlayers(SEASON, plan.seasonType, plan.week);
  tx(db, () => {
    if (games.length) upsertGames(db, games, plan);
    writeWeek(db, plan, games, boxScores, teamIdOf);
  });
  const currentWeek = completeIngest(db, { autoAdvance, log, dataSource: source.kind || 'cfbd' });
  return { week, games: games.length, inProgress: season.liveGames(db, SEASON, week).inProgress, currentWeek };
}

// ---- Probe --------------------------------------------------------------------

const REQUIRED = [
  'passing/C/ATT', 'passing/YDS', 'passing/TD', 'passing/INT',
  'rushing/CAR', 'rushing/YDS', 'rushing/TD',
  'receiving/REC', 'receiving/YDS', 'receiving/TD',
  'kicking/FG', 'kicking/XP',
  'defensive/SACKS', 'interceptions/INT'
];

async function probe(source, log) {
  log('Checking CollegeFootballData');
  const fbs = await source.teamsFbs(SEASON);
  const tracked = fbs.filter((t) => groupKeyFor(t.conference, t.school));
  log(`  teams: ${fbs.length} FBS teams, ${tracked.length} in the Power Four group (Notre Dame included)`);
  const rosterIds = new Set();
  const positions = new Set();
  for (const t of tracked) {
    const roster = await source.roster(t.school, SEASON);
    roster.forEach((p) => { rosterIds.add(String(p.id)); positions.add(p.position); });
  }
  log(`  rosters: ${rosterIds.size} players. Position codes: ${[...positions].sort().join(', ')}`);

  let found = null;
  for (let week = CFBD_REGULAR_WEEKS; week >= 1 && !found; week--) {
    const games = await source.games(SEASON, 'regular', week);
    if (games.some((g) => g.completed)) found = { week, games };
  }
  if (!found) {
    log('  No completed regular-season games yet, so box scores cannot be checked. Try again after week 1.');
    return;
  }
  const boxes = await source.gamePlayers(SEASON, 'regular', found.week);
  log(`  box scores for week ${found.week}: ${boxes.length} games`);

  const counts = new Map();
  const seenAthletes = new Set();
  const unknownSchools = new Set();
  const schoolNames = new Set(tracked.map((t) => t.school));
  for (const box of boxes) {
    for (const side of box.teams || []) {
      if (!schoolNames.has(side.school) && (side.categories || []).length) unknownSchools.add(side.school);
      for (const cat of side.categories || []) {
        for (const type of cat.types || []) {
          const key = `${cat.name}/${type.name}`;
          counts.set(key, (counts.get(key) || 0) + (type.athletes || []).length);
          for (const a of type.athletes || []) seenAthletes.add(String(a.id));
        }
      }
    }
  }
  const mapped = (key) => {
    const [cat, ...rest] = key.split('/');
    const type = rest.join('/');
    return Object.hasOwn(T.PLAYER_STATS[cat] || {}, type) || Object.hasOwn(T.TEAM_DEFENSE_STATS[cat] || {}, type);
  };
  log('  stat types in box scores (athletes listed):');
  for (const [key, n] of [...counts].sort()) {
    log(`    ${key.padEnd(28)} ${String(n).padStart(5)}  ${mapped(key) ? 'used' : 'ignored'}`);
  }
  const missing = REQUIRED.filter((k) => !counts.has(k));
  log(missing.length
    ? `  MISSING required stat types: ${missing.join(', ')}. Scoring for those will read zero. Check the names above.`
    : '  All required stat types are present.');
  const matched = [...seenAthletes].filter((id) => rosterIds.has(id)).length;
  log(`  athletes matched to rosters: ${matched} of ${seenAthletes.size}`);
  if (unknownSchools.size) log(`  schools in box scores not in the group: ${[...unknownSchools].join(', ')}`);
}

// ---- Command line -------------------------------------------------------------

async function run(argv) {
  const flags = new Set(argv);
  const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'power-four.sqlite');
  const log = console.log;
  const autoAdvance = !flags.has('--no-advance') && process.env.AUTO_ADVANCE !== '0';

  if (flags.has('--probe')) {
    await probe(createCfbdClient({ log }), log);
    return;
  }
  if (flags.has('--live')) {
    const source = createCfbdClient({ log });
    const db = openDb(dbFile);
    try {
      log('Refreshing the week in play from CollegeFootballData');
      const r = await refreshLiveWeek({ db, source, autoAdvance, log });
      log(`Done. Week ${r.week}: ${r.games} games, ${r.inProgress} in progress. Season on week ${r.currentWeek}.`);
      log(`CFBD requests made: ${source.requests()}`);
    } finally {
      db.close();
    }
    return;
  }
  const demo = flags.has('--demo');
  const source = demo ? Object.assign(createDemoSource({ year: SEASON }), { kind: 'demo' }) : createCfbdClient({ log });
  const db = openDb(dbFile);
  try {
    if (demo && getMeta(db, 'data_source') === 'cfbd') {
      throw new Error('This database holds live CFBD data. Point DB_PATH at a different file for the demo.');
    }
    log(demo ? 'Loading demo data (offline, synthetic)' : 'Loading live data from CollegeFootballData');
    const result = await ingestAll({ db, source, autoAdvance, log });
    log(`Done. ${result.teams} teams, ${result.weeks} weeks of stats, season on week ${result.currentWeek}.`);
    if (!demo) log(`CFBD requests made: ${source.requests()}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { ingestAll, refreshLiveWeek, lastCompletedWeek, reconcileRosters };
