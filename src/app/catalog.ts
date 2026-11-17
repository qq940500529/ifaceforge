import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { minimatch } from 'minimatch';
import { git, type ProjectPaths } from './project.js';
import { effectiveConfig, type Adapter, type ScanConfig, type SourceConfig } from './config.js';
import {
  digest,
  parseJson,
  projectFile,
  protectedSource,
  sourceText,
  stableJson,
  type ScanSource,
} from './files.js';
import { AppError, invalid } from './errors.js';
import { describeDiagnostic } from './guides.js';
import type { Repository } from '../storage/repository.js';
import { mcpConfigDocument, mcpConfigName, parseMcpConfig, parseSkill, scanSource } from '../scanner/adapters.js';
import { parseMcpManifest } from '../scanner/mcp-discovery.js';
import { mcpLanguageFile } from '../scanner/mcp-languages.js';
import { pythonConstants } from '../scanner/python-constants.js';
import { pythonHttpCandidate } from '../scanner/python-http.js';
import { mapping, parseOpenApi, yamlDocument } from '../scanner/openapi.js';
import {
  mcpId,
  type Diagnostic,
  type Entity,
  type Kind,
  type Observation,
  type Snapshot,
} from '../scanner/model.js';

const adapters: Adapter[] = ['express', 'fastapi', 'mcp-source'];
const ignored = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.devtools',
  '.venv',
  '__pycache__',
  'coverage',
]);
const openApiName = /(?:^|\/)(?:openapi|swagger)(?:[._-][^/]*)?\.(?:ya?ml|json)$/i;
export const scannerVersion = 6;
const apiCoverageCodes = new Set(['DYNAMIC_ROUTE', 'HTTP_HANDLER_UNRESOLVED', 'EXPRESS_SOURCE_PARSE']);

function hasApiVersion(path: string, text: string) {
  if (!/\.(?:json|ya?ml)$/i.test(path) || !/\b(?:openapi|swagger|swaggerVersion)\b/.test(text)) return false;
  try {
    const document = mapping(yamlDocument(text).value);
    return ['openapi', 'swagger', 'swaggerVersion'].some((key) => typeof document?.[key] === 'string');
  } catch {
    return false;
  }
}

export interface RuntimeObservation {
  id: string;
  profile: string;
  service: string;
  kind: 'api' | 'mcp';
  commit?: string;
  sourceKind?: 'git' | 'worktree';
  complete: boolean;
  observations: Observation[];
  diagnostics: Diagnostic[];
}

function runtimeObservations(repository: Repository, commit?: string | null) {
  return repository
    .list<RuntimeObservation>('observations')
    .filter(
      (target) =>
        target.kind === 'api' || (Boolean(commit) && target.commit === commit && target.sourceKind !== 'worktree'),
    );
}

interface ScanFile {
  digest: string;
  observations: Observation[];
  diagnostics: Diagnostic[];
}

function configured(path: string, entry: SourceConfig) {
  if (entry.openapi?.includes(path) || entry.mcpConfigs?.includes(path)) return true;
  return (
    !entry.roots?.length ||
    entry.roots.some((raw) => {
      const root = raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
      return root === '.' || path === root || path.startsWith(root + '/');
    })
  );
}

async function scanPath(
  project: ProjectPaths,
  path: string,
  text: string,
  source: SourceConfig,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
  historical?: ScanSource,
  constants?: ReturnType<typeof pythonConstants>,
) {
  if (/(^|\/)SKILL\.md$/.test(path)) return [parseSkill(project.root, path, text, diagnostics, historical)];
  if (/(^|\/)\.?mcp-capabilities\.json$/i.test(path))
    return parseMcpManifest(path, parseJson(text, path), source.id, diagnostics);
  if (source.mcpConfigs?.includes(path) || mcpConfigName.test(path)) {
    return parseMcpConfig(
      path,
      mcpConfigDocument(path, text),
      diagnostics,
      source.id === 'default' ? undefined : source.id,
    );
  }
  if (source.openapi?.includes(path) || openApiName.test(path) || hasApiVersion(path, text)) {
    return parseOpenApi(
      text,
      { root: project.root, path, service: source.id, read: historical?.read },
      diagnostics,
    );
  }
  return scanSource(
    path,
    text,
    source.adapters ?? adapters,
    source.id,
    diagnostics,
    checkpoint,
    source.mcpRules,
    constants,
  );
}

