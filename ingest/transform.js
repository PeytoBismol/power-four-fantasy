'use strict';

// Turns CollegeFootballData responses into the rows the app stores. Pure functions, no database access.

const { CFBD_REGULAR_WEEKS } = require('../src/config');

const POSITION_MAP = { QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE', K: 'K', PK: 'K' };

// Roster position code -> app position. Anything else returns null and is inferred from stats later.
function normalizePosition(raw) {
  return POSITION_MAP[String(raw || '').trim().toUpperCase()] || null;
}

// CFBD colors are hex strings like "#0C2340". Anything else is stored as null.
function normalizeColor(raw) {
  const m = String(raw || '').trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `#${m[1].toUpperCase()}` : null;
}

// League week for a CFBD week. Regular weeks keep their number; postseason weeks follow the regular season.
function leagueWeekOf(seasonType, week) {
  return seasonType === 'postseason' ? CFBD_REGULAR_WEEKS + week : week;
}

function zeroStats() {
  return {
    pass_cmp: 0, pass_att: 0, pass_yd: 0, pass_td: 0, pass_int: 0,
    rush_att: 0, rush_yd: 0, rush_td: 0,
    rec: 0, rec_yd: 0, rec_td: 0,
    fum_lost: 0, fgm: 0, fga: 0, xpm: 0
  };
}

function num(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// "12/18" -> [12, 18]. A plain "2" -> [2, 0].
function madeAtt(v) {
  const s = String(v ?? '');
  if (!s.includes('/')) return [num(s), 0];
  const [made, att] = s.split('/');
  return [num(made), num(att)];
}

// Offense: CFBD category -> stat type -> how it adds to one player's line.
// Anything not listed here is ignored (punting, returns, player-level defense).
const PLAYER_STATS = {
  passing: {
    'C/ATT': (s, v) => { const [c, a] = madeAtt(v); s.pass_cmp += c; s.pass_att += a; },
    YDS: (s, v) => { s.pass_yd += num(v); },
    TD: (s, v) => { s.pass_td += num(v); },
    INT: (s, v) => { s.pass_int += num(v); }
  },
  rushing: {
    CAR: (s, v) => { s.rush_att += num(v); },
    YDS: (s, v) => { s.rush_yd += num(v); },
    TD: (s, v) => { s.rush_td += num(v); }
  },
  receiving: {
    REC: (s, v) => { s.rec += num(v); },
    YDS: (s, v) => { s.rec_yd += num(v); },
    TD: (s, v) => { s.rec_td += num(v); }
  },
  fumbles: {
    LOST: (s, v) => { s.fum_lost += num(v); }
  },
  kicking: {
    FG: (s, v) => { const [m, a] = madeAtt(v); s.fgm += m; s.fga += a; },
    XP: (s, v) => { const [m] = madeAtt(v); s.xpm += m; }
  }
};

// Team defense: sums the athletes' lines in a game. DEF is scored per school, not per player.
const TEAM_DEFENSE_STATS = {
  defensive: {
    SACKS: (d, v) => { d.sacks += num(v); },
    TD: (d, v) => { d.defensive_td = (d.defensive_td || 0) + num(v); }
  },
  interceptions: {
    INT: (d, v) => { d.def_int += num(v); },
    TD: (d, v) => { d.int_td += num(v); }
  }
};

// One team's side of one game (a /games/players entry) -> offensive player lines and team defense totals
function parseSide(side) {
  const athletes = new Map();
  const defense = { sacks: 0, def_int: 0, defensive_td: null, int_td: 0 };
  for (const cat of side.categories || []) {
    const offense = PLAYER_STATS[cat.name];
    const defenseRules = TEAM_DEFENSE_STATS[cat.name];
    for (const type of cat.types || []) {
      for (const ath of type.athletes || []) {
        if (offense && Object.hasOwn(offense, type.name)) {
          const id = String(ath.id);
          if (!athletes.has(id)) athletes.set(id, { id, name: ath.name || id, stats: zeroStats() });
          offense[type.name](athletes.get(id).stats, ath.stat);
        }
        if (defenseRules && Object.hasOwn(defenseRules, type.name)) {
          defenseRules[type.name](defense, ath.stat);
        }
      }
    }
  }
  // Defensive TDs come from the defensive category when CFBD reports it, otherwise from interceptions
  const defTd = defense.defensive_td ?? defense.int_td;
  return {
    athletes: [...athletes.values()],
    defense: { sacks: defense.sacks, def_int: defense.def_int, def_td: defTd }
  };
}

function hasStats(s) {
  return Object.values(s).some((v) => v !== 0);
}

// Position for a player whose roster code is unknown, from the stats they actually produced
function inferPosition(s) {
  const kicks = (s.fga || 0) + (s.xpm || 0);
  if (kicks > 0 && !(s.pass_att || s.rush_att || s.rec)) return 'K';
  if ((s.pass_att || 0) >= 3) return 'QB';
  if ((s.rush_att || 0) > 0 && (s.rush_att || 0) > (s.rec || 0)) return 'RB';
  if ((s.rec || 0) > 0) return 'WR';
  if ((s.rush_att || 0) > 0) return 'RB';
  return null;
}

module.exports = {
  normalizePosition,
  normalizeColor,
  leagueWeekOf,
  zeroStats,
  parseSide,
  hasStats,
  inferPosition,
  PLAYER_STATS,
  TEAM_DEFENSE_STATS
};
