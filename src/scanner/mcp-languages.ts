import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { mcpObservation, type Capability } from './mcp-discovery.js';
import { mcpId, type Diagnostic, type Observation } from './model.js';

const grammarExtensions = {
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  c_sharp: ['cs'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  swift: ['swift'],
  ruby: ['rb'],
  php: ['php'],
  scala: ['scala', 'sc'],
  dart: ['dart'],
  bash: ['sh', 'bash', 'zsh'],
  lua: ['lua'],
  elixir: ['ex', 'exs'],
  ocaml: ['ml', 'mli'],
} as const;
const protocolEvidenceExtensions = [
  'fs',
  'fsx',
  'ps1',
  'psm1',
  'cmd',
  'bat',
  'r',
  'jl',
  'erl',
  'hrl',
  'hs',
  'lhs',
  'pl',
  'pm',
];
const languages = new Map<string, string>(
  Object.entries(grammarExtensions).flatMap(([grammar, extensions]) =>
    extensions.map((extension) => [extension, grammar] as const),
  ),
);
const modern = new Set(['go', 'rust', 'java', 'c_sharp', 'c', 'cpp', 'swift', 'ruby', 'php', 'dart']);
const require = createRequire(import.meta.url);
const grammars = new Map<string, Promise<Language>>();
let wasm: Promise<void> | undefined;

async function loadGrammar(grammar: string) {
  await (wasm ??= Parser.init());
  let language = grammars.get(grammar);
  if (!language) {
    const pkg = modern.has(grammar) ? '@repomix/tree-sitter-wasms' : 'tree-sitter-wasms';
    language = Language.load(require.resolve(pkg + '/out/tree-sitter-' + grammar + '.wasm'));
    grammars.set(grammar, language);
  }
  return language;
}

const registry: Record<string, Capability> = {
  addtool: 'tool',
  registertool: 'tool',
  createtool: 'tool',
  tool: 'tool',
  addresource: 'resource',
  registerresource: 'resource',
  resource: 'resource',
  addresourcetemplate: 'template',
  registerresourcetemplate: 'template',
  resourcetemplate: 'template',
  addprompt: 'prompt',
  registerprompt: 'prompt',
  prompt: 'prompt',
  mcpservertool: 'tool',
  mcptool: 'tool',
  toolname: 'tool',
  mcpresource: 'resource',
  mcpserverresource: 'resource',
  mcpprompt: 'prompt',
  mcpserverprompt: 'prompt',
};
const wire =
  /^(?:tools\/list|tools\/call|resources\/list|resources\/read|resources\/templates\/list|prompts\/list|prompts\/get|server\/discover)$/;
const sdk =
  /modelcontextprotocol|model.context.protocol|quarkiverse[./-]mcp|springframework\.ai[.\w]*\.mcp|\brmcp\b|\bMcpServer\b|\bMcpTool\b|MCP::(?:Server|Tool)|mcp[_-]server/i;
const callNode = /(?:call|invocation|annotation|attribute|macro|method_call)(?:_expression|_item)?$/;
const stringNode =
  /(?:^|_)(?:string(?:_literal)?|interpreted_string_literal|raw_string_literal|verbatim_string_literal|encapsed_string)$/;

function extension(path: string) {
  return path.split('.').at(-1)?.toLowerCase() ?? '';
}

export function mcpLanguageFile(path: string) {
  const ext = extension(path);
  return languages.has(ext) || protocolEvidenceExtensions.includes(ext);
}

function literal(text: string) {
  const trimmed = text.startsWith('@') ? text.slice(1) : text;
  if (trimmed[0] === '"') {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return undefined;
    }
  }
  if (trimmed[0] === "'" || trimmed.charCodeAt(0) === 96) return trimmed.slice(1, -1);
}

