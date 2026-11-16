import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateProject } from '../../src/app/project.js';
import { desktopDatabaseId, openProjectDatabase } from '../../src/storage/database.js';
import { Projects } from '../../src/storage/projects.js';

const fixtures: string[] = [];
const fixtureParent = realpathSync.native(tmpdir());

function makeDirectory() {
  const directory = mkdtempSync(join(fixtureParent, 'ifaceforge 测试 '));
  fixtures.push(directory);
  return directory;
}
function makeProject() {
  const project = join(makeDirectory(), 'worktree');
  mkdirSync(project);
  execFileSync('git', ['-C', project, 'init', '--quiet'], { stdio: 'ignore' });
  return project;
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    const resolved = realpathSync.native(fixture);
    if (dirname(resolved) !== fixtureParent) throw new Error('Fixture escaped the temporary directory');
    rmSync(resolved, { recursive: true });
  }
});

describe('project storage', () => {
  it('reuses the same registration for a child directory and keeps data outside the worktree', () => {
    const root = makeProject();
    const nested = join(root, '测试 subdirectory');
    mkdirSync(nested);
    const projects = new Projects(makeDirectory());
    try {
      const record = projects.add(nested);
      expect(record.root).toBe(realpathSync.native(root));
      expect(projects.add(root).id).toBe(record.id);
      expect(projects.paths(record.id).database).toBe(
        join(projects.home, 'projects', record.id, 'workbench.sqlite'),
      );
    } finally {
      projects.close();
    }
  });
  it('reports a useful error outside a Git worktree', () => {
    expect(() => locateProject(makeDirectory())).toThrow(/Not inside a Git working tree/);
  });
  it('persists settings across database opens and isolates different worktrees', () => {
    const projects = new Projects(makeDirectory());
    const a = projects.paths(projects.add(makeProject()).id);
    const b = projects.paths(projects.add(makeProject()).id);
    let database = openProjectDatabase(a);
    const other = openProjectDatabase(b);
    try {
      database.prepare('INSERT INTO settings VALUES (?, ?)').run('locale', 'zh-CN');
      database.close();
      database = openProjectDatabase(a);
      expect(database.prepare('SELECT value FROM settings WHERE key = ?').get('locale')?.value).toBe('zh-CN');
      expect(other.prepare('SELECT value FROM settings WHERE key = ?').get('locale')).toBeUndefined();
      expect(database.prepare('PRAGMA application_id').get()?.application_id).toBe(desktopDatabaseId);
    } finally {
      database.close();
      other.close();
      projects.close();
    }
  });
  it('hides, relocates and deletes managed data while preserving source files', () => {
    const projects = new Projects(makeDirectory());
    const root = makeProject();
    const moved = join(dirname(root), 'moved worktree');
    try {
      const { id } = projects.add(root);
      const paths = projects.paths(id);
      openProjectDatabase(paths).close();
      projects.hide(id);
      expect(projects.list()[0].hidden).toBe(1);
      expect(projects.add(root).id).toBe(id);
      renameSync(root, moved);
      expect(projects.list()[0].available).toBe(false);
      expect(() => projects.relocate(id, makeProject())).toThrow(/original worktree/);
      expect(projects.relocate(id, moved).available).toBe(true);
      expect(projects.paths(id).database).toBe(paths.database);
      projects.delete(id);
      expect(existsSync(paths.data)).toBe(false);
      expect(existsSync(join(moved, '.git'))).toBe(true);
    } finally {
      projects.close();
    }
  });
});
