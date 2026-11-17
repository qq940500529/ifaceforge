import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { delimiter } from 'node:path';
import { expect, it, vi } from 'vitest';
import { commitFixture, fixture, ifg } from '../support/fixture.js';
import { git } from '../../src/app/project.js';
import type { SandboxPlan } from '../../src/protocols/mcp-sandbox.js';
import type { Run } from '../../src/app/runs.js';

const image = process.env.IFG_TEST_DOCKER_IMAGE;
const imageArg = image ? ['--image', image] : [];

it.skipIf(!process.env.IFG_TEST_DOCKER)(
  'rejects Windows launchers and reports redacted startup output, exit status and cleanup',
  async () => {
    const sample = fixture('mcp-isolation');
    try {
      vi.stubEnv('IFG_TEST_STARTUP_SECRET', 'diagnostic-must-redact');
      sample.write('integrations/codex/.mcp.json', {
        mcpServers: {
          'host-launcher': { command: 'powershell.exe', args: ['-File', './scripts/start.ps1'], cwd: '.' },
          'exits-early': {
            command: 'node',
            args: [
              '-e',
              "console.error('Startup failed for ' + process.env.IFG_TEST_STARTUP_SECRET); process.exit(23)",
            ],
            env: { IFG_TEST_STARTUP_SECRET: { env: 'IFG_TEST_STARTUP_SECRET' } },
          },
        },
      });
      sample.write('integrations/codex/scripts/start.ps1', 'Fixture');
      commitFixture(sample.root);
      expect((await ifg(sample.root, 'scan')).exit).toBe(0);
      const { items } = (await ifg(sample.root, 'mcp', 'targets')).result.data;
      const args = (name: string) => [
        '--service',
        items.find((item: { name: string }) => item.name === name).id,
        ...imageArg,
      ];
      const blocked = await ifg<SandboxPlan>(sample.root, 'mcp', 'plan', ...args('host-launcher'));
      expect(blocked.result.data).toMatchObject({
        directory: '/workspace/integrations/codex',
        issues: [{ code: 'windows-launcher', path: 'powershell.exe' }],
      });
      const refused = await ifg(
        sample.root,
        'mcp',
        'probe',
        ...args('host-launcher'),
        '--approve',
        blocked.result.data.fingerprint,
      );
      expect(refused.result.error?.code).toBe('MCP_SANDBOX_INCOMPATIBLE');
      const ready = await ifg<SandboxPlan>(sample.root, 'mcp', 'plan', ...args('exits-early'));
      expect(ready.result.data.issues).toEqual([]);
      const failed = await ifg<Run>(
        sample.root,
        'mcp',
        'probe',
        ...args('exits-early'),
        '--approve',
        ready.result.data.fingerprint,
      );
      expect(failed.result.data).toMatchObject({
        status: 'failed',
        sandboxes: [{ cleanup: { state: 'removed' } }],
        steps: [
          {
            error: {
              code: 'MCP_SANDBOX_START',
              details: {
                exitCode: 23,
                startupOutput: expect.stringContaining('Startup failed for [REDACTED]'),
                cleanup: { state: 'removed' },
              },
            },
          },
        ],
      });
      expect(JSON.stringify(failed.result)).not.toContain('diagnostic-must-redact');
    } finally {
      vi.unstubAllEnvs();
      sample.destroy();
    }
  },
  90_000,
);

