import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import type { Diagnostic, Observation } from './model.js';
import { mcpId } from './model.js';
import { mapping } from './openapi.js';

const registrations = {
  tool: 'tool',
  registerTool: 'tool',
  resource: 'resource',
  registerResource: 'resource',
  resourceTemplate: 'template',
  registerResourceTemplate: 'template',
  prompt: 'prompt',
  registerPrompt: 'prompt',
} as const;
type Capability = (typeof registrations)[keyof typeof registrations];
const lists = { tool: 'tools', resource: 'resources', template: 'resourceTemplates', prompt: 'prompts' } as const;

function observation(
  path: string,
  service: string,
  type: Capability,
  name: string,
  definition: Record<string, unknown>,
  origin: 'source' | 'declaration',
  line?: number,
): Observation {
  const key = type === 'resource' ? definition.uri : type === 'template' ? definition.uriTemplate : name;
  return {
    id: mcpId(service, type, typeof key === 'string' ? key : name),
    kind: 'mcp',
    service,
    name,
    origin,
    path,
    line,
    summary: String(definition.description ?? ''),
    definition: { ...definition, type },
  };
}

export function parseMcpManifest(path: string, data: unknown, service: string, diagnostics: Diagnostic[]) {
  const value = mapping(data);
  if (value.schemaVersion !== 1) {
    diagnostics.push({
      path,
      code: 'MCP_MANIFEST_VERSION',
      message: 'Unknown MCP manifest version. Showing original fields.',
    });
    return [
      {
        id: mcpId(service, 'manifest', path),
        kind: 'mcp' as const,
        service,
        name: path,
        summary: '',
        origin: 'declaration' as const,
        path,
        line: 1,
        definition: { type: 'manifest', raw: data },
      },
    ];
  }
  const name = typeof value.service === 'string' && value.service ? value.service : service;
  return (Object.keys(lists) as Capability[]).flatMap((type) => {
    const entries = value[lists[type]];
    if (entries === undefined) return [];
    if (!Array.isArray(entries)) {
      diagnostics.push({ path, code: 'MCP_MANIFEST', message: lists[type] + ' must be an array' });
      return [];
    }
    return entries.flatMap((raw) => {
      const item = mapping(raw);
      const uri = type === 'resource' ? item.uri : type === 'template' ? item.uriTemplate : undefined;
      if (
        typeof item.name !== 'string' ||
        !item.name ||
        ((type === 'resource' || type === 'template') && (typeof uri !== 'string' || !uri))
      ) {
        diagnostics.push({ path, code: 'MCP_MANIFEST', message: 'Missing name or URI in ' + lists[type] });
        return [];
      }
      return [
        observation(
          path,
          name,
          type,
          item.name,
          {
            ...item,
            protocolVersion: value.protocolVersion,
            serverVersion: value.serverVersion,
          },
          'declaration',
          1,
        ),
      ];
    });
  });
}

function memberName(node: Node | null | undefined) {
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return undefined;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return node.property.type === 'StringLiteral' ? node.property.value : undefined;
}

function objectKey(node: Node) {
  return node.type === 'Identifier' ? node.name : node.type === 'StringLiteral' ? node.value : undefined;
}

