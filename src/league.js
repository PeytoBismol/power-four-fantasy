'use strict';

// League rules: membership, rosters, lineups and lineup locks, free agency, waivers (priority or FAAB), trades.
// Every exported mutator runs inside a single transaction (see api.js).

const {
  SEASON, SLOTS, BENCH, SLOT_ELIGIBLE, FANTASY_POSITIONS, GROUPS, DEFAULT_SETTINGS
} = require('./config');
const { ApiError, requireString, inviteCode, nowIso, round1 } = require('./util');
const season = require('./season');

const LINEUP_FILL_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'WRT'];
const FORMATS = ['h2h', 'points'];
const WAIVER_MODES = ['priority', 'faab'];

// Leagues saved before a setting existed read its default
function parseLeague(row) {
  const stored = JSON.parse(row.settings);
  const settings = {
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    ...stored,
    roster: { ...DEFAULT_SETTINGS.roster, ...(stored.roster || {}) },
    scoring: { ...DEFAULT_SETTINGS.scoring, ...(stored.scoring || {}) }
  };
  return { ...row, settings };
}

function getLeague(db, id) {
  const row = db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'League not found');
  return parseLeague(row);
}

function capacity(league) {
  return Object.values(league.settings.roster).reduce((a, b) => a + b, 0);
}

function groupKeyFor(conference, school) {
  const g = GROUPS.find((x) => (x.school ? x.school === school : x.conference === conference));
  return g ? g.key : null;
}

// Fantasy team rows for a league, in creation order
function teamsOf(db, leagueId) {
  return db.prepare('SELECT * FROM fantasy_teams WHERE league_id = ? ORDER BY id').all(leagueId);
}

function teamOf(db, league, teamId) {
  const t = db.prepare('SELECT * FROM fantasy_teams WHERE id = ? AND league_id = ?').get(teamId, league.id);
  if (!t) throw new ApiError(404, 'Team not found in this league');
  return t;
}

function myTeamOf(db, league, userId) {
  return db.prepare('SELECT * FROM fantasy_teams WHERE league_id = ? AND user_id = ?').get(league.id, userId) || null;
}

function requireMember(db, league, userId) {
  const team = myTeamOf(db, league, userId);
  if (!team) throw new ApiError(403, 'You are not a member of this league');
  return team;
}

function requireCommissioner(league, user) {
  if (league.commissioner_id !== user.id) throw new ApiError(403, 'Only the commissioner can do that');
}

function logTx(db, league, kind, teamId, detail) {
  db.prepare('INSERT INTO transactions (league_id, week, kind, team_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(league.id, season.currentWeek(db, league.season), kind, teamId ?? null, JSON.stringify(detail), nowIso());
}

// Player with its school, for display and validation
function playerRow(db, id) {
  return db.prepare(`
    SELECT p.id, p.name, p.position, p.team_id, p.jersey, p.departed,
      t.school, t.abbreviation, t.conference, t.group_key, t.color, t.alt_color,
      ps.status AS injury, ps.note AS injury_note
    FROM players p JOIN teams t ON t.id = p.team_id
    LEFT JOIN player_status ps ON ps.player_id = p.id
    WHERE p.id = ?
  `).get(id) || null;
}

// Injury notes are set by hand, so a card carries the note and nothing more
function injuryOf(row) {
  return row.injury ? { status: row.injury, note: row.injury_note || null } : null;
}

function playerCard(p) {
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    jersey: p.jersey,
    injury: injuryOf(p),
    team: {
      id: p.team_id,
      school: p.school,
      abbreviation: p.abbreviation,
      conference: p.conference,
      group: p.group_key,
      color: p.color,
      alt_color: p.alt_color
    }
  };
}

// player_id -> fantasy team_id for every rostered player in the league
function ownerMap(db, leagueId) {
  const rows = db.prepare(`
    SELECT r.player_id, r.team_id FROM roster r
    JOIN fantasy_teams ft ON ft.id = r.team_id WHERE ft.league_id = ?
  `).all(leagueId);
  return new Map(rows.map((r) => [r.player_id, r.team_id]));
}

function rosterRows(db, teamId) {
  return db.prepare(`
    SELECT r.player_id, r.slot, p.name, p.position, p.jersey, p.team_id, t.school, t.abbreviation,
      t.conference, t.group_key, t.color, t.alt_color, ps.status AS injury, ps.note AS injury_note
    FROM roster r
    JOIN players p ON p.id = r.player_id
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN player_status ps ON ps.player_id = p.id
    WHERE r.team_id = ?
    ORDER BY p.position, p.name
  `).all(teamId);
}

function rosterCount(db, teamId) {
  return db.prepare('SELECT COUNT(*) AS n FROM roster WHERE team_id = ?').get(teamId).n;
}

