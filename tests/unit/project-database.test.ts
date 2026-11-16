import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProject } from '../../src/app/project.js';
import { openProjectDatabase } from '../../src/storage/database.js';

const fixtures: string[] = [];
const fixtureParent = realpathSync(tmpdir());

function makeDirectory(): string {
  const directory = mkdtempSync(join(fixtureParent, 'ifaceforge 测试 '));
  fixtures.push(directory);
  return directory;
}

function makeProject(): string {
  const project = makeDirectory();
  execFileSync('git', ['-C', project, 'init', '--quiet'], { stdio: 'ignore' });
  return project;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    const resolved = realpathSync(fixture);
    if (dirname(resolved) !== fixtureParent) throw new Error('Fixture escaped the temporary directory');
    rmSync(resolved, { recursive: true });
  }
});

describe('project storage', () => {
  it('finds the Git root from a child directory containing spaces and Chinese characters', () => {
    const root = makeProject();
    const nested = join(root, '测试 subdirectory');
    mkdirSync(nested);
    const project = resolveProject(nested);
    expect(project.root).toBe(realpathSync(root));
    expect(project.database).toBe(join(project.root, '.devtools', 'ifaceforge', 'data', 'workbench.sqlite'));
  });

  it('reports a useful error outside a Git worktree', () => {
    expect(() => resolveProject(makeDirectory())).toThrow(/Not inside a Git working tree/);
  });

  it('initializes on demand and persists settings across database opens', () => {
    const project = resolveProject(makeProject());
    let database = openProjectDatabase(project);
    try {
      database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('locale', 'zh-CN');
    } finally {
      database.close();
    }
    database = openProjectDatabase(project);
    try {
      expect(database.prepare('SELECT value FROM settings WHERE key = ?').get('locale')?.value).toBe('zh-CN');
      expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    } finally {
      database.close();
    }
  });

  it('opens a separate database for each project', () => {
    const first = openProjectDatabase(resolveProject(makeProject()));
    const second = openProjectDatabase(resolveProject(makeProject()));
    try {
      first.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('locale', 'zh-CN');
      expect(second.prepare('SELECT value FROM settings WHERE key = ?').get('locale')).toBeUndefined();
    } finally {
      first.close();
      second.close();
    }
  });
});
