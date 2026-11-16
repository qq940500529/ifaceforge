import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { address, close, fixture, ifg, repositoryRoot } from '../support/fixture.js';
// @ts-expect-error The executable JavaScript fixture has no TypeScript declaration.
import { mcpHttp } from '../../fixtures/express/mcp.mjs';

test('coordinates persistent project tasks, version exports and MCP sessions from separate CLI processes', async () => {
  const sample = fixture();
  const service = mcpHttp();
  const endpoint = (await address(service)) + '/mcp';
  const run = (...args: string[]) => ifg(sample.root, ...args);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', sample.root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const commit = (title: string) => {
    git('add', '.');
    git('-c', 'user.name=IfaceForge Tests', '-c', 'user.email=test@example.test', 'commit', '-qm', title);
  };
  try {
    const machine = (await run('commands')).result.data;
    expect(machine.automation.taskProgress).toContain('--stream');
    expect(machine.items.find((item: { name: string }) => item.name === 'project delete').writes).toBe(true);
    expect((await run('schema', 'request')).result.ok).toBe(true);
    const nested = join(sample.root, 'child folder');
    mkdirSync(nested);
    expect((await run('project', 'inspect', nested)).result.data.root).toBe(sample.root);
    expect((await run('project', 'add', nested, '--exact')).exit).toBe(2);
    const project = (await run('project', 'add', sample.root)).result.data.id;
    expect((await run('project', 'select', project)).result.data.selected).toBe(project);
    expect((await run('preferences', 'set', '--lang', 'zh-CN')).result.data.locale).toBe('zh-CN');
    expect((await run('preferences', 'get')).result.data.locale).toBe('zh-CN');

    commit('initial contract');
    git('branch', 'baseline');
    git('switch', '-qc', 'feature');
    sample.write('portable/mcp-capabilities.json', {
      schemaVersion: 1,
      service: 'extra',
      tools: [{ name: 'read-version' }],
    });
    commit('added offline capability');
    const head = git('rev-parse', 'HEAD');
    const log = (await run('git', 'log', '--ref', 'baseline', '--ref', 'feature', '--format', 'graph')).result
      .data;
    expect(log.heads).toHaveLength(2);
    expect(log.graph).toContain('added offline capability');
    expect(
      (await run('git', 'select', '--base', 'baseline', '--target', 'feature', '--mode', 'branches')).result.data
        .target,
    ).toBe('feature');

    const scan = (await run('scan', 'start')).result.data;
    expect(scan.project).toBe(project);
    const watched = await run('task', 'watch', scan.id);
    expect(watched.result.data).toMatchObject({ state: 'complete', result: { complete: true } });
    const stream = execFileSync(
      process.execPath,
      [join(repositoryRoot, 'dist', 'cli', 'main.js'), 'task', 'watch', scan.id, '--stream'],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, IFG_DATA_HOME: sample.data },
      },
    );
    expect(
      stream
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .at(-1),
    ).toMatchObject({ schemaVersion: 1, event: 'task', task: { id: scan.id, state: 'complete' } });
    const comparison = (await run('compare', '--base', 'baseline', '--target', 'feature', '--async')).result.data;
    expect((await run('task', 'watch', comparison.id)).result.data.result.target.sha).toBe(head);
    const path = join(sample.data, '对比报告.md');
    expect(
      (
        await run(
          'compare',
          '--base',
          'baseline',
          '--target',
          'feature',
          '--kind',
          'mcp',
          '--format',
          'markdown',
          '--out',
          path,
        )
      ).exit,
    ).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('read-version');
    expect((await run('compare', '--base', 'baseline', '--target', 'feature', '--out', path)).exit).toBe(3);

    const profile = sample.write('mcp-test-profile.json', {
      schemaVersion: 1,
      id: 'demo',
      name: 'Shared MCP',
      mcp: { transport: 'streamableHttp', url: endpoint },
    });
    expect((await run('profile', 'put', '--file', profile)).exit).toBe(0);
    const connection = (await run('mcp', 'connect', '--profile', 'demo')).result.data.id;
    expect((await run('mcp', 'status')).result.data[0]).toMatchObject({ id: connection, profile: 'demo' });
    const tool = await run('mcp', 'call', 'echo', '--connection', connection, '--args', '{"value":"CLI session"}');
    expect(tool.exit).toBe(0);
    expect(JSON.stringify(tool.result.data)).toContain('CLI session');
    expect((await run('mcp', 'disconnect', connection)).result.data.connected).toBe(false);
    expect((await run('mcp', 'status')).result.data).toEqual([]);

    expect((await run('service', 'stop')).result.data.stopped).toBe(true);
    expect((await run('task', 'show', scan.id)).result.data.state).toBe('complete');
    expect(
      (await run('task', 'list', '--all')).result.data.history.map((item: { id: string }) => item.id),
    ).toEqual(expect.arrayContaining([scan.id, comparison.id]));
    expect((await run('project', 'hide', project)).result.data.projects[0].hidden).toBe(1);
    const moved = join(dirname(sample.root), '项目 moved');
    renameSync(sample.root, moved);
    expect((await run('project', 'relocate', project, '--directory', moved)).result.data.projects[0].root).toBe(
      moved,
    );
    expect((await run('project', 'delete', project)).exit).toBe(2);
    expect((await run('project', 'delete', project, '--confirm')).result.data.projects).toEqual([]);
    expect(existsSync(join(moved, '.git'))).toBe(true);
  } finally {
    await close(service);
    sample.destroy();
  }
}, 90_000);

test('cancels a background HTTP run from another process and preserves CLI-scoped variables', async () => {
  const sample = fixture();
  let received = false;
  const server = createServer((request, response) => {
    received = true;
    if (request.url === '/slow') return;
    response.end(request.headers['x-ifg-test-header'] ?? 'missing');
  });
  const target = await address(server);
  const run = (...args: string[]) => ifg(sample.root, ...args);
  try {
    const slow = sample.write('slow.json', { method: 'GET', url: target + '/slow' });
    const start = (await run('api', 'send', '--file', slow, '--async')).result.data;
    await expect.poll(() => received).toBe(true);
    expect((await run('task', 'cancel', start.id)).exit).toBe(0);
    const watch = await run('task', 'watch', start.id);
    expect(watch.exit).toBe(4);
    const secret = 'CLI_SCOPE_TEST-value';
    const body = sample.write('header.json', {
      method: 'GET',
      url: target,
      headers: [{ name: 'x-ifg-test-header', value: { env: 'IFG_CLI_SCOPE_TEST' } }],
    });
    const assertions = sample.write('assertions.json', [{ type: 'status', equals: 200 }]);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        join(repositoryRoot, 'dist', 'cli', 'main.js'),
        'api',
        'send',
        '--file',
        body,
        '--assertions',
        assertions,
        '--project',
        sample.root,
        '--json',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, IFG_DATA_HOME: sample.data, IFG_CLI_SCOPE_TEST: secret },
      },
    );
    const reply = JSON.parse(stdout);
    expect(reply.data.status).toBe('passed');
    expect(JSON.stringify(reply)).not.toContain(secret);
  } finally {
    server.closeAllConnections();
    await close(server);
    sample.destroy();
  }
}, 45_000);
