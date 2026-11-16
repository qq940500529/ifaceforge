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
          {
            id: 'template',
            type: 'template',
            uriTemplate: 'task://{id}',
            arguments: { id: '43' },
            assertions: [{ type: 'textContains', pointer: '/contents/0/text', text: 'Synthetic task' }],
          },
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
      expect(result.steps[6]).toMatchObject({
        status: 'passed',
        request: { type: 'template', uri: 'task://43' },
        checks: [{ passed: true, expected: 'Synthetic task' }],
      });
      if (!legacy) {
        const saved = [
          {
            id: 'tool-case',
            request: { type: 'call', tool: 'echo', arguments: { value: 'case result' } },
            assertions: [{ type: 'jsonEquals', pointer: '/value', equals: 'case result' }],
          },
          {
            id: 'resource-case',
            request: { type: 'read', uri: 'task://42' },
            assertions: [{ type: 'textContains', pointer: '/contents/0/text', text: 'Sample task' }],
          },
          {
            id: 'template-case',
            request: { type: 'template', uriTemplate: 'task://{id}', arguments: { id: '43' } },
            assertions: [{ type: 'jsonEquals', pointer: '/contents/0/uri', equals: 'task://43' }],
          },
          {
            id: 'prompt-case',
            request: { type: 'prompt', name: 'task-summary', arguments: { title: 'shared case' } },
            assertions: [{ type: 'textContains', pointer: '/messages/0/content/text', text: 'shared case' }],
          },
        ];
        for (const item of saved)
          check(
            await ifg(
              root,
              'case',
              'put',
              '--file',
              write(item.id + '.json', {
                schemaVersion: 1,
                kind: 'mcp',
                profile: 'sample',
                name: item.id,
                ...item,
              }),
            ),
          );
        check(
          await ifg(
            root,
            'suite',
            'put',
            '--file',
            write('mcp-suite.json', {
              schemaVersion: 1,
              id: 'mcp-suite',
              name: 'MCP suite',
              caseIds: saved.map((item) => item.id),
            }),
          ),
        );
        expect(
          check(await ifg(root, 'test', 'run', '--suite', 'mcp-suite')).steps.map(
            (step: { status: string }) => step.status,
          ),
        ).toEqual(Array(4).fill('passed'));
        const assertions = write('assertions.json', [
          { type: 'jsonEquals', pointer: '/value', equals: 'expected' },
        ]);
        const failed = await ifg(
          root,
          'mcp',
          'call',
          'echo',
          '--profile',
          'sample',
          '--args',
          '{"value":"actual"}',
          '--assertions',
          assertions,
        );
        expect(failed.exit).toBe(1);
        expect(failed.result.data.steps[0].checks[0]).toMatchObject({
          passed: false,
          actual: 'actual',
          expected: 'expected',
        });
        expect(check(await ifg(root, 'run', 'list', '--kind', 'mcp', '--profile', 'different')).total).toBe(0);
      }
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