function rosterHas(db, teamId, playerId) {
  return !!db.prepare('SELECT 1 FROM roster WHERE team_id = ? AND player_id = ?').get(teamId, playerId);
}

// ---- Kickoffs and lineup locks --------------------------------------------

// school id -> kickoff info for one league week. A school with no game that week (a bye) is not in the map.
function kickoffsForWeek(db, seasonYear, week) {
  const ref = season.weekRef(week);
  const rows = db.prepare(`
    SELECT home_id, away_id, start_date, completed FROM games
    WHERE season = ? AND season_type = ? AND week = ?
  `).all(seasonYear, ref.seasonType, ref.week);
  const out = new Map();
  for (const g of rows) {
    for (const schoolId of [g.home_id, g.away_id]) {
      if (schoolId !== null && schoolId !== undefined) out.set(schoolId, { start: g.start_date, completed: !!g.completed });
    }
  }
  return out;
}

// A player is locked from his school's kickoff until the game is final. Unknown kickoff times do not lock.
function hasKickedOff(info, now = Date.now()) {
  if (!info) return false;
  if (info.completed) return true;
  return !!info.start && Date.parse(info.start) <= now;
}

// Player ids on this roster whose game has started in the given week
function lockedPlayerIds(db, league, week, roster) {
  const kick = kickoffsForWeek(db, league.season, week);
  const locked = new Set();
  for (const r of roster) if (hasKickedOff(kick.get(r.team_id))) locked.add(r.player_id);
  return locked;
}

// Blocks a roster move for a player whose game has already started this week
function requireUnlocked(db, league, playerId) {
  const p = playerRow(db, playerId);
  if (!p) return;
  const kick = kickoffsForWeek(db, league.season, season.currentWeek(db, league.season));
  if (hasKickedOff(kick.get(p.team_id))) {
    throw new ApiError(400, `${p.name}'s game has started, so that player is locked until it ends`);
  }
}

// ---- Creating and joining -------------------------------------------------

// Validates settings input on top of a base (defaults when creating, current settings when editing)
function normalizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const s = JSON.parse(JSON.stringify(base));
  if (input.team_count !== undefined) {
    const n = Number(input.team_count);
    if (!Number.isInteger(n) || n < 4 || n > 16) throw new ApiError(400, 'Teams must be between 4 and 16');
    s.team_count = n;
  }
  if (input.regular_weeks !== undefined) {
    const n = Number(input.regular_weeks);
    if (!Number.isInteger(n) || n < 8 || n > 16) throw new ApiError(400, 'Regular season must be 8 to 16 weeks');
    s.regular_weeks = n;
  }
  if (input.playoff_teams !== undefined) {
    const n = Number(input.playoff_teams);
    if (![0, 4].includes(n)) throw new ApiError(400, 'Playoffs are 0 (none) or 4 teams');
    s.playoff_teams = n;
  }
  if (input.pick_seconds !== undefined) {
    const n = Number(input.pick_seconds);
    if (!Number.isInteger(n) || n < 30 || n > 600) throw new ApiError(400, 'Pick timer must be 30 to 600 seconds');
    s.pick_seconds = n;
  }
  if (input.format !== undefined) {
    if (!FORMATS.includes(input.format)) throw new ApiError(400, 'Format must be head-to-head or points');
    s.format = input.format;
  }
  if (input.best_ball !== undefined) s.best_ball = !!input.best_ball;
  if (input.waiver_mode !== undefined) {
    if (!WAIVER_MODES.includes(input.waiver_mode)) throw new ApiError(400, 'Waivers are priority or FAAB');
    s.waiver_mode = input.waiver_mode;
  }
  if (input.faab_budget !== undefined) {
    const n = Number(input.faab_budget);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new ApiError(400, 'FAAB budget must be a whole number from 0 to 1000');
    s.faab_budget = n;
  }
  if (input.trade_deadline_week !== undefined) {
    const n = Number(input.trade_deadline_week);
    if (!Number.isInteger(n) || n < 0 || n > 16) throw new ApiError(400, 'Trade deadline must be a week number, or 0 for no deadline');
    s.trade_deadline_week = n;
  }
  if (input.scoring && typeof input.scoring === 'object') {
    for (const [k, v] of Object.entries(input.scoring)) {
      if (!(k in s.scoring)) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > 50) throw new ApiError(400, `Scoring value ${k} is out of range`);
      s.scoring[k] = n;
    }
  }
  // Points leagues have no playoffs: standings decide the champion
  if (s.format === 'points') s.playoff_teams = 0;
  return s;
}

