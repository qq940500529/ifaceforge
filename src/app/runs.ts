import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AppError, failure, invalid } from './errors.js';
import { digest, projectFile, stableJson } from './files.js';
import type { ProjectPaths } from './project.js';
import type { Repository } from '../storage/repository.js';
import { validate } from '../schemas/index.js';
import { apiContract, compare, httpChecks, type Assertion, type Check } from './api.js';
import { prepareHttp, sendHttp, type HttpRequest } from '../protocols/http.js';
import { McpSession, bindMcpAction, resolveMcpTarget, type Discovery, type McpAction } from '../protocols/mcp.js';
import { Bindings, secretName, type Profile } from '../protocols/variables.js';
import { mcpId } from '../scanner/model.js';
import { saveRuntime } from './catalog.js';
import { mapping } from '../scanner/openapi.js';
import { jsonPointer } from './pointer.js';

export type Case = {
  schemaVersion: 1;
  id: string;
  name: string;
  profile?: string;
  assertions?: Assertion[];
  extract?: Record<string, string>;
} & (
  | { kind: 'http'; request: HttpRequest }
  | { kind: 'mcp'; request: McpAction | { tool: string; arguments: Record<string, unknown> } }
);
export interface Suite {
  schemaVersion: 1;
  id: string;
  name: string;
  caseIds: string[];
  continueOnFailure?: boolean;
  outputs?: Record<string, Record<string, string>>;
}
export interface Versioned<T> {
  id: string;
  version: number;
  digest: string;
  document: T;
}
export type RunState = 'running' | 'passed' | 'failed' | 'canceled' | 'interrupted' | 'unknown';
export interface RunStep {
  id: string;
  version?: number;
  digest?: string;
  profile?: string;
  status: RunState | 'skipped';
  durationMs?: number;
  checks?: Check[];
  request?: unknown;
  result?: unknown;
  progress?: unknown;
  error?: { code: string; message: string; details: unknown };
}
export interface Run {
  id: string;
  kind: 'http' | 'mcp' | 'case' | 'suite';
  subject: string;
  profile?: string;
  status: RunState;
  started: string;
  finished?: string;
  owner: number;
  phase: 'preparing' | 'sent';
  cancelRequested?: boolean;
  exitCode?: number;
  steps: RunStep[];
}

export function putVersioned(
  repository: Repository,
  type: 'case' | 'suite',
  input: unknown,
  options: {
    replace?: boolean;
    version?: number;
  },
): Versioned<Case | Suite> {
  const document = validate<Case | Suite>(type, input);
  if ('kind' in document && document.kind === 'http') {
    for (const [name, value] of Object.entries(document.request.inputs ?? {})) {
      if (secretName.test(name) && (!value || typeof value !== 'object' || !Object.hasOwn(value, 'env'))) {
        invalid('Use an environment reference for secrets', { name });
      }
    }
  }
  const collection = type === 'case' ? 'cases' : 'suites';
  const hash = digest(stableJson(document));
  return repository.transaction(() => {
    const previous = repository.get<Versioned<Case | Suite>>(collection, document.id);
    if (previous && previous.digest === hash) return previous;
    if (
      previous &&
      (!options.replace || (options.version !== undefined && options.version !== previous.version))
    ) {
      throw new AppError('VERSION_CONFLICT', 'Record already exists or has changed', 3, {
        id: document.id,
        current: previous,
      });
    }
    if ('caseIds' in document) {
      for (const id of document.caseIds) repository.require('cases', id);
    }
    const record = { id: document.id, version: (previous?.version ?? 0) + 1, digest: hash, document };
    repository.put(collection, document.id, record);
    return record;
  });
}

export function removeCase(repository: Repository, id: string) {
  return repository.transaction(() => {
    const usedBy = repository
      .list<Versioned<Suite>>('suites')
      .filter((suite) => suite.document.caseIds.includes(id));
    if (usedBy.length)
      throw new AppError('CASE_IN_USE', 'Case belongs to a suite', 3, { suites: usedBy.map((suite) => suite.id) });
    return repository.remove('cases', id);
  });
}

interface Step {
  id: string;
  version?: number;
  digest?: string;
  profile?: string;
  extract?: Record<string, string>;
  assertions?: Assertion[];
  request:
    | { kind: 'http'; template: HttpRequest }
    | { kind: 'mcp'; action: McpAction; service?: string; connection?: string };
}
interface Plan {
  kind: Run['kind'];
  subject: string;
  steps: Step[];
  continueOnFailure?: boolean;
  profile?: string;
}

