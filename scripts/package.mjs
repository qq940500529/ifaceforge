import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'release');
const base = join(root, '.devtools', 'ifaceforge');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this script with npm run package.');
mkdirSync(base, { recursive: true });
mkdirSync(out, { recursive: true });
const stage = mkdtempSync(join(base, 'package-'));
const app = join(stage, 'ifaceforge');
mkdirSync(app);
try {
  for (const path of ['dist', 'LICENSE', 'README.md', 'package.json', 'package-lock.json']) {
    cpSync(join(root, path), join(app, path), { recursive: true });
  }
  mkdirSync(join(app, 'docs'));
  for (const file of ['cli.md', 'release.md', 'development-spec.md', 'assets']) {
    cpSync(join(root, 'docs', file), join(app, 'docs', file), { recursive: true });
  }
  execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: app,
    stdio: 'inherit',
  });
  writeFileSync(join(app, 'ifg.cmd'), '@echo off\r\nnode "%~dp0dist\\cli\\main.js" %*\r\n');
  writeFileSync(join(app, 'ifg'), '#!/bin/sh\nexec node "$(dirname "$0")/dist/cli/main.js" "$@"\n', {
    mode: 0o755,
  });
  const archive = join(out, 'ifaceforge-' + packageJson.version + '.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', stage, 'ifaceforge'], { stdio: 'inherit' });
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(join(out, 'SHA256SUMS.txt'), sha + '  ' + basename(archive) + '\n');
  console.log(archive);
} finally {
  if (dirname(stage) === base) rmSync(stage, { recursive: true, force: true });
}
