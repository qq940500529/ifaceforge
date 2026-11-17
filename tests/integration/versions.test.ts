import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { fixture, ifg, type Output } from '../support/fixture.js';

function result<T>(value: Output<T>) {
  expect(value.result.error).toBeNull();
  expect(value.exit).toBe(0);
  return value.result.data;
}

test('enumerates large histories by metadata and scans only requested commits without changing Git', async () => {
  const project = fixture();
  const { root, write } = project;
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.name=Version Test', '-c', 'user.email=test@example.invalid', ...args],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();
  const commit = (message: string) => {
    git('add', '.');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    const contract = {
      openapi: '3.2.1',
      info: { title: 'Service', version: '2' },
      paths: {
        '/widgets': {
          get: {
            summary: 'List widgets',
            responses: {
              200: {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: './schema-接口.json' } } },
              },
            },
          },
        },
      },
    };
    write('openapi.versioned.json', contract);
    write('schema-接口.json', { type: 'string' });
    write('provider/Main.java', {});
    write('mcp-capabilities.json', {
      schemaVersion: 1,
      service: 'portable',
      protocolVersion: '2026-07-28',
      tools: [{ name: 'list-widgets', inputSchema: { type: 'object' } }],
      resources: [{ name: 'one', uri: 'widget://1' }],
      resourceTemplates: [{ name: 'item', uriTemplate: 'widget://{id}' }],
      prompts: [{ name: 'describe' }],
    });
    const historicSkill = 'skills/read-tasks/SKILL.md';
    writeFileSync(
      join(root, historicSkill),
      '---\nname: read-tasks\ndescription: Read tasks\n---\n[guide](fields.md)',
    );
    const common = commit('common');
    git('switch', '-qc', 'baseline');
    write('only-base.json', { value: 'baseline' });
    const base = commit('baseline');
    git('switch', '-qc', 'feature', common);
    write('schema-接口.json', { type: 'integer' });
    writeFileSync(
      join(root, historicSkill),
      '---\nname: read-tasks\ndescription: Read current tasks\n---\n[guide](fields.md)',
    );
    git('mv', 'skills/read-tasks/fields.md', 'skills/read-tasks/fields moved.md');
    const target = commit('feature');
    git('tag', 'v1.0', common);
    execFileSync('git', ['-C', root, 'update-ref', '--stdin'], {
      input:
        Array.from({ length: 70 }, (_, i) => 'update refs/heads/archive/topic-' + i + ' ' + common).join('\n') +
        '\n',
      windowsHide: true,
    });
    const remote = 'refs/remotes/origin/feature';
    git('update-ref', remote, target);
    write('schema-接口.json', { type: 'boolean' });
    git('add', 'schema-接口.json');
    write('untracked.json', { value: 'untouched' });
    const before = git('status', '--porcelain=v1', '--branch');
    const index = git('diff', '--cached', '--no-color');

    const status = result(await ifg(root, 'status'));
    const cache = new DatabaseSync(status.database, { readOnly: true });
    const snapshotCount = () =>
      cache.prepare("SELECT count(*) AS count FROM records WHERE collection = 'git_snapshots'").get()?.count;
    try {
      const refs = result(await ifg(root, 'git', 'branches', '--limit', '5', '--offset', '0'));
      expect(refs.total).toBeGreaterThan(70);
      expect(refs.items).toHaveLength(5);
      expect(result(await ifg(root, 'git', 'branches', '--query', 'origin/feature')).items).toMatchObject([
        { ref: remote, sha: target },
      ]);
      const log = result(await ifg(root, 'git', 'log', '--ref', 'feature', '--limit', '1'));
      expect(log).toMatchObject({
        heads: [target],
        items: [{ sha: target, parents: [common], title: 'feature' }],
        more: true,
      });
      expect(
        result(await ifg(root, 'git', 'log', '--ref', target, '--limit', '1', '--offset', '1')).items[0].sha,
      ).toBe(common);
      expect(snapshotCount()).toBe(0);

      const diff = result(await ifg(root, 'compare', '--base', 'baseline', '--target', 'feature'));
      expect(diff.base.diagnostics.filter((item: { code: string }) => item.code === 'FILE_SCAN_FAILED')).toEqual(
        [],
      );
      expect(diff.target.diagnostics.filter((item: { code: string }) => item.code === 'FILE_SCAN_FAILED')).toEqual(
        [],
      );
      expect(diff).toMatchObject({
        base: { sha: base },
        target: { sha: target },
        effectiveBase: base,
        comparable: true,
        relation: { left: 1, right: 1, common: [common] },
      });
      expect(diff.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'api', name: 'GET /widgets', status: 'changed' }),
          expect.objectContaining({ kind: 'skill', name: 'read-tasks', status: 'changed' }),
        ]),
      );
      expect(diff.files).toEqual(
        expect.arrayContaining([
          {
            status: 'R100',
            previous: 'skills/read-tasks/fields.md',
            path: 'skills/read-tasks/fields moved.md',
          },
        ]),
      );
      expect(snapshotCount()).toBe(2);
      const repeat = result(await ifg(root, 'compare', '--base', base, '--target', target));
      expect(repeat.base.snapshot).toBe(diff.base.snapshot);
      expect(snapshotCount()).toBe(2);
      expect(result(await ifg(root, 'compare', '--base', target, '--target', target)).changes).toEqual([]);
      expect(
        result(await ifg(root, 'compare', '--base', base, '--target', target, '--ancestor', 'auto')).effectiveBase,
      ).toBe(common);
      expect(snapshotCount()).toBe(3);
      expect(
        result(
          await ifg(root, 'compare', 'file', '--base', base, '--target', target, '--path', 'schema-接口.json'),
        ).text,
      ).toContain('integer');
      expect(
        result(await ifg(root, 'source', 'show', '--path', 'schema-接口.json', '--ref', 'feature')).text,
      ).toContain('integer');
      expect(result(await ifg(root, 'source', 'show', '--path', 'schema-接口.json')).text).toContain('boolean');
      const browsing = result(await ifg(root, 'git', 'browse', '--ref', 'baseline'));
      expect(browsing.sha).toBe(base);
      expect(result(await ifg(root, 'git', 'view')).sha).toBe(base);
      const catalog = result(
        await ifg(
          root,
          'catalog',
          'list',
          '--kind',
          'mcp',
          '--service',
          'portable',
          '--snapshot',
          browsing.snapshot,
        ),
      );
      expect(catalog.items.map((item: { name: string }) => item.name).sort()).toEqual([
        'describe',
        'item',
        'list-widgets',
        'one',
      ]);
      expect(result(await ifg(root, 'wiki', 'preview', '--snapshot', browsing.snapshot)).snapshot).toBe(
        browsing.snapshot,
      );
      expect((await ifg(root, 'git', 'commit', 'unknown-ref')).result.error?.code).toBe('GIT_REVISION');
    } finally {
      cache.close();
    }
    expect(git('status', '--porcelain=v1', '--branch')).toBe(before);
    expect(git('diff', '--cached', '--no-color')).toBe(index);
  } finally {
    project.destroy();
  }
}, 180_000);
