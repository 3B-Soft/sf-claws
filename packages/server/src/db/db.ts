import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = Database;

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { strict: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((r: any) => r.id as number),
  );
  const run = db.transaction(() => {
    MIGRATIONS.forEach((m, idx) => {
      const id = idx + 1;
      if (applied.has(id)) return;
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(id, m.name, new Date().toISOString());
    });
  });
  run();
}

export const nowIso = () => new Date().toISOString();

/** Convert sqlite row (snake_case, ints for bools, json strings) -> camelCase object. */
export function rowToObj<T = any>(row: any, opts: { bools?: string[]; json?: string[] } = {}): T {
  if (!row) return row;
  const out: any = {};
  for (const [k, v] of Object.entries(row)) {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    let val: any = v;
    // A nullable boolean column stays null: coercing SQL NULL to false loses the difference
    // between "the user said no" and "the user has not said". `sessions.helpful` is exactly that,
    // and flattening it made every unrated session render as "not helpful".
    if (opts.bools?.includes(camel)) val = v === null || v === undefined ? null : v === 1 || v === true;
    if (opts.json?.includes(camel) && typeof v === 'string') {
      try {
        val = JSON.parse(v);
      } catch {
        /* keep string */
      }
    }
    out[camel] = val;
  }
  return out as T;
}
