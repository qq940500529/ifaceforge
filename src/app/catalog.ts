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
import type { Repository } from '../storage/repository.js';
import { parseMcpConfig, parseSkill, scanSource } from '../scanner/adapters.js';
import { parseMcpManifest } from '../scanner/mcp-discovery.js';
import { mapping, parseOpenApi, yamlDocument } from '../scanner/openapi.js';
import type { Diagnostic, Entity, Kind, Observation, Snapshot } from '../scanner/model.js';

const adapters: Adapter[] = ['express', 'fastapi', 'mcp-typescript'];
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
export const scannerVersion = 3;
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
  complete: boolean;
  observations: Observation[];
  diagnostics: Diagnostic[];
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

function scanPath(
  project: ProjectPaths,
  path: string,
  text: string,
  source: SourceConfig,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
  historical?: ScanSource,
) {
  if (/(^|\/)SKILL\.md$/.test(path)) return [parseSkill(project.root, path, text, diagnostics, historical)];
  if (/(^|\/)\.?mcp-capabilities\.json$/i.test(path))
    return parseMcpManifest(path, parseJson(text, path), source.id, diagnostics);
  if (source.mcpConfigs?.includes(path) || /(^|\/)\.mcp\.json$/.test(path)) {
    return parseMcpConfig(
      path,
      parseJson(text, path),
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
  return scanSource(path, text, source.adapters ?? adapters, source.id, diagnostics, checkpoint);
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
      if (first.kind !== 'skill' && first.definition.type !== 'server') {
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
}

export interface ScanOptions {
  full?: boolean;
  includeUntracked?: boolean;
  progress?: (status: ScanProgress) => void;
  cancelled?: () => boolean;
  tracked?: { paths: string; commit: string | null };
  scan?: ScanConfig;
  historical?: ScanSource;
  snapshotId?: string;
}

export function trackedFiles(include: boolean) {
  return ['ls-files', '-z', '--cached', ...(include ? ['--others', '--exclude-standard'] : [])];
}

export function scanProject(project: ProjectPaths, repository: Repository, options: ScanOptions = {}): Snapshot {
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
  const diagnostics: Diagnostic[] = [];
  const observations: Observation[] = [];
  const cache: [string, ScanFile][] = [];
  const hashes: [string, string][] = [];
  let complete = true;
  let warnings = 0;
  const files = [...paths].sort();
  let processed = 0;
  let reportedAt = 0;
  for (const path of files) {
    check();
    if (processed === 0 || Date.now() - reportedAt >= 100) {
      options.progress?.({ stage: 'processing', processed, total: files.length, warnings });
      reportedAt = Date.now();
    }
    processed++;
    const scopeSources = sources.filter((entry) => configured(path, entry));
    if (
      !scopeSources.length ||
      path.split('/').some((part) => ignored.has(part)) ||
      protectedSource.test(path) ||
      scan.exclude?.some((pattern) => minimatch(path, pattern, { dot: true }))
    )
      continue;
    if (!/\.(?:[cm]?[jt]sx?|py|json|ya?ml|md)$/i.test(path) && !selectedFiles.has(path)) continue;
    try {
      if (
        historical
          ? !historical.has(path)
          : !existsSync(projectFile(project.root, path, false)) && !selectedFiles.has(path)
      )
        continue;
      const text = historical ? historical.read(path) : sourceText(project.root, path);
      const hash = digest(text);
      hashes.push([path, hash]);
      const key = digest(scope + '\0' + (historical ? 'git:' : 'worktree:') + path);
      const old = options.full ? undefined : repository.get<ScanFile>('scan_files', key);
      // OpenAPI can refer to a file whose digest differs from the entry point.
      const mayReference = /\$ref|swaggerVersion/.test(text) || /(^|\/)SKILL\.md$/.test(path);
      const file: ScanFile =
        old?.digest === hash && !mayReference ? old : { digest: hash, diagnostics: [], observations: [] };
      if (old !== file) {
        for (const source of scopeSources) {
          for (const item of scanPath(project, path, text, source, file.diagnostics, check, historical)) {
            file.observations.push(item);
          }
        }
        cache.push([key, file]);
      }
      for (const item of file.diagnostics) {
        diagnostics.push(item);
        if (item.severity !== 'info') warnings++;
      }
      for (const item of file.observations) observations.push(item);
    } catch (error) {
      check();
      complete = false;
      warnings++;
      diagnostics.push({
        path,
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
  options.progress?.({ stage: 'saving', processed, total: files.length, warnings });
  check();
  repository.transaction(() => {
    const runtime = historical ? [] : repository.list<RuntimeObservation>('observations');
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
  const runtime = repository.list<RuntimeObservation>('observations');
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
  return {
    ...page(items, options.limit, options.offset),
    ...(options.kind === 'api' || !options.kind
      ? {
          coverage: {
            method: 'contracts-and-recognized-server-routes',
            unresolved: unresolved.length,
            examples: unresolved.slice(0, 8),
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