it.skipIf(!process.env.IFG_TEST_DOCKER)(
  'probes committed stdio and HTTP services in isolated containers and removes each instance',
  async () => {
    const sample = fixture('mcp-isolation');
    try {
      const local = sample.write(process.platform === 'win32' ? 'docker.exe' : 'docker', {
        sample: 'repository file',
      });
      if (process.platform !== 'win32') chmodSync(local, 0o755);
      vi.stubEnv('PATH', sample.root + delimiter + process.env.PATH);
      sample.write('.env', { workspace: 'test marker' });
      git(sample.root, ['add', '-f', '.env']);
      git(sample.root, [
        '-c',
        'user.name=Tests',
        '-c',
        'user.email=tests@example.test',
        'commit',
        '-qm',
        'Add test service',
      ]);
      const before = git(sample.root, ['status', '--porcelain=v1']);
      expect((await ifg(sample.root, 'scan')).exit).toBe(0);
      const targets = await ifg<{ items: { id: string; name: string }[] }>(sample.root, 'mcp', 'targets');
      expect(targets.result.data.items.map((item) => item.name).sort()).toEqual(['sample-http', 'sample-stdio']);
      for (const target of targets.result.data.items) {
        const source = ['--service', target.id, ...imageArg];
        const prepared = await ifg<SandboxPlan>(sample.root, 'mcp', 'plan', ...source);
        expect(prepared.result.ok, JSON.stringify(prepared.result.error)).toBe(true);
        const plan = prepared.result.data;
        expect(plan.commit).toBe(git(sample.root, ['rev-parse', 'HEAD']).trim());
        expect(plan.dockerPath).not.toContain(sample.root);
        expect(
          (await ifg(sample.root, 'mcp', 'probe', ...source, '--approve', 'invalid')).result.error?.code,
        ).toBe('MCP_SANDBOX_APPROVAL');
        const approved = [...source, '--approve', plan.fingerprint];
        const probe = await ifg<Run>(sample.root, 'mcp', 'probe', ...approved);
        expect(probe.exit, JSON.stringify(probe.result)).toBe(0);
        const report = probe.result.data;
        expect(report.steps[0].result).toMatchObject({
          groups: expect.arrayContaining([
            {
              type: 'tool',
              state: 'found',
              items: expect.arrayContaining([expect.objectContaining({ name: 'isolation' })]),
            },
            expect.objectContaining({ type: 'resource', state: 'found' }),
            expect.objectContaining({ type: 'template', state: 'found' }),
            expect.objectContaining({ type: 'prompt', state: 'found' }),
          ]),
        });
        expect(report.sandboxes?.[0].cleanup.state).toBe('removed');
        const saved = await ifg<Run>(sample.root, 'mcp', 'inventory', '--service', target.id);
        expect(saved.result.data.id).toBe(report.id);
        const called = await ifg<Run>(sample.root, 'mcp', 'call', 'isolation', ...approved);
        expect(called.exit, JSON.stringify(called.result)).toBe(0);
        expect(called.result.data.steps[0].result).toMatchObject({
          structuredContent: {
            uid: 10001,
            writable: false,
            environmentFile: false,
            dockerSocket: false,
            interfaces: ['lo'],
          },
        });
        expect(called.result.data.sandboxes?.[0].cleanup.state).toBe('removed');
        const instances = execFileSync(plan.dockerPath, ['ps', '-a', '--format', '{{.Names}}'], {
          encoding: 'utf8',
          windowsHide: true,
        });
        expect(instances).not.toContain(report.sandboxes?.[0].instance);
        expect(instances).not.toContain(called.result.data.sandboxes?.[0].instance);
      }
      expect(git(sample.root, ['status', '--porcelain=v1'])).toBe(before);
      expect((await ifg(sample.root, 'mcp', 'connect')).exit).toBe(2);
    } finally {
      vi.unstubAllEnvs();
      sample.destroy();
    }
  },
  150_000,
);

it.skipIf(!process.env.IFG_TEST_DOCKER)(
  'reuses a sandbox within a batch and removes it after a test or cancellation',
  async () => {
    const sample = fixture('mcp-isolation');
    try {
      commitFixture(sample.root);
      const run = (...args: string[]) => ifg(sample.root, ...args);
      expect((await run('scan')).exit).toBe(0);
      const targets = (await run('mcp', 'targets')).result.data.items;
      const service = targets.find((item: { name: string }) => item.name === 'sample-stdio').id;
      const source = ['--service', service, ...imageArg];
      const approval = (await run('mcp', 'plan', ...source)).result.data.fingerprint;
      const batch = sample.write('batch.json', {
        schemaVersion: 1,
        steps: [
          {
            id: 'echo',
            type: 'call',
            tool: 'echo',
            arguments: { value: 'approved' },
            extract: { title: '/value' },
          },
          {
            id: 'template',
            type: 'template',
            uriTemplate: 'task://{id}',
            arguments: { id: '43' },
            assertions: [{ type: 'textContains', pointer: '/contents/0/text', text: 'Read task://43' }],
          },
          { id: 'prompt', type: 'prompt', name: 'task-summary', arguments: { title: '{{title}}' } },
        ],
      });
      const tested = await run('mcp', 'batch', ...source, '--approve', approval, '--file', batch);
      expect(tested.exit, JSON.stringify(tested.result)).toBe(0);
      expect(tested.result.data.steps[2].result.messages[0].content.text).toBe('approved');
      expect(tested.result.data.sandboxes).toHaveLength(1);

      const saved = sample.write('case.json', {
        schemaVersion: 1,
        id: 'read',
        name: 'Read resource',
        kind: 'mcp',
        service,
        image,
        request: { type: 'read', uri: 'task://42' },
      });
      expect((await run('case', 'put', '--file', saved)).exit).toBe(0);
      const plan = await run('test', 'plan', '--case', 'read');
      expect(plan.result.data.fingerprint).toBeTruthy();
      const rerun = await run('test', 'run', '--case', 'read', '--approve', plan.result.data.fingerprint);
      expect(rerun.exit, JSON.stringify(rerun.result)).toBe(0);
      expect(rerun.result.data.sandboxes[0].cleanup.state).toBe('removed');

      const slow = await run('mcp', 'call', 'wait', ...source, '--approve', approval, '--async');
      expect(slow.exit, JSON.stringify(slow.result)).toBe(0);
      const id = slow.result.data.id;
      await expect
        .poll(async () => (await run('task', 'show', id)).result.data.phase, { timeout: 20_000 })
        .toBe('sent');
      expect((await run('task', 'cancel', id)).exit).toBe(0);
      const stopped = await run('task', 'watch', id);
      expect(stopped.exit).toBe(4);
      expect(stopped.result.data.status).toBe('unknown');
      expect(stopped.result.data.sandboxes[0].cleanup.state).toBe('removed');
    } finally {
      sample.destroy();
    }
  },
  150_000,
);
