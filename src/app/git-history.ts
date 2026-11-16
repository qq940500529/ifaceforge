import { AppError, invalid } from './errors.js';
import { decodeSource, protectedSource, type ScanSource } from './files.js';
import { git, gitAsync, gitBuffer } from './project.js';

const objectId = /^(?:[a-f\d]{40}|[a-f\d]{64})$/;
const maxBlob = 8 * 1024 * 1024;

export interface GitRef {
  ref: string;
  name: string;
  sha: string;
  kind: 'local' | 'remote' | 'tag';
  current: boolean;
}

export interface GitCommit {
  sha: string;
  parents: string[];
  title: string;
  message: string;
  author: string;
  date: string;
}

export interface GitFile {
  status: string;
  path: string;
  previous?: string;
}

function revision(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f]/.test(value))
    invalid('Expected a Git revision');
  return value;
}

export async function resolveCommit(root: string, value: unknown, signal?: AbortSignal) {
  const ref = revision(value);
  try {
    const sha = (
      await gitAsync(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], signal)
    ).trim();
    if (objectId.test(sha)) return sha;
  } catch (error) {
    if (signal?.aborted || (error as { code?: number }).code !== 128) throw error;
  }
  throw new AppError('GIT_REVISION', 'Commit is missing or ambiguous', 3, { ref });
}

