import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, invalid } from '../app/errors.js';
import { dataHome, locateProject, projectPaths } from '../app/project.js';
import { isInside, projectFile } from '../app/files.js';

export interface RegisteredProject {
  id: string;
  root: string;
  hidden: number;
  lastOpened: string;
  available: boolean;
}
type Row = Omit<RegisteredProject, 'available'> & { identity: string };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const identity = (path: string) => {
  const info = statSync(path, { bigint: true });
  return info.ino ? String(info.dev) + ':' + String(info.ino) : '';
};
const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

export class Projects {
  readonly home: string;
  private readonly db: DatabaseSync;

  constructor(home = dataHome()) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.home = realpathSync.native(home);
    this.db = new DatabaseSync(projectFile(this.home, 'projects.sqlite', false), { timeout: 2500 });
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL, pathKey TEXT NOT NULL UNIQUE, identity TEXT NOT NULL, hidden INTEGER NOT NULL, lastOpened TEXT NOT NULL) STRICT',
    );
    this.db.exec('CREATE TABLE IF NOT EXISTS preferences (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
  }

  close() {
    this.db.close();
  }

  list(): RegisteredProject[] {
    const rows = this.db
      .prepare('SELECT id, root, hidden, lastOpened, identity FROM projects ORDER BY lastOpened DESC')
      .all() as unknown as Row[];
    return rows.map(({ id, root, hidden, lastOpened, identity: original }) => {
      let available = false;
      try {
        available = realpathSync.native(root) === root && (!original || identity(root) === original);
      } catch {
        /* The selected worktree may be disconnected. */
      }
      return { id, root, hidden, lastOpened, available };
    });
  }

  private row(id: string): Row {
    if (!uuid.test(id)) invalid('Invalid project identifier');
    const row = this.db
      .prepare('SELECT id, root, identity, hidden, lastOpened FROM projects WHERE id = ?')
      .get(id) as unknown as Row | undefined;
    if (!row) throw new AppError('PROJECT_NOT_FOUND', 'Project not found.');
    return row;
  }

  touch(id: string) {
    this.row(id);
    this.db.prepare('UPDATE projects SET lastOpened = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  add(root: string) {
    root = locateProject(root);
    if (isInside(this.home, root)) invalid('Choose a worktree outside the app data directory');
    const now = new Date().toISOString();
    const original = identity(root);
    // Serialize concurrent CLI and desktop registration using the path constraint.
    this.db
      .prepare(
        'INSERT INTO projects VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(pathKey) DO UPDATE SET hidden = 0, lastOpened = excluded.lastOpened WHERE projects.identity = excluded.identity',
      )
      .run(randomUUID(), root, key(root), original, now);
    const row = this.db
      .prepare('SELECT id, root, identity, hidden, lastOpened FROM projects WHERE pathKey = ?')
      .get(key(root)) as unknown as Row;
    if (row.identity !== original)
      throw new AppError('PROJECT_REPLACED', 'The registered directory now contains a different worktree.');
    return { id: row.id, root: row.root, hidden: row.hidden, lastOpened: now, available: true };
  }

  hide(id: string) {
    this.row(id);
    this.db.prepare('UPDATE projects SET hidden = 1 WHERE id = ?').run(id);
  }

  delete(id: string) {
    const managed = this.managedPath(id);
    rmSync(managed, { recursive: true, force: true });
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  relocate(id: string, directory: string) {
    const current = this.row(id);
    const root = locateProject(directory);
    if (isInside(this.home, root)) invalid('Choose a worktree outside the app data directory');
    if (!current.identity || identity(root) !== current.identity) {
      throw new AppError(
        'DIFFERENT_PROJECT',
        'The selected directory is not the original worktree. Add it as a new project.',
      );
    }
    const duplicate = this.db.prepare('SELECT id FROM projects WHERE pathKey = ? AND id <> ?').get(key(root), id);
    if (duplicate) throw new AppError('PROJECT_EXISTS', 'This worktree is already registered.');
    this.db.prepare('UPDATE projects SET root = ?, pathKey = ?, hidden = 0 WHERE id = ?').run(root, key(root), id);
    return this.list().find((item) => item.id === id)!;
  }

  managedPath(id: string) {
    this.row(id);
    const relative = join('projects', id);
    const path = projectFile(this.home, relative, false);
    if (existsSync(path) && realpathSync.native(path) !== path) invalid('Project data cannot be redirected');
    const parent = dirname(path);
    if (existsSync(parent) && realpathSync.native(parent) !== parent)
      invalid('Project storage cannot be redirected');
    return path;
  }

  paths(id: string) {
    const row = this.row(id);
    let root: string;
    try {
      root = realpathSync.native(row.root);
    } catch {
      throw new AppError('PROJECT_OFFLINE', 'The project folder is unavailable. Locate it again.');
    }
    if (root !== row.root || (row.identity && identity(root) !== row.identity)) {
      throw new AppError('PROJECT_REPLACED', 'The project folder has changed. Locate the original worktree.');
    }
    return projectPaths(root, this.managedPath(id));
  }

  preference(name: string) {
    return this.db.prepare('SELECT value FROM preferences WHERE name = ?').get(name)?.value as string | undefined;
  }

  setPreference(name: string, value: string) {
    this.db
      .prepare('INSERT INTO preferences VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
      .run(name, value);
  }
}