function createLeague(db, user, input) {
  const name = requireString(input.name, 'League name', { max: 60 });
  const settings = normalizeSettings(input);
  const code = inviteCode();
  const created = nowIso();
  const info = db.prepare(`
    INSERT INTO leagues (name, season, invite_code, commissioner_id, settings, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'predraft', ?)
  `).run(name, SEASON, code, user.id, JSON.stringify(settings), created);
  const leagueId = Number(info.lastInsertRowid);
  const ownName = `${user.name.split(' ')[0]}'s team`;
  const faab = settings.waiver_mode === 'faab' ? settings.faab_budget : 0;
  for (let i = 1; i <= settings.team_count; i++) {
    if (i === 1) {
      db.prepare('INSERT INTO fantasy_teams (league_id, user_id, name, is_cpu, waiver_priority, faab, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run(leagueId, user.id, ownName, i, faab, created);
    } else {
      db.prepare('INSERT INTO fantasy_teams (league_id, user_id, name, is_cpu, waiver_priority, faab, created_at) VALUES (?, NULL, ?, 1, ?, ?, ?)')
        .run(leagueId, `CPU ${i - 1}`, i, faab, created);
    }
  }
  db.prepare("INSERT INTO drafts (league_id, status, current_pick, total_picks) VALUES (?, 'pending', 1, 0)").run(leagueId);
  return getLeague(db, leagueId);
}

function joinLeague(db, user, code) {
  const clean = String(code || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM leagues WHERE invite_code = ?').get(clean);
  if (!row) throw new ApiError(404, 'No league uses that invite code');
  const league = parseLeague(row);
  const existing = myTeamOf(db, league, user.id);
  if (existing) return { league, team: existing, joined: false };
  if (league.status === 'drafting') throw new ApiError(400, 'The draft is live, so nobody can join right now');
  if (league.status === 'complete') throw new ApiError(400, 'This league has finished its season');
  // Before the draft, any team without a member is open. After it, only a team a commissioner released is,
  // and the newcomer takes that team with its roster as it stands.
  const open = league.status === 'predraft'
    ? db.prepare('SELECT * FROM fantasy_teams WHERE league_id = ? AND is_cpu = 1 ORDER BY id LIMIT 1').get(league.id)
    : db.prepare('SELECT * FROM fantasy_teams WHERE league_id = ? AND is_cpu = 1 AND vacated = 1 ORDER BY id LIMIT 1').get(league.id);
  if (!open) {
    throw new ApiError(400, league.status === 'predraft'
      ? 'This league is full'
      : 'This league is full and has started. Ask the commissioner to free a team.');
  }
  db.prepare('UPDATE fantasy_teams SET user_id = ?, is_cpu = 0, vacated = 0, name = ? WHERE id = ?')
    .run(user.id, `${user.name.split(' ')[0]}'s team`, open.id);
  logTx(db, league, 'join', open.id, { user: user.name });
  return { league, team: teamOf(db, league, open.id), joined: true };
}

// Commissioner removes a member. The team goes to a CPU, the member's open trades and claims close,
// and the seat can be joined again with the invite code. The commissioner cannot remove their own team.
function releaseMember(db, league, commissioner, team) {
  requireCommissioner(league, commissioner);
  if (league.status === 'complete') throw new ApiError(400, 'This season is over, so members cannot be removed');
  if (!team.user_id || team.is_cpu) throw new ApiError(400, 'That team has no member to remove');
  if (team.user_id === commissioner.id) throw new ApiError(400, 'You cannot remove yourself. Your own team stays with you.');
  const member = db.prepare('SELECT name FROM users WHERE id = ?').get(team.user_id);
  const position = teamsOf(db, league.id).findIndex((t) => t.id === team.id) + 1;
  db.prepare('UPDATE fantasy_teams SET user_id = NULL, is_cpu = 1, vacated = 1, name = ? WHERE id = ?')
    .run(`CPU ${position - 1}`, team.id);
  db.prepare(`
    UPDATE trades SET status = 'cancelled', updated_at = ?
    WHERE league_id = ? AND status = 'pending' AND (from_team_id = ? OR to_team_id = ?)
  `).run(nowIso(), league.id, team.id, team.id);
  db.prepare("UPDATE waiver_claims SET status = 'cancelled', note = 'The team was handed to a CPU' WHERE team_id = ? AND status = 'pending'").run(team.id);
  db.prepare('DELETE FROM draft_queue WHERE team_id = ?').run(team.id);
  logTx(db, league, 'released', team.id, {
    team: team.name,
    member: member ? member.name : 'Member',
    by: commissioner.name
  });
  // The CPU keeps the team playing: set its lineup for the live week now, and any draft pick it owes runs next
  if (league.status === 'season') {
    autoLineup(db, league, teamOf(db, league, team.id), season.currentWeek(db, league.season));
  }
}

function renameTeam(db, league, team, user, name) {
  if (team.user_id !== user.id) throw new ApiError(403, 'You can only rename your own team');
  const clean = requireString(name, 'Team name', { max: 40 });
  db.prepare('UPDATE fantasy_teams SET name = ? WHERE id = ?').run(clean, team.id);
}

function updateSettings(db, league, user, input) {
  requireCommissioner(league, user);
  if (league.status !== 'predraft') throw new ApiError(400, 'Settings lock once the draft starts');
  // Team count is fixed once the league exists, so it is not editable here
  const merged = normalizeSettings({ ...input, team_count: league.settings.team_count }, league.settings);
  if (input.name !== undefined) {
    const name = requireString(input.name, 'League name', { max: 60 });
    db.prepare('UPDATE leagues SET name = ? WHERE id = ?').run(name, league.id);
  }
  db.prepare('UPDATE leagues SET settings = ? WHERE id = ?').run(JSON.stringify(merged), league.id);
  // Switching to FAAB funds every team; switching back clears the balances
  const faab = merged.waiver_mode === 'faab' ? merged.faab_budget : 0;
  db.prepare('UPDATE fantasy_teams SET faab = ? WHERE league_id = ?').run(faab, league.id);
  return getLeague(db, league.id);
}

// ---- Lineups ---------------------------------------------------------------

// assignments: { playerId: slot }. Players not named go to the bench. Locked players keep their slot.
function setLineup(db, league, team, assignments) {
  if (league.settings.best_ball) throw new ApiError(400, 'Best ball leagues set your lineup automatically');
  const roster = rosterRows(db, team.id);
  const byId = new Map(roster.map((r) => [r.player_id, r]));
  for (const pid of Object.keys(assignments || {})) {
    if (!byId.has(pid)) throw new ApiError(400, 'That player is not on this roster');
  }
  const locked = lockedPlayerIds(db, league, season.currentWeek(db, league.season), roster);
  const used = {};
  const next = new Map();
  for (const r of roster) {
    // A locked player keeps his slot even when the request leaves him out
    const fallback = locked.has(r.player_id) ? r.slot : BENCH;
    const slot = (assignments && assignments[r.player_id]) || fallback;
    if (slot !== BENCH && !SLOTS.includes(slot)) throw new ApiError(400, `Unknown lineup slot ${slot}`);
    if (locked.has(r.player_id) && slot !== r.slot) {
      throw new ApiError(400, `${r.name}'s game has started, so that player's slot is locked`);
    }
    if (slot !== BENCH) {
      if (!SLOT_ELIGIBLE[slot].includes(r.position)) throw new ApiError(400, `${r.name} cannot play ${slot}`);
      used[slot] = (used[slot] || 0) + 1;
      if (used[slot] > league.settings.roster[slot]) throw new ApiError(400, `Too many players in the ${slot} slot`);
    }
    next.set(r.player_id, slot);
  }
  const update = db.prepare('UPDATE roster SET slot = ? WHERE team_id = ? AND player_id = ?');
  for (const [pid, slot] of next) update.run(slot, team.id, pid);
}

// Greedy best-projection lineup: fills QB, RB, WR, TE, K, DEF, then WRT from what is left.
// Players whose game has started keep their slot, unless ignoreLocks is set (used for a league's first lineup at draft end).
function autoLineup(db, league, team, week, { ignoreLocks = false } = {}) {
  const roster = rosterRows(db, team.id);
  const proj = season.projectionMap(db, league.season, league.settings, week);
  const locked = ignoreLocks ? new Set() : lockedPlayerIds(db, league, week, roster);
  const assign = new Map();
  const filled = {};
  for (const r of roster) {
    if (!locked.has(r.player_id)) continue;
    assign.set(r.player_id, r.slot);
    if (r.slot !== BENCH) filled[r.slot] = (filled[r.slot] || 0) + 1;
  }
  const pool = roster
    .filter((r) => !locked.has(r.player_id))
    .sort((a, b) => (proj.get(b.player_id) || 0) - (proj.get(a.player_id) || 0));
  const used = new Set(locked);
  for (const slot of LINEUP_FILL_ORDER) {
    const open = league.settings.roster[slot] - (filled[slot] || 0);
    for (let i = 0; i < open; i++) {
      const pick = pool.find((r) => !used.has(r.player_id) && SLOT_ELIGIBLE[slot].includes(r.position));
      if (!pick) break;
      used.add(pick.player_id);
      assign.set(pick.player_id, slot);
    }
  }
  const update = db.prepare('UPDATE roster SET slot = ? WHERE team_id = ? AND player_id = ?');
  for (const r of roster) update.run(assign.get(r.player_id) || BENCH, team.id, r.player_id);
}

// Best ball leagues keep every lineup on the best setting for the live week
function refreshBestBall(db, league) {
  if (!league.settings.best_ball || league.status !== 'season') return;
  const week = season.currentWeek(db, league.season);
  for (const team of teamsOf(db, league.id)) autoLineup(db, league, team, week);
}

// Injuries that should stop a starter from playing. Questionable players stay quiet.
const OUT_STATUSES = new Set(['Doubtful', 'Out', 'Injured reserve']);

// Things to fix before the week starts: starters listed out, empty starting slots, and bench players who project above a starter
function lineupWarnings(db, league, team, week) {
  const roster = rosterRows(db, team.id);
  const proj = season.projectionMap(db, league.season, league.settings, week);
  const p = (r) => proj.get(r.player_id) || 0;
  const warnings = [];
  for (const r of roster) {
    if (r.slot === BENCH || !OUT_STATUSES.has(r.injury)) continue;
    warnings.push({ kind: 'injured', slot: r.slot, message: `${r.name} is listed ${r.injury} and is in your ${r.slot} slot.` });
  }
  for (const slot of SLOTS) {
    const need = league.settings.roster[slot] || 0;
    const starters = roster.filter((r) => r.slot === slot);
    const bench = roster.filter((r) => r.slot === BENCH && SLOT_ELIGIBLE[slot].includes(r.position));
    if (starters.length < need) {
      if (bench.length) {
        const best = [...bench].sort((a, b) => p(b) - p(a))[0];
        warnings.push({ kind: 'empty', slot, message: `Your ${slot} slot is empty. ${best.name} is on your bench and can fill it.` });
      } else {
        warnings.push({ kind: 'empty', slot, message: `Your ${slot} slot is empty and no eligible player is on your roster.` });
      }
      continue;
    }
    if (!starters.length || !bench.length) continue;
    const lowest = [...starters].sort((a, b) => p(a) - p(b))[0];
    const better = [...bench].sort((a, b) => p(b) - p(a))[0];
    if (p(better) > p(lowest) + 1) {
      warnings.push({
        kind: 'bench',
        slot,
        message: `${better.name} (${round1(p(better))} proj) is on your bench but projects higher than ${lowest.name} (${round1(p(lowest))}) at ${slot}.`
      });
    }
  }
  return warnings;
}

// ---- Free agency -----------------------------------------------------------

function listPlayers(db, league, userId, opts = {}) {
  const where = [`p.position IN (${FANTASY_POSITIONS.map(() => '?').join(',')})`, 'p.departed = 0'];
  const params = [...FANTASY_POSITIONS];
  if (opts.pos && FANTASY_POSITIONS.includes(opts.pos)) {
    where.push('p.position = ?');
    params.push(opts.pos);
  }
  if (opts.group && GROUPS.some((g) => g.key === opts.group)) {
    where.push('t.group_key = ?');
    params.push(opts.group);
  }
  if (opts.q) {
    where.push('(p.name LIKE ? OR t.school LIKE ?)');
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const rows = db.prepare(`
    SELECT p.id, p.name, p.position, p.jersey, p.team_id, t.school, t.abbreviation, t.conference,
      t.group_key, t.color, t.alt_color, ps.status AS injury, ps.note AS injury_note
    FROM players p JOIN teams t ON t.id = p.team_id
    LEFT JOIN player_status ps ON ps.player_id = p.id
    WHERE ${where.join(' AND ')}
  `).all(...params);
  const owners = ownerMap(db, league.id);
  const mine = myTeamOf(db, league, userId);
  const proj = season.projectionMap(db, league.season, league.settings, season.currentWeek(db, league.season));
  let out = rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    jersey: r.jersey,
    injury: injuryOf(r),
    team: { id: r.team_id, school: r.school, abbreviation: r.abbreviation, conference: r.conference, group: r.group_key, color: r.color, alt_color: r.alt_color },
    owner_team_id: owners.has(r.id) ? owners.get(r.id) : null,
    mine: !!mine && owners.get(r.id) === mine.id,
    projection: proj.get(r.id) || 0
  }));
  const status = opts.status || 'free';
  if (status === 'free') out = out.filter((p) => p.owner_team_id === null);
  if (status === 'mine') out = out.filter((p) => p.mine);
  out.sort((a, b) => b.projection - a.projection || a.name.localeCompare(b.name));
  const limit = Math.min(Number(opts.limit) || 100, 500);
  return out.slice(0, limit);
}