export function testPlan(repository: Repository, caseId?: string, suiteId?: string, override?: string): Plan {
  if (Boolean(caseId) === Boolean(suiteId)) invalid('Select a case or suite');
  const suite = suiteId ? repository.require<Versioned<Suite>>('suites', suiteId).document : undefined;
  const cases = (suite?.caseIds ?? [caseId!]).map((id) => repository.require<Versioned<Case>>('cases', id));
  return {
    kind: suite ? 'suite' : 'case',
    subject: suiteId ?? caseId!,
    continueOnFailure: suite?.continueOnFailure,
    profile: override,
    steps: cases.map(({ id, version, digest: hash, document: item }) => {
      const extract = { ...item.extract };
      for (const [alias, name] of Object.entries(suite?.outputs?.[id] ?? {})) {
        if (!Object.hasOwn(extract, name))
          invalid('Suite output mapping refers to an undeclared extraction', { id, name });
        extract[alias] = extract[name];
      }
      const request: Step['request'] =
        item.kind === 'http'
          ? { kind: 'http', template: item.request }
          : { kind: 'mcp', action: 'type' in item.request ? item.request : { type: 'call', ...item.request } };
      return {
        id,
        version,
        digest: hash,
        request,
        profile: override ?? item.profile,
        extract,
        assertions: item.assertions,
      };
    }),
  };
}

export class RunExecutor {
  private readonly connections = new Map<string, { session: McpSession; bindings: Bindings; profile: string }>();
  private readonly running = new Map<string, { controller: AbortController; finished: Promise<Run> }>();

  constructor(
    readonly project: ProjectPaths,
    readonly repository: Repository,
  ) {}

  profile(id?: string) {
    return id ? this.repository.require<Profile>('profiles', id) : undefined;
  }

  async connect(id: string) {
    const profile = this.profile(id)!;
    const bindings = new Bindings(profile);
    try {
      const session = await McpSession.connect(profile, this.project.root, bindings);
      const connection = randomUUID();
      this.connections.set(connection, { session, bindings, profile: id });
      return bindings.redact({ id: connection, ...session.info() });
    } catch (error) {
      const normalized = failure(error);
      throw new AppError(
        normalized.code,
        normalized.message,
        normalized.exitCode,
        bindings.redact(normalized.details),
      );
    }
  }

  async disconnect(id: string) {
    const connection = this.connections.get(id);
    if (!connection) throw new AppError('NOT_FOUND', 'MCP connection not found');
    this.connections.delete(id);
    await connection.session.close();
    return { id, connected: false };
  }

  connectionInfo() {
    return [...this.connections].map(([id, connection]) =>
      connection.bindings.redact({
        id,
        profile: connection.profile,
        ...connection.session.info(),
      }),
    );
  }

  connectionProfile(id: string) {
    const connection = this.connections.get(id);
    if (!connection) throw new AppError('MCP_DISCONNECTED', 'MCP session is no longer available');
    return connection.profile;
  }

  async close() {
    const running = [...this.running.values()];
    for (const entry of running) entry.controller.abort(new AppError('CANCELED', 'Workbench is shutting down', 4));
    await Promise.allSettled([
      ...running.map((entry) => entry.finished),
      ...[...this.connections.keys()].map((id) => this.disconnect(id)),
    ]);
  }

  http(request: HttpRequest, profile?: string, assertions?: Assertion[]) {
    return this.start({
      kind: 'http',
      subject: request.method,
      profile,
      steps: [{ id: 'request', profile, assertions, request: { kind: 'http', template: request } }],
    });
  }

  mcp(
    steps: (McpAction & { id: string; extract?: Record<string, string>; assertions?: Assertion[] })[],
    profile: string,
    service?: string,
    connection?: string,
  ) {
    const seen = new Set<string>();
    for (const step of steps) {
      if (seen.has(step.id)) invalid('Duplicate batch step ID', { id: step.id });
      seen.add(step.id);
    }
    return this.start({
      kind: 'mcp',
      subject: steps[0]?.type ?? 'mcp',
      profile,
      steps: steps.map(({ id, extract, assertions, ...action }) => ({
        id,
        extract,
        assertions,
        profile,
        request: { kind: 'mcp', action, service, connection },
      })),
    });
  }

