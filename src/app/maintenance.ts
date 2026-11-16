import { backup, DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { AppError, invalid } from './errors.js';
import { digest, isInside, parseJson, projectFile } from './files.js';
import type { ProjectPaths } from './project.js';
import type { Repository } from '../storage/repository.js';
import type { Run } from './runs.js';

const maxBackup = 512 * 1024 * 1024;
const managedNotes = /^[^/\\]+\.md$/i;
function notesDir(project: ProjectPaths) {
  return projectFile(project.root, relative(project.root, join(project.data, 'wiki-notes')), false);
}

function writeAtomic(path: string, contents: string) {
  const stage = mkdtempSync(join(dirname(path), '.ifg-data-'));
  try {
    writeFileSync(join(stage, 'result'), contents, { flag: 'wx' });
    renameSync(join(stage, 'result'), path);
  } finally {
    if (dirname(stage) === dirname(path)) rmSync(stage, { recursive: true, force: true });
  }
}

export async function backupData(project: ProjectPaths, repository: Repository, target: string) {
  const out = resolve(target);
  if (isInside(project.data, out)) invalid('Backup destination must be outside the managed data directory');
  if (existsSync(out)) throw new AppError('FILE_EXISTS', 'Backup destination already exists', 3, { out });
  const stage = mkdtempSync(join(project.data, '.ifg-data-'));
  try {
    const copy = join(stage, 'backup.sqlite');
    await backup(repository.db, copy);
    const data = readFileSync(copy);
    const dir = notesDir(project);
    const notes = existsSync(dir)
      ? Object.fromEntries(
          readdirSync(dir)
            .filter((name) => managedNotes.test(name))
            .map((name) => [
              name,
              readFileSync(projectFile(project.root, relative(project.root, join(dir, name))), 'utf8'),
            ]),
        )
      : {};
    const archive = JSON.stringify({
      format: 'ifaceforge-backup',
      schemaVersion: 1,
      sha256: digest(data),
      sqlite: data.toString('base64'),
      notes,
    });
    if (Buffer.byteLength(archive) > maxBackup) invalid('Backup exceeds the supported size');
    writeAtomic(out, archive);
    return { out, bytes: Buffer.byteLength(archive), sha256: digest(archive) };
  } finally {
    if (dirname(stage) === project.data) rmSync(stage, { recursive: true, force: true });
  }
}

export function restoreData(project: ProjectPaths, repository: Repository, file: string, replace = false) {
  const input = readFileSync(file);
  if (input.length > maxBackup) invalid('Backup exceeds the supported size');
  const archive = parseJson(input.toString('utf8')) as {
    format: string;
    schemaVersion: number;
    sha256: string;
    sqlite: string;
    notes: Record<string, string>;
  };
  if (
    !archive ||
    archive.format !== 'ifaceforge-backup' ||
    archive.schemaVersion !== 1 ||
    typeof archive.sqlite !== 'string' ||
    !archive.notes ||
    Array.isArray(archive.notes) ||
    typeof archive.notes !== 'object'
  )
    invalid('Invalid IfaceForge backup');
  const sqlite = Buffer.from(archive.sqlite, 'base64');
  if (digest(sqlite) !== archive.sha256) invalid('Backup checksum mismatch');
  const notes = Object.entries(archive.notes);
  if (
    notes.some(
      ([name, content]) =>
        !managedNotes.test(name) ||
        basename(name) !== name ||
        /[:<>|?*]/.test(name) ||
        typeof content !== 'string' ||
        Buffer.byteLength(content) > 1024 * 1024,
    )
  )
    invalid('Invalid backup note');
  const stage = mkdtempSync(join(project.data, '.ifg-restore-'));
  const dir = notesDir(project);
  const sqlitePath = join(stage, 'backup.sqlite');
  try {
    writeFileSync(sqlitePath, sqlite);
    const copy = new DatabaseSync(sqlitePath, { readOnly: true, allowExtension: false });
    let settings;
    let records;
    try {
      const integrity = copy.prepare('PRAGMA quick_check').get()?.quick_check;
      const version = Number(copy.prepare('PRAGMA user_version').get()?.user_version);
      if (integrity !== 'ok' || ![1, 2].includes(version)) invalid('Unrecognized database backup');
      settings = copy.prepare('SELECT key, value FROM settings').all();
      records = version === 2 ? copy.prepare('SELECT collection, id, value, updated FROM records').all() : [];
    } finally {
      copy.close();
    }
    const next = join(stage, 'notes');
    mkdirSync(next);
    for (const [name, content] of notes) writeFileSync(join(next, name), content, { flag: 'wx' });
    const previous = join(stage, 'previous');
    let movedPrevious = false;
    let movedNext = false;
    try {
      repository.transaction(() => {
        if (
          !replace &&
          (repository.db.prepare('SELECT 1 FROM settings UNION ALL SELECT 1 FROM records LIMIT 1').get() ||
            (existsSync(dir) && readdirSync(dir).length))
        ) {
          throw new AppError('REPLACE_REQUIRED', 'Restore would replace existing project data', 3, { file });
        }
        if (repository.list<Run>('runs').some((run) => run.status === 'running')) {
          throw new AppError('BUSY', 'A run is still active');
        }
        repository.db.exec('DELETE FROM settings; DELETE FROM records');
        const set = repository.db.prepare('INSERT INTO settings VALUES (?, ?)');
        for (const row of settings) set.run(row.key, row.value);
        const insert = repository.db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)');
        for (const row of records) {
          if (row.collection === 'wiki_exports') continue;
          insert.run(row.collection, row.id, row.value, row.updated);
        }
        if (existsSync(dir)) {
          renameSync(dir, previous);
          movedPrevious = true;
        }
        renameSync(next, dir);
        movedNext = true;
      });
    } catch (error) {
      if (movedNext) renameSync(dir, next);
      if (movedPrevious) renameSync(previous, dir);
      throw error;
    }
    return { file: resolve(file), settings: settings.length, records: records.length, notes: notes.length };
  } finally {
    if (dirname(stage) === project.data) rmSync(stage, { recursive: true, force: true });
  }
}

export function pruneData(repository: Repository, before: string, apply = false) {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(before) || Number.isNaN(Date.parse(before)))
    invalid('Expected an ISO 8601 date');
  return repository.transaction(() => {
    const ids = repository
      .list<Run>('runs')
      .filter((run) => run.finished && Date.parse(run.finished) < Date.parse(before))
      .map((run) => run.id);
    if (apply) for (const id of ids) repository.remove('runs', id);
    return { before: new Date(before).toISOString(), applied: apply, ids };
  });
}
