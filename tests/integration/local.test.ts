import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
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

it('starts a loopback UI, validates the instance and ignores cross-origin commands', async () => {
  const { root } = project();
  const started = check(await ifg(root, 'start', '--no-open'));
  cleanups.push(async () => {
    await ifg(root, 'stop');
  });
  expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect((await fetch(started.url)).status).toBe(200);
  expect(check(await ifg(root, 'status')).id).toBe(started.id);
  expect(check(await ifg(root, 'start', '--no-open')).id).toBe(started.id);
  expect(
    (
      await fetch(started.url + '/api/v1/commands/scan', {
        method: 'POST',
        headers: { Origin: 'https://outside.example' },
      })
    ).status,
  ).toBe(403);
  const other = project();
  expect(
    (await ifg(other.root, 'start', '--no-open', '--port', new URL(started.url).port)).result.error?.code,
  ).toBe('PORT_IN_USE');
  expect(check(await ifg(root, 'stop')).running).toBe(false);
  expect(check(await ifg(root, 'status')).running).toBe(false);
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
  check(await ifg(fastapi.root, 'data', 'restore', '--file', backup, '--replace'));
  check(await ifg(fastapi.root, 'test', 'run', '--case', 'read'));
  expect(execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })).toContain(
    'openapi.yml',
  );
  expect(execFileSync('git', ['-C', root, 'diff', '--name-only'], { encoding: 'utf8' })).toBe('');
});

for (const transport of ['stdio', 'streamableHttp'] as const) {
  for (const legacy of [false, true]) {
    it('discovers and calls MCP ' + transport + ' ' + (legacy ? '2025-11-25' : '2026-07-28'), async () => {
      const { root, write } = project();
      const fixturePath = join(repositoryRoot, 'fixtures', 'express', 'mcp.mjs');
      const mcp =
        transport === 'stdio'
          ? { transport, command: process.execPath, args: [fixturePath, 'stdio', legacy ? 'legacy' : 'modern'] }
          : { transport, url: (await listen(mcpHttp(legacy))) + '/mcp' };
      const connect = { schemaVersion: 1, id: 'sample', name: 'Sample', mcp };
      check(await ifg(root, 'profile', 'put', '--file', write('mcp-profile.json', connect)));
      const batch = {
        schemaVersion: 1,
        steps: [
          { id: 'find', type: 'discover' },
          {
            id: 'first',
            type: 'call',
            tool: 'remember',
            arguments: { value: 'connected' },
            extract: { text: '/value' },
          },
          {
            id: 'second',
            type: 'call',
            tool: transport === 'stdio' ? 'recall' : 'echo',
            arguments: transport === 'stdio' ? {} : { value: '{{text}}' },
          },
          { id: 'resource', type: 'read', uri: 'task://42' },
          { id: 'prompt', type: 'prompt', name: 'task-summary', arguments: { title: '{{text}}' } },
          { id: 'error', type: 'call', tool: 'reject', arguments: {} },
        ],
      };
      const result = check(
        await ifg(root, 'mcp', 'batch', '--profile', 'sample', '--file', write('batch.json', batch)),
      );
      expect(result.steps[0].result.protocolVersion).toBe(legacy ? '2025-11-25' : '2026-07-28');
      expect(result.steps[0].result.groups[0].items.map((tool: { name: string }) => tool.name)).toContain('slow');
      expect(result.steps[2].result.structuredContent.value).toBe('connected');
      expect(result.steps[3].result.contents[0].text).toContain('Sample task');
      expect(result.steps[4].result.messages[0].content.text).toContain('connected');
      expect(result.steps[5].result.isError).toBe(true);
      if (transport === 'stdio') {
        const pid = result.steps[1].result.structuredContent.pid;
        expect(result.steps[2].result.structuredContent.pid).toBe(pid);
        expect(() => process.kill(pid, 0)).toThrow();
      }
    });
  }
}

it('cancels a sent MCP request across processes and keeps the original unknown result', async () => {
  const { root, write } = project();
  check(
    await ifg(
      root,
      'profile',
      'put',
      '--file',
      write('profile.json', {
        schemaVersion: 1,
        id: 'sample',
        name: 'Sample',
        mcp: {
          transport: 'stdio',
          command: process.execPath,
          args: [join(repositoryRoot, 'fixtures', 'express', 'mcp.mjs'), 'stdio'],
        },
      }),
    ),
  );
  const running = ifg(root, 'mcp', 'call', 'slow', '--profile', 'sample');
  let run;
  for (let i = 0; i < 20; i++) {
    run = check(await ifg(root, 'run', 'list')).items[0];
    if (run?.phase === 'sent') break;
    await delay(100);
  }
  expect(run?.phase).toBe('sent');
  check(await ifg(root, 'run', 'cancel', run.id));
  const canceled = await running;
  expect(canceled.exit).toBe(4);
  expect(canceled.result.data.status).toBe('unknown');
  expect(check(await ifg(root, 'run', 'show', run.id)).status).toBe('unknown');
});
