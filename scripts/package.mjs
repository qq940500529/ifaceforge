import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = resolve(process.env.IFG_CLI_OUTPUT ?? join(root, 'release'));
const base = join(root, '.devtools', 'ifaceforge');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this script with npm run package:cli.');
mkdirSync(base, { recursive: true });
mkdirSync(out, { recursive: true });
const stage = mkdtempSync(join(base, 'package-'));
const app = join(stage, 'ifaceforge');
mkdirSync(app);
try {
  for (const path of ['LICENSE', 'README.md', 'package.json', 'package-lock.json']) {
    cpSync(join(root, path), join(app, path), { recursive: true });
  }
  for (const folder of ['app', 'cli', 'desktop', 'protocols', 'scanner', 'schemas', 'storage']) {
    cpSync(join(root, 'dist', folder), join(app, 'dist', folder), { recursive: true });
  }
  mkdirSync(join(app, 'docs'));
  for (const file of [
    'cli.md',
    'cli-agent.md',
    'mcp.md',
    'mcp-discovery-plan.md',
    'release.md',
    'development-spec.md',
    'developer-guide.md',
    'developer-guide.en.md',
    'compatibility.json',
  ]) {
    cpSync(join(root, 'docs', file), join(app, 'docs', file), { recursive: true });
  }
  execFileSync(
    process.execPath,
    [npm, 'ci', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'],
    {
      cwd: app,
      stdio: 'inherit',
    },
  );
  const runtime = join(app, 'runtime');
  mkdirSync(runtime);
  const windows = process.platform === 'win32';
  cpSync(process.execPath, join(runtime, windows ? 'node.exe' : 'node'));
  const distributionLicense = process.env.IFG_NODE_LICENSE;
  const license = distributionLicense ? readFileSync(distributionLicense) : await runtimeLicense();
  writeFileSync(join(runtime, 'LICENSE'), license);
  if (windows) {
    writeFileSync(join(app, 'ifg.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\cli\\main.js" %*\r\n');
  } else {
    writeFileSync(
      join(app, 'ifg'),
      '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/runtime/node" "$base/dist/cli/main.js" "$@"\n',
      { mode: 0o755 },
    );
  }
  const artifact = 'ifaceforge-cli-' + packageJson.version + '-' + process.platform + '-' + process.arch;
  const archive = join(out, artifact + '.tar.gz');
  const contents = execFileSync('tar', ['-czf', '-', 'ifaceforge'], { cwd: stage, maxBuffer: 192 * 1024 * 1024 });
  writeFileSync(archive, contents);
  const sha = createHash('sha256').update(contents).digest('hex');
  writeFileSync(join(out, artifact + '.sha256'), sha + '  ' + basename(archive) + '\n');
  console.log(archive);
} finally {
  if (dirname(stage) === base) rmSync(stage, { recursive: true, force: true });
}

async function runtimeLicense() {
  const directory = dirname(process.execPath);
  const distributed = [join(directory, 'LICENSE'), join(dirname(directory), 'LICENSE')].find(existsSync);
  if (distributed) return readFileSync(distributed);
  const url = 'https://raw.githubusercontent.com/nodejs/node/' + process.version + '/LICENSE';
  const response = await fetch(url, { signal: globalThis.AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error('Node.js license download failed with HTTP ' + response.status);
  const text = await response.text();
  if (!text.includes('Node.js is licensed') || text.length < 500)
    throw Error('Expected the complete Node.js license');
  return text;
}
