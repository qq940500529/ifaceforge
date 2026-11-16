import express from 'express';
import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { watch } from 'node:fs';
import type { Workbench } from '../app/workbench.js';
import { AppError, failure, invalid } from '../app/errors.js';
import { webCommands } from '../cli/commands.js';
import { fingerprint, getInstance, instancePath, type Instance } from './instance.js';

function matches(value: string | undefined, secret: string) {
  return (
    !!value &&
    Buffer.byteLength(value) === Buffer.byteLength(secret) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(secret))
  );
}

export async function serve(workbench: Workbench, port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) invalid('Invalid TCP port');
  const { project } = workbench;
  const running = await getInstance(project);
  if (running)
    throw new AppError('ALREADY_RUNNING', 'Project already has a running instance', 3, { url: running.url });
  const lock = join(project.data, 'instance.lock');
  try {
    const owner = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(owner) || owner < 1) throw new AppError('BUSY', 'Instance is starting');
    try {
      process.kill(owner, 0);
      throw new AppError('ALREADY_RUNNING', 'A workbench is running or starting');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      rmSync(lock);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AppError('ALREADY_RUNNING', 'A workbench is starting');
    throw error;
  }
  const csrf = randomBytes(32).toString('hex');
  const app = express();
  const server = createServer(app);
  let instance: Instance;
  let closing: Promise<void> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  const stop = () => {
    closing ??= (async () => {
      watcher?.close();
      await workbench.executor.close();
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(() => server.closeAllConnections(), 750);
        server.close(() => {
          clearTimeout(deadline);
          resolve();
        });
      });
      rmSync(instancePath(project), { force: true });
      rmSync(lock, { force: true });
    })();
    return closing;
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    });
    if (req.get('host') !== new URL(instance.url).host)
      return res.status(403).json({ code: 'INVALID_HOST', message: 'Invalid Host', details: null });
    next();
  });
  const access = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!matches(req.get('x-ifg-instance'), instance.token)) {
      res.status(403).json({ code: 'FORBIDDEN', message: 'Invalid instance token', details: null });
    } else next();
  };
  app.get('/api/v1/instance', access, (_req, res) => {
    const { token: _token, ...info } = instance;
    res.json(info);
  });
  app.post('/api/v1/instance/stop', access, (_req, res) => {
    res.once('finish', () => void stop().catch((error) => process.stderr.write(String(error) + '\n')));
    res.json({ stopping: true });
  });
  app.get('/api/v1/bootstrap', (req, res) => {
    if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== instance.url)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Invalid origin', details: null });
    }
    res.json({ csrf });
  });
  app.post(
    '/api/v1/commands/:command',
    (req, res, next) => {
      if (req.get('origin') !== instance.url || !matches(req.get('x-ifg-csrf'), csrf)) {
        return res
          .status(403)
          .json({ code: 'FORBIDDEN', message: 'Invalid origin or request token', details: null });
      }
      if (closing)
        return res
          .status(503)
          .json({ code: 'SHUTTING_DOWN', message: 'Workbench is shutting down', details: null });
      next();
    },
    express.json({ limit: '4mb' }),
    async (req, res, next) => {
      try {
        if (!webCommands.has(req.params.command)) invalid('Unknown command');
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
          invalid('Expected command parameters');
        res.json(await workbench.execute(req.params.command, req.body, false));
      } catch (error) {
        next(error);
      }
    },
  );
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  const index = join(web, 'index.html');
  app.use(express.static(web, { index: false, fallthrough: true, dotfiles: 'deny' }));
  app.get('/', (_req, res) => {
    if (!existsSync(index))
      return res.status(503).type('text').send('Run npm run build to compile the web interface.');
    res.sendFile('index.html', { root: web });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const err = failure(error);
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : ['BUSY', 'VERSION_CONFLICT', 'REPLACE_REQUIRED', 'WIKI_CONFLICT'].includes(err.code)
          ? 409
          : err.exitCode === 2
            ? 400
            : err.code === 'OPERATION_FAILED'
              ? 500
              : 422;
    res.status(status).json({ code: err.code, message: err.message, details: err.details });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Server did not report a TCP address');
    instance = {
      id: randomUUID(),
      token: randomBytes(32).toString('hex'),
      url: 'http://127.0.0.1:' + address.port,
      pid: process.pid,
      project: fingerprint(project),
    };
    writeFileSync(instancePath(project), JSON.stringify(instance), { mode: 0o600 });
    watcher = watch(project.data, { persistent: false }, () => {
      // Keep the server scoped to this project's instance file.
      if (!existsSync(lock)) void stop();
    });
  } catch (error) {
    server.close();
    rmSync(lock, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      throw new AppError('PORT_IN_USE', 'Requested port is in use', 3, { port });
    throw error;
  }
  let done: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  server.once('close', () => {
    void (closing ?? Promise.resolve()).finally(done);
  });
  return { instance, stop, finished };
}
