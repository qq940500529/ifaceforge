import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectPaths } from '../app/project.js';
import { AppError, invalid } from '../app/errors.js';

export const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string;
export interface Instance {
  id: string;
  token: string;
  url: string;
  pid: number;
  project: string;
}
export const instancePath = (project: ProjectPaths) => join(project.data, 'instance.json');
export const fingerprint = (project: ProjectPaths) => createHash('sha256').update(project.root).digest('hex');

export function readInstance(project: ProjectPaths): Instance | undefined {
  try {
    const instance = JSON.parse(readFileSync(instancePath(project), 'utf8')) as Instance;
    const expected = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
    if (
      instance.project === fingerprint(project) &&
      Number.isInteger(instance.pid) &&
      typeof instance.id === 'string' &&
      typeof instance.token === 'string' &&
      expected.test(instance.url)
    )
      return instance;
  } catch {
    // A missing or stale local file does not establish an instance.
  }
}

export async function getInstance(project: ProjectPaths): Promise<Instance | undefined> {
  const instance = readInstance(project);
  if (!instance) return;
  try {
    const response = await fetch(instance.url + '/api/v1/instance', {
      headers: { 'x-ifg-instance': instance.token },
      redirect: 'error',
      signal: AbortSignal.timeout(650),
    });
    if (!response.ok) return;
    const result = (await response.json()) as { id: string; project: string; pid: number };
    if (result.id === instance.id && result.project === instance.project && result.pid === instance.pid)
      return instance;
  } catch {
    return;
  }
}

export function openLocation(target: string) {
  const executable =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(executable, [target], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {
    /* Caller also receives the address or path. */
  });
  child.unref();
}

export async function stopInstance(project: ProjectPaths) {
  const instance = await getInstance(project);
  if (!instance) return { running: false };
  const response = await fetch(instance.url + '/api/v1/instance/stop', {
    method: 'POST',
    headers: { 'x-ifg-instance': instance.token },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new AppError('STOP_FAILED', 'Could not stop the verified instance');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!existsSync(instancePath(project))) return { running: false, url: instance.url };
    await delay(100);
  }
  throw new AppError('STOP_TIMEOUT', 'The instance is still shutting down');
}

export async function startInstance(project: ProjectPaths, port?: number, noOpen = false) {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) invalid('Invalid TCP port');
  const existing = await getInstance(project);
  if (existing) {
    if (port !== undefined && new URL(existing.url).port !== String(port))
      throw new AppError('ALREADY_RUNNING', 'Project already has a running instance');
    if (!noOpen) openLocation(existing.url);
    return instanceResult(existing);
  }
  const log = openSync(join(project.data, 'web.log'), 'a');
  let child: ChildProcess;
  try {
    const entry = fileURLToPath(new URL('../cli/main.js', import.meta.url));
    child = spawn(
      process.execPath,
      [
        entry,
        'start',
        '--foreground',
        '--no-open',
        '--project',
        project.root,
        ...(port === undefined ? [] : ['--port', String(port)]),
      ],
      {
        detached: true,
        stdio: ['ignore', 'ignore', log, 'ipc'],
        windowsHide: true,
      },
    );
  } finally {
    closeSync(log);
  }
  const started = await new Promise<Instance>((resolve, reject) => {
    const timer = setTimeout(() => done(new AppError('START_TIMEOUT', 'Workbench did not start in time')), 15000);
    function done(error?: Error, instance?: Instance) {
      clearTimeout(timer);
      child.removeListener('exit', exited);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error);
      else resolve(instance!);
    }
    function exited() {
      done(new AppError('START_FAILED', 'Workbench exited before it reported an address'));
    }
    child.once('error', done);
    child.once('exit', exited);
    child.once('message', (message: { instance?: Instance; code?: string; message?: string }) => {
      if (message.instance) done(undefined, message.instance);
      else done(new AppError(message.code ?? 'START_FAILED', message.message ?? 'Failed to start workbench'));
    });
  });
  if (!noOpen) openLocation(started.url);
  return instanceResult(started);
}

export function instanceResult(instance?: Instance) {
  return {
    running: !!instance,
    id: instance?.id,
    url: instance?.url,
    pid: instance?.pid,
    versions: { ifaceforge: version, node: process.versions.node, sqlite: process.versions.sqlite },
  };
}
