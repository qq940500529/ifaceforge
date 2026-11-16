import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { projectFile } from '../app/files.js';
import type { ProjectPaths } from '../app/project.js';

export const desktopDatabaseVersion = 1;
export const desktopDatabaseId = 0x49464744;

export function openProjectDatabase(project: ProjectPaths): DatabaseSync {
  mkdirSync(project.data, { recursive: true, mode: 0o700 });
  const path = projectFile(project.data, 'workbench.sqlite', false);
  const database = new DatabaseSync(path, { timeout: 2500 });
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    const identifier = Number(database.prepare('PRAGMA application_id').get()?.application_id);
    if (version === 0 && identifier === 0) {
      database.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE records (
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          value TEXT NOT NULL CHECK(json_valid(value)),
          updated TEXT NOT NULL,
          PRIMARY KEY (collection, id)
        ) STRICT;
        CREATE INDEX records_updated ON records(collection, updated);
        PRAGMA application_id = ${desktopDatabaseId};
        PRAGMA user_version = ${desktopDatabaseVersion};
      `);
    } else if (version !== desktopDatabaseVersion || identifier !== desktopDatabaseId) {
      throw new Error('Unrecognized IfaceForge desktop database.');
    }
    database.exec('COMMIT');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
