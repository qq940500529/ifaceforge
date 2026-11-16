import { timingSafeEqual } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { AppError, failure, invalid } from '../app/errors.js';
import { execute, hasActiveWork } from './engine.js';
import type { Result } from './protocol.js';
import { endpoint, maxReply, maxRequest, serviceRequest, type ServiceRequest } from './service-client.js';

delete process.env.ELECTRON_RUN_AS_NODE;
if (process.platform !== 'win32') process.umask(0o077);
const address = endpoint(true)!;
const expectedToken = Buffer.from(address.token);
const rawIdle = Number(process.env.IFG_SERVICE_IDLE_MS);
const idle = Number.isFinite(rawIdle) && rawIdle >= 1000 ? rawIdle : 300_000;
const sockets = new Set<Socket>();
let lastUsed = Date.now(),
  stopping = false;
let inFlight = 0;

function reply(socket: Socket, value: Result<unknown>) {
  const json = JSON.stringify(value) + '\n';
  socket.end(
    Buffer.byteLength(json) <= maxReply
      ? json
      : JSON.stringify({
          ok: false,
          error: { code: 'ENGINE_RESPONSE_LIMIT', message: 'Workspace response is too large' },
        }) + '\n',
  );
}

const server = createServer((socket) => {
  sockets.add(socket);
  let pending = '',
    received = false;
  socket.setEncoding('utf8');
  socket.setTimeout(15_000, () => socket.destroy());
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
  socket.on('data', async (chunk: string) => {
    if (received) return;
    pending += chunk;
    if (Buffer.byteLength(pending) > maxRequest) {
      socket.destroy();
      return;
    }
    if (!pending.endsWith('\n')) return;
    received = true;
    socket.setTimeout(0);
    inFlight++;
    let close = false;
    try {
      const packet = JSON.parse(pending) as { protocol?: number; token?: string; request?: ServiceRequest };
      if (
        packet.protocol !== 1 ||
        typeof packet.token !== 'string' ||
        Buffer.byteLength(packet.token) !== expectedToken.length ||
        !timingSafeEqual(Buffer.from(packet.token), expectedToken)
      ) {
        throw new AppError('FORBIDDEN', 'Invalid local workspace credentials');
      }
      lastUsed = Date.now();
      if (!packet.request || typeof packet.request.method !== 'string') invalid('Expected a workspace method');
      const request = packet.request;
      if (stopping) throw new AppError('SHUTTING_DOWN', 'IfaceForge is closing');
      if (request.method === 'close') {
        if (inFlight > 1 || (!request.force && hasActiveWork()))
          throw new AppError('BUSY', 'Finish or cancel active workspace tasks and MCP sessions first');
        stopping = true;
        close = true;
      }
      const data = request.method === 'ping' ? { protocol: 1 } : await execute(request);
      reply(socket, { ok: true, data });
    } catch (error) {
      const { code, message, details, exitCode } = failure(error);
      reply(socket, { ok: false, error: { code, message, details, exitCode } });
    } finally {
      inFlight--;
      if (close) stopListening();
    }
  });
});

function stopListening() {
  clearInterval(cleanup);
  server.close();
}

async function stop() {
  if (stopping) return;
  stopping = true;
  for (const socket of sockets) socket.destroy();
  try {
    await execute({ method: 'close' });
  } finally {
    stopListening();
  }
}

const cleanup = setInterval(
  () => {
    if (!inFlight && Date.now() - lastUsed > idle && !hasActiveWork()) void stop();
  },
  Math.min(5000, idle),
);
cleanup.unref();

let retried = false;
server.on('error', async (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    if (process.platform !== 'win32' && !retried) {
      retried = true;
      try {
        const stale = lstatSync(address.path);
        if (
          stale.isSocket() &&
          stale.uid === process.getuid!() &&
          !(await serviceRequest({ method: 'ping' }, address))
        ) {
          if (lstatSync(address.path).ino === stale.ino) unlinkSync(address.path);
          server.listen(address.path);
          return;
        }
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
          server.listen(address.path);
          return;
        }
      }
    }
    await stop();
  } else throw error;
});

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
server.listen(address.path);
