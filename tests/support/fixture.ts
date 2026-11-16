import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

export const repositoryRoot = resolve(import.meta.dirname, '../..');
const cli = resolve(process.env.IFG_TEST_CLI ?? join(repositoryRoot, 'dist', 'cli', 'main.js'));
const runFile = promisify(execFile);
const parent = realpathSync.native(tmpdir());

export function fixture(name = 'express') {
  const root = mkdtempSync(join(parent, 'ifaceforge 项目 with spaces '));
  cpSync(join(repositoryRoot, 'fixtures', name), root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
  return {
    root,
    write(path: string, data: unknown) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data));
      return target;
    },
    destroy() {
      if (dirname(realpathSync.native(root)) !== parent) throw new Error('Unexpected fixture directory');
      rmSync(root, { recursive: true });
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
  });
  if (result.error) throw result.error;
  return { exit: result.status!, stderr: result.stderr, result: JSON.parse(result.stdout) };
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
