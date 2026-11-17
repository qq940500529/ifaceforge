import { posix } from 'node:path';
import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/python';

export function pythonChildren(node: SyntaxNode) {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

export type PythonConstant = (name: string) => string | undefined;
export type PythonModuleSource = (path: string) => string | undefined;

export function pythonString(
  node: SyntaxNode,
  raw: (node: SyntaxNode) => string,
  lookup: PythonConstant,
  depth = 0,
): string | undefined {
  if (depth >= 12) return;
  if (node.name === 'VariableName' || node.name === 'MemberExpression')
    return lookup(raw(node).replace(/\s/g, ''));
  if (node.name === 'ParenthesizedExpression') {
    const value = pythonChildren(node)[1];
    if (value) return pythonString(value, raw, lookup, depth + 1);
  }
  if (node.name === 'ContinuedString') {
    const values = pythonChildren(node).map((part) => pythonString(part, raw, lookup, depth + 1));
    if (values.every((part) => part !== undefined)) return values.join('');
  }
  if (node.name === 'BinaryExpression') {
    const [left, operator, right] = pythonChildren(node);
    if (!left || !operator || !right || raw(operator) !== '+') return;
    const prefix = pythonString(left, raw, lookup, depth + 1);
    const suffix = pythonString(right, raw, lookup, depth + 1);
    if (prefix !== undefined && suffix !== undefined) return prefix + suffix;
  }
  if (node.name !== 'String') return;
  const quoted = /^(r|u)?("""|'''|"|')([\s\S]*)\2$/i.exec(raw(node));
  if (!quoted) return;
  if (quoted[1]?.toLowerCase() === 'r') return quoted[3];
  return quoted[3].replace(
    /\\(?:[\\'"abfnrtv]|\r?\n|x[\da-f]{2}|u[\da-f]{4}|U[\da-f]{8}|[0-7]{1,3})/gi,
    (escape) => {
      if (escape.endsWith('\n')) return '';
      const char = escape[1];
      if (/^[xXuU]$/.test(char) || /^[0-7]$/.test(char)) {
        const value = /^[0-7]$/.test(char)
          ? Number.parseInt(escape.slice(1), 8)
          : Number.parseInt(escape.slice(2), 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : escape;
      }
      return { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[char] ?? char;
    },
  );
}

interface Module {
  raw: (node: SyntaxNode) => string;
  constants: Map<string, SyntaxNode | null>;
  imports: Map<string, { module: string; member?: string }>;
}

function pythonModule(text: string, root: SyntaxNode): Module {
  const raw = (node: SyntaxNode) => text.slice(node.from, node.to);
  const constants: Module['constants'] = new Map();
  const imports: Module['imports'] = new Map();
  const bind = (name: string, entry: { module: string; member?: string }) => {
    if (imports.has(name)) constants.set(name, null);
    imports.set(name, entry);
  };
  for (const node of pythonChildren(root)) {
    if (node.name === 'AssignStatement' || node.name === 'UpdateStatement') {
      const parts = pythonChildren(node);
      const at = parts.findIndex((part) => part.name === 'AssignOp' && raw(part) === '=');
      const name = parts[0]?.name === 'VariableName' && raw(parts[0]);
      if (name)
        constants.set(
          name,
          at >= 1 && at === parts.length - 2 && !constants.has(name) && !imports.has(name) ? parts[at + 1] : null,
        );
    } else if (node.name === 'ImportStatement') {
      const tokens = pythonChildren(node).filter((item) => item.name !== 'Comment');
      const at = tokens.findIndex((item) => item.name === 'import');
      if (at < 0) continue;
      const from = tokens[0]?.name === 'from' ? tokens.slice(1, at).map(raw).join('') : '';
      const names = tokens
        .slice(at + 1)
        .map(raw)
        .join(' ')
        .replace(/\s*\.\s*/g, '.');
      for (const part of names.replace(/[()]/g, '').split(',')) {
        const match = /^\s*([A-Za-z_]\w*(?:\.\w+)*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
        if (!match) continue;
        const [, name, alias] = match;
        bind(alias ?? name, from ? { module: from, member: name } : { module: name });
      }
    }
  }
  return { raw, imports, constants };
}

export function pythonConstants(source?: PythonModuleSource) {
  const modules = new Map<string, Module | undefined>();
  const values = new Map<string, string | undefined>();
  function load(path: string) {
    if (!modules.has(path)) {
      const text = source?.(path);
      modules.set(path, text === undefined ? undefined : pythonModule(text, parser.parse(text).topNode));
    }
    return modules.get(path);
  }

  function modulePaths(file: string, name: string) {
    const leading = /^\.+/.exec(name)?.[0].length ?? 0;
    const module = name.slice(leading).replaceAll('.', '/');
    const dirs = posix
      .dirname(file)
      .split('/')
      .filter((dir) => dir !== '.');
    if (leading > dirs.length + 1) return [];
    const roots = leading
      ? [dirs.slice(0, dirs.length - leading + 1).join('/')]
      : ['', ...dirs.map((_item, index) => dirs.slice(0, index + 1).join('/'))];
    const candidates = roots.map((root) => posix.join(root, module));
    return [
      ...new Set(
        candidates.flatMap((path) => (path === '.' ? ['__init__.py'] : [path + '.py', path + '/__init__.py'])),
      ),
    ];
  }

  function resolve(file: string, name: string, seen: Set<string>, current?: Module): string | undefined {
    const key = file + '\0' + name;
    if (values.has(key)) return values.get(key);
    if (seen.has(key) || seen.size >= 12) return;
    const module = current ?? load(file);
    if (!module) return;
    seen.add(key);
    const expression = module.constants.get(name);
    let result: string | undefined;
    if (expression) result = pythonString(expression, module.raw, (other) => resolve(file, other, seen, module));
    else if (!module.constants.has(name)) {
      const alias = [...module.imports.keys()].find((entry) => name === entry || name.startsWith(entry + '.'));
      const imported = alias ? module.imports.get(alias) : undefined;
      if (imported && alias) {
        const names = name.slice(alias.length).split('.').filter(Boolean);
        if (imported.member) names.unshift(imported.member);
        const member = names.pop();
        if (member) {
          const target = [imported.module, ...names].join(imported.module.endsWith('.') ? '' : '.');
          const candidates = modulePaths(file, target).filter((path) => load(path));
          if (candidates.length === 1) result = resolve(candidates[0], member, seen);
        }
      }
    }
    seen.delete(key);
    values.set(key, result);
    return result;
  }
  return (file: string, text: string, root: SyntaxNode): PythonConstant => {
    const current = pythonModule(text, root);
    modules.set(file, current);
    return (name) => resolve(file, name, new Set(), current);
  };
}
