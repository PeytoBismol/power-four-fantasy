'use strict';

// Shared league rules. Change positions, lineup slots and default scoring here.

const SEASON = Number(process.env.SEASON || 2026);

// CFBD regular-season weeks 1-15 (week 15 is conference championship week). Later weeks are postseason.
const CFBD_REGULAR_WEEKS = 15;

// Conference groups. Matching uses CFBD's conference name, or the school name for Notre Dame.
const GROUPS = [
  { key: 'SEC', label: 'SEC', conference: 'SEC' },
  { key: 'BIG10', label: 'Big Ten', conference: 'Big Ten' },
  { key: 'BIG12', label: 'Big 12', conference: 'Big 12' },
  { key: 'ACC', label: 'ACC', conference: 'ACC' },
  { key: 'IND', label: 'Notre Dame', school: 'Notre Dame' }
];

// Players that count in fantasy. DEF is one pseudo-player per school.
const FANTASY_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

// Lineup slots, in display order. WRT takes a WR, RB or TE.
const SLOTS = ['QB', 'RB', 'WR', 'TE', 'WRT', 'K', 'DEF'];
const BENCH = 'BN';
const SLOT_ELIGIBLE = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  WRT: ['WR', 'RB', 'TE'],
  K: ['K'],
  DEF: ['DEF'],
  BN: FANTASY_POSITIONS
};

// Default starting lineup and roster size: 9 starters + 6 bench = 15.
const DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, WRT: 1, K: 1, DEF: 1, BN: 6 };

// Injury notes a league organiser can set by hand (see `npm run injury`). Out and Doubtful starters get a warning.
const INJURY_STATUSES = ['Questionable', 'Doubtful', 'Out', 'Injured reserve'];

// Per-team caps used by drafting bots so every roster stays playable.
const DRAFT_POSITION_CAPS = { QB: 3, RB: 5, WR: 6, TE: 3, K: 1, DEF: 1 };
const DRAFT_MINIMUMS = { QB: 2, RB: 3, WR: 3, TE: 1, K: 1, DEF: 1 };

const DEFAULT_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2,
  rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6,
  fum_lost: -2,
  fg: 3, xp: 1,
  def_sack: 1, def_int: 2, def_td: 6
};

const DEFAULT_SETTINGS = {
  roster: DEFAULT_ROSTER,
  scoring: DEFAULT_SCORING,
  team_count: 10,
  regular_weeks: 15,        // last regular-season week scored (15 = conference championship week)
  playoff_teams: 4,         // 0 = no playoffs, 4 = single-elimination semis and final
  pick_seconds: 90,         // pick timer; expired picks are auto-drafted
  format: 'h2h',            // 'h2h' = weekly matchups; 'points' = season total points, no schedule
  best_ball: false,         // true = the app starts the best projected lineup every week
  waiver_mode: 'priority',  // 'priority' = rotating order; 'faab' = sealed budget bids
  faab_budget: 100,         // starting FAAB dollars per team (faab mode only)
  trade_deadline_week: 0    // last league week trades are allowed; 0 = no deadline
};

const ROSTER_SIZE = Object.values(DEFAULT_ROSTER).reduce((a, b) => a + b, 0);

module.exports = {
  SEASON,
  CFBD_REGULAR_WEEKS,
  GROUPS,
  FANTASY_POSITIONS,
  SLOTS,
  BENCH,
  SLOT_ELIGIBLE,
  DEFAULT_ROSTER,
  DRAFT_POSITION_CAPS,
  DRAFT_MINIMUMS,
  INJURY_STATUSES,
  DEFAULT_SCORING,
  DEFAULT_SETTINGS,
  ROSTER_SIZE
};
