import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseOpenApi } from '../../src/scanner/openapi.js';
import { scanMcpSource } from '../../src/scanner/mcp-discovery.js';
import type { Diagnostic } from '../../src/scanner/model.js';
import { address, close, fixture, ifg, repositoryRoot } from '../support/fixture.js';

it('reads all supported Swagger and OpenAPI families and preserves unknown definitions', () => {
  for (const spec of ['1.0', '1.1', '1.2', '2.0', '3.0.4', '3.1.2', '3.2.1']) {
    const paths = { '/hello': { get: { responses: { 200: { description: 'OK', schema: { type: 'string' } } } } } };
    const document = spec.startsWith('1.')
      ? {
          swaggerVersion: spec,
          apiVersion: 'stable',
          apis: [{ path: '/hello', operations: [{ method: 'GET', type: 'string' }] }],
        }
      : spec === '2.0'
        ? { swagger: spec, paths }
        : { openapi: spec, paths };
    const diagnostics: Diagnostic[] = [];
    expect(parseOpenApi(JSON.stringify(document), { service: 'test' }, diagnostics)).toMatchObject([
      { name: 'GET /hello', definition: { specVersion: spec } },
    ]);
    expect(diagnostics).toEqual([]);
  }
  const diagnostics: Diagnostic[] = [];
  const paths = new Map([
    [
      'pet.json',
      JSON.stringify({
        swaggerVersion: '1.2',
        apis: [{ path: '/pets', operations: [{ method: 'GET', type: 'Pet' }] }],
        models: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
      }),
    ],
  ]);
  const root = { swaggerVersion: '1.2', apis: [{ path: '/pet' }] };
  expect(
    parseOpenApi(
      JSON.stringify(root),
      {
        service: 'test',
        path: 'swagger.json',
        read: (name) =>
          paths.get(name) ??
          (() => {
            throw Error(name);
          })(),
      },
      diagnostics,
    ),
  ).toMatchObject([
    {
      path: 'pet.json',
      name: 'GET /pets',
      definition: {
        operation: { responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } } },
      },
    },
  ]);
  expect(diagnostics).toEqual([]);
  expect(parseOpenApi('openapi: 8.0.0\npaths: {}', { service: 'test' }, diagnostics)[0].definition.raw).toEqual({
    openapi: '8.0.0',
    paths: {},
  });
  expect(diagnostics[0].code).toBe('API_SPEC_VERSION');
});

it('inspects literal MCP registrations in TypeScript without importing source', () => {
  const diagnostics: Diagnostic[] = [];
  const source = [
    'const input = z.object({id:z.string(), limit:z.number().int().optional()});',
    'const tool = "find";',
    'server.registerTool(\n tool, {description: "Find a record", inputSchema: input}, handler);',
    'server.registerResource("fixed", "test://1", {});',
    'server.registerResource("variable", new ResourceTemplate("test://{id}", {}), {});',
    'server.registerPrompt("explain", {argsSchema:z.object({name:z.string()})}, handler);',
    'server.registerTool(process.env.TOOL_NAME, dynamicConfig, handler);',
    'throw new Error("must never execute");',
  ].join('\n');
  const scan = scanMcpSource('test.ts', source, 'test', diagnostics);
  expect(scan).toMatchObject([
    {
      name: 'find',
      definition: { type: 'tool', inputSchema: { required: ['id'], properties: { limit: { type: 'integer' } } } },
    },
    { name: 'fixed', definition: { type: 'resource', uri: 'test://1' } },
    { name: 'variable', definition: { type: 'template', uriTemplate: 'test://{id}' } },
    { name: 'explain', definition: { type: 'prompt', argsSchema: { required: ['name'] } } },
  ]);
  expect(diagnostics.map((issue) => issue.code)).toContain('MCP_DYNAMIC_REGISTRATION');
});