function sourceHint(path: string, service: string, method: string, line: number, adapter: string): Observation {
  return {
    id: mcpId(service, 'source-hint', method + ':' + path),
    kind: 'mcp',
    service,
    name: method,
    summary: '',
    origin: 'source',
    path,
    line,
    definition: { type: 'source-hint', method, adapter },
  };
}

function callName(node: Node) {
  const app =
    node.childForFieldName('function') ??
    node.childForFieldName('name') ??
    node.childForFieldName('method') ??
    (node.type === 'attribute' ? node.firstNamedChild : null);
  const raw = app?.text ?? node.text.split(/[(!]/, 1)[0];
  return (raw.match(/[A-Za-z_][\w]*\s*$/)?.[0] ?? '').trim().replaceAll('_', '').toLowerCase();
}

function declaration(node: Node) {
  for (let parent = node.parent, depth = 0; parent && depth < 6; parent = parent.parent, depth++) {
    if (/(?:method|function)_(?:declaration|definition|item)/.test(parent.type)) return parent;
    if (parent.type === 'attribute_item') return parent.nextNamedSibling ?? undefined;
  }
}

const scalarTypes = new Map([
  ['string', 'string'],
  ['str', 'string'],
  ['bool', 'boolean'],
  ['boolean', 'boolean'],
  ['int', 'integer'],
  ['int32', 'integer'],
  ['i32', 'integer'],
  ['long', 'integer'],
  ['double', 'number'],
  ['float', 'number'],
  ['float64', 'number'],
]);

function declaredSchema(node: Node | undefined) {
  const params = node?.childForFieldName('parameters');
  if (!params) return;
  const fields: [string, { type?: string }][] = [];
  const required: string[] = [];
  for (const param of params.namedChildren) {
    if (!param || !/parameter/.test(param.type)) continue;
    const name = param.childForFieldName('name') ?? param.childForFieldName('pattern');
    if (!name) continue;
    const type = scalarTypes.get(param.childForFieldName('type')?.text.toLowerCase() ?? '');
    fields.push([name.text, type ? { type } : {}]);
    if (!param.childForFieldName('value') && !param.childForFieldName('default')) required.push(name.text);
  }
  return { type: 'object', properties: Object.fromEntries(fields), required };
}

function callDefinition(node: Node, registered: Capability) {
  const argumentList =
    node.childForFieldName('arguments') ??
    node.childForFieldName('parameters') ??
    node.namedChildren.find((child) => child && /arguments?|token_tree/.test(child.type));
  const nodes = argumentList?.namedChildren.filter((child): child is Node => child !== null) ?? [];
  const strings: string[] = [];
  const fields = new Map<string, string>();
  const addField = (key: Node | null | undefined, value: Node | null | undefined) => {
    if (!key || !value) return;
    const scalar = stringNode.test(value.type) ? value : value.firstNamedChild;
    const resolved = scalar && stringNode.test(scalar.type) ? literal(scalar.text) : undefined;
    if (resolved !== undefined) fields.set((literal(key.text) ?? key.text).toLowerCase(), resolved);
  };
  for (const [index, child] of nodes.entries()) {
    if (stringNode.test(child.type)) {
      const value = literal(child.text);
      if (value) strings.push(value);
      if (argumentList?.type === 'token_tree' && index) addField(nodes[index - 1], child);
      continue;
    }
    if (
      [
        'keyword_argument',
        'assignment_expression',
        'attribute_argument',
        'element_value_pair',
        'pair',
        'argument',
      ].includes(child.type)
    ) {
      let parts = child.namedChildren.filter((item): item is Node => item !== null);
      if (parts.length === 1 && parts[0].type === 'assignment_expression')
        parts = parts[0].namedChildren.filter((item): item is Node => item !== null);
      if (parts.length === 1 && stringNode.test(parts[0].type)) {
        const value = literal(parts[0].text);
        if (value) strings.push(value);
      } else addField(parts[0], parts[1]);
      continue;
    }
    const shape = child.type === 'unary_expression' ? child.childForFieldName('operand') : child;
    if (shape?.type === 'composite_literal') {
      for (const field of shape.childForFieldName('body')?.namedChildren ?? []) {
        if (field?.type === 'keyed_element')
          addField(field.childForFieldName('key')?.firstNamedChild, field.childForFieldName('value'));
      }
    }
  }
  const isResource = registered === 'resource' || registered === 'template';
  const uri =
    fields.get('uri') ?? fields.get('uritemplate') ?? strings.find((value) => /^[a-z][\w+.-]*:/i.test(value));
  const type = isResource && uri?.includes('{') ? 'template' : registered;
  const owner = /annotation|attribute/.test(node.type) ? declaration(node) : undefined;
  return {
    type,
    name: fields.get('name') ?? strings[0] ?? owner?.childForFieldName('name')?.text,
    uri: isResource ? uri : undefined,
    description: fields.get('description'),
    inputSchema: type === 'tool' ? declaredSchema(owner) : undefined,
  };
}

export async function scanMcpLanguage(
  path: string,
  text: string,
  service: string,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
  rules: readonly { extension: string; method: string; capability: Capability }[] = [],
) {
  const ext = extension(path);
  const grammar = languages.get(ext);
  const explicit = new Map(
    rules
      .filter((rule) => rule.extension === ext)
      .map((rule) => [rule.method.replaceAll('_', '').toLowerCase(), rule.capability]),
  );
  const usesSdk = sdk.test(text);
  if (
    !usesSdk &&
    !explicit.size &&
    !/(?:tools|resources|prompts)\/(?:list|call|read|get|templates)|server\/discover/.test(text)
  )
    return [];
  const results = new Map<string, Observation>();
  const remember = (entry: Observation) => results.set(entry.id + ':' + entry.line, entry);
  if (!grammar) {
    const hints =
      /["']((?:tools\/(?:list|call)|resources\/(?:list|read|templates\/list)|prompts\/(?:list|get)|server\/discover))["']/g;
    for (const found of text.matchAll(hints)) {
      checkpoint?.();
      const at = text.slice(0, found.index).split('\n').length;
      remember(sourceHint(path, service, found[1], at, ext));
    }
    return [...results.values()];
  }
  const language = await loadGrammar(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  try {
    if (!tree) return [];
    const pending = [tree.rootNode];
    let visited = 0;
    while (pending.length) {
      if (++visited % 256 === 0) checkpoint?.();
      const node = pending.pop()!;
      const line = node.startPosition.row + 1;
      if (stringNode.test(node.type)) {
        const method = literal(node.text);
        if (method && wire.test(method)) remember(sourceHint(path, service, method, line, grammar));
        continue;
      }
      if (callNode.test(node.type)) {
        const method = callName(node);
        const registration =
          explicit.get(method) ?? (usesSdk && Object.hasOwn(registry, method) ? registry[method] : undefined);
        if (registration) {
          const { type, name, uri, description, inputSchema } = callDefinition(node, registration);
          if (name && (!(type === 'resource' || type === 'template') || uri)) {
            const definition = {
              adapter: 'tree-sitter:' + grammar,
              description,
              inputSchema,
              unresolved: ['runtimeSchema'],
              ...(uri ? { [type === 'template' ? 'uriTemplate' : 'uri']: uri } : {}),
            };
            remember(mcpObservation(path, service, type, name, definition, 'source', line));
          } else if (/^(?:add|register)/.test(method) || explicit.has(method)) {
            diagnostics.push({
              path,
              line,
              code: 'MCP_DYNAMIC_REGISTRATION',
              message: 'MCP registration name or URI depends on an unresolved expression',
            });
          }
        }
      }
      for (let index = node.namedChildCount - 1; index >= 0; index--) {
        const child = node.namedChild(index);
        if (child && !child.type.includes('comment')) pending.push(child);
      }
    }
  } finally {
    tree?.delete();
    parser.delete();
  }
  return [...results.values()];
}
