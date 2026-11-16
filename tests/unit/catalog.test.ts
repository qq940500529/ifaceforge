import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { locateProject, projectPaths } from '../../src/app/project.js';
import { openProjectDatabase } from '../../src/storage/database.js';
import { Repository } from '../../src/storage/repository.js';
import { checkConfig } from '../../src/app/config.js';
import { activeSnapshot, diffScans, scanProject, searchCatalog } from '../../src/app/catalog.js';
import { parseJson } from '../../src/app/files.js';

const parent = realpathSync.native(tmpdir());
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(realpathSync.native(root)) !== parent) throw Error('Unexpected fixture path');
    rmSync(root, { recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(parent, 'ifg 目录 '));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  return projectPaths(locateProject(root), join(root, '.test-data'));
}

it('rejects duplicate keys, unsupported settings, duplicate sources and escaping paths', () => {
  const project = fixture();
  expect(() => parseJson('{"schemaVersion":1,"schemaVersion":2}')).toThrow('Duplicate JSON key');
  expect(() => checkConfig(project, { schemaVersion: 1, typo: true })).toThrow('schema');
  expect(() => checkConfig(project, { schemaVersion: 1, sources: [{ id: 'app' }, { id: 'app' }] })).toThrow(
    'Duplicate source',
  );
  expect(() => checkConfig(project, { schemaVersion: 1, sources: [{ id: 'app', roots: ['../escape'] }] })).toThrow(
    'escapes',
  );
});

it('merges route evidence, searches skill text and keeps the active snapshot when parsing fails', () => {
  const project = fixture();
  const write = (path: string, value: string) => writeFileSync(join(project.root, path), value);
  mkdirSync(join(project.root, 'tasks'));
  write('tasks/SKILL.md', '---\nname: tasks\ndescription: Read tasks\n---\n任务说明 [missing](missing.md)');
  write('app.js', "import express from 'express'; const app = express(); app.get('/tasks/:id', handler);");
  write('openapi.yml', 'openapi: 3.1.0\npaths:\n  /tasks/{taskId}:\n    get:\n      summary: Read task\n');
  const db = openProjectDatabase(project);
  try {
    const repository = new Repository(db);
    const snapshot = scanProject(project, repository, { includeUntracked: true });
    expect(snapshot.complete).toBe(true);
    const api = searchCatalog(repository, { query: 'read task', kind: 'api' }).items[0];
    expect(api.observations.map((item) => item.origin).sort()).toEqual(['declaration', 'source']);
    expect(api.differences).toContain('DEFINITION_CONFLICT');
    expect(
      searchCatalog(repository, { query: '任务说明' }).items[0].observations[0].definition.references,
    ).toEqual([{ path: 'tasks/missing.md', status: 'missing' }]);
    write('openapi.yml', 'openapi: [invalid');
    const failed = scanProject(project, repository, { includeUntracked: true });
    expect(failed.complete).toBe(false);
    expect(activeSnapshot(repository)?.id).toBe(snapshot.id);
    expect(diffScans(snapshot, failed)).toMatchObject({ comparable: false, removed: [] });
  } finally {
    db.close();
  }
});

it('reports real scan progress and leaves the previous snapshot intact when cancelled', () => {
  const project = fixture();
  writeFileSync(
    join(project.root, 'routes.js'),
    "import express from 'express'; const app = express(); app.get('/original', handler);",
  );
  const db = openProjectDatabase(project);
  try {
    const repository = new Repository(db);
    const original = scanProject(project, repository, { includeUntracked: true });
    writeFileSync(
      join(project.root, 'routes.js'),
      "import express from 'express'; const app = express(); app.get('/edited', handler);",
    );
    const stages: string[] = [];
    expect(() =>
      scanProject(project, repository, {
        includeUntracked: true,
        progress: ({ stage }) => {
          stages.push(stage);
        },
        cancelled: () => stages.includes('saving'),
      }),
    ).toThrow('Scan cancelled');
    expect(stages).toEqual(['enumerating', 'processing', 'saving']);
    expect(activeSnapshot(repository)?.id).toBe(original.id);
    expect(repository.list('scans')).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('verifies Express receivers, preserves client calls as evidence, and reports custom Python coverage', () => {
  const project = fixture();
  const write = (path: string, value: string) => writeFileSync(join(project.root, path), value);
  write(
    'browser.ts',
    [
      'const api = createManagementApi();',
      'void api.get("/browser-only");',
      'void api.get("/documented?q=page");',
      'void fetch("/fetch-only", { method: "POST" });',
    ].join('\n'),
  );
  write(
    'server.ts',
    [
      'import web, { Router as makeRouter } from "express";',
      'const api = web(), sub = makeRouter();',
      'const alias = sub;',
      'const pattern = "/widgets/:id";',
      'alias.get(pattern, respond);',
      'api.route("/documented").get(respond);',
      'function render(api) { api.get("/shadowed", respond); }',
      'api.get(pathFromConfig, respond);',
      'const other = new Map(); other.get("/map-only");',
    ].join('\n'),
  );
  write(
    'common.cjs',
    [
      'const { Router: localRoutes } = require("express");',
      'const router = localRoutes();',
      'router.post("/common", respond);',
    ].join('\n'),
  );
  write('contract.json', JSON.stringify({ openapi: '3.1.0', paths: { '/documented': { get: {} } } }));
  write(
    'handler.py',
    [
      'from urllib.parse import urlsplit',
      'def dispatch(handler):',
      '    route = urlsplit(handler.path)',
      '    if handler.command != "GET":',
      '        raise ValueError(route)',
    ].join('\n'),
  );
  write('another.py', 'from flask import Flask\n@app.get("/flask")\ndef route(): pass\n');
  const db = openProjectDatabase(project);
  try {
    const repository = new Repository(db);
    const snapshot = scanProject(project, repository, { includeUntracked: true });
    const result = searchCatalog(repository, { kind: 'api' });
    expect(result.items.map((item) => item.name)).toEqual([
      'GET /documented',
      'GET /widgets/{id}',
      'POST /common',
    ]);
    expect(result.items[0].observations.map((entry) => entry.origin).sort()).toEqual([
      'call-site',
      'declaration',
      'source',
    ]);
    expect(result.items[0].differences).toEqual([]);
    expect(result.coverage).toMatchObject({
      unresolved: 2,
      examples: expect.arrayContaining([
        expect.objectContaining({ path: 'handler.py', line: 2, code: 'HTTP_HANDLER_UNRESOLVED' }),
        expect.objectContaining({ path: 'server.ts', line: 8, code: 'DYNAMIC_ROUTE' }),
      ]),
    });
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'HTTP_CALL_SITE', path: 'browser.ts', line: 2 }),
        expect.objectContaining({ code: 'HTTP_CALL_SITE', path: 'browser.ts', line: 4 }),
      ]),
    );
  } finally {
    db.close();
  }
});
