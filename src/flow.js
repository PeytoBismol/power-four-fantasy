'use strict';

// Matchups, standings, playoffs, power rankings, recaps, awards, and advancing the season week.

const { BENCH, SEASON } = require('./config');
const { round1 } = require('./util');
const season = require('./season');
const L = require('./league');

// Starters and points for one team in one week. Finished weeks use the locked lineup.
function teamWeek(db, league, teamId, week, liveWeek, pmap) {
  const locked = week < liveWeek;
  const rows = locked
    ? db.prepare('SELECT player_id, slot FROM lineup_locks WHERE team_id = ? AND week = ? AND slot != ?').all(teamId, week, BENCH)
    : db.prepare('SELECT player_id, slot FROM roster WHERE team_id = ? AND slot != ?').all(teamId, BENCH);
  const starters = rows.map((r) => {
    const p = L.playerRow(db, r.player_id);
    return {
      player_id: r.player_id,
      slot: r.slot,
      name: p ? p.name : r.player_id,
      position: p ? p.position : 'DEF',
      school: p ? p.school : null,
      points: pmap.get(r.player_id) || 0
    };
  });
  const total = round1(starters.reduce((sum, s) => sum + s.points, 0));
  return { total, starters };
}

function teamSummary(db, team) {
  const owner = team.user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(team.user_id) : null;
  return {
    id: team.id,
    name: team.name,
    is_cpu: !!team.is_cpu,
    owner: team.is_cpu ? 'CPU' : owner ? owner.name : 'Open',
    draft_slot: team.draft_slot
  };
}

// Matchups for one week with points and lineups. Points leagues have no matchups.
function matchupsForWeek(db, league, week, liveWeek) {
  const pmap = season.weekPoints(db, league.season, league.settings, week);
  const teams = new Map(L.teamsOf(db, league.id).map((t) => [t.id, t]));
  const rows = db.prepare('SELECT * FROM matchups WHERE league_id = ? AND week = ? ORDER BY playoff_round, id').all(league.id, week);
  return rows.map((m) => {
    const side = (teamId) => {
      if (teamId === null || teamId === undefined) return null;
      const t = teams.get(teamId);
      const { total, starters } = teamWeek(db, league, teamId, week, liveWeek, pmap);
      return { team: teamSummary(db, t), points: total, starters };
    };
    const home = side(m.home_team_id);
    const away = side(m.away_team_id);
    let winner = null;
    if (week < liveWeek && home && away) {
      if (home.points > away.points) winner = home.team.id;
      else if (away.points > home.points) winner = away.team.id;
    }
    return {
      id: m.id,
      week,
      playoff_round: m.playoff_round,
      status: season.weekStatus(week, liveWeek),
      home,
      away,
      winner_team_id: winner
    };
  });
}

