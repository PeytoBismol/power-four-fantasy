'use strict';

// Snake draft engine. CPU teams and expired pick timers are auto-drafted on the server.

const { FANTASY_POSITIONS, DRAFT_POSITION_CAPS, DRAFT_MINIMUMS } = require('./config');
const { ApiError, nowIso } = require('./util');
const season = require('./season');
const L = require('./league');

// Starters each team needs per position, WRT split across RB/WR/TE. Used for replacement levels.
const STARTERS_PER_TEAM = { QB: 1, RB: 2.5, WR: 2.5, TE: 1.5, K: 1, DEF: 1 };

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Snake order: odd rounds go 1..N, even rounds go N..1
function pickTeamId(order, pick) {
  const n = order.length;
  const idx = (pick - 1) % n;
  const round = Math.ceil(pick / n);
  return round % 2 === 1 ? order[idx] : order[n - 1 - idx];
}

function draftRow(db, leagueId) {
  const d = db.prepare('SELECT * FROM drafts WHERE league_id = ?').get(leagueId);
  if (!d) throw new ApiError(404, 'Draft not found');
  return { ...d, order: d.draft_order ? JSON.parse(d.draft_order) : [] };
}

// Draft value = projection minus the replacement level at that position
function draftRanking(db, league, week) {
  const teams = league.settings.team_count;
  const proj = season.projectionMap(db, league.season, league.settings, week);
  const players = db.prepare(`
    SELECT p.id, p.position FROM players p
    WHERE p.position IN (${FANTASY_POSITIONS.map(() => '?').join(',')}) AND p.departed = 0
  `).all(...FANTASY_POSITIONS);
  const byPos = {};
  for (const pos of FANTASY_POSITIONS) byPos[pos] = [];
  for (const p of players) byPos[p.position].push(proj.get(p.id) || 0);
  const replacement = {};
  for (const pos of FANTASY_POSITIONS) {
    const sorted = byPos[pos].sort((a, b) => b - a);
    const idx = Math.min(sorted.length - 1, Math.round(STARTERS_PER_TEAM[pos] * teams));
    replacement[pos] = idx >= 0 ? sorted[idx] : 0;
  }
  return players
    .map((p) => ({ id: p.id, position: p.position, value: (proj.get(p.id) || 0) - replacement[p.position], projection: proj.get(p.id) || 0 }))
    .sort((a, b) => b.value - a.value);
}

// Best available player for a team's current pick. Bots respect position caps and minimums.
function autopick(db, league, teamId, round, week) {
  const taken = L.ownerMap(db, league.id);
  const roster = L.rosterRows(db, teamId);
  const count = (pos) => roster.filter((r) => r.position === pos).length;
  const needed = FANTASY_POSITIONS.filter((pos) => count(pos) < DRAFT_MINIMUMS[pos]);
  const restrict = round >= 5 && needed.length > 0;
  for (const cand of draftRanking(db, league, week)) {
    if (taken.has(cand.id)) continue;
    if (count(cand.position) >= DRAFT_POSITION_CAPS[cand.position]) continue;
    if (restrict && !needed.includes(cand.position)) continue;
    return cand.id;
  }
  throw new ApiError(500, 'No players left to draft');
}

function recordPick(db, league, pick, round, teamId, playerId, auto) {
  db.prepare('INSERT INTO draft_picks (league_id, pick_no, round, team_id, player_id, auto, made_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(league.id, pick, round, teamId, playerId, auto ? 1 : 0, nowIso());
  db.prepare("INSERT INTO roster (team_id, player_id, slot) VALUES (?, ?, 'BN')").run(teamId, playerId);
  // A drafted player comes off every queue in the league
  db.prepare('DELETE FROM draft_queue WHERE league_id = ? AND player_id = ?').run(league.id, playerId);
  const p = L.playerRow(db, playerId);
  L.logTx(db, league, 'draft', teamId, { pick, round, player: p ? p.name : playerId, player_id: playerId, auto: !!auto });
}

// First player on a team's queue that nobody has taken yet. Used when that team's pick times out.
function queuedPick(db, league, teamId) {
  const taken = L.ownerMap(db, league.id);
  const rows = db.prepare('SELECT player_id FROM draft_queue WHERE team_id = ? ORDER BY position').all(teamId);
  const pick = rows.find((r) => !taken.has(r.player_id));
  return pick ? pick.player_id : null;
}

// Queue for one team, in order, with each player's current value rank
function getQueue(db, league, team) {
  const rank = new Map(draftRanking(db, league, season.currentWeek(db, league.season)).map((c, i) => [c.id, i + 1]));
  const taken = L.ownerMap(db, league.id);
  return db.prepare(`
    SELECT q.player_id, q.position, p.name, p.position AS pos, t.school
    FROM draft_queue q JOIN players p ON p.id = q.player_id JOIN teams t ON t.id = p.team_id
    WHERE q.team_id = ? ORDER BY q.position
  `).all(team.id).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.pos,
    school: r.school,
    rank: rank.get(r.player_id) || null,
    taken: taken.has(r.player_id)
  }));
}

