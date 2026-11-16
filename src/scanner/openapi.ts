import { posix } from 'node:path';
import { parseDocument, LineCounter, isMap, isScalar } from 'yaml';
import { sourceText } from '../app/files.js';
import { invalid } from '../app/errors.js';
import { jsonPointer } from '../app/pointer.js';
import { apiId, type Diagnostic, type Observation } from './model.js';

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function yamlDocument(text: string) {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  if (doc.errors.length)
    invalid(
      'Invalid YAML or JSON',
      doc.errors.map((error) => error.message),
    );
  // Aliases are unnecessary for imported schemas and may create cycles or oversized expansions.
  return { doc, lines, value: doc.toJS({ maxAliasCount: 0 }) as unknown };
}

export function parseOpenApi(
  text: string,
  options: {
    root?: string;
    path?: string;
    service: string;
    profile?: string;
  },
  diagnostics: Diagnostic[],
): Observation[] {
  const { doc, lines, value } = yamlDocument(text);
  const definitions = mapping(value);
  if (!/^3\.[01]\.\d+(?:[-+].+)?$/.test(String(definitions.openapi))) {
    invalid('Expected OpenAPI 3.0 or 3.1');
  }
  const documents = new Map([[options.path ?? '', value]]);
  let expandedNodes = 0;
  function expand(node: unknown, path: string, refs: ReadonlySet<string>, depth = 0): unknown {
    if (++expandedNodes > 250000 || depth > 100) invalid('OpenAPI reference expansion exceeds limits');
    if (Array.isArray(node)) return node.map((item) => expand(item, path, refs, depth + 1));
    if (node === null || typeof node !== 'object') return node;
    const { $ref, ...rest } = mapping(node);
    const fields = Object.fromEntries(
      Object.entries(rest).map(([key, item]) => [key, expand(item, path, refs, depth + 1)]),
    );
    if (typeof $ref !== 'string') return fields;
    try {
      const [file, fragment = ''] = $ref.split('#');
      const decoded = decodeURIComponent(file);
      if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(decoded) || decoded.includes('\\'))
        throw Error('External reference');
      const target = decoded ? posix.normalize(posix.join(posix.dirname(path), decoded)) : path;
      const pointer = decodeURIComponent(fragment);
      const key = target + '#' + pointer;
      if (refs.has(key)) throw Error('Circular reference');
      if (!documents.has(target)) {
        if (!options.root || !options.path) throw Error('Remote references disabled');
        documents.set(target, yamlDocument(sourceText(options.root, target)).value);
      }
      const resolved = jsonPointer(documents.get(target), pointer);
      if (resolved === undefined) throw Error('Reference target missing');
      return { ...mapping(expand(resolved, target, new Set([...refs, key]), depth + 1)), ...fields };
    } catch (error) {
      diagnostics.push({ path: options.path, code: 'UNRESOLVED_REF', message: String(error) + ': ' + $ref });
      return { ...fields, $ref, 'x-ifg-unresolved': true };
    }
  }

  const paths = doc.get('paths', true);
  const observations: Observation[] = [];
  for (const [path, raw] of Object.entries(mapping(definitions.paths))) {
    if (!path.startsWith('/')) continue;
    const item = mapping(expand(raw, options.path ?? '', new Set()));
    const pathNode = isMap(paths) ? paths.get(path, true) : undefined;
    for (const [method, content] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      const operation = mapping(content);
      const node = isMap(pathNode)
        ? pathNode.items.find((pair) => isScalar(pair.key) && pair.key.value === method)
        : undefined;
      const offset = node && isScalar(node.key) ? node.key.range?.[0] : undefined;
      const parameters = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];
      const distinct = new Map(
        parameters.map((parameter) => {
          const entry = mapping(parameter);
          return [String(entry.in) + ':' + String(entry.name), parameter];
        }),
      );
      observations.push({
        id: apiId(options.service, method, path),
        kind: 'api',
        service: options.service,
        name: method.toUpperCase() + ' ' + path,
        summary: String(operation.summary ?? operation.description ?? ''),
        origin: options.profile ? 'runtime' : 'declaration',
        profile: options.profile,
        path: options.path,
        line: offset === undefined ? undefined : lines.linePos(offset).line,
        definition: {
          method,
          path,
          openapi: definitions.openapi,
          operation: {
            ...operation,
            parameters: [...distinct.values()],
            security: operation.security ?? definitions.security,
            servers: operation.servers ?? item.servers ?? definitions.servers,
          },
          securitySchemes: mapping(definitions.components).securitySchemes,
        },
      });
    }
  }
  return observations;
}
