import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  McpServer,
  ResourceTemplate,
  createMcpHandler,
  legacyStatelessFallback,
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

export function makeMcp() {
  const server = new McpServer({ name: 'synthetic-tasks', version: '1.0.0' });
  let lastValue = '';
  const reply = (value) => ({
    structuredContent: { value, pid: process.pid },
    content: [{ type: 'text', text: value }],
  });
  server.registerTool('echo', { inputSchema: z.object({ value: z.string() }) }, ({ value }) => reply(value));
  server.registerTool('remember', { inputSchema: z.object({ value: z.string() }) }, ({ value }) => {
    lastValue = value;
    return reply(value);
  });
  server.registerTool('recall', {}, () => reply(lastValue));
  server.registerTool('reject', {}, () => ({
    isError: true,
    content: [{ type: 'text', text: 'Synthetic error' }],
  }));
  server.registerTool('slow', {}, async (ctx) => {
    await delay(30000, undefined, { signal: ctx.signal });
    return reply('finished');
  });
  server.registerResource('task', 'task://42', { mimeType: 'text/plain' }, (uri) => ({
    contents: [{ uri: uri.href, text: 'Sample task 42' }],
  }));
  server.registerResource(
    'task-template',
    new ResourceTemplate('task://{id}', { list: undefined }),
    {},
    (uri) => ({ contents: [{ uri: uri.href, text: 'Synthetic task' }] }),
  );
  server.registerPrompt('task-summary', { argsSchema: z.object({ title: z.string() }) }, ({ title }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Summarize ' + title } }],
  }));
  server.server.setRequestHandler('tools/list', async ({ params }) => {
    const emptyInput = { type: 'object' };
    return params?.cursor
      ? {
          tools: [
            { name: 'recall', inputSchema: emptyInput },
            { name: 'reject', inputSchema: emptyInput },
            { name: 'slow', inputSchema: emptyInput },
          ],
        }
      : {
          tools: [
            {
              name: 'echo',
              inputSchema: { ...emptyInput, properties: { value: { type: 'string' } }, required: ['value'] },
            },
            {
              name: 'remember',
              inputSchema: { ...emptyInput, properties: { value: { type: 'string' } }, required: ['value'] },
            },
          ],
          nextCursor: 'page-2',
        };
  });
  return server;
}

class LegacyStdio extends StdioServerTransport {
  start() {
    const forward = this.onmessage;
    this.onmessage = (message) => {
      if (message.method === 'server/discover') {
        void this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      } else forward?.(message);
    };
    return super.start();
  }
}

export function mcpHttp(legacy = false) {
  const modern = createMcpHandler(makeMcp);
  const legacyFetch = legacyStatelessFallback(makeMcp);
  const legacyHandler = {
    fetch: async (request, options) => {
      if (request.method === 'POST') {
        const body = options?.parsedBody ?? (await request.clone().json());
        if (body.method === 'server/discover')
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'Method not found' },
          });
      }
      return legacyFetch(request, options);
    },
  };
  const dispatch = toNodeHandler(legacy ? legacyHandler : modern);
  return createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    void dispatch(req, res);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [transport = 'stdio', era = 'modern', port = '4301'] = process.argv.slice(2);
  if (transport === 'stdio') {
    if (era === 'legacy') await makeMcp().connect(new LegacyStdio());
    else serveStdio(makeMcp);
  } else {
    const server = mcpHttp(era === 'legacy');
    server.listen(Number(port), '127.0.0.1', () =>
      console.log('http://127.0.0.1:' + server.address().port + '/mcp'),
    );
  }
}