export function scanMcpSource(
  path: string,
  text: string,
  service: string,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
) {
  if (!/\.(?:registerTool|registerResource(?:Template)?|registerPrompt|tool|resource|prompt)\b/.test(text))
    return [];
  let program;
  try {
    program = parse(text, {
      sourceType: 'unambiguous',
      plugins: [
        /\.(?:[cm]?ts|tsx)$/i.test(path) ? 'typescript' : 'jsx',
        ...(/\.tsx$/i.test(path) ? ['jsx' as const] : []),
      ],
    }).program;
  } catch (error) {
    diagnostics.push({ path, code: 'MCP_SOURCE_PARSE', message: (error as Error).message });
    return [];
  }
  const constants = new Map<string, Node>();
  for (const item of program.body) {
    const declaration = item.type === 'ExportNamedDeclaration' ? item.declaration : item;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const binding of declaration.declarations)
      if (binding.id.type === 'Identifier' && binding.init) constants.set(binding.id.name, binding.init);
  }

  function literal(node: Node | null | undefined, depth = 0): unknown {
    if (!node || depth > 16) return undefined;
    switch (node.type) {
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NumericLiteral':
        return node.value;
      case 'NullLiteral':
        return null;
      case 'TemplateLiteral':
        return node.expressions.length ? undefined : node.quasis[0]?.value.cooked;
      case 'Identifier':
        return literal(constants.get(node.name), depth + 1);
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
        return literal(node.expression, depth + 1);
      case 'ArrayExpression': {
        const values = node.elements.map((item) => literal(item, depth + 1));
        return values.includes(undefined) ? undefined : values;
      }
      case 'ObjectExpression':
        return Object.fromEntries(
          node.properties.flatMap((property) => {
            if (property.type !== 'ObjectProperty' || property.computed) return [];
            const key = objectKey(property.key);
            const value = literal(property.value, depth + 1);
            return key === undefined || value === undefined ? [] : [[key, value]];
          }),
        );
      default:
        return undefined;
    }
  }

  function schemaShape(node: Node | null | undefined, depth: number): Record<string, unknown> | undefined {
    if (!node || depth > 16) return;
    if (node.type === 'Identifier') return schemaShape(constants.get(node.name), depth + 1);
    if (node.type === 'ObjectExpression') {
      const properties: [string, Record<string, unknown>][] = [],
        required: string[] = [];
      for (const property of node.properties) {
        if (property.type !== 'ObjectProperty' || property.computed) return;
        const key = objectKey(property.key);
        const value = schemaShape(property.value, depth + 1);
        if (key === undefined || !value) return;
        const { optional, ...schema } = value;
        properties.push([key, schema]);
        if (!optional) required.push(key);
      }
      return { type: 'object', properties: Object.fromEntries(properties), required };
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    const method = memberName(node.callee);
    const arg = node.arguments[0];
    const receiver = node.callee.object;
    if (receiver.type === 'Identifier' && receiver.name === 'z') {
      if (method && ['string', 'number', 'boolean', 'null'].includes(method)) return { type: method };
      if (method === 'object') return schemaShape(arg, depth + 1);
      if (method === 'array') {
        const items = schemaShape(arg, depth + 1);
        return items ? { type: 'array', items } : undefined;
      }
      const value = literal(arg, depth + 1);
      if (method === 'literal' && value !== undefined) return { const: value };
      if (method === 'enum' && Array.isArray(value)) return { enum: value };
      return;
    }
    const inner = schemaShape(receiver, depth + 1);
    if (!inner) return;
    if (method === 'int') return { ...inner, type: 'integer' };
    if (method === 'optional') return { ...inner, optional: true };
    if (method === 'nullable') return { anyOf: [inner, { type: 'null' }] };
    const value = literal(arg, depth + 1);
    if (method === 'describe' && typeof value === 'string') return { ...inner, description: value };
    if (method === 'default' && value !== undefined) return { ...inner, default: value, optional: true };
    return;
  }

  function config(node: Node | undefined) {
    const result = mapping(literal(node));
    const object = node?.type === 'Identifier' ? constants.get(node.name) : node;
    const unresolved: string[] = [];
    if (object?.type !== 'ObjectExpression') return { result, unresolved };
    for (const property of object.properties) {
      if (property.type !== 'ObjectProperty' || property.computed) continue;
      const key = objectKey(property.key);
      if (key && ['inputSchema', 'outputSchema', 'argsSchema'].includes(key) && !Object.hasOwn(result, key)) {
        const schema = schemaShape(property.value, 0);
        if (schema) result[key] = schema;
        else unresolved.push(key);
      }
    }
    return { result, unresolved };
  }

  const observations: Observation[] = [];
  const pending: Node[] = [program];
  let inspected = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++inspected % 256 === 0) checkpoint?.();
    for (const value of Object.values(node)) {
      for (const item of Array.isArray(value) ? value : [value])
        if (item && typeof item === 'object' && typeof item.type === 'string') pending.push(item as Node);
    }
    if (node.type !== 'CallExpression') continue;
    const method = memberName(node.callee);
    if (!method || !Object.hasOwn(registrations, method)) continue;
    const line = node.loc?.start.line;
    const [nameArg, next, resourceConfig] = node.arguments;
    const name = literal(nameArg);
    if (typeof name !== 'string') {
      diagnostics.push({
        path,
        code: 'MCP_DYNAMIC_REGISTRATION',
        message: 'Dynamic ' + method + ' at line ' + line,
      });
      continue;
    }
    let type: Capability = registrations[method as keyof typeof registrations];
    const isResource = type === 'resource' || type === 'template';
    const uriArg =
      next?.type === 'NewExpression' &&
      next.callee.type === 'Identifier' &&
      next.callee.name === 'ResourceTemplate'
        ? next.arguments[0]
        : next;
    const uri = isResource ? literal(uriArg) : undefined;
    if (type === 'resource' && typeof uri === 'string' && uri.includes('{')) type = 'template';
    const { result, unresolved } = config(isResource ? resourceConfig : next);
    if (typeof uri === 'string') result[type === 'template' ? 'uriTemplate' : 'uri'] = uri;
    else if (isResource) unresolved.push(type === 'template' ? 'uriTemplate' : 'uri');
    if (typeof literal(next) === 'string' && !isResource) result.description = literal(next);
    if (unresolved.length) {
      result.unresolved = unresolved;
      diagnostics.push({
        path,
        code: 'MCP_DYNAMIC_FIELDS',
        message: name + ' at line ' + line + ': ' + unresolved.join(', '),
      });
    }
    observations.push(observation(path, service, type, name, result, 'source', line));
  }
  return observations.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
