import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, invalid } from '../app/errors.js';
import { openLocation, version } from '../app/platform.js';
import type { CommandInput } from '../app/workbench.js';
import type { Run } from '../app/runs.js';
import { ensureService, serviceRequest, type ServiceRequest } from '../desktop/service-client.js';
import type { ScanTask, TaskList, VersionTask, WorkspaceState } from '../desktop/protocol.js';

export type CliInput = CommandInput & {
  async?: boolean;
  all?: boolean;
  confirm?: boolean;
  directory?: string;
  exact?: boolean;
  force?: boolean;
  stream?: boolean;
  useWorktree?: boolean;
};
type Task = ScanTask | VersionTask | Run;
const releases = 'https://github.com/qq940500529/ifaceforge/releases';

export async function workspace<T>(method: ServiceRequest, start = true) {
  let result = await serviceRequest<T>(method);
  if (!result && start) {
    await ensureService();
    result = await serviceRequest<T>(method);
    if (!result) throw new AppError('ENGINE_UNAVAILABLE', 'Workspace service is unavailable');
  }
  if (result?.ok === false)
    throw new AppError(result.error.code, result.error.message, result.error.exitCode ?? 3, result.error.details);
  return result?.data;
}

function required(value: string | undefined, name: string) {
  if (!value) invalid('Missing ' + name);
  return value;
}

function running(task: Task) {
  const state = 'state' in task ? task.state : task.status;
  return state === 'running' || state === 'cancelling';
}

export async function watchTask(id: string, project?: string, onProgress?: (task: Task) => void) {
  let previous = '';
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
  };
  process.on('SIGINT', cancel);
  try {
    while (true) {
      if (interrupted) await workspace({ method: 'task cancel', task: id, project });
      const task = (await workspace<Task>({ method: 'task show', task: id, project }))!;
      const stamp =
        'stage' in task
          ? [task.state, task.stage, task.processed, task.total].join(':')
          : task.status + ':' + task.steps.length;
      if (stamp !== previous) onProgress?.(task);
      previous = stamp;
      if (!running(task)) return task;
      await delay(350);
    }
  } finally {
    process.off('SIGINT', cancel);
  }
}

function requireTaskResult(task: ScanTask | VersionTask) {
  if (task.state === 'cancelled')
    throw new AppError('SCAN_CANCELLED', 'Workspace task cancelled', 4, { id: task.id });
  if (task.state === 'failed')
    throw new AppError(
      task.error?.code ?? 'SCAN_FAILED',
      task.error?.message ?? 'Workspace task failed',
      task.error?.exitCode ?? 3,
      task.error?.details,
    );
  return task.result;
}

function releaseOrder(value: string) {
  const [core, preview] = value.replace(/^v/, '').split('-', 2);
  return [...core.split('.').map(Number), preview ? 0 : 1, Number(/\d+$/.exec(preview ?? '')?.[0] ?? 0)];
}

