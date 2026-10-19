'use strict';

const { DEFAULT_SCORING } = require('./config');
const { round1 } = require('./util');

// Merges a league's scoring overrides onto the defaults
function scoringFor(settings) {
  return { ...DEFAULT_SCORING, ...((settings && settings.scoring) || {}) };
}

// Points allowed by a defense in one game (same brackets as the NFL fantasy convention)
function pointsAllowedPoints(n) {
  if (n === 0) return 10;
  if (n <= 6) return 7;
  if (n <= 13) return 4;
  if (n <= 20) return 1;
  if (n <= 27) return 0;
  if (n <= 34) return -1;
  return -4;
}

// One player's stat row (player_games shape) under a scoring table
function playerPoints(row, s) {
  if (!row) return 0;
  return round1(
    row.pass_yd * s.pass_yd +
    row.pass_td * s.pass_td +
    row.pass_int * s.pass_int +
    row.rush_yd * s.rush_yd +
    row.rush_td * s.rush_td +
    row.rec * s.rec +
    row.rec_yd * s.rec_yd +
    row.rec_td * s.rec_td +
    row.fum_lost * s.fum_lost +
    row.fgm * s.fg +
    row.xpm * s.xp
  );
}

// One team's defense row (defense_games shape)
function defensePoints(row, s) {
  if (!row) return 0;
  const pa = row.points_allowed == null ? 0 : pointsAllowedPoints(row.points_allowed);
  return round1(row.sacks * s.def_sack + row.def_int * s.def_int + row.def_td * s.def_td + pa);
}

function average(values) {
  if (!values.length) return 0;
  return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

module.exports = { scoringFor, pointsAllowedPoints, playerPoints, defensePoints, average };
