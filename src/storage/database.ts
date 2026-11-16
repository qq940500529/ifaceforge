import { mkdirSync } from 'node:fs';
import { relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectFile } from '../app/files.js';
import type { ProjectPaths } from '../app/project.js';

const schemaVersion = 2;

export function openProjectDatabase(project: ProjectPaths): DatabaseSync {
  projectFile(project.root, relative(project.root, project.database), false);
  mkdirSync(project.data, { recursive: true });
  const database = new DatabaseSync(project.database, { timeout: 2_000 });
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > schemaVersion) {
      throw new Error(`Database version ${version} requires a newer release of IfaceForge.`);
    }
    if (version < 1) {
      database.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    }
    if (version < 2) {
      database.exec(`
        CREATE TABLE records (
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          value TEXT NOT NULL CHECK(json_valid(value)),
          updated TEXT NOT NULL,
          PRIMARY KEY (collection, id)
        ) STRICT;
        CREATE INDEX records_updated ON records(collection, updated);
        PRAGMA user_version = 2;
      `);
    }
    database.exec('COMMIT');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
