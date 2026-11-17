import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { commitFixture, fixture, ifg } from '../support/fixture.js';

it('scans independent Python and Go services and keeps same-named capabilities distinct', async () => {
  const sample = fixture('mcp-isolation');
  const write = (path: string, text: string) => {
    const file = join(sample.root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  try {
    sample.write('.ifaceforge.json', {
      schemaVersion: 1,
      sources: [
        { id: 'stock', roots: ['inventory'], adapters: ['mcp-source'] },
        { id: 'schedule', roots: ['planning'], adapters: ['mcp-source'] },
      ],
    });
    write('inventory/.mcp.yaml', 'mcpServers:\n  stock:\n    command: python\n');
    write(
      'inventory/providers/find_entries.py',
      `from fastmcp import FastMCP as Gateway
portal = Gateway("stock")
@portal.tool(name="lookup")
def locate(sku: str):
    """Find a stock entry."""
    pass
`,
    );
    write('planning/mcp.toml', '[mcp_servers.schedule]\ncommand = "planner"\n');
    write(
      'planning/handlers.go',
      `package planning
import "github.com/modelcontextprotocol/go-sdk/mcp"
func register(service *mcp.Server) {
    mcp.AddTool(service, &mcp.Tool{Name: "lookup", Description: "Find a schedule entry."}, lookup)
}
`,
    );
    commitFixture(sample.root);
    expect((await ifg(sample.root, 'scan')).exit).toBe(0);
    const targets = await ifg(sample.root, 'mcp', 'targets');
    expect(targets.result.data.items).toHaveLength(2);
    for (const item of targets.result.data.items) {
      const result = await ifg(sample.root, 'mcp', 'inventory', '--origin', 'source', '--service', item.id);
      const stock = item.name === 'stock';
      expect(result.result.data.items).toMatchObject([
        {
          name: 'lookup',
          service: item.name,
          path: stock ? 'inventory/providers/find_entries.py' : 'planning/handlers.go',
          summary: stock ? 'Find a stock entry.' : 'Find a schedule entry.',
        },
      ]);
    }
  } finally {
    sample.destroy();
  }
}, 30_000);
