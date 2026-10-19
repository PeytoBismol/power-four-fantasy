#!/usr/bin/env node
'use strict';

// Command line tools.
//   node src/cli.js status                       show the season clock, data freshness and row counts
//   node src/cli.js advance                      close the current week (claims, lineup locks, playoffs)
//   node src/cli.js demo                         create a demo coach with a finished draft (run ingest first)
//   node src/cli.js backup                       copy the database into BACKUP_DIR now
//   node src/cli.js reset-password <email> <pw>  set a new password (signs the user out everywhere)
//   node src/cli.js injury <player> <status>     set an injury note by hand (Questionable, Doubtful, Out, Injured reserve, or clear)
//   node src/cli.js feedback                     show the latest messages sent from Settings > Help

require('./env').loadEnv();

const path = require('path');
const crypto = require('crypto');
const { openDb, tx, getMeta, setMeta, backupDatabase } = require('./db');
const { SEASON, INJURY_STATUSES } = require('./config');
const { hashPassword, nowIso } = require('./util');
const season = require('./season');
const flow = require('./flow');
const draft = require('./draft');
const L = require('./league');
const { settingsFrom } = require('./maintenance');
const { newRecoveryCode, normalizeCode } = require('./api');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'power-four.sqlite');
const DEMO_EMAIL = 'demo@powerfour.local';
const DEMO_LEAGUE = 'Demo League';

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function status(db) {
  console.log(`Season ${SEASON}, current week ${season.currentWeek(db)}`);
  console.log(`Data: ${getMeta(db, 'data_source', 'none')}, last ingest ${getMeta(db, 'last_ingest_at', 'never')}`);
  const refresh = settingsFrom(DB_FILE);
  console.log(`Refresh: full every ${refresh.ingestHours || 'never'} h, live scores every ${refresh.liveMinutes || 'never'} min while games are on`);
  const ingestError = getMeta(db, 'last_ingest_error', '');
  if (ingestError) console.log(`Last ingest failed: ${ingestError}`);
  console.log(`Last backup ${getMeta(db, 'last_backup_at', 'never')}`);
  console.log(`Teams ${count(db, 'teams')}, players ${count(db, 'players')}, games ${count(db, 'games')}`);
  console.log(`Users ${count(db, 'users')}, leagues ${count(db, 'leagues')}`);
}

function backup(db) {
  const { backupDir, keep } = settingsFrom(DB_FILE);
  const file = backupDatabase(db, backupDir, keep);
  tx(db, () => setMeta(db, 'last_backup_at', nowIso()));
  console.log(`Backup saved to ${file}`);
  console.log(`Keeping the newest ${keep}. Set BACKUP_KEEP to change that.`);
}

// For accounts that signed up before recovery codes existed, or a user who lost both password and code
function resetPassword(db, email, password) {
  const address = String(email || '').trim().toLowerCase();
  if (!address || !password) throw new Error('Usage: node src/cli.js reset-password <email> <new password>');
  if (password.length < 8) throw new Error('The new password must be at least 8 characters.');
  const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(address);
  if (!user) throw new Error(`No account uses ${address}.`);
  const recovery = newRecoveryCode();
  tx(db, () => {
    db.prepare('UPDATE users SET password_hash = ?, recovery_hash = ? WHERE id = ?')
      .run(hashPassword(password), hashPassword(normalizeCode(recovery)), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  });
  console.log(`Password reset for ${user.name} (${address}). Every session for that account is signed out.`);
  console.log(`New recovery code: ${recovery}`);
}

function advance(db) {
  const r = tx(db, () => flow.advanceWeek(db, SEASON));
  console.log(`Week ${r.from} is closed. Now week ${r.to}, with ${r.leagues} league(s) processed.`);
}

// Runs the demo coach's draft to the end: the script makes every pick for them
function finishDemoDraft(db, league, user) {
  draft.startDraft(db, league, user);
  for (let guard = 0; guard < 1000; guard++) {
    const current = L.getLeague(db, league.id);
    if (current.status !== 'drafting') break;
    const state = draft.draftState(db, current, user.id);
    if (!state.on_clock) break;
    const pid = draft.autopick(db, current, state.on_clock.id, state.round, season.currentWeek(db));
    draft.makePick(db, current, user, pid);
  }
}

// One demo coach and one demo league, reused on every run. Each run sets a fresh password.
function demo(db) {
  if (!count(db, 'teams')) throw new Error('No teams in the database yet. Run `npm run ingest:demo` or `npm run ingest` first.');
  const password = crypto.randomBytes(9).toString('base64url');
  const result = tx(db, () => {
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(DEMO_EMAIL);
    if (user) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    } else {
      const info = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(DEMO_EMAIL, 'Demo Coach', hashPassword(password), nowIso());
      user = { id: Number(info.lastInsertRowid), name: 'Demo Coach' };
    }
    const existing = db.prepare('SELECT id FROM leagues WHERE commissioner_id = ? AND name = ? ORDER BY id LIMIT 1')
      .get(user.id, DEMO_LEAGUE);
    if (existing) return { leagueId: existing.id, created: false };
    const league = L.createLeague(db, user, { name: DEMO_LEAGUE });
    finishDemoDraft(db, league, user);
    return { leagueId: league.id, created: true };
  });
  console.log(`Demo league ${result.leagueId} is ready${result.created ? ' (draft complete)' : ''}.`);
  console.log(`Sign in with ${DEMO_EMAIL} and password ${password}`);
  console.log('Run `npm run demo` again for a fresh password. The same demo league is reused.');
}

