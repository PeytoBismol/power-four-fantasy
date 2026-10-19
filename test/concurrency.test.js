'use strict';

// Two processes on one database file. The server and a CLI command (advance, backup, reset-password) can run
// at the same time, so a write must wait for the other process's lock instead of failing at once.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, tx, getMeta, setMeta } = require('../src/db');

test('a write waits for another process to release the write lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-lock-'));
  const file = path.join(dir, 'lock.sqlite');
  const db = openDb(file);
  try {
    // The other process takes the write lock and holds it for 1.2 seconds
    const holder = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const other = new DatabaseSync(${JSON.stringify(file)});
      other.exec('BEGIN IMMEDIATE');
      other.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('held', '1')").run();
      process.stdout.write('locked\\n');
      const end = Date.now() + 1200;
      while (Date.now() < end) { /* hold the lock */ }
      other.exec('COMMIT');
      other.close();
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    await new Promise((resolve) => holder.stdout.once('data', resolve));

    const started = Date.now();
    tx(db, () => setMeta(db, 'waited', 'yes'));
    const waited = Date.now() - started;
    await exited;

    assert.equal(getMeta(db, 'waited'), 'yes', 'the write went through once the lock was free');
    assert.ok(waited >= 400, `the write waited for the lock (took ${waited} ms)`);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
