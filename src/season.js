'use strict';

// Season clock and weekly scoring. Reads derived stats from the database.

const { SEASON, CFBD_REGULAR_WEEKS } = require('./config');
const { scoringFor, playerPoints, defensePoints, average } = require('./scoring');
const { round1 } = require('./util');

// Scores are cached briefly so the players list does not rescan stats on every request.
const cache = new Map();
const TTL_MS = 60 * 1000;

function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = compute();
  cache.set(key, { value, at: Date.now() });
  return value;
}

function clearCache() {
  cache.clear();
}

function currentWeek(db, season = SEASON) {
  const row = db.prepare('SELECT current_week FROM season_state WHERE season = ?').get(season);
  return row ? row.current_week : 1;
}

function setCurrentWeek(db, season, week) {
  db.prepare(`
    INSERT INTO season_state (season, current_week, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(season) DO UPDATE SET current_week = excluded.current_week, updated_at = excluded.updated_at
  `).run(season, week, new Date().toISOString());
  clearCache();
}

// League week -> the CFBD season type and week it draws stats from.
// Weeks 1-15 are regular-season weeks; later weeks are postseason (bowls, CFP).
function weekRef(week) {
  return week <= CFBD_REGULAR_WEEKS
    ? { seasonType: 'regular', week }
    : { seasonType: 'postseason', week: week - CFBD_REGULAR_WEEKS };
}

// Fantasy points for every scoring player in a league week (keys are player ids, DEF-<teamId> for defenses)
function weekPoints(db, season, settings, week) {
  const scoring = scoringFor(settings);
  const ref = weekRef(week);
  const key = `wp:${season}:${ref.seasonType}:${ref.week}:${JSON.stringify(scoring)}`;
  return cached(key, () => {
    const out = new Map();
    const rows = db.prepare(`
      SELECT player_id,
        SUM(pass_yd) AS pass_yd, SUM(pass_td) AS pass_td, SUM(pass_int) AS pass_int,
        SUM(rush_yd) AS rush_yd, SUM(rush_td) AS rush_td,
        SUM(rec) AS rec, SUM(rec_yd) AS rec_yd, SUM(rec_td) AS rec_td,
        SUM(fum_lost) AS fum_lost, SUM(fgm) AS fgm, SUM(xpm) AS xpm
      FROM player_games
      WHERE season = ? AND season_type = ? AND week = ?
      GROUP BY player_id
    `).all(season, ref.seasonType, ref.week);
    for (const r of rows) out.set(r.player_id, playerPoints(r, scoring));

    const defs = db.prepare(`
      SELECT team_id, points_allowed, sacks, def_int, def_td
      FROM defense_games WHERE season = ? AND season_type = ? AND week = ?
    `).all(season, ref.seasonType, ref.week);
    for (const d of defs) {
      const id = `DEF-${d.team_id}`;
      out.set(id, round1((out.get(id) || 0) + defensePoints(d, scoring)));
    }
    return out;
  });
}

// Average points over the previous four weeks, per player id
function projectionMap(db, season, settings, week) {
  const scoring = scoringFor(settings);
  const key = `proj:${season}:${week}:${settings.regular_weeks}:${JSON.stringify(scoring)}`;
  return cached(key, () => {
    const weeks = [];
    for (let w = Math.max(1, week - 4); w < week; w++) weeks.push(w);
    const sums = new Map();
    for (const w of weeks) {
      for (const [pid, pts] of weekPoints(db, season, settings, w)) {
        sums.set(pid, (sums.get(pid) || 0) + pts);
      }
    }
    const n = weeks.length || 1;
    const out = new Map();
    for (const [pid, total] of sums) out.set(pid, round1(total / n));
    return out;
  });
}

function weekStatus(week, liveWeek) {
  if (week < liveWeek) return 'final';
  if (week === liveWeek) return 'live';
  return 'upcoming';
}

// A game counts as live from an hour before kickoff until six hours after it, until CFBD marks it final.
const LIVE_BEFORE_MS = 60 * 60 * 1000;
const LIVE_AFTER_MS = 6 * 60 * 60 * 1000;

// Games in a league week that are not final. `window` counts the ones in the live window now (refresh them),
// `inProgress` the ones that have already kicked off.
function liveGames(db, seasonYear, week, now = Date.now()) {
  const ref = weekRef(week);
  const rows = db.prepare(`
    SELECT start_date FROM games
    WHERE season = ? AND season_type = ? AND week = ? AND completed = 0 AND start_date IS NOT NULL
  `).all(seasonYear, ref.seasonType, ref.week);
  let window = 0;
  let inProgress = 0;
  for (const r of rows) {
    const t = Date.parse(r.start_date);
    if (Number.isNaN(t)) continue;
    if (t >= now - LIVE_AFTER_MS && t <= now + LIVE_BEFORE_MS) window++;
    if (t <= now && t >= now - LIVE_AFTER_MS) inProgress++;
  }
  return { window, inProgress };
}

module.exports = {
  cached,
  clearCache,
  currentWeek,
  setCurrentWeek,
  weekRef,
  weekPoints,
  projectionMap,
  weekStatus,
  liveGames,
  average
};
