import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../app/errors.js';

export type Collection =
  | 'profiles'
  | 'scans'
  | 'scan_files'
  | 'cases'
  | 'suites'
  | 'runs'
  | 'wiki_exports'
  | 'observations'
  | 'git_snapshots';

export class Repository {
  constructor(readonly db: DatabaseSync) {}

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get<T>(collection: Collection, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE collection = ? AND id = ?').get(collection, id);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }

  require<T>(collection: Collection, id: string): T {
    const record = this.get<T>(collection, id);
    if (!record) throw new AppError('NOT_FOUND', 'Record not found', 3, { collection, id });
    return record;
  }

  list<T>(collection: Collection): T[] {
    return this.db
      .prepare('SELECT value FROM records WHERE collection = ? ORDER BY updated DESC, id')
      .all(collection)
      .map((row) => JSON.parse(String(row.value)) as T);
  }

  put(collection: Collection, id: string, value: unknown) {
    this.db
      .prepare(
        `
      INSERT INTO records (collection, id, value, updated) VALUES (?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET value = excluded.value, updated = excluded.updated
    `,
      )
      .run(collection, id, JSON.stringify(value), new Date().toISOString());
  }

  remove(collection: Collection, id: string) {
    return Number(
      this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(collection, id).changes,
    );
  }

  setting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return undefined;
    const value = String(row.value);
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  set(key: string, value: unknown) {
    this.db
      .prepare(
        `
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
      )
      .run(key, JSON.stringify(value));
  }
}
