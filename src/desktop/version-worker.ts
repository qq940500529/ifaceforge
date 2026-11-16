import { parentPort, workerData } from 'node:worker_threads';
import { AppError, failure } from '../app/errors.js';
import { browseVersion, compareVersions } from '../app/version-compare.js';
import type { ScanProgress } from '../app/catalog.js';
import type { CommandInput } from '../app/workbench.js';
import type { ProjectPaths } from '../app/project.js';
import { openProjectDatabase } from '../storage/database.js';
import { Repository } from '../storage/repository.js';

const { project, operation, input, signal } = workerData as {
  project: ProjectPaths;
  operation: 'compare' | 'git browse';
  input: CommandInput;
  signal: SharedArrayBuffer;
};
const flag = new Int32Array(signal);
const controller = new AbortController();
const stop = () => controller.abort();
parentPort?.on('message', stop);
const cancelled = () => Atomics.load(flag, 0) !== 0;
const options = {
  cancelled,
  full: input.full,
  progress: (progress: ScanProgress) => parentPort?.postMessage({ progress }),
};

try {
  if (cancelled()) throw new AppError('SCAN_CANCELLED', 'Version task cancelled');
  const db = openProjectDatabase(project);
  try {
    const repository = new Repository(db);
    if (operation === 'compare') {
      const result = await compareVersions(
        project,
        repository,
        {
          ...input,
          ancestor: input.ancestor === 'auto' ? '' : input.ancestor,
        },
        options,
        controller.signal,
      );
      if (cancelled()) throw new AppError('SCAN_CANCELLED', 'Version task cancelled');
      parentPort?.postMessage({ result });
    } else {
      const result = await browseVersion(project, repository, input.ref!, options, controller.signal);
      if (cancelled()) throw new AppError('SCAN_CANCELLED', 'Version task cancelled');
      repository.set('gitView', result);
      parentPort?.postMessage({ result });
    }
  } finally {
    db.close();
  }
} catch (error) {
  const { code, message, details } = failure(
    cancelled() ? new AppError('SCAN_CANCELLED', 'Version task cancelled') : error,
  );
  parentPort?.postMessage({ error: { code, message, details } });
} finally {
  parentPort?.off('message', stop);
}
