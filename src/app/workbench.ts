import { execFileSync } from 'node:child_process';
import { AppError, invalid } from './errors.js';
import { safeProfile } from './profiles.js';
import { apiFragment, importApi, requestDraft, type Assertion } from './api.js';
import { activeSnapshot, diffScans, getEntity, page, scanProject, searchCatalog } from './catalog.js';
import { checkConfig, effectiveConfig, type Locale } from './config.js';
import { sourceText, projectFile } from './files.js';
import { backupData, pruneData, restoreData } from './maintenance.js';
import type { ProjectPaths } from './project.js';
import {
  recoverRun,
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
import { Bindings, secretHeader, secretName, type Profile } from '../protocols/variables.js';
import { getInstance, instanceResult, openLocation, startInstance, stopInstance } from '../server/instance.js';

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
  profile?: string;
  connection?: string;
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
  port?: number;
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
  noOpen?: boolean;
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
    const wiki = () => ({
      snapshot: input.snapshot,
      out: input.out,
      locale: input.lang ?? effectiveConfig(project, repository).settings.locale,
    });
    const batch = async (actions: Parameters<RunExecutor['mcp']>[0]) => {
      const run = executor.mcp(actions, need(input.profile, 'profile'), input.service, input.connection);
      return wait ? run.finished : run.run;
    };
    switch (command) {
      case 'start':
        return startInstance(project, input.port, input.noOpen);
      case 'stop':
        return stopInstance(project);
      case 'status':
        return {
          project: project.root,
          database: project.database,
          dataDir: project.data,
          databaseSchema: repository.db.prepare('PRAGMA user_version').get()?.user_version,
          ...instanceResult(await getInstance(project)),
        };
      case 'project': {
        let branch = '';
        try {
          branch = execFileSync('git', ['branch', '--show-current'], {
            cwd: project.root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch {
          /* Detached or unavailable Git information. */
        }
        const snapshot = activeSnapshot(repository);
        const locale =
          repository.setting<{ locale?: Locale }>('config')?.locale ?? repository.setting<Locale>('locale');
        return { root: project.root, data: project.data, branch, snapshot: snapshot?.id, locale };
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
        const scan = scanProject(project, repository, input);
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
        return repository.require('scans', id());
      case 'scan diff':
        return diffScans(
          repository.require('scans', need(input.from, 'from')),
          repository.require('scans', need(input.to, 'to')),
        );
      case 'catalog list':
      case 'catalog search':
        return searchCatalog(repository, input);
      case 'skill list':
      case 'skill search':
        return searchCatalog(repository, { ...input, kind: 'skill' });
      case 'catalog show':
      case 'skill show': {
        const entity = getEntity(repository, id());
        if (command === 'skill show' && entity.kind !== 'skill') invalid('Expected a skill ID');
        return entity;
      }
      case 'source show': {
        const path = need(input.path, 'path');
        if (/(^|[\\/])(?:\.git|\.devtools|\.env(?:\.[^\\/]*)?)([\\/]|$)|\.(?:pem|key|pfx|p12)$/i.test(path)) {
          invalid('Workspaces and credential files are outside the source viewer');
        }
        return { path, text: sourceText(project.root, path) };
      }
      case 'api import':
        return importApi(project, repository, { ...input, profile: profile() });
      case 'api draft':
        return requestDraft(getEntity(repository, id()));
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
        return apiFragment(getEntity(repository, id()), input.format);
      case 'mcp connect':
        return executor.connect(need(input.profile, 'profile'));
      case 'mcp disconnect':
        return executor.disconnect(id());
      case 'mcp discover':
        return batch([{ id: 'discover', type: 'discover' }]);
      case 'mcp call':
      case 'mcp read':
      case 'mcp prompt': {
        const args = input.args ?? {};
        const action: McpAction =
          command === 'mcp call'
            ? { type: 'call', tool: id(), arguments: args as Record<string, unknown> }
            : command === 'mcp read'
              ? { type: 'read', uri: id() }
              : { type: 'prompt', name: id(), arguments: args as Record<string, string> };
        const data = validate<{ steps: Parameters<RunExecutor['mcp']>[0] }>('mcp-batch', {
          schemaVersion: 1,
          steps: [{ ...action, id: action.type }],
        });
        return batch(data.steps);
      }
      case 'mcp batch':
        return batch(validate<{ steps: Parameters<RunExecutor['mcp']>[0] }>('mcp-batch', input.body).steps);
      case 'test run': {
        const run = repository.transaction(() => testPlan(repository, input.case, input.suite, input.profile));
        const handle = executor.start(run);
        return wait ? handle.finished : handle.run;
      }
      case 'run list':
        return pagination(
          repository
            .list<Run>('runs')
            .map((run) => (run.status === 'running' ? recoverRun(repository, run.id) : run))
            .filter(
              (run) =>
                (!input.state || input.state === run.status) && (!input.kind || String(input.kind) === run.kind),
            ),
        );
      case 'run show':
      case 'run export':
        return recoverRun(repository, id());
      case 'run cancel':
        return executor.cancel(id());
      case 'wiki preview':
        return previewWiki(project, repository, wiki());
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
      case 'wiki open': {
        const record = readWiki(repository, id());
        openLocation(record.out);
        return record;
      }
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
