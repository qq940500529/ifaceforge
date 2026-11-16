import { posix } from 'node:path';
import { parseDocument, LineCounter, isMap, isScalar } from 'yaml';
import { protectedSource, sourceText } from '../app/files.js';
import { invalid } from '../app/errors.js';
import { jsonPointer } from '../app/pointer.js';
import { apiId, type Diagnostic, type Observation } from './model.js';

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query']);

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

function mediaContent(types: unknown, schema: unknown) {
  const media = Array.isArray(types) && types.length ? types : ['application/json'];
  return Object.fromEntries(
    media.filter((key): key is string => typeof key === 'string').map((key) => [key, { schema }]),
  );
}

function legacySchema(entry: Record<string, unknown>) {
  const {
    type,
    format,
    items,
    enum: values,
    minimum,
    maximum,
    pattern,
    minLength,
    maxLength,
    default: fallback,
  } = entry;
  if (typeof type !== 'string' || type === 'void') return undefined;
  if (!['array', 'boolean', 'integer', 'number', 'object', 'string', 'file'].includes(type)) return { $ref: type };
  return {
    type: type === 'file' ? 'string' : type,
    format: type === 'file' ? 'binary' : format,
    items,
    enum: values,
    minimum,
    maximum,
    pattern,
    minLength,
    maxLength,
    default: fallback,
  };
}

function legacyOperation(operation: Record<string, unknown>, root: Record<string, unknown>) {
  const input = Array.isArray(operation.parameters) ? operation.parameters.map(mapping) : [];
  const parameters: Record<string, unknown>[] = input.map((entry) => ({
    ...entry,
    in: entry.in ?? entry.paramType,
    schema: entry.schema ?? legacySchema(entry),
  }));
  const body = parameters.find((entry) => entry.in === 'body');
  const form = parameters.filter((entry) => entry.in === 'formData' || entry.in === 'form');
  const responses = Object.fromEntries(
    Object.entries(mapping(operation.responses)).map(([status, response]) => {
      const entry = mapping(response);
      return [
        status,
        {
          ...entry,
          content: entry.schema ? mediaContent(operation.produces ?? root.produces, entry.schema) : undefined,
        },
      ];
    }),
  );
  const requestBody = body
    ? { required: body.required, content: mediaContent(operation.consumes ?? root.consumes, body.schema) }
    : form.length
      ? {
          content: mediaContent(operation.consumes ?? root.consumes ?? ['application/x-www-form-urlencoded'], {
            type: 'object',
            properties: Object.fromEntries(form.map((entry) => [String(entry.name), entry.schema])),
            required: form.filter((entry) => entry.required === true).map((entry) => entry.name),
          }),
        }
      : undefined;
  return {
    ...operation,
    parameters: parameters.filter((entry) => entry !== body && !form.includes(entry)),
    responses,
    requestBody,
  };
}

function legacyPaths(root: Record<string, unknown>) {
  if (!Array.isArray(root.apis)) return {};
  const paths = new Map<string, Record<string, unknown>>();
  for (const entry of root.apis.map(mapping)) {
    if (typeof entry.path !== 'string' || !Array.isArray(entry.operations)) continue;
    const item = paths.get(entry.path) ?? {};
    for (const op of entry.operations.map(mapping)) {
      const method = String(op.method ?? op.httpMethod).toLowerCase();
      const responseSchema = legacySchema({ ...op, type: op.type ?? op.responseClass });
      const responses = Object.fromEntries(
        (Array.isArray(op.responseMessages ?? op.errorResponses)
          ? ((op.responseMessages ?? op.errorResponses) as unknown[])
          : []
        )
          .map(mapping)
          .map((response) => [
            String(response.code),
            {
              description: response.message ?? response.reason,
              schema: response.responseModel ? { $ref: response.responseModel } : undefined,
            },
          ]),
      );
      item[method] = {
        ...op,
        operationId: op.nickname,
        responses: { 200: { description: 'OK', schema: responseSchema }, ...responses },
      };
    }
    paths.set(entry.path, item);
  }
  return Object.fromEntries(paths);
}

