'use strict';

const fs = require('fs');
const path = require('path');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(`Power Four Fantasy needs Node.js 22.13 or newer (built-in node:sqlite). Running ${process.version}.`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  school TEXT NOT NULL,
  mascot TEXT,
  abbreviation TEXT,
  conference TEXT,
  group_key TEXT NOT NULL,
  color TEXT,
  alt_color TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  name TEXT NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  position TEXT NOT NULL,
  jersey INTEGER,
  guessed_position INTEGER NOT NULL DEFAULT 0,
  departed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS players_pos ON players(position);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  season_type TEXT NOT NULL,
  start_date TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  home_id INTEGER,
  away_id INTEGER,
  home_points INTEGER,
  away_points INTEGER
);
CREATE INDEX IF NOT EXISTS games_week ON games(season, season_type, week);

-- Derived per-player, per-game stat lines (not raw API responses)
CREATE TABLE IF NOT EXISTS player_games (
  game_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  season_type TEXT NOT NULL,
  week INTEGER NOT NULL,
  pass_att INTEGER NOT NULL DEFAULT 0,
  pass_cmp INTEGER NOT NULL DEFAULT 0,
  pass_yd REAL NOT NULL DEFAULT 0,
  pass_td REAL NOT NULL DEFAULT 0,
  pass_int REAL NOT NULL DEFAULT 0,
  rush_att INTEGER NOT NULL DEFAULT 0,
  rush_yd REAL NOT NULL DEFAULT 0,
  rush_td REAL NOT NULL DEFAULT 0,
  rec INTEGER NOT NULL DEFAULT 0,
  rec_yd REAL NOT NULL DEFAULT 0,
  rec_td REAL NOT NULL DEFAULT 0,
  fum_lost REAL NOT NULL DEFAULT 0,
  fgm REAL NOT NULL DEFAULT 0,
  fga REAL NOT NULL DEFAULT 0,
  xpm REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX IF NOT EXISTS pg_week ON player_games(season, season_type, week);
CREATE INDEX IF NOT EXISTS pg_player ON player_games(player_id);

-- Team defense per game: points allowed plus defensive plays
CREATE TABLE IF NOT EXISTS defense_games (
  game_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  season_type TEXT NOT NULL,
  week INTEGER NOT NULL,
  points_allowed INTEGER,
  sacks REAL NOT NULL DEFAULT 0,
  def_int REAL NOT NULL DEFAULT 0,
  def_td REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, team_id)
);
CREATE INDEX IF NOT EXISTS dg_week ON defense_games(season, season_type, week);

CREATE TABLE IF NOT EXISTS season_state (
  season INTEGER PRIMARY KEY,
  current_week INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  recovery_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  season INTEGER NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  commissioner_id INTEGER NOT NULL REFERENCES users(id),
  settings TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'predraft',
  start_week INTEGER,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fantasy_teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  is_cpu INTEGER NOT NULL DEFAULT 0,
  draft_slot INTEGER,
  waiver_priority INTEGER NOT NULL DEFAULT 0,
  faab INTEGER NOT NULL DEFAULT 0,
  vacated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ft_league ON fantasy_teams(league_id);

-- Injury or availability note for a player, entered by hand. CFBD does not publish injury reports.
CREATE TABLE IF NOT EXISTS player_status (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  status TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL
);

-- Messages sent through Settings > Help. Read with: npm run feedback
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  league_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_user ON feedback(user_id, created_at);

-- Current roster: each row is one player on one fantasy team, with its lineup slot
CREATE TABLE IF NOT EXISTS roster (
  team_id INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  slot TEXT NOT NULL DEFAULT 'BN',
  PRIMARY KEY (team_id, player_id)
);
CREATE INDEX IF NOT EXISTS roster_player ON roster(player_id);

-- Lineup actually used in a finished week, copied when the week advances
CREATE TABLE IF NOT EXISTS lineup_locks (
  team_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  PRIMARY KEY (team_id, week, player_id)
);

-- Each team's draft queue: the player it wants next, in order. Used when its pick times out.
CREATE TABLE IF NOT EXISTS draft_queue (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (team_id, player_id)
);

CREATE TABLE IF NOT EXISTS drafts (
  league_id INTEGER PRIMARY KEY REFERENCES leagues(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  draft_order TEXT,
  current_pick INTEGER NOT NULL DEFAULT 1,
  pick_deadline TEXT,
  total_picks INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS draft_picks (
  league_id INTEGER NOT NULL,
  pick_no INTEGER NOT NULL,
  round INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  player_id TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  made_at TEXT,
  PRIMARY KEY (league_id, pick_no)
);

CREATE TABLE IF NOT EXISTS matchups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  home_team_id INTEGER,
  away_team_id INTEGER,
  playoff_round INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS matchups_league_week ON matchups(league_id, week);

CREATE TABLE IF NOT EXISTS waiver_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  drop_player_id TEXT,
  week INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  bid INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  from_team_id INTEGER NOT NULL REFERENCES fantasy_teams(id),
  to_team_id INTEGER NOT NULL REFERENCES fantasy_teams(id),
  give TEXT NOT NULL,
  get_players TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week INTEGER,
  kind TEXT NOT NULL,
  team_id INTEGER,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tx_league ON transactions(league_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_league ON messages(league_id, id);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Final standings of a finished league, kept for league history
CREATE TABLE IF NOT EXISTS season_results (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  league_name TEXT NOT NULL,
  team_name TEXT NOT NULL,
  owner TEXT,
  user_id INTEGER,
  place INTEGER NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  points_for REAL NOT NULL DEFAULT 0,
  champion INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (league_id, team_id)
);
CREATE INDEX IF NOT EXISTS sr_user ON season_results(user_id);
`;

// Columns added after the first release. CREATE TABLE above already has them for new databases;
// this brings an older database file up to date.
const ADDED_COLUMNS = [
  ['players', 'departed', 'INTEGER NOT NULL DEFAULT 0'],
  ['fantasy_teams', 'faab', 'INTEGER NOT NULL DEFAULT 0'],
  ['waiver_claims', 'bid', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'recovery_hash', 'TEXT'],
  ['leagues', 'finished_at', 'TEXT'],
  ['fantasy_teams', 'vacated', 'INTEGER NOT NULL DEFAULT 0']
];

function migrate(db) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

// Pass ':memory:' for a throwaway database (tests). Anything else is a file, created with its folder if needed.
function openDb(file) {
  const memory = file === ':memory:';
  const target = memory ? file : path.resolve(file);
  if (!memory) fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  // Another process (the CLI, a backup) waits up to 5 seconds for the write lock instead of failing at once
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  if (!memory) db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Runs fn inside a transaction, rolling back on error.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---- Backups ---------------------------------------------------------------
// VACUUM INTO writes a consistent copy while the app keeps running. Files are named pf-YYYYMMDD-HHMMSSmmm.sqlite (UTC).

const BACKUP_NAME = /^pf-\d{8}-\d{9}\.sqlite$/;

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => BACKUP_NAME.test(f))
    .sort()
    .reverse()
    .map((f) => path.join(dir, f));
}

function backupDatabase(db, dir, keep = 14) {
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${ms}`;
  const file = path.join(dir, `pf-${stamp}.sqlite`);
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const old of listBackups(dir).slice(Math.max(1, keep))) fs.rmSync(old, { force: true });
  return file;
}

module.exports = { openDb, tx, getMeta, setMeta, backupDatabase, listBackups, BACKUP_NAME };