// Replaces a team's queue. Only the team's own owner can set it, and only before its picks are made.
function setQueue(db, league, team, playerIds) {
  if (!Array.isArray(playerIds)) throw new ApiError(400, 'Queue must be a list of player ids');
  if (playerIds.length > 60) throw new ApiError(400, 'Queue can hold up to 60 players');
  const unique = [...new Set(playerIds.map(String))];
  for (const pid of unique) {
    const p = L.playerRow(db, pid);
    if (!p || !FANTASY_POSITIONS.includes(p.position)) throw new ApiError(400, 'Queue has a player who is not in the pool');
    if (p.departed) throw new ApiError(400, `${p.name} is no longer on a Power Four roster`);
  }
  db.prepare('DELETE FROM draft_queue WHERE team_id = ?').run(team.id);
  const insert = db.prepare('INSERT INTO draft_queue (league_id, team_id, position, player_id) VALUES (?, ?, ?, ?)');
  unique.forEach((pid, i) => insert.run(league.id, team.id, i + 1, pid));
}

// Commissioner sets the draft order before the draft starts: teamIds[0] picks first
function setDraftOrder(db, league, user, teamIds) {
  L.requireCommissioner(league, user);
  if (league.status !== 'predraft') throw new ApiError(400, 'Draft order is set before the draft starts');
  const ids = L.teamsOf(db, league.id).map((t) => t.id);
  if (!Array.isArray(teamIds) || teamIds.length !== ids.length || !ids.every((id) => teamIds.map(Number).includes(id))) {
    throw new ApiError(400, 'Draft order must list every team exactly once');
  }
  teamIds.forEach((tid, i) => db.prepare('UPDATE fantasy_teams SET draft_slot = ? WHERE id = ?').run(i + 1, Number(tid)));
}

function randomizeDraftOrder(db, league, user) {
  L.requireCommissioner(league, user);
  if (league.status !== 'predraft') throw new ApiError(400, 'Draft order is set before the draft starts');
  const ids = shuffle(L.teamsOf(db, league.id).map((t) => t.id));
  setDraftOrder(db, league, user, ids);
}

// Advances the draft as far as it can go: CPU picks and expired timers run now, a human on the clock stops it
function processDraft(db, league) {
  const d = draftRow(db, league.id);
  if (d.status !== 'live') return;
  const order = d.order;
  const n = order.length;
  const week = season.currentWeek(db, league.season);
  const teams = new Map(L.teamsOf(db, league.id).map((t) => [t.id, t]));
  const seconds = league.settings.pick_seconds;
  let pick = d.current_pick;
  let deadline = d.pick_deadline;
  while (pick <= d.total_picks) {
    const teamId = pickTeamId(order, pick);
    const round = Math.ceil(pick / n);
    const expired = !!deadline && Date.now() >= Date.parse(deadline);
    if (teams.get(teamId).is_cpu || expired) {
      // A timed-out human takes the first available player on their queue, else the best available
      const queued = teams.get(teamId).is_cpu ? null : queuedPick(db, league, teamId);
      const playerId = queued || autopick(db, league, teamId, round, week);
      recordPick(db, league, pick, round, teamId, playerId, true);
      pick++;
      deadline = null;
      continue;
    }
    if (!deadline) deadline = new Date(Date.now() + seconds * 1000).toISOString();
    break;
  }
  if (pick > d.total_picks) {
    finishDraft(db, league);
    return;
  }
  db.prepare('UPDATE drafts SET current_pick = ?, pick_deadline = ? WHERE league_id = ?').run(pick, deadline, league.id);
}

function startDraft(db, league, user) {
  L.requireCommissioner(league, user);
  if (league.status !== 'predraft') throw new ApiError(400, 'The draft has already started');
  const teams = L.teamsOf(db, league.id);
  // Use the commissioner's order when every team has one, otherwise shuffle
  const ordered = teams.every((t) => t.draft_slot) ? [...teams].sort((a, b) => a.draft_slot - b.draft_slot).map((t) => t.id) : null;
  const order = ordered || shuffle(teams.map((t) => t.id));
  order.forEach((tid, i) => db.prepare('UPDATE fantasy_teams SET draft_slot = ? WHERE id = ?').run(i + 1, tid));
  const total = teams.length * L.capacity(league);
  const week = season.currentWeek(db, league.season);
  db.prepare("UPDATE leagues SET status = 'drafting', start_week = ? WHERE id = ?").run(week, league.id);
  db.prepare(`
    UPDATE drafts SET status = 'live', draft_order = ?, current_pick = 1, total_picks = ?, pick_deadline = NULL
    WHERE league_id = ?
  `).run(JSON.stringify(order), total, league.id);
  processDraft(db, L.getLeague(db, league.id));
}

