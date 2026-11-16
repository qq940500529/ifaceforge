import { parentPort, workerData } from 'node:worker_threads';
import { failure } from '../app/errors.js';
import { activeSnapshot, diffScans, scanProject, trackedFiles, type ScanOptions } from '../app/catalog.js';
import { gitAsync, type ProjectPaths } from '../app/project.js';
import { effectiveConfig } from '../app/config.js';
import { AppError } from '../app/errors.js';
import { openProjectDatabase } from '../storage/database.js';
import { Repository } from '../storage/repository.js';

const { project, input, signal } = workerData as {
  project: ProjectPaths;
  input: Pick<ScanOptions, 'full' | 'includeUntracked'>;
  signal: SharedArrayBuffer;
};
const abort = new Int32Array(signal);
const gitAbort = new AbortController();
const cancel = () => gitAbort.abort();
parentPort?.on('message', cancel);
const cancelled = () => Atomics.load(abort, 0) !== 0;
try {
  const db = openProjectDatabase(project);
  try {
    const repository = new Repository(db);
    const previous = activeSnapshot(repository);
    if (cancelled()) throw new AppError('SCAN_CANCELLED', 'Scan cancelled');
    const { scan: scanConfig } = effectiveConfig(project, repository);
    const includeUntracked = input.includeUntracked ?? scanConfig.includeUntracked ?? false;
    const paths = await gitAsync(project.root, trackedFiles(includeUntracked), gitAbort.signal);
    const head = await gitAsync(project.root, ['rev-parse', '--verify', 'HEAD'], gitAbort.signal).catch(
      (error: unknown) => {
        if ((error as { code?: number }).code === 128) return null;
        throw error;
      },
    );
    const scan = scanProject(project, repository, {
      ...input,
      progress: (progress) => parentPort?.postMessage({ progress }),
      cancelled,
      includeUntracked,
      scan: scanConfig,
      tracked: { paths, commit: head?.trim() ?? null },
    });
    const diff = previous ? diffScans(previous, scan) : undefined;
    const changes = diff?.comparable
      ? { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length }
      : undefined;
    const { entities, ...snapshot } = scan;
    parentPort?.postMessage({ result: { ...snapshot, count: entities.length, changes } });
  } finally {
    db.close();
  }
} catch (error) {
  const { code, message, details } = failure(
    cancelled() ? new AppError('SCAN_CANCELLED', 'Scan cancelled') : error,
  );
  parentPort?.postMessage({ error: { code, message, details } });
} finally {
  parentPort?.off('message', cancel);
}
