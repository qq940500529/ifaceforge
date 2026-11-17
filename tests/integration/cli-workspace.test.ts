import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { address, close, fixture, ifg, ifgStdin, repositoryRoot } from '../support/fixture.js';

test('coordinates persistent project tasks and version exports from separate CLI processes', async () => {
  const sample = fixture();
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
    expect((await run('about')).result.data).toMatchObject({
      name: 'IfaceForge',
      license: 'MIT',
      acknowledgements: { markdown: ['react-markdown', 'remark-gfm'] },
    });
    expect(
      ifgStdin(sample.root, { id: 'one two' }, 'mcp', 'template-preview', 'task://{id}{?view}', '--args', '-')
        .result.data,
    ).toMatchObject({
      uri: 'task://one%20two',
      variables: [
        { name: 'id', required: true },
        { name: 'view', required: false },
      ],
    });
    expect((await run('mcp', 'template-preview', 'task://{id}')).exit).toBe(2);
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
    const skill = 'skills/read-example/SKILL.md';
    const missed = 'skills/read-example/references/missing.md';
    const skillPath = join(sample.root, skill);
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(join(dirname(skillPath), 'available.md'), '# Available\n');
    writeFileSync(
      skillPath,
      [
        '---',
        'name: read-example',
        'description: Review an example.',
        '---',
        '[Local](available.md#available) · [Jump](#related) · [External](https://example.test/demo)',
        '~~~markdown',
        '[In code](references/example.md)',
        '~~~',
        'Read [the example](references/missing.md).',
        '',
      ].join('\r\n'),
    );
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
    expect((await run('git', 'selection')).result.data).toMatchObject({ mode: 'branches', target: 'feature' });
    const expectedIssue = {
      code: 'SKILL_REFERENCE_MISSING',
      severity: 'warning',
      path: skill,
      line: 9,
      details: { target: missed },
    };
    const validation = (await run('guide', 'validate', '--ref', 'HEAD')).result.data;
    expect(validation.commit).toBe(head);
    expect(validation.issues.filter((entry: { path: string }) => entry.path === skill)).toMatchObject([
      expectedIssue,
    ]);

    const scan = (await run('scan', 'start')).result.data;
    expect(scan.project).toBe(project);
    const watched = await run('task', 'watch', scan.id);
    expect(watched.result.data).toMatchObject({ state: 'complete', result: { complete: true } });
    const issueLog = join(sample.data, 'scan warnings.txt');
    const warnings = await run('task', 'diagnostics', scan.id, '--severity', 'warning');
    expect(warnings.result.data.issues).toContainEqual(expect.objectContaining(expectedIssue));
    expect((await run('task', 'diagnostics', scan.id, '--severity', 'error')).result.data.issues).toEqual([]);
    expect((await run('task', 'diagnostics', scan.id, '--severity', 'unknown')).exit).toBe(2);
    expect((await run('task', 'diagnostics', scan.id, '--format', 'text', '--out', issueLog)).exit).toBe(0);
    const issueText = readFileSync(issueLog, 'utf8');
    expect(issueText).toContain(`[WARNING] ${expectedIssue.code}\n${skill}:9`);
    expect(issueText).toContain(missed);
    const wiki = await run('wiki', 'preview', '--lang', 'en');
    const exported = join(sample.data, 'wiki catalogue.json');
    expect((await run('wiki', 'export', '--lang', 'en', '--out', exported)).exit).toBe(0);
    expect(JSON.parse(readFileSync(exported, 'utf8'))).toEqual(wiki.result.data.catalog);
    expect((await run('wiki', 'export', '--out', exported)).exit).toBe(3);
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
    expect((await run('task', 'diagnostics', comparison.id)).exit).toBe(2);
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
