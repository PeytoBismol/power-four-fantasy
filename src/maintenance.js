'use strict';

// Scheduled work for a running server. Started by the main entry point, not by createApp, so tests stay quiet.
//   INGEST_HOURS        how often to pull the full CFBD data set (rosters, schedules, every week). Default 12 with a CFBD key.
//   LIVE_SCORE_MINUTES  how often to pull just the week in play while games are on. Default 10 with a CFBD key.
//                       0 turns it off. Minimum 5, so the CFBD quota is not used up on game days.
//   BACKUP_HOURS        how often to copy the database. Default 24. 0 turns it off.
//   BACKUP_DIR          where copies go. Default: a backups folder next to the database file.
//   BACKUP_KEEP         how many copies to keep. Default 14. The oldest are deleted.

const path = require('path');
const { getMeta, setMeta, backupDatabase } = require('./db');
const { nowIso } = require('./util');
const { SEASON } = require('./config');
const season = require('./season');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const LIVE_MIN_MINUTES = 5;

function hours(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of hours. Use 0 to turn it off.`);
  return n;
}

function minutesSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of minutes. Use 0 to turn it off.`);
  if (n > 0 && n < LIVE_MIN_MINUTES) {
    throw new Error(`${name} must be 0 (off) or at least ${LIVE_MIN_MINUTES} minutes, so the CFBD quota is not used up.`);
  }
  return n;
}

function settingsFrom(dbFile) {
  const keyed = !!process.env.CFBD_API_KEY;
  return {
    ingestHours: hours('INGEST_HOURS', keyed ? 12 : 0),
    liveMinutes: minutesSetting('LIVE_SCORE_MINUTES', keyed ? 10 : 0),
    backupHours: hours('BACKUP_HOURS', 24),
    keep: Math.max(1, Number(process.env.BACKUP_KEEP) || 14),
    backupDir: process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(dbFile)), 'backups')
  };
}

// The CFBD work for one refresh. Errors are thrown to the caller, which records them.
async function refreshFromCfbd(kind, { db, log }) {
  const { createCfbdClient } = require('../ingest/cfbd');
  const source = createCfbdClient({ log });
  const autoAdvance = process.env.AUTO_ADVANCE !== '0';
  const logLine = (line) => log(`[ingest] ${line.trim()}`);
  if (kind === 'full') {
    const { ingestAll } = require('../ingest/ingest');
    const result = await ingestAll({ db, source, autoAdvance, log: logLine });
    log(`[ingest] full refresh done. Season on week ${result.currentWeek}. CFBD requests this run: ${source.requests()}`);
  } else {
    const { refreshLiveWeek } = require('../ingest/ingest');
    const r = await refreshLiveWeek({ db, source, autoAdvance, log: logLine });
    log(`[ingest] live scores: week ${r.week}, ${r.games} games, ${r.inProgress} in progress. CFBD requests this run: ${source.requests()}`);
  }
}

// Decides once a minute what to pull. A full refresh runs when it is due. Otherwise the week in play is
// refreshed every LIVE_SCORE_MINUTES, but only while a game is in its live window, so quiet weeks pull nothing.
// `now` and `run` can be replaced in tests.
function createScoreScheduler({ db, s, log = console.log, now = () => Date.now(), run = refreshFromCfbd }) {
  let busy = false;
  let lastFull = now();
  let lastLive = 0;

  async function execute(kind) {
    busy = true;
    try {
      await run(kind, { db, log });
      setMeta(db, 'last_ingest_error', '');
    } catch (err) {
      setMeta(db, 'last_ingest_error', `${nowIso()}: ${err.message}`);
      log(`[ingest] ${kind === 'full' ? 'full refresh' : 'live scores'} failed: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  return {
    // Starts a refresh if one is due. Returns 'full', 'live', or null when nothing ran.
    tick() {
      if (busy) return null;
      if (getMeta(db, 'data_source') === 'demo') return null;
      const t = now();
      if (s.ingestHours > 0 && t - lastFull >= s.ingestHours * HOUR_MS) {
        lastFull = t;
        lastLive = t;
        execute('full');
        return 'full';
      }
      if (s.liveMinutes > 0 && t - lastLive >= s.liveMinutes * MINUTE_MS) {
        const inWindow = season.liveGames(db, SEASON, season.currentWeek(db), t).window > 0;
        if (inWindow) {
          lastLive = t;
          execute('live');
          return 'live';
        }
      }
      return null;
    }
  };
}

function startMaintenance({ db, dbFile, log = console.log }) {
  const s = settingsFrom(dbFile);
  const timers = [];
  const memory = dbFile === ':memory:';

  log(`[maintenance] full refresh every ${s.ingestHours || 'never'} h, live scores every ${s.liveMinutes || 'never'} min during games, backup every ${s.backupHours || 'never'} h, keeping ${s.keep} in ${s.backupDir}`);

  if (s.backupHours > 0 && !memory) {
    const runBackup = () => {
      try {
        const file = backupDatabase(db, s.backupDir, s.keep);
        setMeta(db, 'last_backup_at', nowIso());
        log(`[backup] saved ${path.basename(file)}`);
      } catch (err) {
        log(`[backup] failed: ${err.message}`);
      }
    };
    const t = setInterval(runBackup, s.backupHours * HOUR_MS);
    t.unref();
    timers.push(t);
  }

  if (s.ingestHours > 0 || s.liveMinutes > 0) {
    if (!process.env.CFBD_API_KEY) {
      log('[ingest] INGEST_HOURS or LIVE_SCORE_MINUTES is set but CFBD_API_KEY is missing, so scheduled score refresh is off.');
    } else {
      const scheduler = createScoreScheduler({ db, s, log });
      const t = setInterval(() => scheduler.tick(), MINUTE_MS);
      t.unref();
      timers.push(t);
    }
  }

  return {
    settings: s,
    stop() {
      for (const t of timers) clearInterval(t);
    }
  };
}

module.exports = { startMaintenance, settingsFrom, createScoreScheduler };
