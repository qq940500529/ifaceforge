import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { basename, isAbsolute, relative } from 'node:path';
import { AppError, failure, invalid } from '../app/errors.js';
import { locateProject } from '../app/project.js';
import { Workbench, type CommandInput } from '../app/workbench.js';
import type { Run } from '../app/runs.js';
import type { ScanProgress } from '../app/catalog.js';
import { commandNames } from '../cli/commands.js';
import { bindingEnvironment } from '../protocols/variables.js';
import { openProjectDatabase } from '../storage/database.js';
import { Projects } from '../storage/projects.js';
import { Repository } from '../storage/repository.js';
import type {
  EngineRequest,
  ErrorInfo,
  ScanSummary,
  ScanTask,
  TaskList,
  VersionTask,
  WorkspaceState,
} from './protocol.js';

const registry = new Projects();
const benches = new Map<string, Workbench>();
type ScanJob = { task: ScanTask; worker: Worker; signal: Int32Array; finished: Promise<void> };
const scans = new Map<string, ScanJob>();
const versions = new Map<string, Omit<ScanJob, 'task'> & { task: VersionTask }>();
const inFlight = new Map<string, number>();
const disposing = new Set<string>();
const active = (task?: Pick<ScanTask, 'state'>) => task?.state === 'running' || task?.state === 'cancelling';
let closing = false;

function persisted(task: ScanTask | VersionTask) {
  registry.putTask(task);
  return task;
}

function interrupted(task: ScanTask | VersionTask) {
  return active(task)
    ? {
        ...task,
        state: 'failed',
        error: { code: 'TASK_INTERRUPTED', message: 'The workspace service exited before completing this task' },
      }
    : task;
}

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
  return {
    scans: [...scans.values()].map(({ task }) => task),
    versions: [...versions.values()].map(({ task: { result: _result, ...task } }) => task),
    runs,
  };
}

function startVersion(project: string, operation: VersionTask['operation'], input: CommandInput) {
  const key = project + ':' + operation;
  if (active(versions.get(key)?.task)) throw new AppError('BUSY', 'A version task is already running');
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const task: VersionTask = {
    id: randomUUID(),
    project,
    operation,
    started: Date.now(),
    state: 'running',
    stage: 'enumerating',
    processed: 0,
    warnings: 0,
  };
  const worker = new Worker(new URL('./version-worker.js', import.meta.url), {
    workerData: { project: registry.paths(project), operation, input, signal: signal.buffer },
  });
  function close(error?: ErrorInfo) {
    if (!active(task)) return;
    task.finished = Date.now();
    task.state = error?.code === 'SCAN_CANCELLED' ? 'cancelled' : error ? 'failed' : 'complete';
    if (task.state === 'failed') task.error = error;
    persisted(task);
  }
  const finished = new Promise<void>((resolve) =>
    worker.once('exit', () => {
      close({ code: 'SCAN_EXITED', message: 'Version worker exited' });
      resolve();
    }),
  );
  worker.on('error', (error) => close(failure(error)));
  worker.on(
    'message',
    ({
      progress,
      result,
      error,
    }: {
      progress?: ScanProgress;
      result?: VersionTask['result'];
      error?: ErrorInfo;
    }) => {
      if (progress && active(task)) Object.assign(task, progress);
      if (error) close(error);
      if (result && active(task)) {
        task.result = result;
        close();
      }
    },
  );
  versions.set(key, { task, worker, signal, finished });
  return persisted(task);
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
    persisted(task);
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
        persisted(task);
      }
    },
  );
  worker.on('error', (error) => fail(failure(error)));
  scans.set(project, { task, worker, signal, finished });
  return persisted(task);
}