  cancel(id: string) {
    const run = this.repository.transaction(() => {
      const run = recoverRun(this.repository, id);
      if (run.status === 'running') {
        run.cancelRequested = true;
        this.repository.put('runs', id, run);
      }
      return run;
    });
    this.running.get(id)?.controller.abort(new AppError('CANCELED', 'Run canceled', 4));
    return run;
  }

  start(plan: Plan) {
    const run: Run = {
      id: randomUUID(),
      kind: plan.kind,
      subject: plan.subject,
      profile: plan.profile,
      status: 'running',
      started: new Date().toISOString(),
      owner: process.pid,
      phase: 'preparing',
      steps: [],
    };
    const controller = new AbortController();
    this.repository.put('runs', run.id, run);
    const finished = Promise.resolve()
      .then(() => this.execute(run, plan, controller))
      .finally(() => this.running.delete(run.id));
    this.running.set(run.id, { controller, finished });
    return { run, finished };
  }

  private async execute(run: Run, plan: Plan, controller: AbortController) {
    const sessions = new Map<string, McpSession>();
    const outputs: Record<string, unknown> = Object.create(null);
    const secrets = new Set<string>();
    const signal = controller.signal;
    const checkCancel = () => {
      try {
        if (this.repository.get<Run>('runs', run.id)?.cancelRequested) {
          controller.abort(new AppError('CANCELED', 'Run canceled', 4));
        }
      } catch (error) {
        const err = failure(error);
        if (err.code !== 'BUSY') controller.abort(err);
      }
    };
    const save = () =>
      this.repository.transaction(() => {
        run.cancelRequested ||= this.repository.get<Run>('runs', run.id)?.cancelRequested;
        this.repository.put('runs', run.id, run);
      });
    const poll = setInterval(checkCancel, 200);
    try {
      for (const step of plan.steps) {
        if (signal.aborted || run.status === 'unknown' || (!plan.continueOnFailure && run.exitCode)) {
          run.steps.push({ id: step.id, status: 'skipped' });
          continue;
        }
        const started = performance.now();
        const record: RunStep = {
          id: step.id,
          version: step.version,
          digest: step.digest,
          profile: step.profile,
          status: 'running',
        };
        run.steps.push(record);
        run.phase = 'preparing';
        save();
        let bindings = new Bindings();
        const sent = (request: unknown) => {
          signal.throwIfAborted();
          record.request = bindings.redact(request);
          run.phase = 'sent';
          save();
        };
        try {
          const profile = this.profile(step.profile);
          bindings = new Bindings(
            profile,
            step.request.kind === 'http' ? step.request.template.inputs : {},
            outputs,
          );
          for (const value of secrets) bindings.hide(value);
          let result: unknown;
          let observed: unknown;
          let checks: Check[];
          if (step.request.kind === 'http') {
            const template = step.request.template;
            const contract = apiContract(this.repository, template, profile);
            const request = prepareHttp(template, profile, bindings);
            sent({ ...request, url: request.url.href });
            const response = await sendHttp(request, signal);
            result = response;
            observed = response.json;
            checks = httpChecks(step.assertions ?? [], response, contract);
          } else {
            if (!profile) invalid('An MCP profile is required');
            const connection = step.request.connection ? this.connections.get(step.request.connection) : undefined;
            if (step.request.connection && (!connection || connection.profile !== profile.id)) {
              throw new AppError('MCP_DISCONNECTED', 'MCP session is no longer available');
            }
            let session = connection?.session ?? sessions.get(profile.id);
            if (!session) {
              session = await McpSession.connect(profile, this.project.root, bindings, signal);
              sessions.set(profile.id, session);
            }
            for (const value of connection?.bindings.secrets ?? []) bindings.hide(value);
            const input = bindMcpAction(step.request.action, bindings);
            const action = resolveMcpTarget(input);
            let inventory: Discovery | undefined;
            if (
              action.type === 'discover' ||
              step.assertions?.some((assertion) => assertion.type === 'toolDiscovered')
            ) {
              inventory = (await session.execute({ type: 'discover' }, signal)) as Discovery;
              saveInventory(
                this.repository,
                bindings.redact(inventory),
                profile.id,
                step.request.service ?? profile.id,
              );
            }
            if (action.type === 'discover') result = inventory;
            else {
              session.validate(action);
              sent(input.type === 'template' && action.type === 'read' ? { ...input, uri: action.uri } : action);
              result = await session.execute(action, signal, (progress) => {
                record.progress = bindings.redact(progress);
                save();
              });
            }
            observed = mapping(result).structuredContent ?? result;
            checks = (step.assertions ?? []).map((assertion) =>
              mcpCheck(this.project, assertion, result, observed, inventory),
            );
          }
          for (const [name, pointer] of Object.entries(step.extract ?? {})) {
            const value = jsonPointer(observed, pointer);
            if (value === undefined) checks.push({ type: 'extract', passed: false, details: { name, pointer } });
            else outputs[name] = value;
          }
          record.result = bindings.redact(result);
          record.checks = bindings.redact(checks);
          record.status = checks.every((check) => check.passed) ? 'passed' : 'failed';
          if (record.status === 'failed') run.exitCode = Math.max(run.exitCode ?? 0, 1);
        } catch (error) {
          const err = failure(error);
          record.error = bindings.redact({ code: err.code, message: err.message, details: err.details });
          record.status = err.code === 'MCP_RESULT_UNKNOWN' ? 'unknown' : signal.aborted ? 'canceled' : 'failed';
          if (record.status === 'unknown') run.status = 'unknown';
          run.exitCode = Math.max(run.exitCode ?? 0, err.exitCode);
        }
        for (const value of bindings.secrets) secrets.add(value);
        record.durationMs = Math.round(performance.now() - started);
        run.phase = 'preparing';
        save();
      }
      if (run.status !== 'unknown') run.status = signal.aborted ? 'canceled' : run.exitCode ? 'failed' : 'passed';
      if (signal.aborted) run.exitCode = 4;
      run.exitCode ??= 0;
      run.finished = new Date().toISOString();
      save();
      return run;
    } finally {
      clearInterval(poll);
      await Promise.allSettled([...sessions.values()].map((session) => session.close()));
    }
  }
}