// Standings from completed regular-season weeks. Head-to-head ranks by wins; points leagues rank by points for.
function standings(db, league, liveWeek) {
  const teams = L.teamsOf(db, league.id);
  const rec = new Map(teams.map((t) => [t.id, { team: teamSummary(db, t), wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 }]));
  const start = league.start_week || liveWeek;
  const last = Math.min(liveWeek - 1, league.settings.regular_weeks);
  const points = league.settings.format === 'points';
  for (let w = start; w <= last; w++) {
    const pmap = season.weekPoints(db, league.season, league.settings, w);
    if (points) {
      for (const t of teams) rec.get(t.id).points_for += teamWeek(db, league, t.id, w, liveWeek, pmap).total;
      continue;
    }
    const matchups = db.prepare('SELECT * FROM matchups WHERE league_id = ? AND week = ? AND playoff_round = 0').all(league.id, w);
    for (const m of matchups) {
      if (m.home_team_id === null || m.away_team_id === null) continue;
      const h = teamWeek(db, league, m.home_team_id, w, liveWeek, pmap).total;
      const a = teamWeek(db, league, m.away_team_id, w, liveWeek, pmap).total;
      const hr = rec.get(m.home_team_id);
      const ar = rec.get(m.away_team_id);
      hr.points_for += h; hr.points_against += a;
      ar.points_for += a; ar.points_against += h;
      if (h > a) { hr.wins++; ar.losses++; }
      else if (a > h) { ar.wins++; hr.losses++; }
      else { hr.ties++; ar.ties++; }
    }
  }
  const rows = [...rec.values()].map((r) => ({
    ...r,
    points_for: round1(r.points_for),
    points_against: round1(r.points_against)
  }));
  if (points) rows.sort((x, y) => y.points_for - x.points_for);
  else rows.sort((x, y) => y.wins - x.wins || y.points_for - x.points_for);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

// Power rankings: record first (head-to-head), then average points over the last three finished weeks.
// Points leagues use the standings order. `move` is places gained since last week.
function powerRankings(db, league, liveWeek) {
  const cur = standings(db, league, liveWeek);
  const points = league.settings.format === 'points';
  const prev = new Map(standings(db, league, liveWeek - 1).map((r) => [r.team.id, r.rank]));
  const from = Math.max(league.start_week || 1, liveWeek - 3);
  const to = Math.min(liveWeek - 1, league.settings.regular_weeks);
  const recent = new Map();
  for (let w = from; w <= to; w++) {
    const pmap = season.weekPoints(db, league.season, league.settings, w);
    for (const t of L.teamsOf(db, league.id)) {
      const e = recent.get(t.id) || { total: 0, n: 0 };
      e.total += teamWeek(db, league, t.id, w, liveWeek, pmap).total;
      e.n += 1;
      recent.set(t.id, e);
    }
  }
  const avg = (id) => {
    const e = recent.get(id);
    return e && e.n ? round1(e.total / e.n) : 0;
  };
  const rows = cur.map((r) => {
    const games = r.wins + r.losses + r.ties;
    return { ...r, last3_avg: avg(r.team.id), win_pct: games ? round1((r.wins + r.ties / 2) / games * 100) : 0 };
  });
  if (!points) rows.sort((x, y) => y.win_pct - x.win_pct || y.last3_avg - x.last3_avg || x.rank - y.rank);
  return rows.map((r, i) => {
    const power = i + 1;
    const before = prev.get(r.team.id);
    const move = before && liveWeek - 1 >= (league.start_week || 1) ? before - power : null;
    return { ...r, power_rank: power, move };
  });
}

// Recap of a finished league week: every matchup, the closest and biggest game, top player, high team.
function weekRecap(db, league, week, liveWeek) {
  if (week >= liveWeek) return { week, status: season.weekStatus(week, liveWeek), ready: false, games: [] };
  const games = matchupsForWeek(db, league, week, liveWeek)
    .filter((m) => m.home && m.away)
    .map((m) => ({
      id: m.id,
      playoff_round: m.playoff_round,
      home: { team: m.home.team, points: m.home.points },
      away: { team: m.away.team, points: m.away.points },
      margin: round1(Math.abs(m.home.points - m.away.points)),
      winner_team_id: m.winner_team_id
    }));
  const pmap = season.weekPoints(db, league.season, league.settings, week);
  const teamsWeek = L.teamsOf(db, league.id).map((t) => {
    const wk = teamWeek(db, league, t.id, week, liveWeek, pmap);
    return { team: teamSummary(db, t), points: wk.total, starters: wk.starters };
  });
  let topPlayer = null;
  for (const tw of teamsWeek) {
    for (const s of tw.starters) {
      if (!topPlayer || s.points > topPlayer.points) topPlayer = { name: s.name, position: s.position, school: s.school, points: s.points, team: tw.team.name };
    }
  }
  const highTeam = teamsWeek.reduce((best, tw) => (!best || tw.points > best.points ? tw : best), null);
  const byMargin = [...games].sort((a, b) => a.margin - b.margin);
  return {
    week,
    status: season.weekStatus(week, liveWeek),
    ready: true,
    games,
    closest: byMargin[0] || null,
    blowout: byMargin[byMargin.length - 1] || null,
    top_player: topPlayer,
    high_team: highTeam ? { team: highTeam.team, points: highTeam.points } : null
  };
}

// Season awards from every finished regular-season week
function seasonAwards(db, league, liveWeek) {
  const to = Math.min(liveWeek - 1, league.settings.regular_weeks);
  const from = league.start_week || 1;
  const teams = L.teamsOf(db, league.id);
  const names = new Map(teams.map((t) => [t.id, t.name]));
  const playerTotals = new Map();
  const teamTotals = new Map();
  let bestWeek = null;
  let blowout = null;
  let closest = null;
  for (let w = from; w <= to; w++) {
    const pmap = season.weekPoints(db, league.season, league.settings, w);
    for (const t of teams) {
      const wk = teamWeek(db, league, t.id, w, liveWeek, pmap);
      teamTotals.set(t.id, (teamTotals.get(t.id) || 0) + wk.total);
      if (!bestWeek || wk.total > bestWeek.points) bestWeek = { team: t.name, week: w, points: wk.total };
      for (const s of wk.starters) {
        const e = playerTotals.get(s.player_id) || { name: s.name, position: s.position, school: s.school, team: t.name, points: 0 };
        e.points = round1(e.points + s.points);
        playerTotals.set(s.player_id, e);
      }
    }
    if (league.settings.format !== 'points') {
      for (const m of matchupsForWeek(db, league, w, liveWeek)) {
        if (!m.home || !m.away || m.playoff_round) continue;
        const margin = round1(Math.abs(m.home.points - m.away.points));
        const row = { week: w, margin, winner: m.winner_team_id ? names.get(m.winner_team_id) : null, a: m.home.team.name, b: m.away.team.name, a_points: m.home.points, b_points: m.away.points };
        if (!blowout || margin > blowout.margin) blowout = row;
        if (!closest || margin < closest.margin) closest = row;
      }
    }
  }
  const topPlayer = [...playerTotals.values()].sort((a, b) => b.points - a.points)[0] || null;
  const topTeamId = [...teamTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    top_player: topPlayer,
    best_team: topTeamId ? { team: names.get(topTeamId[0]), points: round1(topTeamId[1]) } : null,
    best_week: bestWeek,
    biggest_blowout: blowout,
    closest_game: closest
  };
}

// Team ids in final order: champion, runner-up, then everyone else by regular-season standings
function finalPlaces(db, league) {
  const reg = league.settings.regular_weeks;
  const order = standings(db, league, reg + 1).map((r) => r.team.id);
  if (league.settings.playoff_teams !== 4) return order;
  const finals = matchupsForWeek(db, league, reg + 2, reg + 3).filter((m) => m.playoff_round === 2);
  if (!finals.length || !finals[0].winner_team_id) return order;
  const champ = finals[0].winner_team_id;
  const runner = finals[0].home.team.id === champ ? finals[0].away.team.id : finals[0].home.team.id;
  return [champ, runner, ...order.filter((id) => id !== champ && id !== runner)];
}

function lockLineups(db, league, week) {
  db.prepare('DELETE FROM lineup_locks WHERE week = ? AND team_id IN (SELECT id FROM fantasy_teams WHERE league_id = ?)').run(week, league.id);
  db.prepare(`
    INSERT INTO lineup_locks (team_id, week, player_id, slot)
    SELECT r.team_id, ?, r.player_id, r.slot FROM roster r
    JOIN fantasy_teams ft ON ft.id = r.team_id
    WHERE ft.league_id = ? AND r.slot != ?
  `).run(week, league.id, BENCH);
}

function finalWeekOf(league) {
  return league.settings.regular_weeks + (league.settings.playoff_teams === 4 ? 2 : 0);
}

// Creates the semifinals and final once the regular season ends. Seeds come from standings.
function ensurePlayoffs(db, league, nextWeek) {
  const reg = league.settings.regular_weeks;
  if (league.settings.playoff_teams !== 4) return;
  if (nextWeek === reg + 1) {
    const exists = db.prepare('SELECT 1 FROM matchups WHERE league_id = ? AND playoff_round = 1').get(league.id);
    if (exists) return;
    const seeds = standings(db, league, nextWeek).map((r) => r.team.id);
    if (seeds.length < 4) return;
    const insert = db.prepare('INSERT INTO matchups (league_id, week, home_team_id, away_team_id, playoff_round) VALUES (?, ?, ?, ?, 1)');
    insert.run(league.id, reg + 1, seeds[0], seeds[3]);
    insert.run(league.id, reg + 1, seeds[1], seeds[2]);
  }
  if (nextWeek === reg + 2) {
    const exists = db.prepare('SELECT 1 FROM matchups WHERE league_id = ? AND playoff_round = 2').get(league.id);
    if (exists) return;
    const semis = db.prepare('SELECT * FROM matchups WHERE league_id = ? AND playoff_round = 1 ORDER BY id').all(league.id);
    if (semis.length < 2) return;
    const pmap = season.weekPoints(db, league.season, league.settings, reg + 1);
    const winners = semis.map((m) => {
      const h = teamWeek(db, league, m.home_team_id, reg + 1, nextWeek, pmap).total;
      const a = teamWeek(db, league, m.away_team_id, reg + 1, nextWeek, pmap).total;
      return h >= a ? m.home_team_id : m.away_team_id; // ties go to the higher seed
    });
    db.prepare('INSERT INTO matchups (league_id, week, home_team_id, away_team_id, playoff_round) VALUES (?, ?, ?, ?, 2)')
      .run(league.id, reg + 2, winners[0], winners[1]);
  }
}

// The champion: the final's winner in a playoff league, otherwise the top of the standings
function championOf(db, league) {
  const order = finalPlaces(db, league);
  return order.length ? order[0] : null;
}

// Writes the finished league's results so they stay in history after the season moves on
function recordSeasonResults(db, league) {
  const places = finalPlaces(db, league);
  const rows = new Map(standings(db, league, league.settings.regular_weeks + 1).map((r) => [r.team.id, r]));
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO season_results
      (league_id, team_id, season, league_name, team_name, owner, user_id, place, wins, losses, points_for, champion, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  places.forEach((teamId, i) => {
    const team = L.teamOf(db, league, teamId);
    const r = rows.get(teamId) || { wins: 0, losses: 0, points_for: 0 };
    const user = team.user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(team.user_id) : null;
    insert.run(
      league.id, teamId, league.season, league.name, team.name,
      user ? user.name : 'CPU', team.user_id || null, i + 1,
      r.wins, r.losses, r.points_for, i === 0 ? 1 : 0, now
    );
  });
}

// Moves the whole season forward one week: claims, lineup locks, playoff seeding, CPU lineups
function advanceWeek(db, seasonYear = SEASON) {
  const w = season.currentWeek(db, seasonYear);
  const next = w + 1;
  const leagues = db.prepare("SELECT * FROM leagues WHERE season = ? AND status = 'season'").all(seasonYear).map(L.parseLeague);
  for (const league of leagues) {
    L.processClaims(db, league);
    lockLineups(db, league, w);
    ensurePlayoffs(db, league, next);
    for (const team of L.teamsOf(db, league.id)) {
      // Best ball sets every lineup for the coming week; otherwise only CPU teams are set automatically
      if (team.is_cpu || league.settings.best_ball) L.autoLineup(db, league, team, next);
    }
    if (w >= finalWeekOf(league)) {
      const champ = championOf(db, league);
      db.prepare("UPDATE leagues SET status = 'complete', finished_at = ? WHERE id = ?").run(new Date().toISOString(), league.id);
      recordSeasonResults(db, league);
      if (champ) L.logTx(db, league, 'champion', champ, { week: w });
    }
  }
  season.setCurrentWeek(db, seasonYear, next);
  return { from: w, to: next, leagues: leagues.length };
}

module.exports = {
  teamWeek,
  matchupsForWeek,
  standings,
  powerRankings,
  weekRecap,
  seasonAwards,
  finalPlaces,
  ensurePlayoffs,
  lockLineups,
  finalWeekOf,
  championOf,
  recordSeasonResults,
  advanceWeek,
  teamSummary
};
