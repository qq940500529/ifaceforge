import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { invalid } from './errors.js';

export function isInside(root: string, entry: string) {
  const path = relative(root, entry);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

export function projectFile(root: string, path: string, mustExist = true): string {
  if (isAbsolute(path)) invalid('Expected a project relative path', { path });
  const entry = resolve(root, path);
  if (!isInside(root, entry)) invalid('Path escapes project', { path });
  let ancestor = entry;
  for (;;) {
    try {
      if (!isInside(root, realpathSync(ancestor))) invalid('Path resolves outside project', { path });
      return entry;
    } catch (error) {
      if (mustExist || (error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === root) throw error;
      ancestor = resolve(ancestor, '..');
    }
  }
}

export function parseJson(text: string, label = 'JSON'): unknown {
  const errors: ParseError[] = [];
  const root = parseTree(text.replace(/^\uFEFF/, ''), errors, { disallowComments: true });
  if (!root || errors.length)
    invalid(
      'Invalid ' + label,
      errors.map((error) => ({
        offset: error.offset,
        reason: printParseErrorCode(error.error),
      })),
    );
  const pending: Node[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key: string = property.children![0].value;
        if (keys.has(key)) invalid('Duplicate JSON key', { label, key, offset: property.offset });
        keys.add(key);
      }
    }
    pending.push(...(node.children ?? []));
  }
  return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
}

export function readJson(path: string) {
  return parseJson(readFileSync(path === '-' ? 0 : path, 'utf8'), path);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sourceText(root: string, path: string) {
  const content = readFileSync(projectFile(root, path));
  if (content.length > 8 * 1024 * 1024 || content.includes(0)) invalid('Expected a UTF-8 source file up to 8 MiB');
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
}
