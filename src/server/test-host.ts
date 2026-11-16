import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Workbench } from '../app/workbench.js';
import { failure, invalid } from '../app/errors.js';
import { commandNames } from '../cli/commands.js';
import { Projects } from '../storage/projects.js';
import { openProjectDatabase } from '../storage/database.js';
import { Repository } from '../storage/repository.js';

// This loopback adapter is used only by browser regression tests.
const registry = new Projects();
const project = registry.paths(registry.add(process.argv[2]).id);
const db = openProjectDatabase(project);
const bench = new Workbench(project, new Repository(db));
const app = express();
const csrf = randomUUID();
app.get('/api/v1/bootstrap', (_req, res) => {
  res.json({ csrf });
});
app.post('/api/v1/commands/:command', express.json({ limit: '4mb' }), async (req, res) => {
  try {
    if (req.get('x-ifg-csrf') !== csrf || req.get('origin') !== 'http://' + req.get('host')) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Invalid test session' });
    }
    if (!commandNames.has(req.params.command)) invalid('Unknown command');
    return res.json(await bench.execute(req.params.command, req.body, false));
  } catch (error) {
    const { code, message, details } = failure(error);
    return res.status(400).json({ code, message, details });
  }
});
app.use(express.static(fileURLToPath(new URL('../web/', import.meta.url))));
const server = app.listen(0, '127.0.0.1', () => {
  if (process.send) {
    const address = server.address();
    if (address && typeof address !== 'string')
      process.send({ url: 'http://127.0.0.1:' + address.port, data: project.data });
  }
});
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await bench.executor.close();
  server.closeAllConnections();
  server.close(() => {
    db.close();
    registry.close();
    if (process.connected) process.disconnect();
  });
}
process.on('message', (message) => {
  if (message === 'stop') void close();
});
process.on('disconnect', () => void close());
