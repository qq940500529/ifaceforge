import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AppError, invalid } from '../app/errors.js';
import { dataHome } from '../app/project.js';
import type { EngineRequest, Result } from './protocol.js';

export type ServiceRequest = EngineRequest | { method: 'ping' };
const tokenPattern = /^[a-f0-9]{64}$/;
export const maxRequest = 4 * 1024 * 1024;
export const maxReply = 32 * 1024 * 1024;

export function endpoint(create = false) {
  const home = dataHome();
  if (create) mkdirSync(home, { recursive: true, mode: 0o700 });
  let root: string;
  try {
    root = realpathSync.native(home);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const key = createHash('sha256')
    .update(userInfo().username + '\0' + (process.platform === 'win32' ? root.toLowerCase() : root))
    .digest('hex')
    .slice(0, 24);
  const tokenPath = join(root, '.ipc-token');
  if (create) {
    try {
      writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let token: string;
  try {
    const info = lstatSync(tokenPath);
    if (!info.isFile() || (process.platform !== 'win32' && (info.uid !== process.getuid!() || info.mode & 0o077)))
      invalid('Workspace IPC token must be a file private to the current user');
    token = readFileSync(tokenPath, 'utf8');
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!tokenPattern.test(token)) invalid('Invalid workspace IPC token');
  if (process.platform === 'win32') return { path: '\\\\.\\pipe\\ifaceforge-' + key, token };
  const directory = join(tmpdir(), 'ifg-' + key);
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (create) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.uid !== process.getuid!() || info.mode & 0o077)
      invalid('Workspace socket directory must belong to the current user');
  }
  return { path: join(directory, 'ipc'), token };
}

export function serviceRequest<T>(request: ServiceRequest, address = endpoint()): Promise<Result<T> | undefined> {
  if (!address) return Promise.resolve(undefined);
  const payload = JSON.stringify({ protocol: 1, token: address.token, request }) + '\n';
  if (Buffer.byteLength(payload) > maxRequest) invalid('Workspace command is too large');
  return new Promise((resolve, reject) => {
    const socket = connect(address.path);
    let pending = '',
      complete = false;
    socket.setEncoding('utf8');
    socket.setTimeout(180_000, () =>
      socket.destroy(new AppError('ENGINE_TIMEOUT', 'The workspace engine did not respond')),
    );
    socket.once('connect', () => socket.write(payload));
    socket.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > maxReply) {
        socket.destroy(new AppError('ENGINE_RESPONSE_LIMIT', 'Workspace response is too large'));
        return;
      }
      if (!pending.endsWith('\n')) return;
      try {
        const result = JSON.parse(pending) as Result<T>;
        complete = true;
        resolve(result);
        socket.destroy();
      } catch (error) {
        socket.destroy(new AppError('ENGINE_PROTOCOL', 'Invalid workspace response', 3, String(error)));
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      complete = true;
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(undefined);
      else reject(error);
    });
    socket.once('close', () => {
      if (!complete) reject(new AppError('ENGINE_UNAVAILABLE', 'The workspace engine disconnected'));
    });
  });
}

let booting: Promise<void> | undefined;
async function launch() {
  const address = endpoint(true)!;
  if ((await serviceRequest({ method: 'ping' }, address))?.ok) return;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./service.js', import.meta.url))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  let startupError: Error | undefined;
  child.on('error', (error) => {
    startupError = error;
  });
  child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError) throw startupError;
    if ((await serviceRequest({ method: 'ping' }, address))?.ok) return;
    await delay(75);
  }
  throw new AppError('ENGINE_UNAVAILABLE', 'Unable to start the workspace engine');
}

export async function ensureService() {
  booting ??= launch().finally(() => {
    booting = undefined;
  });
  return booting;
}