function makePick(db, league, user, playerId) {
  if (league.status !== 'drafting') throw new ApiError(400, 'The draft is not live');
  processDraft(db, L.getLeague(db, league.id));
  const d = draftRow(db, league.id);
  if (d.status !== 'live') throw new ApiError(400, 'The draft is over');
  const pick = d.current_pick;
  const teamId = pickTeamId(d.order, pick);
  const team = L.teamOf(db, league, teamId);
  if (team.user_id !== user.id) throw new ApiError(409, 'It is not your pick');
  const p = L.playerRow(db, playerId);
  if (!p || !FANTASY_POSITIONS.includes(p.position)) throw new ApiError(404, 'Player not found');
  if (L.ownerMap(db, league.id).has(playerId)) throw new ApiError(400, `${p.name} has already been drafted`);
  const round = Math.ceil(pick / d.order.length);
  recordPick(db, league, pick, round, teamId, playerId, false);
  db.prepare('UPDATE drafts SET current_pick = ?, pick_deadline = NULL WHERE league_id = ?').run(pick + 1, league.id);
  processDraft(db, L.getLeague(db, league.id));
}

// Finishes the draft: lineups set, schedule built, league moves to the season
function finishDraft(db, league) {
  db.prepare("UPDATE drafts SET status = 'complete', pick_deadline = NULL WHERE league_id = ?").run(league.id);
  db.prepare("UPDATE leagues SET status = 'season' WHERE id = ?").run(league.id);
  const week = season.currentWeek(db, league.season);
  const fresh = L.getLeague(db, league.id);
  // A league can start in a week whose games are already under way, so the first lineup ignores kickoffs
  for (const team of L.teamsOf(db, league.id)) L.autoLineup(db, fresh, team, week, { ignoreLocks: true });
  // Points leagues have no head-to-head matchups
  if (fresh.settings.format !== 'points') generateSchedule(db, fresh);
}

// Round-robin for the regular season, starting at the league's start week. Repeats after N-1 weeks.
function generateSchedule(db, league) {
  const teams = L.teamsOf(db, league.id).map((t) => t.id);
  const ids = teams.length % 2 === 0 ? teams : [...teams, null];
  const n = ids.length;
  const start = league.start_week || season.currentWeek(db, league.season);
  const insert = db.prepare('INSERT INTO matchups (league_id, week, home_team_id, away_team_id, playoff_round) VALUES (?, ?, ?, ?, 0)');
  for (let w = start; w <= league.settings.regular_weeks; w++) {
    const r = (w - start) % (n - 1);
    const rot = [ids[0]];
    const rest = ids.slice(1);
    for (let i = 0; i < rest.length; i++) rot.push(rest[(i + r) % rest.length]);
    for (let i = 0; i < n / 2; i++) {
      const a = rot[i];
      const b = rot[n - 1 - i];
      if (a === null || b === null) continue;
      const flip = w % 2 === 0;
      insert.run(league.id, w, flip ? b : a, flip ? a : b);
    }
  }
}

// Current pick, clock and recent picks for the draft room
function draftState(db, league, viewerUserId) {
  processDraft(db, league);
  const d = draftRow(db, league.id);
  const teams = new Map(L.teamsOf(db, league.id).map((t) => [t.id, t]));
  const names = db.prepare('SELECT id, name FROM players WHERE id IN (SELECT player_id FROM draft_picks WHERE league_id = ?)').all(league.id);
  const nameOf = new Map(names.map((p) => [p.id, p.name]));
  const picks = db.prepare(`
    SELECT pick_no, round, team_id, player_id, auto FROM draft_picks WHERE league_id = ? ORDER BY pick_no
  `).all(league.id);
  let onClock = null;
  let round = null;
  if (d.status === 'live' && d.current_pick <= d.total_picks) {
    const tid = pickTeamId(d.order, d.current_pick);
    onClock = teams.get(tid);
    round = Math.ceil(d.current_pick / d.order.length);
  }
  return {
    status: d.status,
    total_picks: d.total_picks,
    current_pick: d.current_pick,
    round,
    on_clock: onClock ? { id: onClock.id, name: onClock.name, is_me: onClock.user_id === viewerUserId } : null,
    deadline: d.pick_deadline,
    pick_seconds: league.settings.pick_seconds,
    order: d.order.map((tid) => ({ id: tid, name: teams.get(tid).name, slot: d.order.indexOf(tid) + 1 })),
    picks: picks.map((p) => ({
      pick_no: p.pick_no,
      round: p.round,
      team: { id: p.team_id, name: teams.get(p.team_id).name },
      player: p.player_id ? { id: p.player_id, name: nameOf.get(p.player_id) || p.player_id } : null,
      auto: !!p.auto
    }))
  };
}

module.exports = {
  pickTeamId,
  draftRanking,
  startDraft,
  makePick,
  processDraft,
  draftState,
  generateSchedule,
  autopick,
  queuedPick,
  getQueue,
  setQueue,
  setDraftOrder,
  randomizeDraftOrder,
  shuffle
};