async function checkUpdates() {
  const response = await fetch('https://api.github.com/repos/qq940500529/ifaceforge/releases?per_page=30', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'IfaceForge CLI' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new AppError('UPDATE_CHECK_FAILED', 'GitHub release check returned ' + response.status, 3, {
      url: releases,
    });
  const items = (await response.json()) as { tag_name: string; html_url: string; draft: boolean }[];
  const newer = (a: string, b: string) => {
    const right = releaseOrder(b);
    const first = releaseOrder(a).findIndex((part, index) => part !== right[index]);
    return first < 0 ? 0 : releaseOrder(a)[first] - right[first];
  };
  const latest = items
    .filter((item) => !item.draft && /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(item.tag_name))
    .sort((a, b) => newer(b.tag_name, a.tag_name))[0];
  return {
    installed: version,
    latest: latest?.tag_name.replace(/^v/, '') ?? null,
    available: !!latest && newer(latest.tag_name, version) > 0,
    url: latest?.html_url ?? releases,
  };
}

export async function globalWorkspace(
  name: string,
  input: CliInput,
  project?: string,
  progress?: (task: Task) => void,
): Promise<{ data: unknown } | undefined> {
  const id = () => required(input.id, 'identifier');
  if (name === 'service status') return { data: { running: !!(await workspace({ method: 'ping' }, false)) } };
  if (name === 'service stop') {
    const stopped = await workspace({ method: 'close', force: input.force }, false);
    return { data: { stopped: stopped === true } };
  }
  if (name === 'update check') return { data: await checkUpdates() };
  if (name === 'update open') {
    openLocation(releases);
    return { data: { url: releases } };
  }
  if (name === 'preferences get' || name === 'preferences set') {
    const state = await workspace<WorkspaceState>(
      name === 'preferences get' ? { method: 'state' } : { method: 'locale', locale: input.lang! },
    );
    return { data: { locale: state?.locale ?? null, selected: state?.selected ?? null } };
  }
  if (name === 'project inspect') return { data: await workspace({ method: 'inspect', path: resolve(id()) }) };
  if (name === 'project select' || name === 'project hide' || name === 'project delete') {
    if (name === 'project delete' && input.confirm !== true)
      invalid('Provide the project ID and --confirm to delete its application data');
    const method = name === 'project select' ? 'select' : name === 'project hide' ? 'hide' : 'delete';
    return { data: await workspace({ method, project: id() }) };
  }
  if (name === 'project relocate') {
    const selected = await workspace<{ selected: string; root: string }>({
      method: 'inspect',
      path: resolve(required(input.directory, 'directory')),
    });
    if (selected!.selected !== selected!.root && !input.useWorktree)
      invalid('Choose the worktree root or use --use-worktree', selected);
    return { data: await workspace({ method: 'relocate', project: id(), path: selected!.root }) };
  }
  if (name === 'task list') {
    const active = (await workspace<TaskList>({ method: 'tasks' }, false)) ?? {
      scans: [],
      versions: [],
      runs: [],
    };
    const history = input.all ? await workspace({ method: 'task history' }) : undefined;
    const filter = <T extends { project: string }>(items: T[]) =>
      items.filter((item) => !project || item.project === project);
    return {
      data: {
        scans: filter(active.scans),
        versions: filter(active.versions ?? []),
        runs: filter(active.runs),
        ...(history ? { history: filter(history as TaskList['scans']) } : {}),
      },
    };
  }
  if (name === 'task watch') return { data: await watchTask(id(), project, progress) };
  if (name === 'task show' || name === 'task cancel')
    return { data: await workspace({ method: name, task: id(), project }) };
  return undefined;
}

export async function projectWorkspace(
  name: string,
  project: string,
  input: CliInput,
  environment?: Record<string, string | null>,
) {
  const method = name === 'git select' ? 'git preference' : name === 'scan start' ? 'scan' : name;
  const needsService = input.async === true || ['scan start', 'git select'].includes(name);
  const payload = { ...input };
  if (payload.file && ['data restore', 'api import'].includes(name) && payload.file !== '-')
    payload.file = resolve(payload.file);
  if (payload.out && ['data backup', 'wiki build', 'wiki preview'].includes(name))
    payload.out = resolve(payload.out);
  const executesRun = /^(?:api send|mcp (?:probe|call|read|template|prompt|batch)|test run)$/.test(name);
  const data = await workspace(
    { method: 'command', name: method, project, input: payload, wait: !input.async && !executesRun, environment },
    needsService,
  );
  if (data === undefined) return undefined;
  if (executesRun && !input.async) return { data: await watchTask((data as Run).id, project) };
  if (
    name === 'scan start' ||
    input.async ||
    !(name === 'scan' || name === 'compare' || (name === 'git browse' && input.ref))
  )
    return { data };
  const task = await watchTask((data as ScanTask).id, project);
  const value = requireTaskResult(task as ScanTask | VersionTask);
  if (name === 'scan' && input.requireComplete && !(value as ScanTask['result'])?.complete)
    throw new AppError('INCOMPLETE_SCAN', 'Scan is incomplete', 3, value);
  return { data: value };
}
