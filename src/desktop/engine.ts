import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { basename, isAbsolute, relative } from 'node:path';
import { AppError, failure, invalid } from '../app/errors.js';
import { locateProject } from '../app/project.js';
import { Workbench } from '../app/workbench.js';
import type { Run } from '../app/runs.js';
import type { ScanProgress } from '../app/catalog.js';
import { commandNames } from '../cli/commands.js';
import { openProjectDatabase } from '../storage/database.js';
import { Projects } from '../storage/projects.js';
import { Repository } from '../storage/repository.js';
import type { EngineRequest, ErrorInfo, ScanSummary, ScanTask, TaskList, WorkspaceState } from './protocol.js';

const registry = new Projects();
const benches = new Map<string, Workbench>();
type ScanJob = { task: ScanTask; worker: Worker; signal: Int32Array; finished: Promise<void> };
const scans = new Map<string, ScanJob>();
const inFlight = new Map<string, number>();
const disposing = new Set<string>();
const active = (task?: ScanTask) => task?.state === 'running' || task?.state === 'cancelling';
let closing = false;

function workspace(): WorkspaceState {
  const projects = registry.list();
  const saved = registry.preference('selected');
  const visible = projects.filter((project) => !project.hidden);
  const lang = registry.preference('locale');
  return {
    projects,
    selected:
      visible.find((project) => project.id === saved)?.id ?? visible.find((project) => project.available)?.id,
    locale: lang === 'en' || lang === 'zh-CN' ? lang : undefined,
  };
}
function select(project: string) {
  registry.touch(project);
  registry.setPreference('selected', project);
  return workspace();
}
function workbench(id: string) {
  const paths = registry.paths(id);
  const current = benches.get(id);
  if (current) return current;
  const bench = new Workbench(paths, new Repository(openProjectDatabase(paths)));
  benches.set(id, bench);
  return bench;
}
function tasks(): TaskList {
  const runs = [...benches].flatMap(([project, bench]) =>
    bench.repository
      .list<Run>('runs')
      .filter((run) => run.status === 'running')
      .map((run) => ({
        project,
        id: run.id,
        kind: run.kind,
        started: run.started,
      })),
  );
  return { scans: [...scans.values()].map(({ task }) => task), runs };
}

function startScan(project: string, input: { full?: boolean; includeUntracked?: boolean }) {
  const current = scans.get(project);
  if (current && active(current.task)) return current.task;
  const paths = registry.paths(project);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const task: ScanTask = {
    id: randomUUID(),
    project,
    started: Date.now(),
    state: 'running',
    stage: 'enumerating',
    processed: 0,
    warnings: 0,
  };
  const worker = new Worker(new URL('./scan-worker.js', import.meta.url), {
    workerData: {
      project: paths,
      input: { full: input.full === true, includeUntracked: input.includeUntracked },
      signal: signal.buffer,
    },
  });
  const finished = new Promise<void>((resolve) =>
    worker.once('exit', (code) => {
      if (active(task)) fail({ code: 'SCAN_EXITED', message: 'Scan process exited (' + code + ')' });
      resolve();
    }),
  );
  const fail = (error: ErrorInfo) => {
    if (!active(task)) return;
    task.state = error.code === 'SCAN_CANCELLED' ? 'cancelled' : 'failed';
    task.finished = Date.now();
    if (task.state === 'failed') task.error = error;
  };
  worker.on(
    'message',
    ({ progress, result, error }: { progress?: ScanProgress; result?: ScanSummary; error?: ErrorInfo }) => {
      if (progress && active(task)) Object.assign(task, progress);
      if (error) fail(error);
      if (result && active(task)) {
        task.state = 'complete';
        task.result = result;
        task.finished = Date.now();
      }
    },
  );
  worker.on('error', (error) => fail(failure(error)));
  scans.set(project, { task, worker, signal, finished });
  return task;
}

async function dispose(project: string, change: () => WorkspaceState) {
  if (
    disposing.has(project) ||
    inFlight.has(project) ||
    active(scans.get(project)?.task) ||
    tasks().runs.some((run) => run.project === project)
  ) {
    throw new AppError('BUSY', 'Finish or cancel the active tasks for this project first.');
  }
  disposing.add(project);
  try {
    const bench = benches.get(project);
    if (bench) {
      await bench.executor.close();
      bench.repository.db.close();
      benches.delete(project);
    }
    return change();
  } finally {
    disposing.delete(project);
  }
}

async function execute(request: EngineRequest): Promise<unknown> {
  if (closing) throw new AppError('SHUTTING_DOWN', 'IfaceForge is closing.');
  switch (request.method) {
    case 'state':
      return workspace();
    case 'locale':
      if (!['en', 'zh-CN'].includes(request.locale)) invalid('Unsupported language');
      registry.setPreference('locale', request.locale);
      return workspace();
    case 'inspect':
      return { selected: realpathSync.native(request.path), root: locateProject(request.path) };
    case 'add': {
      const record = registry.add(request.path);
      workbench(record.id);
      return select(record.id);
    }
    case 'select':
      return select(request.project);
    case 'hide':
      registry.hide(request.project);
      return workspace();
    case 'delete':
      return dispose(request.project, () => {
        registry.delete(request.project);
        scans.delete(request.project);
        return workspace();
      });
    case 'relocate':
      return dispose(request.project, () => select(registry.relocate(request.project, request.path).id));
    case 'tasks':
      return tasks();
    case 'scan cancel': {
      const job = scans.get(request.project);
      if (!job || job.task.id !== request.task) invalid('Scan task not found');
      if (active(job.task)) {
        job.task.state = 'cancelling';
        Atomics.store(job.signal, 0, 1);
        job.worker.postMessage('cancel');
      }
      return job.task;
    }
    case 'command': {
      const { name, input, project } = request;
      if (!commandNames.has(name)) invalid('Unknown desktop command');
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected command parameters');
      if (disposing.has(project)) throw new AppError('BUSY', 'Project storage is being changed.');
      if (name === 'scan') return startScan(project, input);
      if (name === 'data restore' && active(scans.get(project)?.task)) {
        throw new AppError('BUSY', 'Wait for the scan to finish before restoring data.');
      }
      const bench = workbench(project);
      inFlight.set(project, (inFlight.get(project) ?? 0) + 1);
      try {
        const params =
          name === 'api import' && input.file && isAbsolute(input.file)
            ? { ...input, file: relative(bench.project.root, input.file) }
            : input;
        const data = await bench.execute(name, params, false);
        if (name === 'project') return { ...(data as object), name: basename(bench.project.root) };
        return data;
      } finally {
        const remaining = (inFlight.get(project) ?? 1) - 1;
        if (remaining) inFlight.set(project, remaining);
        else inFlight.delete(project);
      }
    }
    case 'close':
      closing = true;
      for (const job of scans.values()) {
        if (!active(job.task)) continue;
        Atomics.store(job.signal, 0, 1);
        job.worker.postMessage('cancel');
      }
      await Promise.all([...benches.values()].map((bench) => bench.executor.close()));
      await Promise.all([...scans.values()].map((job) => job.finished));
      for (const bench of benches.values()) bench.repository.db.close();
      registry.close();
      return true;
  }
}

const port = process.parentPort;
if (!port) throw new Error('Start the engine from IfaceForge.');
port.on('message', async ({ data }: { data: { id: number; request: EngineRequest } }) => {
  const { id, request } = data;
  try {
    port.postMessage({ id, result: { ok: true, data: await execute(request) } });
  } catch (error) {
    const { code, message, details } = failure(error);
    port.postMessage({ id, result: { ok: false, error: { code, message, details } } });
  }
});
