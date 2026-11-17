import { AppError, invalid } from './errors.js';
import { safeProfile } from './profiles.js';
import { apiFragment, importApi, requestDraft, type Assertion } from './api.js';
import {
  activeSnapshot,
  catalog,
  diffScans,
  getEntity,
  getSnapshot,
  page,
  scanProject,
  scannerVersion,
  searchCatalog,
} from './catalog.js';
import { checkConfig, effectiveConfig, type Locale } from './config.js';
import { digest, sourceText, projectFile, protectedSource, stableJson } from './files.js';
import { commitSource, filePatch, gitCommit, gitLog, gitRefs, gitRelation, resolveCommit } from './git-history.js';
import { browseVersion, compareVersions, type BrowseVersion, type VersionSelection } from './version-compare.js';
import { guide, guideDiagnostics } from './guides.js';
import { assertMcpLaunch, mcpTarget, mcpTargets, requireApproval, testTargets } from './mcp-targets.js';
import { backupData, pruneData, restoreData } from './maintenance.js';
import { git, type ProjectPaths } from './project.js';
import {
  recoverRun,
  repositoryProfile,
  removeCase,
  RunExecutor,
  putVersioned,
  testPlan,
  type Run,
  type Versioned,
  type Case,
  type Suite,
} from './runs.js';
import { buildWiki, getNote, previewWiki, putNote, readWiki } from './wiki.js';
import { Repository } from '../storage/repository.js';
import { validate } from '../schemas/index.js';
import type { Kind, Snapshot } from '../scanner/model.js';
import { curl, prepareHttp, type HttpRequest } from '../protocols/http.js';
import type { McpAction } from '../protocols/mcp.js';
import { worktreeHash } from '../protocols/mcp-native.js';
import { Bindings, secretHeader, secretName, type Profile } from '../protocols/variables.js';

export interface CommandInput {
  id?: string;
  query?: string;
  path?: string;
  file?: string;
  url?: string;
  out?: string;
  page?: string;
  from?: string;
  to?: string;
  base?: string;
  target?: string;
  ref?: string;
  refs?: string[];
  mode?: VersionSelection['mode'];
  mcpMode?: 'native' | 'isolated';
  ancestor?: string;
  previous?: string;
  profile?: string;
  approve?: string;
  image?: string;
  protocol?: string;
  service?: string;
  kind?: Kind;
  origin?: string;
  state?: string;
  format?: string;
  lang?: Locale;
  snapshot?: string;
  before?: string;
  case?: string;
  suite?: string;
  fileToken?: string;
  limit?: number;
  offset?: number;
  version?: number;
  body?: unknown;
  args?: unknown;
  assertions?: Assertion[];
  replace?: boolean;
  apply?: boolean;
  full?: boolean;
  includeUntracked?: boolean;
  requireComplete?: boolean;
}

function need(value: string | undefined, name: string) {
  if (typeof value !== 'string' || !value) invalid('Missing ' + name);
  return value;
}

export class Workbench {
  readonly executor: RunExecutor;
  constructor(
    readonly project: ProjectPaths,
    readonly repository: Repository,
  ) {
    this.executor = new RunExecutor(project, repository);
  }

