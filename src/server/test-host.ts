import express from 'express';
import { fileURLToPath } from 'node:url';
import { Workbench, type CommandInput } from '../app/workbench.js';
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
app.use((req, res, next) => {
  const address = server.address();
  if (!address || typeof address === 'string' || req.get('host') !== '127.0.0.1:' + address.port) {
    return res.sendStatus(403);
  }
  next();
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
    if (process.connected) process.disconnect?.();
  });
}
process.on('message', async (message: 'stop' | { id: number; command: string; input: CommandInput }) => {
  if (message === 'stop') return close();
  if (!message || !Number.isSafeInteger(message.id)) return;
  try {
    if (!commandNames.has(message.command)) invalid('Unknown command');
    const data = await bench.execute(message.command, message.input, false);
    process.send?.({ id: message.id, status: 200, data });
  } catch (error) {
    const { code, message: text, details } = failure(error);
    process.send?.({ id: message.id, status: 400, data: { code, message: text, details } });
  }
});
process.on('disconnect', () => void close());
