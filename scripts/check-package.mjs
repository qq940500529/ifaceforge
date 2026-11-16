import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const archive = resolve(process.argv[2] ?? '');
const base = realpathSync.native(tmpdir());
const stage = mkdtempSync(join(base, 'ifaceforge-package-check-'));
const git = (args) => execFileSync('git', args, { stdio: 'ignore' });
try {
  const root = join(stage, '验收 Git project');
  const install = join(root, '.devtools', 'ifaceforge', 'app');
  mkdirSync(install, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', install], { stdio: 'inherit' });
  const cli = join(install, 'ifaceforge', 'dist', 'cli', 'main.js');
  git(['init', root]);
  const run = (...args) =>
    JSON.parse(execFileSync(process.execPath, [cli, ...args, '--project', root, '--json'], { encoding: 'utf8' }));
  const started = run('start', '--no-open');
  if (!started.ok || !started.data.running) throw new Error('Packaged server failed to start');
  try {
    const response = await fetch(started.data.url);
    const state = run('status');
    if (!response.ok || !state.data.running)
      throw new Error(
        'Packaged server is unavailable (HTTP ' + response.status + ', running: ' + state.data.running + ')',
      );
    const html = await response.text();
    const entry = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    if (!entry) throw new Error('The packaged HTML has no browser script');
    const asset = await fetch(new URL(entry, started.data.url));
    if (!asset.ok || (await asset.arrayBuffer()).byteLength === 0) {
      throw new Error('Packaged browser assets are unavailable');
    }
    console.log(
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        url: started.data.url,
      }),
    );
  } finally {
    if (run('stop').data.running !== false) throw new Error('Packaged server did not stop');
    // Wait for the verified child to release its SQLite and log handles before cleanup.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(started.data.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      if (attempt === 49) throw new Error('Packaged server process did not exit');
      await delay(100);
    }
  }
} finally {
  if (dirname(realpathSync.native(stage)) === base) {
    try {
      rmSync(stage, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error.code)) throw error;
      console.warn('Windows retained the temporary package check directory: ' + stage);
    }
  }
}
