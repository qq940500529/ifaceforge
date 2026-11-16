import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

export const repositoryRoot = resolve(import.meta.dirname, '../..');
const cli = resolve(process.env.IFG_TEST_CLI ?? join(repositoryRoot, 'dist', 'cli', 'main.js'));
const runFile = promisify(execFile);
const parent = realpathSync.native(tmpdir());
const directories = new Map<string, string>();
const fixtureEnv = (root: string) => ({ ...process.env, IFG_DATA_HOME: directories.get(root) });

export function fixture(name = 'express') {
  const base = mkdtempSync(join(parent, 'ifaceforge 项目 with spaces '));
  const root = join(base, name);
  const data = join(base, 'data');
  directories.set(root, data);
  cpSync(join(repositoryRoot, 'fixtures', name), root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
  return {
    root,
    data,
    write(path: string, data: unknown) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data));
      return target;
    },
    destroy() {
      if (dirname(realpathSync.native(base)) !== parent) throw new Error('Unexpected fixture directory');
      directories.delete(root);
      rmSync(base, { recursive: true });
    },
  };
}

export interface Output<T> {
  exit: number;
  stderr: string;
  result: {
    schemaVersion: number;
    command: string;
    ok: boolean;
    data: T;
    error: { code: string; details: unknown } | null;
  };
}
export async function ifg<T = any>(project: string, ...args: string[]): Promise<Output<T>> {
  try {
    const { stdout, stderr } = await runFile(process.execPath, [cli, ...args, '--project', project, '--json'], {
      maxBuffer: 32 * 1024 * 1024,
      env: fixtureEnv(project),
    });
    return { exit: 0, stderr, result: JSON.parse(stdout) };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof result.code !== 'number' || !result.stdout) throw error;
    return { exit: result.code, stderr: result.stderr ?? '', result: JSON.parse(result.stdout) };
  }
}

export function ifgStdin<T = any>(project: string, input: unknown, ...args: string[]): Output<T> {
  const result = spawnSync(process.execPath, [cli, ...args, '--project', project, '--json'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 10000,
    env: fixtureEnv(project),
  });
  if (result.error) throw result.error;
  return { exit: result.status!, stderr: result.stderr, result: JSON.parse(result.stdout) };
}

export async function browserWorkbench(root: string) {
  const child = spawn(process.execPath, [join(repositoryRoot, 'dist', 'server', 'test-host.js'), root], {
    env: fixtureEnv(root),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (part) => {
    stderr += part;
  });
  const finished = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const ready = new Promise<{ url: string; data: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Browser test host exited: ' + stderr)));
    child.once('message', (message) => resolve(message as { url: string; data: string }));
  });
  const info = await ready;
  return {
    ...info,
    async stop() {
      if (child.connected) child.send('stop');
      await finished;
    },
  };
}

export async function address(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server');
  return 'http://127.0.0.1:' + address.port;
}

export function close(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