export async function gitRefs(root: string, query = '') {
  const format = '%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(symref)';
  const listing = await gitAsync(root, [
    'for-each-ref',
    '--sort=refname',
    '--format=' + format,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  return listing
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .flatMap((row): GitRef[] => {
      const [ref, sha, peeled, head, symbolic] = row.split('\0');
      if (symbolic) return [];
      const [group, ...parts] = ref.split('/').slice(1);
      const name = parts.join('/');
      if (!name.toLowerCase().includes(query.toLowerCase())) return [];
      return [
        {
          ref,
          sha: peeled || sha,
          name,
          current: head === '*',
          kind: group === 'heads' ? 'local' : group === 'remotes' ? 'remote' : 'tag',
        },
      ];
    });
}

const commitFormat = '%H%x00%P%x00%s%x00%b%x00%an%x00%aI';

function readLog(text: string): GitCommit[] {
  const parts = text.split('\0');
  const commits: GitCommit[] = [];
  for (let i = 0; i + 5 < parts.length; i += 6) {
    const [sha, parents, title, message, author, date] = parts.slice(i, i + 6);
    if (objectId.test(sha))
      commits.push({
        sha,
        parents: parents.split(' ').filter(Boolean),
        title,
        message: message.trimEnd(),
        author,
        date,
      });
  }
  return commits;
}

export async function gitLog(root: string, refs: string[], offset = 0, limit = 30, query?: string) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    invalid('Invalid Git history page');
  if (!Array.isArray(refs) || refs.length > 64) invalid('Invalid history references');
  if (query !== undefined && (typeof query !== 'string' || query.length > 256 || /[\x00-\x1f]/.test(query)))
    invalid('Invalid commit search');
  const heads = [
    ...new Set(
      await Promise.all(
        (refs.length ? refs : ['HEAD']).map((ref) =>
          resolveCommit(root, ref).catch((error) => {
            if (ref === 'HEAD' && refs.length === 0 && error instanceof AppError && error.code === 'GIT_REVISION')
              return '';
            throw error;
          }),
        ),
      ),
    ),
  ].filter(Boolean);
  if (!heads.length) return { heads, items: [], more: false, offset, limit };
  const result = await gitAsync(root, [
    'log',
    '--topo-order',
    '-z',
    '--no-notes',
    '--format=' + commitFormat,
    ...(query ? ['--fixed-strings', '--regexp-ignore-case', '--grep=' + query] : []),
    '--skip=' + offset,
    '--max-count=' + (limit + 1),
    ...heads,
    '--',
  ]);
  const commits = readLog(result);
  return { heads, items: commits.slice(0, limit), more: commits.length > limit, offset, limit };
}

export async function gitCommit(root: string, ref: unknown) {
  const sha = await resolveCommit(root, ref);
  return readLog(
    await gitAsync(root, ['log', '-1', '-z', '--no-notes', '--format=' + commitFormat, sha, '--']),
  )[0];
}

export async function gitRelation(root: string, base: string, target: string, signal?: AbortSignal) {
  const range = base + '...' + target;
  const [counts, raw, common, shallow] = await Promise.all([
    gitAsync(root, ['rev-list', '--left-right', '--count', range, '--'], signal),
    gitAsync(root, ['rev-list', '--left-right', '--topo-order', '--max-count=500', range, '--'], signal),
    gitAsync(root, ['merge-base', '--all', base, target], signal).catch((error) => {
      if (!signal?.aborted && (error as { code?: number }).code === 1) return '';
      throw error;
    }),
    gitAsync(root, ['rev-parse', '--is-shallow-repository'], signal),
  ]);
  const [left, right] = counts.trim().split(/\s+/).map(Number);
  const records = raw.trim().split('\n').filter(Boolean);
  return {
    left,
    right,
    common: common.trim().split('\n').filter(Boolean),
    shallow: shallow.trim() === 'true',
    baseOnly: records.filter((row) => row.startsWith('<')).map((row) => row.slice(1)),
    targetOnly: records.filter((row) => row.startsWith('>')).map((row) => row.slice(1)),
  };
}

function diffArgs(base: string, target: string) {
  if (!objectId.test(base) || !objectId.test(target)) invalid('Expected resolved Git commits');
  return ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames'];
}

export async function changedFiles(root: string, base: string, target: string, signal?: AbortSignal) {
  const raw = await gitAsync(root, [...diffArgs(base, target), '--name-status', '-z', base, target, '--'], signal);
  const fields = raw.split('\0');
  const items: GitFile[] = [];
  for (let i = 0; fields[i];) {
    const status = fields[i++];
    const path = fields[i++];
    if (/^[RC]/.test(status)) items.push({ status, previous: path, path: fields[i++] });
    else items.push({ status, path });
  }
  return items;
}

export async function filePatch(root: string, base: string, target: string, path: string, previous?: string) {
  const paths = [path, ...(previous ? [previous] : [])];
  if (paths.some((entry) => !entry || protectedSource.test(entry))) invalid('File is outside the source viewer');
  let patch: Buffer;
  try {
    patch = gitBuffer(
      root,
      [...diffArgs(base, target), '--unified=3', base, target, '--', ...paths],
      undefined,
      2 * 1024 * 1024,
    );
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOBUFS') throw error;
    return { text: '', truncated: true, binary: false };
  }
  const header = patch.subarray(0, 160 * 1024).toString('utf8');
  return {
    text: header,
    truncated: patch.length > 160 * 1024,
    binary: /^(?:Binary files |GIT binary patch)/m.test(header),
  };
}

const scanExtension = /\.(?:[cm]?[jt]sx?|py|json|ya?ml|md)$/i;

export function commitSource(root: string, commit: string, onlyPath?: string): ScanSource {
  if (!objectId.test(commit)) invalid('Expected resolved Git commit');
  const records = new Map<string, { oid: string; bytes: number }>();
  const flags = ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', commit, '--'];
  if (onlyPath !== undefined) flags.push(onlyPath);
  for (const entry of git(root, flags).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const mode = /^(100644|100755) blob ([a-f\d]+)\s+(\d+)$/.exec(entry.slice(0, tab));
    const path = entry.slice(tab + 1);
    if (mode && !protectedSource.test(path)) records.set(path, { oid: mode[2], bytes: Number(mode[3]) });
  }

  const lookup = new Map<string, number>();
  const groups: string[][] = [];
  let current: string[] = [],
    bytes = 0;
  for (const [path, item] of records) {
    if (!scanExtension.test(path) || item.bytes > maxBlob) continue;
    if (current.length >= 128 || bytes + item.bytes > maxBlob) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    lookup.set(path, groups.length);
    current.push(path);
    bytes += item.bytes;
  }
  if (current.length) groups.push(current);

  let loaded = -1;
  let blobs = new Map<string, Buffer>();
  function readBatch(paths: string[]) {
    const raw = gitBuffer(
      root,
      ['cat-file', '--batch'],
      paths.map((path) => records.get(path)!.oid).join('\n') + '\n',
      maxBlob + 256 * 1024,
    );
    const result = new Map<string, Buffer>();
    let at = 0;
    for (const path of paths) {
      const lineEnd = raw.indexOf(10, at);
      const item = records.get(path)!;
      if (lineEnd < 0 || raw.subarray(at, lineEnd).toString() !== item.oid + ' blob ' + item.bytes)
        invalid('Git blob could not be read', { path });
      const start = lineEnd + 1;
      result.set(path, raw.subarray(start, start + item.bytes));
      at = start + item.bytes + 1;
    }
    return result;
  }

  return {
    commit,
    paths: records.keys(),
    has: (path) => records.has(path),
    read(path) {
      const item = records.get(path);
      if (!item) throw new AppError('NOT_FOUND', 'File not found in this commit', 3, { path, commit });
      if (item.bytes > maxBlob) invalid('Expected a UTF-8 source file up to 8 MiB', { path });
      const group = lookup.get(path);
      if (group === undefined) return decodeSource(readBatch([path]).get(path)!);
      if (group !== loaded) {
        blobs = readBatch(groups[group]);
        loaded = group;
      }
      return decodeSource(blobs.get(path)!);
    },
  };
}
