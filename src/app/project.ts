import { execFile, execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export interface ProjectPaths {
  root: string;
  config: string;
  data: string;
  database: string;
}

export class ProjectError extends Error {
  constructor(
    readonly code: 'INVALID_PROJECT' | 'GIT_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

export function dataHome() {
  if (process.env.IFG_DATA_HOME) return resolve(process.env.IFG_DATA_HOME);
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'IfaceForge');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'IfaceForge');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ifaceforge');
}

function gitOptions() {
  // GUI processes may inherit repository overrides from the terminal that launched them.
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'])
    delete env[key];
  return { encoding: 'utf8', windowsHide: true, env, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 } as const;
}

export function git(root: string, args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { ...gitOptions(), stdio: ['ignore', 'pipe', 'pipe'] });
}

const executeGit = promisify(execFile);
export async function gitAsync(root: string, args: string[], signal: AbortSignal) {
  const { stdout } = await executeGit('git', ['-C', root, ...args], { ...gitOptions(), signal });
  return stdout;
}

export function locateProject(directory: string): string {
  let start: string;
  try {
    start = realpathSync.native(resolve(directory));
    if (!statSync(start).isDirectory()) throw Error('Not a directory');
  } catch {
    throw new ProjectError('INVALID_PROJECT', 'Cannot open project directory: ' + directory);
  }
  try {
    return realpathSync.native(git(start, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProjectError(
        'GIT_UNAVAILABLE',
        'Install Git and make it available on PATH, then restart IfaceForge.',
      );
    }
    throw new ProjectError('INVALID_PROJECT', 'Not inside a Git working tree: ' + start);
  }
}

export function projectPaths(root: string, data: string): ProjectPaths {
  return { root, data, config: join(root, '.ifaceforge.json'), database: join(data, 'workbench.sqlite') };
}
