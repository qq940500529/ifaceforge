import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const archive = resolve(process.argv[2] ?? '');
const parent = realpathSync.native(tmpdir());
const stage = mkdtempSync(join(parent, 'ifaceforge-cli-check-'));
try {
  const root = join(stage, '验收 Git project');
  mkdirSync(root);
  execFileSync('tar', ['-xzf', '-'], { cwd: stage, input: readFileSync(archive) });
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  const cli = join(stage, 'ifaceforge', 'dist', 'cli', 'main.js');
  const runtime = join(stage, 'ifaceforge', 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const env = { ...process.env, IFG_DATA_HOME: join(stage, 'app data') };
  const run = (...args) =>
    JSON.parse(
      execFileSync(runtime, [cli, ...args, '--project', root, '--json'], {
        env,
        encoding: 'utf8',
      }),
    );
  const state = run('status');
  const scan = run('scan');
  const task = run('scan', 'start');
  const report = run('task', 'watch', task.data.id);
  run('service', 'stop');
  if (
    !state.ok ||
    state.data.project !== realpathSync.native(root) ||
    !scan.ok ||
    !scan.data.complete ||
    report.data.state !== 'complete'
  ) {
    throw new Error('Packaged CLI verification failed');
  }
  console.log(
    JSON.stringify({
      node: execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim(),
      platform: process.platform,
      arch: process.arch,
    }),
  );
} finally {
  if (dirname(realpathSync.native(stage)) === parent)
    rmSync(stage, { recursive: true, maxRetries: 4, retryDelay: 150 });
}