async function dispose(project: string, change: () => WorkspaceState) {
  if (
    disposing.has(project) ||
    inFlight.has(project) ||
    active(scans.get(project)?.task) ||
    [...versions.values()].some(({ task }) => task.project === project && active(task)) ||
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

export function hasActiveWork() {
  return (
    tasks().runs.length > 0 ||
    inFlight.size > 0 ||
    [...benches.values()].some((bench) => bench.executor.connectionInfo().length > 0) ||
    [...scans.values(), ...versions.values()].some((job) => active(job.task))
  );
}

function cancel(job: ScanJob | (Omit<ScanJob, 'task'> & { task: VersionTask })) {
  if (active(job.task)) {
    job.task.state = 'cancelling';
    Atomics.store(job.signal, 0, 1);
    job.worker.postMessage('cancel');
  }
  return job.task;
}

export async function execute(request: EngineRequest): Promise<unknown> {
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
        for (const [key, job] of versions) if (job.task.project === request.project) versions.delete(key);
        return workspace();
      });
    case 'relocate':
      return dispose(request.project, () => select(registry.relocate(request.project, request.path).id));
    case 'tasks':
      return tasks();
    case 'task history': {
      const open = new Map([...scans.values(), ...versions.values()].map(({ task }) => [task.id, task]));
      return registry.savedTasks<ScanTask | VersionTask>().map((saved) => {
        const { result: _result, ...task } = open.get(saved.id) ?? interrupted(saved);
        return task;
      });
    }
    case 'task show':
    case 'task cancel': {
      const job = [...scans.values(), ...versions.values()].find(
        ({ task }) => task.id === request.task && (!request.project || task.project === request.project),
      );
      if (job) return request.method === 'task cancel' ? cancel(job) : job.task;
      const saved = registry.task<ScanTask | VersionTask>(request.task);
      if (saved && (!request.project || request.project === saved.project)) return interrupted(saved);
      const running = tasks().runs.find(
        (run) => run.id === request.task && (!request.project || run.project === request.project),
      );
      const project = request.project ?? running?.project;
      if (!project) throw new AppError('NOT_FOUND', 'Task not found');
      return workbench(project).execute(request.method === 'task cancel' ? 'run cancel' : 'run show', {
        id: request.task,
      });
    }
    case 'scan cancel': {
      const job = scans.get(request.project);
      if (!job || job.task.id !== request.task) invalid('Scan task not found');
      return cancel(job);
    }
    case 'command': {
      const { name, input, project } = request;
      if (!commandNames.has(name)) invalid('Unknown desktop command');
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected command parameters');
      if (disposing.has(project)) throw new AppError('BUSY', 'Project storage is being changed.');
      if (name === 'scan') return startScan(project, input);
      if (name === 'compare' || (name === 'git browse' && input.ref)) return startVersion(project, name, input);
      if (name === 'git browse' && active(versions.get(project + ':git browse')?.task))
        throw new AppError('BUSY', 'Wait for the version scan to finish');
      if (name === 'git task' || name === 'git cancel') {
        const job = [...versions.values()].find(({ task }) => task.project === project && task.id === input.id);
        if (!job) invalid('Version task not found');
        return name === 'git cancel' ? cancel(job) : job.task;
      }
      if (
        name === 'data restore' &&
        (active(scans.get(project)?.task) ||
          [...versions.values()].some(({ task }) => task.project === project && active(task)))
      ) {
        throw new AppError('BUSY', 'Wait for the scan to finish before restoring data.');
      }
      const bench = workbench(project);
      inFlight.set(project, (inFlight.get(project) ?? 0) + 1);
      try {
        const params =
          name === 'api import' && input.file && isAbsolute(input.file)
            ? { ...input, file: relative(bench.project.root, input.file) }
            : input;
        const data = await (request.environment
          ? bindingEnvironment.run(request.environment, () => bench.execute(name, params, request.wait === true))
          : bench.execute(name, params, request.wait === true));
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
      for (const job of [...scans.values(), ...versions.values()]) {
        if (!active(job.task)) continue;
        Atomics.store(job.signal, 0, 1);
        job.worker.postMessage('cancel');
      }
      await Promise.all([...benches.values()].map((bench) => bench.executor.close()));
      await Promise.all([...scans.values(), ...versions.values()].map((job) => job.finished));
      for (const bench of benches.values()) bench.repository.db.close();
      registry.close();
      return true;
  }
  invalid('Unknown workspace action');
}