type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown> };
const responses: Record<string, unknown> = {
  'tools/list': { tools: [{ name: 'sample', inputSchema: { type: 'object' } }] },
  'resources/list': { resources: [{ name: 'sample', uri: 'sample://1' }] },
  'resources/templates/list': { resourceTemplates: [{ name: 'sample', uriTemplate: 'sample://{id}' }] },
  'prompts/list': { prompts: [{ name: 'sample' }] },
  'tools/call': { content: [{ type: 'text', text: 'tool' }] },
  'prompts/get': { messages: [{ role: 'user', content: { type: 'text', text: 'prompt' } }] },
};
function protocolReply(request: Rpc, revision: string) {
  if (request.id === undefined) return null;
  const id = request.id;
  if (request.method === 'initialize' && request.params?.protocolVersion === revision)
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: revision,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'Revision test server', version: '1.0.0' },
      },
    };
  if (request.method === 'resources/read')
    return { jsonrpc: '2.0', id, result: { contents: [{ uri: request.params?.uri, text: 'resource' }] } };
  if (!request.method || !Object.hasOwn(responses, request.method))
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported request' } };
  return { jsonrpc: '2.0', id, result: responses[request.method] };
}
async function jsonBody(request: IncomingMessage): Promise<Rpc> {
  const parts: Buffer[] = [];
  for await (const chunk of request) parts.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(parts).toString());
}

for (const [protocolVersion, transport] of [
  ['2024-11-05', 'sse'],
  ['2025-03-26', 'streamableHttp'],
  ['2025-06-18', 'streamableHttp'],
  ['2025-11-25', 'streamableHttp'],
] as const)
  it(
    'discovers and calls each capability on ' + protocolVersion + ' ' + transport,
    async () => {
      const project = fixture();
      let stream: ServerResponse | undefined;
      const server = createServer(
        (req, res) =>
          void (async () => {
            if (transport === 'sse' && req.method === 'GET') {
              stream = res;
              res.writeHead(200, { 'Content-Type': 'text/event-stream' });
              res.write('event: endpoint\ndata: /messages\n\n');
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(405).end();
              return;
            }
            const reply = protocolReply(await jsonBody(req), protocolVersion);
            if (transport === 'sse' || !reply) {
              res.writeHead(202).end();
              if (reply) stream?.write('event: message\ndata: ' + JSON.stringify(reply) + '\n\n');
            } else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
          })().catch(() => res.writeHead(500).end()),
      );
      try {
        const url = (await address(server)) + (transport === 'sse' ? '/sse' : '/mcp');
        const profile = project.write('profile.json', {
          schemaVersion: 1,
          id: 'revision',
          name: 'Revision',
          mcp: { transport, url, protocolVersion },
        });
        expect((await ifg(project.root, 'profile', 'put', '--file', profile)).exit).toBe(0);
        const file = project.write('sequence.json', {
          schemaVersion: 1,
          steps: [
            { id: 'discover', type: 'discover' },
            { id: 'tool', type: 'call', tool: 'sample', arguments: {} },
            { id: 'read', type: 'read', uri: 'sample://1' },
            { id: 'template', type: 'template', uriTemplate: 'sample://{id}', arguments: { id: '2' } },
            { id: 'prompt', type: 'prompt', name: 'sample', arguments: {} },
          ],
        });
        const run = await ifg(project.root, 'mcp', 'batch', '--profile', 'revision', '--file', file);
        expect(run.result.error).toBeNull();
        expect(run.result.data.steps[0].result.protocolVersion).toBe(protocolVersion);
        expect(run.result.data.steps[0].result.groups.map((group: { state: string }) => group.state)).toEqual([
          'found',
          'found',
          'found',
          'found',
        ]);
        expect(run.result.data.steps[3].result.contents[0].uri).toBe('sample://2');
      } finally {
        stream?.end();
        await close(server);
        project.destroy();
      }
    },
    30000,
  );

it('serves the same developer guide as Markdown and a read-only MCP resource', async () => {
  const project = fixture();
  try {
    const guide = await ifg(project.root, 'guide', 'show', '--lang', 'en');
    expect(guide.result.data.markdown).toContain('## Skills');
    const profile = project.write('guides-profile.json', {
      schemaVersion: 1,
      id: 'guides',
      name: 'Guides',
      mcp: {
        transport: 'stdio',
        command: process.execPath,
        args: [join(repositoryRoot, 'dist', 'cli', 'main.js'), 'guide', 'serve'],
        protocolVersion: '2026-07-28',
      },
    });
    expect((await ifg(project.root, 'profile', 'put', '--file', profile)).exit).toBe(0);
    const resource = await ifg(
      project.root,
      'mcp',
      'read',
      'ifaceforge://guides/developer-en',
      '--profile',
      'guides',
    );
    expect(resource.result.error).toBeNull();
    expect(resource.result.data.steps[0].result.contents[0].text).toBe(guide.result.data.markdown);
  } finally {
    project.destroy();
  }
}, 30000);
