import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/python';
import { mcpObservation, type Capability } from './mcp-discovery.js';
import type { Diagnostic, Observation } from './model.js';

function children(node: SyntaxNode) {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function groups(nodes: SyntaxNode[], ignored: string[]) {
  const result: SyntaxNode[][] = [[]];
  for (const node of nodes) {
    if (node.name === ',') result.push([]);
    else if (!ignored.includes(node.name)) result.at(-1)!.push(node);
  }
  return result.filter((group) => group.length);
}

function pythonString(raw: string) {
  const match = /^(r|u)?("""|'''|"|')([\s\S]*)\2$/i.exec(raw);
  if (!match) return;
  if (match[1]?.toLowerCase() === 'r') return match[3];
  return match[3].replace(/\\(?:[\\'"nrt]|\r?\n)/g, (escape) => {
    if (escape.endsWith('\n')) return '';
    return { n: '\n', r: '\r', t: '\t' }[escape[1]] ?? escape[1];
  });
}

type JsonSchema = Record<string, unknown>;

export function scanPythonMcp(
  path: string,
  text: string,
  service: string,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
) {
  if (!/@[\w.]+\.(?:tool|resource|prompt)\b|\.(?:add_tool|add_resource|add_prompt)\s*\(/.test(text)) return [];
  const script = parser.parse(text).topNode;
  const raw = (node: SyntaxNode | undefined) => (node ? text.slice(node.from, node.to) : '');
  const imports = children(script)
    .filter((node) => node.name === 'ImportStatement')
    .map(raw);
  const sdk = /\b(?:mcp(?:\.|\s)|fastmcp(?:\.|\s))/.test(imports.join('\n'));
  const registryModule = /(?:^|\/)mcp\/(?!tests?\/)/i.test(path);
  if (!sdk && !registryModule) return [];
  const constructors = new Set<string>();
  for (const statement of imports) {
    if (!/\b(?:mcp|fastmcp)\b/.test(statement)) continue;
    for (const [, name, alias] of statement.matchAll(/\b(FastMCP|Server)\b(?:\s+as\s+(\w+))?/g))
      constructors.add(alias ?? name);
    const namespace = /^import\s+(?:fastmcp|mcp)(?:\.\w+)*(?:\s+as\s+(\w+))?/.exec(statement);
    if (namespace) {
      const prefix = namespace[1] ?? statement.split(/\s+/)[1];
      constructors.add(prefix + '.FastMCP');
      constructors.add(prefix + '.Server');
    }
  }
  const globals = new Map<string, SyntaxNode>();
  const servers = new Set<string>();
  const results: Observation[] = [];
  const line = (offset: number) => text.slice(0, offset).split('\n').length;

  function literal(node: SyntaxNode | undefined, values: Map<string, SyntaxNode>, depth = 0): unknown {
    if (!node || depth > 12) return;
    if (node.name === 'String') return pythonString(raw(node));
    if (node.name === 'None') return null;
    if (node.name === 'Boolean') return raw(node) === 'True';
    if (node.name === 'Number' || node.name === 'UnaryExpression') {
      const number = Number(raw(node).replaceAll('_', ''));
      if (Number.isFinite(number)) return number;
    }
    if (node.name === 'VariableName') return literal(values.get(raw(node)), values, depth + 1);
    if (node.name === 'ArrayExpression' || node.name === 'TupleExpression') {
      const items = groups(children(node), ['[', ']', '(', ')']).map(([item]) => literal(item, values, depth + 1));
      return items.includes(undefined) ? undefined : items;
    }
    if (node.name === 'DictionaryExpression') {
      const entries = groups(children(node), ['{', '}']).map(([key, colon, value]) => [
        literal(key, values, depth + 1),
        colon?.name === ':' ? literal(value, values, depth + 1) : undefined,
      ]);
      if (entries.every(([key, value]) => typeof key === 'string' && value !== undefined))
        return Object.fromEntries(entries as [string, unknown][]);
    }
    if (node.name === 'BinaryExpression') {
      const [left, operator, right] = children(node);
      if (raw(operator) !== '+') return;
      const first = literal(left, values, depth + 1);
      const last = literal(right, values, depth + 1);
      if (typeof first === 'string' && typeof last === 'string') return first + last;
    }
  }

  function schema(
    node: SyntaxNode | undefined,
    values: Map<string, SyntaxNode>,
    depth = 0,
  ): JsonSchema | undefined {
    if (!node || depth > 10) return;
    const name = raw(node);
    const primitive = new Map([
      ['str', 'string'],
      ['bool', 'boolean'],
      ['int', 'integer'],
      ['float', 'number'],
      ['None', 'null'],
      ['dict', 'object'],
      ['list', 'array'],
      ['tuple', 'array'],
      ['set', 'array'],
    ]).get(name);
    if (primitive) return { type: primitive };
    if (name === 'Any' || name === 'typing.Any') return {};
    if (node.name === 'VariableName') return schema(values.get(name), values, depth + 1);
    if (node.name === 'BinaryExpression') {
      const [left, operator, right] = children(node);
      if (raw(operator) !== '|') return;
      const fields = [left, right].map((item) => schema(item, values, depth + 1));
      if (fields.every(Boolean)) return { anyOf: fields };
    }
    if (node.name === 'MemberExpression') {
      const [base, open, ...args] = children(node);
      if (open?.name !== '[') return;
      const items = groups(args, [']']).map(([arg]) => arg);
      const type = raw(base).split('.').at(-1)?.toLowerCase();
      const inner = () => schema(items[0], values, depth + 1);
      if (type === 'annotated') return inner();
      if (type === 'list' || type === 'sequence' || type === 'set') return { type: 'array', items: inner() ?? {} };
      if (type === 'optional' && inner()) return { anyOf: [inner(), { type: 'null' }] };
      if (type === 'dict' || type === 'mapping')
        return { type: 'object', additionalProperties: schema(items[1], values, depth + 1) ?? {} };
      if (type === 'union') {
        const types = items.map((item) => schema(item, values, depth + 1));
        if (types.every(Boolean)) return { anyOf: types };
      }
      if (type === 'literal') {
        const valuesLiteral = items.map((item) => literal(item, values));
        if (!valuesLiteral.includes(undefined)) return { enum: valuesLiteral };
      }
    }
  }

  function params(fn: SyntaxNode) {
    const list = fn.getChild('ParamList');
    return list ? groups(children(list), ['(', ')']) : [];
  }

  function inspect(
    node: SyntaxNode,
    values: Map<string, SyntaxNode>,
    receivers: Set<string>,
    conditional = false,
  ) {
    if (++visited % 256 === 0) checkpoint?.();
    if (node.name === 'AssignStatement') {
      const [name, operator, expression] = children(node);
      if (name?.name === 'VariableName' && operator?.name === 'AssignOp' && expression) {
        values.set(raw(name), expression);
        if (expression.name === 'CallExpression' && constructors.has(raw(expression.firstChild ?? undefined)))
          receivers.add(raw(name));
        if (receivers.has(raw(expression))) receivers.add(raw(name));
      }
      return;
    }
    if (node.name === 'FunctionDefinition') {
      const next = new Set(receivers);
      const name = raw(node.getChild('VariableName') ?? undefined);
      for (const [parameter, type] of params(node)) {
        if (parameter.name !== 'VariableName') continue;
        if (constructors.has(raw(type?.lastChild ?? undefined))) next.add(raw(parameter));
        if (registryModule && name === 'register' && ['mcp', 'server'].includes(raw(parameter)))
          next.add(raw(parameter));
      }
      const body = node.getChild('Body');
      if (body) inspect(body, new Map(values), next, conditional);
      return;
    }
    if (node.name === 'DecoratedStatement') {
      const fn = node.getChild('FunctionDefinition');
      if (!fn) return;
      for (const decorator of node.getChildren('Decorator')) {
        const args = decorator.getChild('ArgList');
        const target = text.slice(decorator.from, args?.from ?? decorator.to).trim();
        const match = /^@(\w+)\.(tool|resource|prompt)$/.exec(target);
        if (!match || !receivers.has(match[1])) continue;
        const type = match[2] as Capability;
        const named = new Map<string, SyntaxNode>();
        const positionals: SyntaxNode[] = [];
        for (const [first, second, last] of args ? groups(children(args), ['(', ')']) : []) {
          if (second?.name === 'AssignOp' && last) named.set(raw(first), last);
          else positionals.push(first);
        }
        record(fn, decorator, type, named, positionals, values, conditional);
      }
      return;
    }
    if (node.name === 'ExpressionStatement') {
      const call = node.firstChild;
      const match =
        call?.name === 'CallExpression' &&
        /^(\w+)\.add_(tool|prompt|resource)$/.exec(raw(call.firstChild ?? undefined));
      if (call && match && receivers.has(match[1])) {
        const args = call.getChild('ArgList');
        const entries = args ? groups(children(args), ['(', ')']) : [];
        const fn = declarations.get(raw(entries[0]?.[0]));
        if (fn && match[2] !== 'resource') {
          const named = new Map<string, SyntaxNode>();
          for (const [first, second, last] of entries.slice(1))
            if (second?.name === 'AssignOp' && last) named.set(raw(first), last);
          record(fn, call, match[2] as Capability, named, [], values, conditional);
        } else {
          diagnostics.push({
            path,
            line: line(call.from),
            code: 'MCP_DYNAMIC_REGISTRATION',
            message: 'MCP registration uses an unresolved object',
          });
        }
      }
      return;
    }
    if (
      [
        'Script',
        'Body',
        'IfStatement',
        'ForStatement',
        'WhileStatement',
        'TryStatement',
        'WithStatement',
      ].includes(node.name)
    ) {
      for (const child of children(node)) {
        if (child.name === 'FunctionDefinition')
          declarations.set(raw(child.getChild('VariableName') ?? undefined), child);
        inspect(child, values, receivers, conditional || !['Script', 'Body'].includes(node.name));
      }
    }
  }

  function record(
    fn: SyntaxNode,
    location: SyntaxNode,
    registered: Capability,
    named: Map<string, SyntaxNode>,
    positionals: SyntaxNode[],
    values: Map<string, SyntaxNode>,
    conditional: boolean,
  ) {
    const nameNode = named.get('name') ?? (registered === 'resource' ? undefined : positionals[0]);
    const name = nameNode ? literal(nameNode, values) : raw(fn.getChild('VariableName') ?? undefined);
    const resource = registered === 'resource';
    const uri = resource ? literal(named.get('uri') ?? positionals[0], values) : undefined;
    const at = line(location.from);
    if (typeof name !== 'string' || !name || (resource && typeof uri !== 'string')) {
      diagnostics.push({
        path,
        line: at,
        code: 'MCP_DYNAMIC_REGISTRATION',
        message: 'MCP name or URI depends on runtime values',
      });
      return;
    }
    const type = typeof uri === 'string' && /\{[^}]+\}/.test(uri) ? 'template' : registered;
    const doc = fn.getChild('Body')?.getChild('ExpressionStatement')?.firstChild;
    const explicit = literal(named.get('description'), values);
    const description =
      typeof explicit === 'string' ? explicit : doc?.name === 'String' ? pythonString(raw(doc)) : undefined;
    const definition: Record<string, unknown> = {
      adapter: 'python-fastmcp',
      description: description?.trim(),
      conditional: conditional || undefined,
      ...(typeof uri === 'string' ? { [type === 'template' ? 'uriTemplate' : 'uri']: uri } : {}),
    };
    for (const field of ['title', 'mime_type', 'icons', 'annotations']) {
      const value = literal(named.get(field), values);
      if (value !== undefined) definition[field === 'mime_type' ? 'mimeType' : field] = value;
    }
    if (type === 'tool' || type === 'prompt') {
      const properties: [string, JsonSchema][] = [];
      const required: string[] = [];
      const unresolved: string[] = [];
      for (const [parameter, ...tail] of params(fn)) {
        if (parameter.name !== 'VariableName') continue;
        const key = raw(parameter);
        const annotation = tail.find((item) => item.name === 'TypeDef');
        const assign = tail.findIndex((item) => item.name === 'AssignOp');
        if (key === 'self' || /(?:^|\.)Context$/.test(raw(annotation?.lastChild ?? undefined))) continue;
        const annotationSchema = schema(annotation?.lastChild ?? undefined, values);
        const value = assign < 0 ? undefined : literal(tail[assign + 1], values);
        if (type === 'tool' && (!annotationSchema || (assign >= 0 && value === undefined))) unresolved.push(key);
        if (assign < 0) required.push(key);
        properties.push([key, { ...annotationSchema, ...(value === undefined ? {} : { default: value }) }]);
      }
      if (type === 'tool') {
        definition.inputSchema = { type: 'object', properties: Object.fromEntries(properties), required };
        const output = schema(fn.getChild('TypeDef')?.lastChild ?? undefined, values);
        if (output?.type === 'object') definition.outputSchema = output;
        definition.unresolved = ['runtimeSchema', ...unresolved];
      } else {
        definition.arguments = properties.map(([name]) => ({ name, required: required.includes(name) }));
      }
    }
    results.push(mcpObservation(path, service, type, name, definition, 'source', at));
  }

  const declarations = new Map<string, SyntaxNode>();
  let visited = 0;
  inspect(script, globals, servers);
  return results;
}