// Sets or clears a player's injury note. CollegeFootballData has no injury feed, so this is entered by hand.
function injury(db, query, status, note) {
  const q = String(query || '').trim();
  if (!q || !status) {
    throw new Error(`Usage: node src/cli.js injury <player name or id> <${INJURY_STATUSES.join('|')}|clear> [note]`);
  }
  const matches = db.prepare(`
    SELECT p.id, p.name, t.school FROM players p JOIN teams t ON t.id = p.team_id
    WHERE p.departed = 0 AND (p.id = ? OR p.name LIKE ?)
    ORDER BY p.name LIMIT 6
  `).all(q, `%${q}%`);
  if (!matches.length) throw new Error(`No player matches "${q}".`);
  if (matches.length > 1) {
    throw new Error(`More than one player matches "${q}": ${matches.map((m) => `${m.name} (${m.school}, id ${m.id})`).join('; ')}. Use the id.`);
  }
  const p = matches[0];
  const wanted = String(status).trim().toLowerCase();
  if (wanted === 'clear' || wanted === 'healthy') {
    tx(db, () => db.prepare('DELETE FROM player_status WHERE player_id = ?').run(p.id));
    console.log(`${p.name} (${p.school}) is cleared. No injury note.`);
    return;
  }
  const label = INJURY_STATUSES.find((s) => s.toLowerCase() === wanted);
  if (!label) throw new Error(`Status must be one of ${INJURY_STATUSES.join(', ')}, or clear.`);
  const text = note ? String(note).trim().slice(0, 200) : null;
  tx(db, () => {
    db.prepare(`
      INSERT INTO player_status (player_id, status, note, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(player_id) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at
    `).run(p.id, label, text, nowIso());
  });
  console.log(`${p.name} (${p.school}) is now ${label}${text ? `: ${text}` : ''}. Every league shows it from now on.`);
}

function feedback(db) {
  const rows = db.prepare(`
    SELECT f.id, f.body, f.created_at, f.league_id, u.name, u.email
    FROM feedback f LEFT JOIN users u ON u.id = f.user_id
    ORDER BY f.id DESC LIMIT 30
  `).all();
  if (!rows.length) {
    console.log('No messages yet.');
    return;
  }
  for (const r of rows) {
    const from = r.name ? `${r.name} <${r.email}>` : 'a deleted account';
    console.log(`#${r.id}  ${r.created_at}  from ${from}${r.league_id ? `  (league ${r.league_id})` : ''}`);
    console.log(`    ${r.body.replace(/\s+/g, ' ')}`);
  }
}

const [cmd = 'status', ...rest] = process.argv.slice(2);
const db = openDb(DB_FILE);
try {
  if (cmd === 'status') status(db);
  else if (cmd === 'advance') advance(db);
  else if (cmd === 'demo') demo(db);
  else if (cmd === 'backup') backup(db);
  else if (cmd === 'reset-password') resetPassword(db, rest[0], rest[1]);
  else if (cmd === 'injury') injury(db, rest[0], rest[1], rest.slice(2).join(' '));
  else if (cmd === 'feedback') feedback(db);
  else {
    console.error(`Unknown command "${cmd}". Use status, advance, demo, backup, reset-password, injury or feedback.`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
