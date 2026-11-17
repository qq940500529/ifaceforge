import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { McpSession, type Discovery } from '../../src/protocols/mcp.js';
import { Bindings, type Profile } from '../../src/protocols/variables.js';
import { address, close, fixture, ifg, ifgStdin, repositoryRoot, type Output } from '../support/fixture.js';
// @ts-expect-error JavaScript fixture is also runnable directly from Node.
import { taskApp } from '../../fixtures/express/app.mjs';
// @ts-expect-error JavaScript fixture is also runnable directly from Node.
import { mcpHttp } from '../../fixtures/express/mcp.mjs';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function project(name = 'express') {
  const entry = fixture(name);
  cleanups.push(() => entry.destroy());
  return entry;
}
async function listen(server: ReturnType<typeof createServer>) {
  const url = await address(server);
  cleanups.push(() => close(server));
  return url;
}
function check<T>(result: Output<T>): T {
  expect(result.exit, JSON.stringify(result.result.error)).toBe(0);
  expect(result.result.schemaVersion).toBe(1);
  expect(result.result.error).toBeNull();
  return result.result.data;
}

it('registers two working trees and resolves their databases by stable project ID', async () => {
  const first = project();
  const second = project();
  const a = check(await ifg(first.root, 'project', 'add', first.root));
  const b = check(await ifg(first.root, 'project', 'add', second.root));
  expect(a.id).not.toBe(b.id);
  expect(check(await ifg(first.root, 'project', 'list')).map((entry: { id: string }) => entry.id)).toEqual(
    expect.arrayContaining([a.id, b.id]),
  );
  const status = check(await ifg(first.root, 'status'));
  expect(status.dataDir.startsWith(first.root)).toBe(false);
  expect(status.databaseSchema).toBe(1);
});

it('scans both frameworks, imports runtime routes and runs HTTP cases entirely through CLI', async () => {
  const { root, write } = project();
  const fastapi = project('fastapi');
  expect(check(await ifg(root, 'commands')).items.length).toBeGreaterThan(40);
  expect(check(await ifg(root, 'schema', 'case')).oneOf.length).toBe(2);
  check(await ifg(fastapi.root, 'scan', '--require-complete'));
  const fastCatalog = check(await ifg(fastapi.root, 'catalog', 'search', 'inventory'));
  expect(fastCatalog.items[0].observations.map((item: { origin: string }) => item.origin).sort()).toEqual([
    'declaration',
    'source',
  ]);
  check(await ifg(root, 'scan', '--require-complete'));
  const list = check(await ifg(root, 'catalog', 'search', 'Read a task', '--kind', 'api'));
  const operationId = list.items[0].id;
  expect(list.items[0].observations.length).toBe(2);
  const serviceUrl = await listen(createServer(taskApp()));
  const profile = { schemaVersion: 1, id: 'demo', name: 'Demo', http: { baseUrl: serviceUrl } };
  check(ifgStdin(root, profile, 'profile', 'put', '--file', '-'));
  const template = (path: string) => ({ method: 'GET', path, operationId });
  const regular = {
    schemaVersion: 1,
    id: 'read',
    name: 'Read task',
    kind: 'http',
    profile: 'demo',
    request: template('/tasks/42'),
    assertions: [{ type: 'status', equals: 200 }, { type: 'responseSchema' }],
  };
  check(await ifg(root, 'case', 'put', '--file', write('case.json', regular)));
  const success = check(await ifg(root, 'test', 'run', '--case', 'read'));
  expect(success.steps[0].checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
  check(
    await ifg(
      root,
      'case',
      'put',
      '--file',
      write('missing.json', {
        ...regular,
        id: 'missing',
        request: template('/tasks/0'),
        assertions: [{ type: 'status', equals: 404 }, { type: 'responseSchema' }],
      }),
    ),
  );
  check(await ifg(root, 'test', 'run', '--case', 'missing'));
  const stale = await ifg(
    root,
    'case',
    'put',
    '--file',
    write('stale.json', { ...regular, name: 'Updated' }),
    '--replace',
    '--version',
    '9',
  );
  expect(stale.result.error?.code).toBe('VERSION_CONFLICT');
  check(
    await ifg(
      root,
      'case',
      'put',
      '--file',
      write('failure.json', { ...regular, id: 'failure', assertions: [{ type: 'status', equals: 202 }] }),
    ),
  );
  const failed = await ifg(root, 'test', 'run', '--case', 'failure');
  expect(failed.exit).toBe(1);
  expect(failed.result.error?.code).toBe('ASSERTION_FAILED');
  expect(check(await ifg(root, 'run', 'export', failed.result.data.id)).steps[0].checks[0].actual).toBe(200);
  check(await ifg(root, 'api', 'import', '--url', serviceUrl + '/contract', '--service', 'tasks'));
  expect(
    check(await ifg(root, 'catalog', 'list', '--kind', 'api')).items.some(
      (item: { name: string }) => item.name === 'GET /health',
    ),
  ).toBe(true);
  const skill = check(await ifg(root, 'skill', 'search', '读取任务')).items[0];
  expect(check(await ifg(root, 'source', 'show', '--path', 'skills/read-tasks/fields.md')).text).toContain(
    'integer ID',
  );
  const manual = join(root, 'note.md');
  writeFileSync(manual, 'Local notes');
  check(await ifg(root, 'wiki', 'note-put', skill.id, '--file', manual));
  for (const locale of ['en', 'zh-CN']) {
    const wiki = check(await ifg(root, 'wiki', 'build', '--lang', locale));
    const entry = wiki.catalog.items.find((item: { id: string }) => item.id === skill.id);
    expect(readFileSync(join(wiki.out, entry.page), 'utf8')).toContain('Local notes');
    expect(readFileSync(join(wiki.out, 'catalog.json'), 'utf8')).not.toContain(root);
  }
  const backup = join(root, 'database.json');
  check(await ifg(root, 'data', 'backup', '--out', backup));
  expect(check(await ifg(fastapi.root, 'case', 'list')).total).toBe(0);
  expect((await ifg(fastapi.root, 'data', 'restore', '--file', backup, '--replace')).result.error?.code).toBe(
    'INVALID_ARGUMENT',
  );
  check(await ifg(root, 'data', 'restore', '--file', backup, '--replace'));
  check(await ifg(root, 'test', 'run', '--case', 'read'));
  expect(execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })).toContain(
    'openapi.yml',
  );
  expect(execFileSync('git', ['-C', root, 'diff', '--name-only'], { encoding: 'utf8' })).toBe('');
}, 60000);

for (const transport of ['stdio', 'streamableHttp'] as const) {
  it('negotiates MCP 2026-07-28 over ' + transport, async () => {
    const { root } = project();
    const config: Profile = {
      schemaVersion: 1,
      id: 'sample',
      name: 'Sample',
      mcp:
        transport === 'stdio'
          ? {
              transport,
              command: process.execPath,
              args: [join(repositoryRoot, 'fixtures', 'express', 'mcp.mjs'), 'stdio', 'modern'],
            }
          : { transport, url: (await listen(mcpHttp())) + '/mcp' },
    };
    const session = await McpSession.connect(config, root, new Bindings(config));
    try {
      const inventory = (await session.execute({ type: 'discover' })) as Discovery;
      expect(inventory.protocolVersion).toBe('2026-07-28');
      expect(inventory.groups[0].items.map((tool) => tool.name)).toContain('slow');
      expect(
        await session.execute({ type: 'call', tool: 'echo', arguments: { value: 'protocol test' } }),
      ).toMatchObject({ structuredContent: { value: 'protocol test' } });
    } finally {
      await session.close();
    }
  });
}
