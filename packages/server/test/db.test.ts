import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.js';
import { MIGRATIONS } from '../src/db/migrations.js';

it('reopens a migrated SQLite file without losing data or reapplying migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-claws-db-'));
  const file = join(dir, 'state.sqlite');
  let db = openDb(file);
  try {
    const migrations = db.prepare('SELECT * FROM schema_migrations ORDER BY id').all();
    expect(migrations).toHaveLength(MIGRATIONS.length);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    db.exec('CREATE TABLE runtime_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO runtime_probe (value) VALUES (?)').run('persisted');
    db.close();
    db = openDb(file);
    expect(db.prepare('SELECT value FROM runtime_probe').get()).toEqual({ value: 'persisted' });
    expect(db.prepare('SELECT * FROM schema_migrations ORDER BY id').all()).toEqual(migrations);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('enforces foreign keys and rolls back failed transactions with the Bun driver', () => {
  const db = openDb(':memory:');
  try {
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    db.exec('CREATE TABLE parent_probe (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE child_probe (parent_id INTEGER REFERENCES parent_probe(id))');
    const write = db.transaction(() => {
      db.prepare('INSERT INTO parent_probe VALUES (?)').run(1);
      db.prepare('INSERT INTO child_probe VALUES (?)').run(2);
    });
    expect(write).toThrow();
    expect(db.prepare('SELECT * FROM parent_probe').all()).toEqual([]);
  } finally {
    db.close();
  }
});
