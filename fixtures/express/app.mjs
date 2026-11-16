import express from 'express';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { pathToFileURL } from 'node:url';

export function taskApp() {
  const app = express();
  app.use(express.json());
  app.get('/tasks/:id', (req, res) => {
    if (req.params.id !== '42') return res.status(404).json({ error: 'missing' });
    res.json({ id: 42, title: 'Sample task' });
  });
  const dynamicRoute = '/health';
  app.get(dynamicRoute, (_req, res) => res.json({ ok: true }));
  app.get('/contract', (_req, res) => {
    const contract = parse(readFileSync(new URL('./openapi.yml', import.meta.url), 'utf8'));
    contract.paths['/health'] = { get: { summary: 'Health', responses: { 200: { description: 'Online' } } } };
    res.json(contract);
  });
  return app;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = taskApp().listen(Number(process.argv[2] ?? 4300), '127.0.0.1', () => {
    console.log('http://127.0.0.1:' + server.address().port);
  });
}
