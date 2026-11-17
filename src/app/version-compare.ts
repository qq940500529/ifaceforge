import { diffScans, scanProject, scanScope, type ScanOptions } from './catalog.js';
import { effectiveConfig, type ScanConfig } from './config.js';
import { digest } from './files.js';
import { AppError, invalid } from './errors.js';
import { changedFiles, commitSource, gitRelation, resolveCommit } from './git-history.js';
import type { ProjectPaths } from './project.js';
import type { Repository } from '../storage/repository.js';
import type { Entity, Snapshot } from '../scanner/model.js';

export type VersionMode = 'branches' | 'commits';
export interface BrowseVersion {
  ref: string;
  sha: string;
  snapshot: string;
  complete: boolean;
}
export interface VersionSelection {
  base?: string;
  target?: string;
  mode?: VersionMode;
  ancestor?: string;
}

export interface VersionChange {
  id: string;
  kind: Entity['kind'];
  name: string;
  service: string;
  status: 'added' | 'changed' | 'removed';
  before?: Entity;
  after?: Entity;
}

function cancelled(options: ScanOptions) {
  if (options.cancelled?.()) throw new AppError('SCAN_CANCELLED', 'Scan cancelled');
}

function historical(
  project: ProjectPaths,
  repository: Repository,
  sha: string,
  scan: ScanConfig,
  options: ScanOptions,
) {
  cancelled(options);
  const snapshotId = 'git-' + digest(sha + '\0' + scanScope(scan));
  const existing = options.full ? undefined : repository.get<Snapshot>('git_snapshots', snapshotId);
  if (existing?.complete) return existing;
  return scanProject(project, repository, {
    ...options,
    scan,
    snapshotId,
    historical: commitSource(project.root, sha),
  });
}

export async function browseVersion(
  project: ProjectPaths,
  repository: Repository,
  ref: string,
  options: ScanOptions = {},
  signal?: AbortSignal,
): Promise<BrowseVersion> {
  const sha = await resolveCommit(project.root, ref, signal);
  const snapshot = await historical(project, repository, sha, effectiveConfig(project, repository).scan, options);
  cancelled(options);
  return { ref, sha, snapshot: snapshot.id, complete: snapshot.complete };
}

function summary(snapshot: Snapshot) {
  const { id, commit, complete, diagnostics, scope, entities } = snapshot;
  return { snapshot: id, commit, complete, diagnostics, scope, count: entities.length };
}

export async function compareVersions(
  project: ProjectPaths,
  repository: Repository,
  selection: VersionSelection,
  options: ScanOptions = {},
  signal?: AbortSignal,
) {
  const { base, target, mode = 'commits', ancestor } = selection;
  if (mode !== 'commits' && mode !== 'branches') invalid('Unknown comparison mode');
  const [baseSha, targetSha] = await Promise.all([
    resolveCommit(project.root, base, signal),
    resolveCommit(project.root, target, signal),
  ]);
  const relation = await gitRelation(project.root, baseSha, targetSha, signal);
  let effectiveBase = baseSha;
  if (ancestor !== undefined) {
    if (!relation.common.length)
      throw new AppError('GIT_NO_ANCESTOR', 'No common ancestor is available', 3, relation);
    const candidate = ancestor ? await resolveCommit(project.root, ancestor, signal) : relation.common[0];
    if (!ancestor && relation.common.length > 1)
      throw new AppError('GIT_MULTIPLE_ANCESTORS', 'Select a common ancestor', 3, relation);
    if (!relation.common.includes(candidate)) invalid('The revision is not a common ancestor of these endpoints');
    effectiveBase = candidate;
  }
  const scan = effectiveConfig(project, repository).scan;
  const phase = (side: 'base' | 'target'): ScanOptions => ({
    ...options,
    progress: (progress) => options.progress?.({ ...progress, phase: side }),
  });
  const before = await historical(project, repository, effectiveBase, scan, phase('base'));
  const after = await historical(project, repository, targetSha, scan, phase('target'));
  cancelled(options);
  const files =
    effectiveBase === targetSha ? [] : await changedFiles(project.root, effectiveBase, targetSha, signal);
  const delta = diffScans(before, after);
  const old = new Map(before.entities.map((entity) => [entity.id, entity]));
  const current = new Map(after.entities.map((entity) => [entity.id, entity]));
  const changes: VersionChange[] = [];
  for (const status of ['added', 'changed', 'removed'] as const) {
    for (const id of delta[status]) {
      const entry = current.get(id) ?? old.get(id)!;
      changes.push({
        id,
        status,
        kind: entry.kind,
        name: entry.name,
        service: entry.service,
        before: old.get(id),
        after: current.get(id),
      });
    }
  }
  return {
    base: { ref: base, sha: baseSha, ...summary(before) },
    target: { ref: target, sha: targetSha, ...summary(after) },
    mode,
    effectiveBase,
    relation,
    comparable: delta.comparable,
    changes,
    files,
  };
}
export type VersionReport = Awaited<ReturnType<typeof compareVersions>>;