function requireFreeAgent(db, league, playerId) {
  const p = playerRow(db, playerId);
  if (!p || !FANTASY_POSITIONS.includes(p.position)) throw new ApiError(404, 'Player not found');
  if (p.departed) throw new ApiError(400, `${p.name} is no longer on a Power Four roster`);
  const owner = ownerMap(db, league.id).get(playerId);
  if (owner !== undefined) throw new ApiError(400, `${p.name} is already on a roster`);
  return p;
}

// Instant add. Needs an open roster spot, or a drop in the same request.
function addPlayer(db, league, team, playerId, dropId) {
  if (league.status !== 'season') throw new ApiError(400, 'Free agents open once the draft is complete');
  const p = requireFreeAgent(db, league, playerId);
  if (dropId) {
    if (!rosterHas(db, team.id, dropId)) throw new ApiError(400, 'The player to drop is not on your roster');
    requireUnlocked(db, league, dropId);
    removeFromRoster(db, league, team, dropId, { quiet: true });
  } else if (rosterCount(db, team.id) >= capacity(league)) {
    throw new ApiError(400, 'Your roster is full. Drop a player first.');
  }
  db.prepare("INSERT INTO roster (team_id, player_id, slot) VALUES (?, ?, 'BN')").run(team.id, p.id);
  logTx(db, league, 'add', team.id, { player: p.name, player_id: p.id, dropped: dropId || null });
  refreshBestBall(db, league);
  return p;
}