export function parseOpenApi(
  text: string,
  options: {
    root?: string;
    path?: string;
    service: string;
    profile?: string;
    read?: (path: string) => string;
    visited?: ReadonlySet<string>;
  },
  diagnostics: Diagnostic[],
): Observation[] {
  const { doc, lines, value } = yamlDocument(text);
  const definitions = mapping(value);
  const specification = String(definitions.openapi ?? definitions.swagger ?? definitions.swaggerVersion ?? '');
  if (!specification) invalid('Expected a Swagger or OpenAPI document');
  const early = /^1\.[012]$/.test(specification);
  const legacy = early || specification === '2.0';
  if (!legacy && !/^3\.[012]\.\d+(?:[-+].+)?$/.test(specification)) {
    diagnostics.push({
      path: options.path,
      code: 'API_SPEC_VERSION',
      message: 'Unrecognized API specification version ' + specification,
    });
    return [
      {
        id: 'api-definition:' + options.service + ':' + (options.path ?? ''),
        kind: 'api',
        service: options.service,
        name: 'API definition · ' + specification,
        summary: '',
        origin: options.profile ? 'runtime' : 'declaration',
        profile: options.profile,
        path: options.path,
        line: 1,
        definition: { specVersion: specification, raw: value },
      },
    ];
  }
  const read = options.read ?? (options.root ? (path: string) => sourceText(options.root!, path) : undefined);
  function relativeDocument(path: string, name: string) {
    const decoded = decodeURIComponent(name);
    if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(decoded) || decoded.includes('\\')) throw Error('External reference');
    const target = posix.normalize(posix.join(posix.dirname(path), decoded));
    if (target.startsWith('../') || target === '..' || protectedSource.test(target))
      throw Error('Reference outside source viewer');
    return target;
  }
  if (
    early &&
    Array.isArray(definitions.apis) &&
    !definitions.apis.some((item) => Array.isArray(mapping(item).operations))
  ) {
    const visited = new Set([...(options.visited ?? []), options.path ?? '']);
    return definitions.apis.flatMap((item) => {
      const name = mapping(item).path;
      if (typeof name !== 'string' || !options.path || !read) return [];
      try {
        const file = name.replace(/^\/(?!\/)/, '');
        const target = relativeDocument(options.path, file);
        if (visited.has(target) || visited.size >= 32) throw Error('Circular resource listing');
        let source: string,
          selected = target;
        try {
          source = read(target);
        } catch (error) {
          if (posix.extname(target)) throw error;
          selected += '.json';
          source = read(selected);
        }
        return parseOpenApi(source, { ...options, path: selected, visited }, diagnostics);
      } catch (error) {
        diagnostics.push({ path: options.path, code: 'SWAGGER_RESOURCE', message: String(error) });
        return [];
      }
    });
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
      const model = early && !/[#/.:]/.test($ref);
      const [file, fragment = ''] = model ? ['', '/models/' + $ref] : $ref.split('#');
      const target = file ? relativeDocument(path, file) : path;
      const pointer = decodeURIComponent(fragment);
      const key = target + '#' + pointer;
      if (refs.has(key)) throw Error('Circular reference');
      if (!documents.has(target)) {
        if (!read || !options.path) throw Error('Remote references disabled');
        documents.set(target, yamlDocument(read(target)).value);
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
  for (const [path, raw] of Object.entries(early ? legacyPaths(definitions) : mapping(definitions.paths))) {
    if (!path.startsWith('/')) continue;
    const item = mapping(expand(raw, options.path ?? '', new Set()));
    const pathNode = isMap(paths) ? paths.get(path, true) : undefined;
    const standard = Object.entries(item).filter(([method]) => methods.has(method));
    const additional = Object.entries(mapping(item.additionalOperations)).filter(([method]) =>
      /^[A-Za-z][A-Za-z0-9_-]*$/.test(method),
    );
    for (const [method, content] of [...standard, ...additional]) {
      const operation = legacy
        ? mapping(expand(legacyOperation(mapping(content), definitions), options.path ?? '', new Set()))
        : mapping(content);
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
          openapi: legacy ? '3.0.4' : specification,
          specVersion: specification,
          apiVersion: mapping(definitions.info).version ?? definitions.apiVersion,
          rawOperation: legacy ? content : undefined,
          operation: {
            ...operation,
            parameters: [...distinct.values()],
            security: operation.security ?? definitions.security,
            servers:
              operation.servers ??
              item.servers ??
              definitions.servers ??
              (legacy && typeof definitions.basePath === 'string'
                ? [
                    {
                      url:
                        typeof definitions.host === 'string'
                          ? (Array.isArray(definitions.schemes) ? (definitions.schemes[0] ?? 'https') : 'https') +
                            '://' +
                            definitions.host +
                            definitions.basePath
                          : definitions.basePath,
                    },
                  ]
                : undefined),
          },
          securitySchemes: mapping(definitions.components).securitySchemes ?? definitions.securityDefinitions,
        },
      });
    }
  }
  return observations;
}