export function mergeObservations(
  observations: Observation[],
  runtime: RuntimeObservation[] = [],
  checkpoint?: () => void,
): Entity[] {
  const groups = new Map<string, Map<string, Observation>>();
  for (const [index, item] of observations.entries()) {
    if (index % 256 === 0) checkpoint?.();
    let group = groups.get(item.id);
    if (!group) {
      group = new Map();
      groups.set(item.id, group);
    }
    const identity = stableJson(item);
    if (!group.has(identity)) group.set(identity, item);
  }
  return [...groups.values()]
    .flatMap((entries) => {
      const group = [...entries.values()];
      const providers = group.filter((entry) => entry.origin !== 'call-site');
      const first = providers.find((entry) => entry.origin === 'declaration') ?? providers[0];
      if (!first) return [];
      const sources = new Set(providers.map((entry) => entry.origin));
      const differences: string[] = [];
      if (first.kind === 'api') {
        if (!sources.has('declaration') && sources.has('source')) differences.push('MISSING_CONTRACT');
        if (sources.has('declaration') && !sources.has('source')) differences.push('UNVERIFIED_IMPLEMENTATION');
        const paths = new Set(providers.map((entry) => entry.definition.path));
        const definitions = new Set(
          providers.filter((entry) => entry.origin !== 'source').map((entry) => stableJson(entry.definition)),
        );
        if (paths.size > 1 || definitions.size > 1) differences.push('DEFINITION_CONFLICT');
      }
      if (
        first.kind !== 'skill' &&
        !['server', 'source-hint', 'manifest'].includes(String(first.definition.type))
      ) {
        for (const target of runtime) {
          if (
            target.complete &&
            target.kind === first.kind &&
            target.service === first.service &&
            !target.observations.some((entry) => entry.id === first.id)
          ) {
            differences.push('MISSING_RUNTIME:' + target.profile);
          }
        }
      }
      return {
        id: first.id,
        kind: first.kind,
        service: first.service,
        name: first.name,
        summary: first.summary || providers.find((entry) => entry.summary)?.summary || '',
        version: digest(stableJson([...new Set(providers.map((entry) => stableJson(entry.definition)))].sort())),
        observations: [...providers, ...group.filter((entry) => entry.origin === 'call-site')],
        differences,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

export interface ScanProgress {
  stage: 'enumerating' | 'processing' | 'saving';
  phase?: 'base' | 'target';
  processed: number;
  total?: number;
  warnings: number;
  errors?: number;
}

export interface ScanOptions {
  full?: boolean;
  includeUntracked?: boolean;
  progress?: (status: ScanProgress) => void;
  diagnostic?: (issue: Diagnostic) => void;
  cancelled?: () => boolean;
  tracked?: { paths: string; commit: string | null };
  scan?: ScanConfig;
  historical?: ScanSource;
  snapshotId?: string;
}

export function trackedFiles(include: boolean) {
  return ['ls-files', '-z', '--cached', ...(include ? ['--others', '--exclude-standard'] : [])];
}

export async function scanProject(
  project: ProjectPaths,
  repository: Repository,
  options: ScanOptions = {},
): Promise<Snapshot> {
  const check = () => {
    if (options.cancelled?.()) throw new AppError('SCAN_CANCELLED', 'Scan cancelled');
  };
  options.progress?.({ stage: 'enumerating', processed: 0, warnings: 0 });
  check();
  const scan = options.scan ?? effectiveConfig(project, repository).scan;
  const historical = options.historical;
  const include = !historical && (options.includeUntracked ?? scan.includeUntracked ?? false);
  const sources = (scan.sources?.length ? scan.sources : [{ id: 'default' }]).map((entry) => ({
    ...entry,
    roots: normalized(entry.roots),
    openapi: normalized(entry.openapi),
    mcpConfigs: normalized(entry.mcpConfigs),
  }));
  const scope = scanScope(scan, include);
  const paths = new Set(
    historical?.paths ??
      (options.tracked?.paths ?? git(project.root, trackedFiles(include))).split('\0').filter(Boolean),
  );
  const selectedFiles = new Set(
    sources.flatMap((source) => [...(source.openapi ?? []), ...(source.mcpConfigs ?? [])]),
  );
  for (const path of selectedFiles) paths.add(path);
  const ignoredPath = (path: string) =>
    path.split('/').some((part) => ignored.has(part)) ||
    protectedSource.test(path) ||
    scan.exclude?.some((pattern) => minimatch(path, pattern, { dot: true }));
  const read = (path: string) => (historical ? historical.read(path) : sourceText(project.root, path));
  const constants = pythonConstants((path) => {
    check();
    if (!paths.has(path) || ignoredPath(path) || (historical && !historical.has(path))) return;
    try {
      return read(path);
    } catch {
      return;
    }
  });
  const diagnostics: Diagnostic[] = [];
  const observations: Observation[] = [];
  const cache: [string, ScanFile][] = [];
  const hashes: [string, string][] = [];
  let complete = true;
  let warnings = 0;
  let errors = 0;
  function recordDiagnostic(issue: Diagnostic) {
    const details = describeDiagnostic(issue);
    diagnostics.push(details);
    if (details.severity === 'info') return;
    if (details.severity === 'error') errors++;
    else warnings++;
    options.diagnostic?.(details);
  }
  const files = [...paths].sort();
  let processed = 0;
  let reportedAt = 0;
  for (const path of files) {
    check();
    if (processed === 0 || Date.now() - reportedAt >= 100) {
      options.progress?.({ stage: 'processing', processed, total: files.length, warnings, errors });
      reportedAt = Date.now();
    }
    processed++;
    const scopeSources = sources.filter((entry) => configured(path, entry));
    if (!scopeSources.length || ignoredPath(path)) continue;
    if (
      !/\.(?:[cm]?[jt]sx?|py|jsonc?|ya?ml|md|toml)$/i.test(path) &&
      !mcpLanguageFile(path) &&
      !scopeSources.some((source) =>
        source.mcpRules?.some((rule) => path.toLowerCase().endsWith('.' + rule.extension)),
      ) &&
      !selectedFiles.has(path)
    )
      continue;
    try {
      if (
        historical
          ? !historical.has(path)
          : !existsSync(projectFile(project.root, path, false)) && !selectedFiles.has(path)
      )
        continue;
      const text = read(path);
      const hash = digest(text);
      hashes.push([path, hash]);
      const key = digest(scope + '\0' + (historical ? 'git:' : 'worktree:') + path);
      const old = options.full ? undefined : repository.get<ScanFile>('scan_files', key);
      // Imported constants can change independently of the HTTP handler.
      const mayReference =
        /\$ref|swaggerVersion/.test(text) ||
        /(^|\/)SKILL\.md$/.test(path) ||
        (/\.py$/i.test(path) &&
          pythonHttpCandidate(path, text) &&
          scopeSources.some((source) => (source.adapters ?? adapters).includes('fastapi')));
      const file: ScanFile =
        old?.digest === hash && !mayReference ? old : { digest: hash, diagnostics: [], observations: [] };
      if (old !== file) {
        for (const source of scopeSources) {
          for (const item of await scanPath(
            project,
            path,
            text,
            source,
            file.diagnostics,
            check,
            historical,
            constants,
          )) {
            file.observations.push(item);
          }
        }
        cache.push([key, file]);
      }
      for (const item of file.diagnostics) recordDiagnostic(item);
      for (const item of file.observations) observations.push(item);
    } catch (error) {
      check();
      complete = false;
      recordDiagnostic({
        path,
        severity: 'error',
        code: 'FILE_SCAN_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let commit = historical?.commit ?? options.tracked?.commit ?? null;
  if (!options.tracked && !historical) {
    try {
      commit = git(project.root, ['rev-parse', '--verify', 'HEAD']).trim();
    } catch {
      // A freshly initialized Git project has no commit.
    }
  }
  const mcpServices = new Set(
    observations
      .filter((entry) => entry.kind === 'mcp' && entry.definition.type === 'server')
      .map((entry) => entry.service),
  );
  if (mcpServices.size === 1) {
    const service = [...mcpServices][0];
    for (let index = 0; index < observations.length; index++) {
      const entry = observations[index];
      if (entry.kind !== 'mcp' || entry.origin !== 'source' || entry.service !== 'default') continue;
      const key = String(entry.definition.uri ?? entry.definition.uriTemplate ?? entry.name);
      observations[index] = { ...entry, service, id: mcpId(service, String(entry.definition.type), key) };
    }
  }
  const declarations = new Map<string, string | null>();
  for (const item of observations) {
    if (item.kind !== 'api' || item.origin !== 'declaration' || typeof item.definition.path !== 'string') continue;
    const path = item.definition.path;
    declarations.set(item.id, declarations.has(item.id) && declarations.get(item.id) !== path ? null : path);
  }
  const declared = new Set(declarations.keys());
  for (const [index, item] of observations.entries()) {
    const contractPath = declarations.get(item.id);
    if (item.definition.adapter === 'python-http' && item.definition.pathPattern && contractPath) {
      observations[index] = {
        ...item,
        name: String(item.definition.method).toUpperCase() + ' ' + contractPath,
        definition: { ...item.definition, path: contractPath },
      };
    }
    if (item.definition.adapter !== 'python-http' || declared.has(item.id)) continue;
    declared.add(item.id);
    recordDiagnostic({
      code: 'HTTP_ROUTE_UNDOCUMENTED',
      path: item.path,
      line: item.line,
      message: item.name + ' has source evidence and no OpenAPI declaration in this service',
    });
  }
  const snapshot: Snapshot = {
    id: options.snapshotId ?? randomUUID(),
    source: historical ? 'git' : 'worktree',
    scannerVersion,
    created: new Date().toISOString(),
    commit,
    scope,
    complete,
    diagnostics,
    worktree: digest(stableJson(hashes)),
    entities: [],
  };
  options.progress?.({ stage: 'saving', processed, total: files.length, warnings, errors });
  check();
  repository.transaction(() => {
    const runtime = historical ? [] : runtimeObservations(repository, snapshot.commit);
    snapshot.entities = mergeObservations(
      [...observations, ...runtime.flatMap((target) => target.observations)],
      runtime,
      check,
    );
    check();
    for (const [key, file] of cache) repository.put('scan_files', key, file);
    repository.put(historical ? 'git_snapshots' : 'scans', snapshot.id, snapshot);
    if (complete && !historical) repository.set('activeSnapshot', snapshot.id);
  });
  return snapshot;
}

export function scanScope(scan: ScanConfig, include = false) {
  return digest(stableJson({ scan, include, scannerVersion }));
}

function normalized(paths?: string[]) {
  return paths?.map((path) => path.replaceAll('\\', '/').replace(/^\.\//, ''));
}

export function activeSnapshot(repository: Repository): Snapshot | undefined {
  const id = repository.setting<string>('activeSnapshot');
  const snapshot = id ? repository.get<Snapshot>('scans', id) : undefined;
  return snapshot?.scannerVersion === scannerVersion ? snapshot : undefined;
}

export function catalog(repository: Repository, historical?: string) {
  if (historical) return getSnapshot(repository, historical).entities;
  const snapshot = activeSnapshot(repository);
  const runtime = runtimeObservations(repository, snapshot?.commit);
  return mergeObservations(
    [
      ...(snapshot?.entities.flatMap((item) => item.observations.filter((entry) => entry.origin !== 'runtime')) ??
        []),
      ...runtime.flatMap((target) => target.observations),
    ],
    runtime,
  );
}

export function saveRuntime(repository: Repository, target: RuntimeObservation) {
  repository.transaction(() => {
    const previous = repository.get<RuntimeObservation>('observations', target.id);
    const observations = new Map(
      (target.complete ? [] : (previous?.observations ?? [])).map((item) => [item.id, item]),
    );
    for (const item of target.observations) observations.set(item.id, item);
    repository.put('observations', target.id, { ...target, observations: [...observations.values()] });
  });
  return target;
}

export function getSnapshot(repository: Repository, id: string): Snapshot {
  return repository.require<Snapshot>(id.startsWith('git-') ? 'git_snapshots' : 'scans', id);
}

export function getEntity(repository: Repository, id: string, snapshot?: string): Entity {
  const match = catalog(repository, snapshot).find((entity) => entity.id === id);
  if (!match) throw new AppError('NOT_FOUND', 'Capability not found', 3, { id });
  return match;
}

function folded(value: string) {
  return value.normalize('NFKC').toLowerCase();
}

export function page<T>(items: T[], limit = 20, offset = 0) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
    invalid('Invalid pagination', { limit, offset });
  }
  return { items: items.slice(offset, offset + limit), limit, offset, total: items.length };
}

export function searchCatalog(
  repository: Repository,
  options: {
    query?: string;
    snapshot?: string;
    kind?: Kind;
    service?: string;
    origin?: string;
    state?: string;
    limit?: number;
    offset?: number;
  },
) {
  const query = folded(options.query ?? '');
  const items = catalog(repository, options.snapshot).filter(
    (item) =>
      (!options.kind || item.kind === options.kind) &&
      (!options.service || item.service === options.service) &&
      (!options.origin || item.observations.some((entry) => entry.origin === options.origin)) &&
      (!options.state ||
        (options.state === 'matched'
          ? !item.differences.length
          : item.differences.some((code) => code.startsWith(options.state!)))) &&
      folded(
        [
          item.id,
          item.name,
          item.summary,
          ...item.observations.map((entry) => [entry.path, entry.definition.body].join(' ')),
        ].join(' '),
      ).includes(query),
  );
  const exact = (item: Entity) => Number(folded(item.name) === query);
  items.sort(
    (a, b) =>
      exact(b) - exact(a) ||
      a.name.localeCompare(b.name, 'en') ||
      (a.observations[0].path ?? '').localeCompare(b.observations[0].path ?? '', 'en') ||
      a.id.localeCompare(b.id, 'en'),
  );
  const snapshot = options.snapshot ? getSnapshot(repository, options.snapshot) : activeSnapshot(repository);
  const unresolved = snapshot?.diagnostics.filter((issue) => apiCoverageCodes.has(issue.code)) ?? [];
  const undocumented = snapshot?.diagnostics.filter((issue) => issue.code === 'HTTP_ROUTE_UNDOCUMENTED') ?? [];
  return {
    ...page(items, options.limit, options.offset),
    ...(options.kind === 'api' || !options.kind
      ? {
          coverage: {
            method: 'contracts-and-recognized-server-routes',
            unresolved: unresolved.length,
            undocumented: undocumented.length,
            examples: [
              ...unresolved.slice(0, undocumented.length ? 4 : 8),
              ...undocumented.slice(0, 8 - Math.min(4, unresolved.length)),
            ],
          },
        }
      : {}),
  };
}

export function diffScans(from: Snapshot, to: Snapshot) {
  const comparable = from.complete && to.complete && from.scope === to.scope;
  const previous = new Map(from.entities.map((entity) => [entity.id, entity]));
  const current = new Set(to.entities.map((entity) => entity.id));
  return {
    from: from.id,
    to: to.id,
    comparable,
    added: to.entities.filter((entity) => !previous.has(entity.id)).map((entity) => entity.id),
    changed: to.entities
      .filter((entity) => previous.has(entity.id) && previous.get(entity.id)?.version !== entity.version)
      .map((entity) => entity.id),
    removed: comparable
      ? from.entities.filter((entity) => !current.has(entity.id)).map((entity) => entity.id)
      : [],
  };
}