function mcpCheck(
  project: ProjectPaths,
  assertion: Assertion,
  response: unknown,
  observed: unknown,
  inventory?: Discovery,
): Check {
  if (assertion.type === 'toolError') {
    const actual = mapping(response).isError === true;
    return { type: assertion.type, passed: actual === assertion.equals, actual, expected: assertion.equals };
  }
  if (assertion.type === 'toolDiscovered') {
    const found =
      inventory?.groups.some(
        (group) => group.type === 'tool' && group.items.some((item) => item.name === assertion.name),
      ) === true;
    return { type: assertion.type, passed: found, expected: assertion.name };
  }
  if (assertion.type === 'fileExists') {
    const actual = existsSync(projectFile(project.root, assertion.path, false));
    return { type: assertion.type, passed: actual, actual, expected: true, details: { path: assertion.path } };
  }
  return (
    compare(assertion, observed) ?? { type: assertion.type, passed: false, details: 'Unsupported MCP assertion' }
  );
}

function saveInventory(repository: Repository, discovery: Discovery, profile: string, service: string) {
  const complete = discovery.groups.every((group) => ['found', 'empty', 'notPublished'].includes(group.state));
  saveRuntime(repository, {
    id: 'mcp:' + service + ':' + profile,
    profile,
    service,
    kind: 'mcp',
    complete,
    diagnostics: discovery.groups
      .filter((group) => group.error)
      .map((group) => ({ code: group.state, message: group.type })),
    observations: discovery.groups.flatMap((group) =>
      group.items.map((item) => {
        const name = String(item.uri ?? item.uriTemplate ?? item.name);
        return {
          id: mcpId(service, group.type, name),
          kind: 'mcp',
          origin: 'runtime',
          name,
          service,
          profile,
          summary: String(item.description ?? ''),
          definition: { type: group.type, ...item },
        };
      }),
    ),
  });
}

export function recoverRun(repository: Repository, id: string): Run {
  const run = repository.require<Run>('runs', id);
  if (run.status !== 'running') return run;
  try {
    process.kill(run.owner, 0);
    return run;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return run;
  }
  run.status = run.phase === 'sent' ? 'unknown' : 'interrupted';
  const lastStep = run.steps.at(-1);
  if (lastStep?.status === 'running') lastStep.status = run.status;
  run.finished = new Date().toISOString();
  run.exitCode = 4;
  repository.put('runs', run.id, run);
  return run;
}
