import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { minimatch } from 'minimatch';
import type { ProjectPaths } from './project.js';
import { effectiveConfig, type Adapter, type SourceConfig } from './config.js';
import { digest, parseJson, projectFile, sourceText, stableJson } from './files.js';
import { AppError, invalid } from './errors.js';
import type { Repository } from '../storage/repository.js';
import { parseMcpConfig, parseSkill, scanSource } from '../scanner/adapters.js';
import { parseOpenApi } from '../scanner/openapi.js';
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
const credentialFile = /(?:^|\/)(?:\.env(?:\.[^/]*)?|.*\.(?:pem|pfx|p12|key))$/i;
const scannerVersion = 1;

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

function git(project: ProjectPaths, args: string[]) {
  return execFileSync('git', ['-C', project.root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
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
) {
  if (/(^|\/)SKILL\.md$/.test(path)) return [parseSkill(project.root, path, text, diagnostics)];
  if (source.mcpConfigs?.includes(path) || /(^|\/)\.mcp\.json$/.test(path)) {
    return parseMcpConfig(
      path,
      parseJson(text, path),
      diagnostics,
      source.id === 'default' ? undefined : source.id,
    );
  }
  if (
    source.openapi?.includes(path) ||
    openApiName.test(path) ||
    (/\.(?:json|ya?ml)$/i.test(path) && /(?:^|[\n{,])\s*["']?openapi["']?\s*:\s*["']?3\.[01]\./.test(text))
  ) {
    return parseOpenApi(text, { root: project.root, path, service: source.id }, diagnostics);
  }
  return scanSource(path, text, source.adapters ?? adapters, source.id, diagnostics);
}

export function mergeObservations(observations: Observation[], runtime: RuntimeObservation[] = []): Entity[] {
  const groups = new Map<string, Observation[]>();
  for (const item of observations) {
    const group = groups.get(item.id) ?? [];
    if (!group.some((entry) => stableJson(entry) === stableJson(item))) group.push(item);
    groups.set(item.id, group);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group.find((entry) => entry.origin === 'declaration') ?? group[0];
      const sources = new Set(group.map((entry) => entry.origin));
      const differences: string[] = [];
      if (first.kind === 'api') {
        if (!sources.has('declaration') && sources.has('source')) differences.push('MISSING_CONTRACT');
        if (sources.has('declaration') && !sources.has('source')) differences.push('UNVERIFIED_IMPLEMENTATION');
        const paths = new Set(group.map((entry) => entry.definition.path));
        const definitions = new Set(
          group.filter((entry) => entry.origin !== 'source').map((entry) => stableJson(entry.definition)),
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
        summary: first.summary || group.find((entry) => entry.summary)?.summary || '',
        version: digest(stableJson([...new Set(group.map((entry) => stableJson(entry.definition)))].sort())),
        observations: group,
        differences,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

export function scanProject(
  project: ProjectPaths,
  repository: Repository,
  options: { full?: boolean; includeUntracked?: boolean } = {},
): Snapshot {
  const { scan } = effectiveConfig(project, repository);
  const include = options.includeUntracked ?? scan.includeUntracked ?? false;
  const sources = (scan.sources?.length ? scan.sources : [{ id: 'default' }]).map((entry) => ({
    ...entry,
    roots: normalized(entry.roots),
    openapi: normalized(entry.openapi),
    mcpConfigs: normalized(entry.mcpConfigs),
  }));
  const scope = digest(stableJson({ scan, include, scannerVersion }));
  const paths = new Set(
    git(project, ['ls-files', '-z', '--cached', ...(include ? ['--others', '--exclude-standard'] : [])])
      .split('\0')
      .filter(Boolean),
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
  for (const path of [...paths].sort()) {
    const scopeSources = sources.filter((entry) => configured(path, entry));
    if (
      !scopeSources.length ||
      path.split('/').some((part) => ignored.has(part)) ||
      credentialFile.test(path) ||
      scan.exclude?.some((pattern) => minimatch(path, pattern, { dot: true }))
    )
      continue;
    if (!/\.(?:[cm]?[jt]sx?|py|json|ya?ml|md)$/i.test(path) && !selectedFiles.has(path)) continue;
    try {
      const entry = projectFile(project.root, path, false);
      if (!existsSync(entry) && !selectedFiles.has(path)) continue;
      const text = sourceText(project.root, path);
      const hash = digest(text);
      hashes.push([path, hash]);
      const key = digest(scope + '\0' + path);
      const old = options.full ? undefined : repository.get<ScanFile>('scan_files', key);
      // OpenAPI can refer to a file whose digest differs from the entry point.
      const mayReference = /\$ref/.test(text) || /(^|\/)SKILL\.md$/.test(path);
      const file: ScanFile =
        old?.digest === hash && !mayReference ? old : { digest: hash, diagnostics: [], observations: [] };
      if (old !== file) {
        for (const source of scopeSources) {
          file.observations.push(...scanPath(project, path, text, source, file.diagnostics));
        }
        cache.push([key, file]);
      }
      diagnostics.push(...file.diagnostics);
      observations.push(...file.observations);
    } catch (error) {
      complete = false;
      diagnostics.push({
        path,
        code: 'FILE_SCAN_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let commit: string | null = null;
  try {
    commit = git(project, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    // A freshly initialized Git project has no commit.
  }
  const snapshot: Snapshot = {
    id: randomUUID(),
    created: new Date().toISOString(),
    commit,
    scope,
    complete,
    diagnostics,
    worktree: digest(stableJson(hashes)),
    entities: mergeObservations(observations),
  };
  repository.transaction(() => {
    const runtime = repository.list<RuntimeObservation>('observations');
    snapshot.entities = mergeObservations(
      [...observations, ...runtime.flatMap((target) => target.observations)],
      runtime,
    );
    for (const [key, file] of cache) repository.put('scan_files', key, file);
    repository.put('scans', snapshot.id, snapshot);
    if (complete) repository.set('activeSnapshot', snapshot.id);
  });
  return snapshot;
}

function normalized(paths?: string[]) {
  return paths?.map((path) => path.replaceAll('\\', '/').replace(/^\.\//, ''));
}

export function activeSnapshot(repository: Repository): Snapshot | undefined {
  const id = repository.setting<string>('activeSnapshot');
  return id ? repository.get<Snapshot>('scans', id) : undefined;
}

export function catalog(repository: Repository) {
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

export function getEntity(repository: Repository, id: string): Entity {
  const match = catalog(repository).find((entity) => entity.id === id);
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
    kind?: Kind;
    service?: string;
    origin?: string;
    state?: string;
    limit?: number;
    offset?: number;
  },
) {
  const query = folded(options.query ?? '');
  const items = catalog(repository).filter(
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
  return page(items, options.limit, options.offset);
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
