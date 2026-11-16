import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { cliGuide, guide } from '../app/guides.js';
import { version } from '../app/platform.js';
import { commandReference } from './commands.js';

export function serveGuides() {
  serveStdio(() => {
    const server = new McpServer({ name: 'ifaceforge-guides', version });
    const resources = [
      { name: 'developer-en', mimeType: 'text/markdown', text: guide('en').markdown },
      { name: 'developer-zh', mimeType: 'text/markdown', text: guide('zh-CN').markdown },
      {
        name: 'compatibility',
        mimeType: 'application/json',
        text: JSON.stringify(guide().compatibility, null, 2),
      },
      { name: 'rules', mimeType: 'application/json', text: JSON.stringify(guide().rules, null, 2) },
      { name: 'cli-agent', mimeType: 'text/markdown', text: cliGuide() },
      { name: 'cli-commands', mimeType: 'application/json', text: JSON.stringify(commandReference(), null, 2) },
    ];
    for (const { name, mimeType, text } of resources)
      server.registerResource(name, 'ifaceforge://guides/' + name, { mimeType }, (uri) => ({
        contents: [{ uri: uri.href, mimeType, text }],
      }));
    return server;
  });
}
