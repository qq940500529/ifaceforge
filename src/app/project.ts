import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

export function resolveProject(directory: string): ProjectPaths {
  let start: string;
  try {
    start = realpathSync(resolve(directory));
  } catch {
    throw new ProjectError('INVALID_PROJECT', `Cannot open project directory: ${directory}`);
  }

  let rootPath: string;
  try {
    // Separate arguments preserve literal paths containing spaces and shell characters.
    rootPath = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProjectError('GIT_UNAVAILABLE', 'Git is required to locate the project root.');
    }
    throw new ProjectError('INVALID_PROJECT', `Not inside a Git working tree: ${start}`);
  }

  const root = realpathSync(rootPath);
  const data = join(root, '.devtools', 'ifaceforge', 'data');
  return { root, data, config: join(root, '.ifaceforge.json'), database: join(data, 'workbench.sqlite') };
}