function removeFromRoster(db, league, team, playerId, { quiet = false } = {}) {
  const p = playerRow(db, playerId);
  db.prepare('DELETE FROM roster WHERE team_id = ? AND player_id = ?').run(team.id, playerId);
  if (!quiet) logTx(db, league, 'drop', team.id, { player: p ? p.name : playerId, player_id: playerId });
}

function dropPlayer(db, league, team, playerId) {
  if (league.status !== 'season') throw new ApiError(400, 'Roster moves open once the draft is complete');
  if (!rosterHas(db, team.id, playerId)) throw new ApiError(400, 'That player is not on your roster');
  requireUnlocked(db, league, playerId);
  removeFromRoster(db, league, team, playerId);
  refreshBestBall(db, league);
}

// Waiver claim for a player who is free now. Processed when the week advances.
// In FAAB leagues the bid is what the team offers from its budget; priority leagues ignore it.
function createClaim(db, league, team, playerId, dropId, bid = 0) {
  if (league.status !== 'season') throw new ApiError(400, 'Claims open once the draft is complete');
  requireFreeAgent(db, league, playerId);
  if (dropId && !rosterHas(db, team.id, dropId)) throw new ApiError(400, 'The player to drop is not on your roster');
  if (dropId) requireUnlocked(db, league, dropId);
  let amount = 0;
  if (league.settings.waiver_mode === 'faab') {
    amount = Number(bid) || 0;
    if (!Number.isInteger(amount) || amount < 0) throw new ApiError(400, 'Bid must be a whole number, 0 or more');
    const balance = db.prepare('SELECT faab FROM fantasy_teams WHERE id = ?').get(team.id).faab;
    if (amount > balance) throw new ApiError(400, `Your bid is more than your FAAB balance of ${balance}`);
  }
  const existing = db.prepare("SELECT id FROM waiver_claims WHERE team_id = ? AND player_id = ? AND status = 'pending'").get(team.id, playerId);
  if (existing) throw new ApiError(400, 'You already have a claim on that player');
  db.prepare(`
    INSERT INTO waiver_claims (league_id, team_id, player_id, drop_player_id, week, status, bid, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(league.id, team.id, playerId, dropId || null, season.currentWeek(db, league.season), amount, nowIso());
}

function cancelClaim(db, league, team, claimId) {
  const row = db.prepare('SELECT * FROM waiver_claims WHERE id = ? AND league_id = ? AND team_id = ?').get(claimId, league.id, team.id);
  if (!row) throw new ApiError(404, 'Claim not found');
  if (row.status !== 'pending') throw new ApiError(400, 'Only pending claims can be cancelled');
  db.prepare("UPDATE waiver_claims SET status = 'cancelled' WHERE id = ?").run(claimId);
}

// Tries one claim. Returns null on success, or the reason it failed.
function executeClaim(db, league, claim) {
  const team = db.prepare('SELECT * FROM fantasy_teams WHERE id = ?').get(claim.team_id);
  const owner = ownerMap(db, league.id).get(claim.player_id);
  if (owner !== undefined) return 'Player was claimed by another team';
  const p = playerRow(db, claim.player_id);
  if (p && p.departed) return 'Player left the Power Four';
  const faab = league.settings.waiver_mode === 'faab';
  if (faab && claim.bid > team.faab) return 'Not enough FAAB budget';
  if (claim.drop_player_id && !rosterHas(db, team.id, claim.drop_player_id)) return 'Drop player is no longer on your roster';
  if (!claim.drop_player_id && rosterCount(db, team.id) >= capacity(league)) return 'Roster was full';
  if (claim.drop_player_id) removeFromRoster(db, league, team, claim.drop_player_id, { quiet: true });
  db.prepare("INSERT INTO roster (team_id, player_id, slot) VALUES (?, ?, 'BN')").run(team.id, claim.player_id);
  if (faab && claim.bid > 0) db.prepare('UPDATE fantasy_teams SET faab = faab - ? WHERE id = ?').run(claim.bid, team.id);
  logTx(db, league, 'waiver', team.id, {
    player: p ? p.name : claim.player_id,
    player_id: claim.player_id,
    dropped: claim.drop_player_id || null,
    bid: faab ? claim.bid : null
  });
  return null;
}

// Priority leagues: highest waiver priority first. FAAB leagues: highest bid first, priority breaks ties.
// A winner moves to the back of the line.
function processClaims(db, league) {
  const order = league.settings.waiver_mode === 'faab'
    ? 'c.bid DESC, ft.waiver_priority ASC, c.created_at ASC, c.id ASC'
    : 'ft.waiver_priority ASC, c.created_at ASC, c.id ASC';
  const pending = db.prepare(`
    SELECT c.*, ft.waiver_priority FROM waiver_claims c
    JOIN fantasy_teams ft ON ft.id = c.team_id
    WHERE c.league_id = ? AND c.status = 'pending'
    ORDER BY ${order}
  `).all(league.id);
  const remaining = [...pending];
  while (remaining.length) {
    const top = remaining[0];
    const group = remaining.filter((c) => c.player_id === top.player_id);
    let winner = null;
    for (const claim of group) {
      const reason = executeClaim(db, league, claim);
      if (reason === null) {
        winner = claim;
        db.prepare("UPDATE waiver_claims SET status = 'won', note = NULL WHERE id = ?").run(claim.id);
        break;
      }
      db.prepare("UPDATE waiver_claims SET status = 'failed', note = ? WHERE id = ?").run(reason, claim.id);
    }
    for (const claim of group) {
      if (claim === winner) continue;
      // Only still-pending claims lose here. Failed ones keep their reason.
      db.prepare("UPDATE waiver_claims SET status = 'lost', note = 'Another team won this player' WHERE id = ? AND status = 'pending'").run(claim.id);
    }
    if (winner && league.settings.waiver_mode !== 'faab') {
      db.prepare(`
        UPDATE fantasy_teams SET waiver_priority = (SELECT COALESCE(MAX(waiver_priority), 0) + 1 FROM fantasy_teams WHERE league_id = ?)
        WHERE id = ?
      `).run(league.id, winner.team_id);
    } else if (winner) {
      db.prepare(`
        UPDATE fantasy_teams SET waiver_priority = (SELECT COALESCE(MAX(waiver_priority), 0) + 1 FROM fantasy_teams WHERE league_id = ?)
        WHERE id = ?
      `).run(league.id, winner.team_id);
    }
    for (const claim of group) remaining.splice(remaining.indexOf(claim), 1);
  }
  refreshBestBall(db, league);
}

// ---- Trades ----------------------------------------------------------------

function requireTradeWindow(db, league) {
  if (league.status !== 'season') throw new ApiError(400, 'Trades open once the draft is complete');
  const deadline = league.settings.trade_deadline_week;
  if (deadline && season.currentWeek(db, league.season) > deadline) {
    throw new ApiError(400, `Trades closed after week ${deadline}`);
  }
}

function proposeTrade(db, league, fromTeam, toTeamId, give, get) {
  requireTradeWindow(db, league);
  if (!Array.isArray(give) || !Array.isArray(get)) throw new ApiError(400, 'Trade needs give and get lists');
  if (give.length + get.length === 0) throw new ApiError(400, 'Add at least one player to the trade');
  if (give.length > 6 || get.length > 6) throw new ApiError(400, 'Up to 6 players per side');
  const to = teamOf(db, league, toTeamId);
  if (to.id === fromTeam.id) throw new ApiError(400, 'Pick a different team to trade with');
  for (const pid of give) if (!rosterHas(db, fromTeam.id, pid)) throw new ApiError(400, 'You can only offer players on your roster');
  for (const pid of get) if (!rosterHas(db, to.id, pid)) throw new ApiError(400, 'That player is not on the other roster');
  for (const pid of [...give, ...get]) requireUnlocked(db, league, pid);
  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO trades (league_id, from_team_id, to_team_id, give, get_players, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(league.id, fromTeam.id, to.id, JSON.stringify(give), JSON.stringify(get), now, now);
  return Number(info.lastInsertRowid);
}

function loadTrade(db, league, tradeId) {
  const t = db.prepare('SELECT * FROM trades WHERE id = ? AND league_id = ?').get(tradeId, league.id);
  if (!t) throw new ApiError(404, 'Trade not found');
  return { ...t, give: JSON.parse(t.give), get_players: JSON.parse(t.get_players) };
}

function acceptTrade(db, league, user, tradeId) {
  requireTradeWindow(db, league);
  const trade = loadTrade(db, league, tradeId);
  if (trade.status !== 'pending') throw new ApiError(400, 'This trade is no longer open');
  const to = teamOf(db, league, trade.to_team_id);
  const from = teamOf(db, league, trade.from_team_id);
  if (to.user_id !== user.id) throw new ApiError(403, 'Only the receiving team can accept');
  for (const pid of trade.give) if (!rosterHas(db, from.id, pid)) throw new ApiError(400, 'A player in this trade has moved');
  for (const pid of trade.get_players) if (!rosterHas(db, to.id, pid)) throw new ApiError(400, 'A player in this trade has moved');
  for (const pid of [...trade.give, ...trade.get_players]) requireUnlocked(db, league, pid);
  const fromAfter = rosterCount(db, from.id) - trade.give.length + trade.get_players.length;
  const toAfter = rosterCount(db, to.id) - trade.get_players.length + trade.give.length;
  if (fromAfter > capacity(league) || toAfter > capacity(league)) throw new ApiError(400, 'A roster would be over the limit');
  const move = db.prepare("UPDATE roster SET team_id = ?, slot = 'BN' WHERE team_id = ? AND player_id = ?");
  for (const pid of trade.give) move.run(to.id, from.id, pid);
  for (const pid of trade.get_players) move.run(from.id, to.id, pid);
  db.prepare("UPDATE trades SET status = 'accepted', updated_at = ? WHERE id = ?").run(nowIso(), trade.id);
  const names = (ids) => ids.map((id) => (playerRow(db, id) || { name: id }).name);
  logTx(db, league, 'trade', from.id, {
    from: from.name, to: to.name, give: names(trade.give), get: names(trade.get_players)
  });
  refreshBestBall(db, league);
  return trade;
}

function declineTrade(db, league, user, tradeId) {
  const trade = loadTrade(db, league, tradeId);
  if (trade.status !== 'pending') throw new ApiError(400, 'This trade is no longer open');
  const to = teamOf(db, league, trade.to_team_id);
  if (to.user_id !== user.id) throw new ApiError(403, 'Only the receiving team can decline');
  db.prepare("UPDATE trades SET status = 'declined', updated_at = ? WHERE id = ?").run(nowIso(), trade.id);
}

function cancelTrade(db, league, user, tradeId) {
  const trade = loadTrade(db, league, tradeId);
  if (trade.status !== 'pending') throw new ApiError(400, 'This trade is no longer open');
  const from = teamOf(db, league, trade.from_team_id);
  if (from.user_id !== user.id) throw new ApiError(403, 'Only the proposing team can cancel');
  db.prepare("UPDATE trades SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), trade.id);
}

// The receiving team answers with its own offer. The original is closed and a new one goes back the other way.
function counterTrade(db, league, user, tradeId, give, get) {
  requireTradeWindow(db, league);
  const trade = loadTrade(db, league, tradeId);
  if (trade.status !== 'pending') throw new ApiError(400, 'This trade is no longer open');
  const to = teamOf(db, league, trade.to_team_id);
  const from = teamOf(db, league, trade.from_team_id);
  if (to.user_id !== user.id) throw new ApiError(403, 'Only the receiving team can counter');
  const id = proposeTrade(db, league, to, from.id, give, get);
  db.prepare("UPDATE trades SET status = 'countered', updated_at = ? WHERE id = ?").run(nowIso(), trade.id);
  return id;
}

// What a trade does for the proposing side, using the same values the draft ranks players by
function tradeSummary(values, give, get) {
  const total = (ids, key) => ids.reduce((sum, id) => sum + ((values.get(id) || {})[key] || 0), 0);
  return {
    value_change: round1(total(get, 'value') - total(give, 'value')),
    projection_change: round1(total(get, 'projection') - total(give, 'projection'))
  };
}

module.exports = {
  FORMATS,
  WAIVER_MODES,
  parseLeague,
  getLeague,
  capacity,
  groupKeyFor,
  teamsOf,
  teamOf,
  myTeamOf,
  requireMember,
  requireCommissioner,
  logTx,
  playerRow,
  playerCard,
  ownerMap,
  rosterRows,
  rosterCount,
  rosterHas,
  kickoffsForWeek,
  hasKickedOff,
  lockedPlayerIds,
  requireUnlocked,
  createLeague,
  joinLeague,
  releaseMember,
  renameTeam,
  updateSettings,
  normalizeSettings,
  setLineup,
  autoLineup,
  refreshBestBall,
  lineupWarnings,
  listPlayers,
  addPlayer,
  dropPlayer,
  createClaim,
  cancelClaim,
  processClaims,
  proposeTrade,
  loadTrade,
  acceptTrade,
  declineTrade,
  cancelTrade,
  counterTrade,
  tradeSummary
};
