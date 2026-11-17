import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';

const echo = {
  name: 'echo',
  description: 'Returns the input',
  inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
};
const isolation = { name: 'isolation', inputSchema: { type: 'object' } };
const wait = { name: 'wait', inputSchema: { type: 'object' } };

function isolationEvidence() {
  let writable = true;
  try {
    writeFileSync('/workspace/runtime-write', 'unexpected');
  } catch {
    writable = false;
  }
  return {
    uid: process.getuid(),
    writable,
    environmentFile: existsSync('/workspace/.env'),
    dockerSocket: existsSync('/var/run/docker.sock'),
    interfaces: Object.keys(networkInterfaces()),
  };
}

async function handle({ jsonrpc = '2.0', id, method, params }) {
  if (id === undefined) return undefined;
  let result;
  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: params.protocolVersion,
        serverInfo: { name: 'IfaceForge test service', version: '1' },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      };
      break;
    case 'tools/list':
      result = params?.cursor ? { tools: [isolation, wait] } : { tools: [echo], nextCursor: 'page-2' };
      break;
    case 'resources/list':
      result = { resources: [{ name: 'task', uri: 'task://42', mimeType: 'text/plain' }] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [{ name: 'task-template', uriTemplate: 'task://{id}' }] };
      break;
    case 'prompts/list':
      result = { prompts: [{ name: 'task-summary', arguments: [{ name: 'title', required: true }] }] };
      break;
    case 'tools/call': {
      if (params.name === 'wait') return new Promise(() => {});
      const data = params.name === 'isolation' ? isolationEvidence() : params.arguments;
      result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      break;
    }
    case 'resources/read':
      result = { contents: [{ uri: params.uri, text: 'Read ' + params.uri }] };
      break;
    case 'prompts/get':
      result = { messages: [{ role: 'user', content: { type: 'text', text: params.arguments.title } }] };
      break;
    default:
      return { jsonrpc, id, error: { code: -32601, message: 'Unknown method' } };
  }
  return { jsonrpc, id, result };
}

if (process.argv.includes('--http')) {
  createServer(async (request, response) => {
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let input = '';
    for await (const chunk of request) input += chunk;
    const result = await handle(JSON.parse(input));
    if (result === undefined) response.writeHead(202).end();
    else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  }).listen(9898, '127.0.0.1');
} else {
  createInterface({ input: process.stdin }).on('line', (input) => {
    void handle(JSON.parse(input)).then((result) => {
      if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
    });
  });
}