  async execute(command: string, input: CommandInput = {}, wait = true): Promise<unknown> {
    const { project, repository, executor } = this;
    const pagination = <T>(items: T[]) => page(items, input.limit, input.offset);
    const id = () => need(input.id, 'record ID');
    const profile = () => executor.profile(input.profile);
    const historical = async () =>
      input.snapshot ?? (input.ref ? (await browseVersion(project, repository, input.ref)).snapshot : undefined);
    const wiki = () => ({
      snapshot: input.snapshot,
      out: input.out,
      locale: input.lang ?? effectiveConfig(project, repository).settings.locale,
    });
    const approvedFingerprint = (fingerprint: string, steps?: Parameters<RunExecutor['mcp']>[0]) =>
      input.mcpMode === 'native' && steps?.some((step) => step.type !== 'discover')
        ? digest(stableJson({ fingerprint, steps }))
        : fingerprint;
    const batch = async (actions: Parameters<RunExecutor['mcp']>[0]) => {
      const target = await mcpTarget(project, repository, {
        ...input,
        mode: input.mcpMode,
        snapshot: input.service ? await historical() : input.snapshot,
      });
      assertMcpLaunch(target.plan);
      requireApproval(approvedFingerprint(target.plan.fingerprint, actions), input.approve);
      const run = executor.mcp(actions, target);
      return wait ? run.finished : run.run;
    };
    switch (command) {
      case 'status':
        return {
          project: project.root,
          database: project.database,
          dataDir: project.data,
          databaseSchema: repository.db.prepare('PRAGMA user_version').get()?.user_version,
        };
      case 'project': {
        let branch = '';
        try {
          branch = git(project.root, ['branch', '--show-current']).trim();
        } catch {
          /* Detached or unavailable Git information. */
        }
        const snapshot = activeSnapshot(repository);
        const locale =
          repository.setting<{ locale?: Locale }>('config')?.locale ?? repository.setting<Locale>('locale');
        return { root: project.root, data: project.data, branch, snapshot: snapshot?.id, locale };
      }
      case 'git branches':
        return pagination(await gitRefs(project.root, input.query));
      case 'guide show':
        return guide(input.lang);
      case 'guide validate': {
        const snapshot = await historical();
        return guideDiagnostics(
          snapshot ? getSnapshot(repository, snapshot) : await scanProject(project, repository),
        );
      }
      case 'git log':
        return gitLog(
          project.root,
          input.refs ?? (input.ref ? [input.ref] : []),
          input.offset,
          input.limit,
          input.query,
        );
      case 'git commit':
        return gitCommit(project.root, need(input.ref ?? input.id, 'revision'));
      case 'git relation': {
        const [base, target] = await Promise.all([
          resolveCommit(project.root, input.base),
          resolveCommit(project.root, input.target),
        ]);
        return gitRelation(project.root, base, target);
      }
      case 'git view': {
        const view = repository.setting<BrowseVersion>('gitView');
        return view && repository.get<Snapshot>('git_snapshots', view.snapshot)?.scannerVersion === scannerVersion
          ? view
          : null;
      }
      case 'git browse': {
        const view = input.ref ? await browseVersion(project, repository, input.ref, { full: input.full }) : null;
        repository.set('gitView', view);
        return view;
      }
      case 'git preference': {
        const selection = { base: input.base, target: input.target, mode: input.mode, ancestor: input.ancestor };
        if (Object.values(selection).some((value) => value !== undefined)) {
          if (input.mode !== 'branches' && input.mode !== 'commits') invalid('Unknown comparison mode');
          if (
            Object.values(selection).some(
              (value) => value !== undefined && (typeof value !== 'string' || value.length > 1024),
            )
          )
            invalid('Invalid comparison preference');
          repository.set('gitSelection', selection);
        }
        return repository.setting<VersionSelection>('gitSelection') ?? null;
      }
      case 'compare':
        return compareVersions(project, repository, {
          ...input,
          ancestor: input.ancestor === 'auto' ? '' : input.ancestor,
        });
      case 'compare file': {
        const [base, target] = await Promise.all([
          resolveCommit(project.root, input.base),
          resolveCommit(project.root, input.target),
        ]);
        return filePatch(project.root, base, target, need(input.path, 'path'), input.previous);
      }
      case 'config show':
        return effectiveConfig(project, repository);
      case 'config validate':
        return checkConfig(project, input.body);
      case 'config apply': {
        const { value } = checkConfig(project, input.body, 'settings');
        repository.set('config', value);
        return effectiveConfig(project, repository);
      }
      case 'profile list':
        return pagination(repository.list<Profile>('profiles').map(safeProfile));
      case 'profile show':
        return safeProfile(executor.profile(id())!);
      case 'profile put': {
        const profile = validate<Profile>('profile', input.body);
        for (const [name, value] of Object.entries(profile.variables ?? {})) {
          if (secretName.test(name) && (!value || typeof value !== 'object'))
            invalid('Use an environment reference for secrets', { name });
        }
        if (profile.mcp?.transport === 'stdio') projectFile(project.root, profile.mcp.cwd ?? '.', false);
        repository.put('profiles', profile.id, profile);
        return safeProfile(profile);
      }
      case 'profile remove':
        return { removed: repository.remove('profiles', id()) };
      case 'scan': {
        const scan = await scanProject(project, repository, input);
        const { entities, ...summary } = scan;
        const data = { ...summary, count: entities.length };
        if (!scan.complete && input.requireComplete)
          throw new AppError('INCOMPLETE_SCAN', 'Scan is incomplete', 3, data);
        return data;
      }
      case 'scan list':
        return pagination(
          repository
            .list<Snapshot>('scans')
            .map(({ entities, ...summary }) => ({ ...summary, count: entities.length })),
        );
      case 'scan show':
        return getSnapshot(repository, id());
      case 'scan diff':
        return diffScans(
          getSnapshot(repository, need(input.from, 'from')),
          getSnapshot(repository, need(input.to, 'to')),
        );
      case 'catalog list':
      case 'catalog search':
        return searchCatalog(repository, { ...input, snapshot: await historical() });
      case 'skill list':
      case 'skill search':
        return searchCatalog(repository, { ...input, kind: 'skill', snapshot: await historical() });
      case 'catalog show':
      case 'skill show': {
        const entity = getEntity(repository, id(), await historical());
        if (command === 'skill show' && entity.kind !== 'skill') invalid('Expected a skill ID');
        return entity;
      }
      case 'source show': {
        const path = need(input.path, 'path');
        if (protectedSource.test(path)) {
          invalid('Workspaces and credential files are outside the source viewer');
        }
        const snapshot = input.snapshot ? getSnapshot(repository, input.snapshot) : undefined;
        const revision = input.ref
          ? await resolveCommit(project.root, input.ref)
          : snapshot?.source === 'git'
            ? snapshot.commit
            : null;
        return {
          path,
          text: revision ? commitSource(project.root, revision, path).read(path) : sourceText(project.root, path),
        };
      }
      case 'api import':
        return importApi(project, repository, { ...input, profile: profile() });
      case 'api draft': {
        const snapshot = await historical();
        const draft = requestDraft(getEntity(repository, id(), snapshot));
        return snapshot ? { ...draft, operationId: undefined } : draft;
      }
      case 'api preview': {
        const template = validate<HttpRequest>('request', input.body);
        const selected = profile();
        const bindings = new Bindings(selected, template.inputs);
        const request = prepareHttp(template, selected, bindings);
        return bindings.redact({ method: request.method, url: request.url.href });
      }
      case 'api send': {
        const assertions =
          input.assertions === undefined ? undefined : validate<Assertion[]>('assertions', input.assertions);
        const run = executor.http(validate<HttpRequest>('request', input.body), input.profile, assertions);
        return wait ? run.finished : run.run;
      }
      case 'api curl':
        return { curl: curl(validate<HttpRequest>('request', input.body), profile()) };
      case 'api export':
        return apiFragment(getEntity(repository, id(), await historical()), input.format);
      case 'mcp targets':
        return pagination(mcpTargets(repository, await historical()));
      case 'mcp inventory': {
        if (Boolean(input.service) === Boolean(input.profile))
          invalid('Select a repository MCP server or an isolated MCP profile');
        if (input.mcpMode && input.mcpMode !== 'isolated' && input.mcpMode !== 'native')
          invalid('Unknown MCP launch mode');
        const snapshotId = await historical();
        if (input.origin === 'source' || input.origin === 'declaration') {
          if (!input.service) invalid('Select a scanned service for source inventory');
          const service = getEntity(repository, input.service, snapshotId).service;
          const items = catalog(repository, snapshotId).filter(
            (item) => item.kind === 'mcp' && item.service === service,
          );
          return pagination(
            items.flatMap((item) =>
              item.observations.filter(
                (entry) => entry.origin === input.origin && entry.definition.type !== 'server',
              ),
            ),
          );
        }
        const snapshot = snapshotId ? getSnapshot(repository, snapshotId) : undefined;
        const commit = await resolveCommit(project.root, input.ref ?? snapshot?.commit ?? 'HEAD');
        const nativeSource =
          input.mcpMode === 'native' ? (input.ref || snapshot?.source === 'git' ? 'git' : 'worktree') : undefined;
        const nativeHash = nativeSource === 'worktree' ? await worktreeHash(project.root, commit) : commit;
        const target = input.service ? repositoryProfile(input.service) : input.profile;
        const runs = repository
          .list<Run>('runs')
          .filter(
            (run) =>
              run.kind === 'mcp' &&
              run.subject === 'discover' &&
              run.profile === target &&
              run.sandboxes?.[0]?.commit === commit &&
              (run.sandboxes[0].mode ?? 'isolated') === (input.mcpMode ?? 'isolated') &&
              (!nativeSource ||
                (run.sandboxes[0].codeSource === nativeSource && run.sandboxes[0].sourceHash === nativeHash)) &&
              run.steps[0]?.result,
          );
        return (
          runs.find((run) =>
            (run.steps[0].result as import('../protocols/mcp.js').Discovery).groups.every((group) =>
              ['found', 'empty', 'notPublished'].includes(group.state),
            ),
          ) ??
          runs[0] ??
          null
        );
      }
      case 'mcp plan': {
        const target = await mcpTarget(project, repository, {
          ...input,
          mode: input.mcpMode,
          snapshot: input.service ? await historical() : input.snapshot,
        });
        const steps =
          input.body === undefined
            ? undefined
            : validate<{ steps: Parameters<RunExecutor['mcp']>[0] }>('mcp-batch', input.body).steps;
        return {
          ...target.plan,
          fingerprint: approvedFingerprint(target.plan.fingerprint, steps),
          operations: steps?.map((step) => ({ id: step.id, type: step.type })),
          profile: target.profile.id,
          service: target.service,
          path: target.path,
        };
      }
      case 'mcp probe':
        return batch([
          {
            id: 'discover',
            type: 'discover',
            assertions:
              input.assertions === undefined ? undefined : validate<Assertion[]>('assertions', input.assertions),
          },
        ]);
      case 'mcp call':
      case 'mcp read':
      case 'mcp template':
      case 'mcp prompt': {
        const args = input.args ?? {};
        const action: McpAction =
          command === 'mcp call'
            ? { type: 'call', tool: id(), arguments: args as Record<string, unknown> }
            : command === 'mcp read'
              ? { type: 'read', uri: id() }
              : command === 'mcp template'
                ? { type: 'template', uriTemplate: id(), arguments: args as Record<string, unknown> }
                : { type: 'prompt', name: id(), arguments: args as Record<string, string> };
        const data = validate<{ steps: Parameters<RunExecutor['mcp']>[0] }>('mcp-batch', {
          schemaVersion: 1,
          steps: [
            {
              ...action,
              id: action.type,
              ...(input.assertions === undefined ? {} : { assertions: input.assertions }),
            },
          ],
        });
        return batch(data.steps);
      }
      case 'mcp batch':
        return batch(validate<{ steps: Parameters<RunExecutor['mcp']>[0] }>('mcp-batch', input.body).steps);
      case 'test plan':
      case 'test run': {
        const run = repository.transaction(() => testPlan(repository, input.case, input.suite, input.profile));
        const snapshot = run.steps.some((step) => step.request.kind === 'mcp' && step.request.service)
          ? await historical()
          : input.snapshot;
        const target = await testTargets(project, repository, run, input.ref, snapshot);
        if (command === 'test plan') return { plans: target.plans, fingerprint: target.fingerprint };
        for (const launch of target.plans) assertMcpLaunch(launch);
        if (target.fingerprint) requireApproval(target.fingerprint, input.approve);
        const handle = executor.start(run, target.targets);
        return wait ? handle.finished : handle.run;
      }
      case 'run list':
        return pagination(
          repository
            .list<Run>('runs')
            .map((run) => (run.status === 'running' ? recoverRun(repository, run.id) : run))
            .filter(
              (run) =>
                (!input.state || input.state === run.status) &&
                (!input.kind || String(input.kind) === run.kind) &&
                (!input.profile || input.profile === run.profile),
            ),
        );
      case 'run show':
      case 'run export':
        return recoverRun(repository, id());
      case 'run cancel':
        return executor.cancel(id());
      case 'wiki preview':
        return previewWiki(project, repository, wiki());
      case 'wiki export':
        return previewWiki(project, repository, { ...wiki(), out: undefined }).catalog;
      case 'wiki build':
        return buildWiki(project, repository, wiki());
      case 'wiki list':
        return pagination(repository.list('wiki_exports'));
      case 'wiki show':
        return readWiki(repository, id(), input.page);
      case 'wiki note-put': {
        if (typeof input.body !== 'string') invalid('Expected Markdown text');
        return putNote(project, id(), input.body);
      }
      case 'wiki note-show':
        return getNote(project, id());
      case 'wiki open':
        return readWiki(repository, id());
      case 'data backup':
        return backupData(project, repository, need(input.out, 'output path'));
      case 'data restore':
        return restoreData(project, repository, need(input.file, 'backup path'), input.replace);
      case 'data prune':
        return pruneData(repository, need(input.before, 'cutoff date'), input.apply);
    }
    const [type, verb] = command.split(' ');
    if (type === 'case' || type === 'suite') {
      const collection = type === 'case' ? 'cases' : 'suites';
      if (verb === 'list') return pagination(repository.list(collection));
      if (verb === 'show') return repository.require(collection, id());
      if (verb === 'export') {
        const document = repository.require<Versioned<Case | Suite>>(collection, id()).document;
        if ('kind' in document && document.kind === 'http') {
          return {
            ...document,
            request: {
              ...document.request,
              headers: document.request.headers?.filter((header) => !secretHeader.test(header.name)),
            },
          };
        }
        return document;
      }
      if (verb === 'put')
        return putVersioned(repository, type, input.body, { replace: input.replace, version: input.version });
      if (verb === 'remove')
        return { removed: type === 'case' ? removeCase(repository, id()) : repository.remove(collection, id()) };
    }
    invalid('Unknown command', { command });
  }
}
