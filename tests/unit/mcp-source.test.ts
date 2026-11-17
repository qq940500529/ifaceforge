import { describe, expect, it } from 'vitest';
import { mcpConfigDocument, parseMcpConfig } from '../../src/scanner/adapters.js';
import { scanMcpLanguage } from '../../src/scanner/mcp-languages.js';
import { scanPythonMcp } from '../../src/scanner/mcp-python.js';

describe('MCP source evidence', () => {
  it('extracts Python decorator names, types, defaults and resource URI composition', () => {
    const source = `from mcp.server.fastmcp import FastMCP as Application
BASE = "sample://"
URI = BASE + "items/{item}"
def register(service: Application):
    @service.tool(name="repeat")
    def repeat(message: str, count: int = 2, enabled: bool = True) -> dict:
        """Repeat a message."""
        pass
    @service.resource(URI)
    def read(item: str):
        pass
    @service.prompt()
    def greeting(name: str):
        pass
    @service.resource(resolve_at_runtime())
    def unresolved():
        pass
`;
    const diagnostics: Parameters<typeof scanPythonMcp>[3] = [];
    const items = scanPythonMcp('server.py', source, 'demo', diagnostics);
    expect(items.map((item) => [item.name, item.definition.type])).toEqual([
      ['repeat', 'tool'],
      ['read', 'template'],
      ['greeting', 'prompt'],
    ]);
    expect(items[0]).toMatchObject({
      line: 5,
      summary: 'Repeat a message.',
      definition: {
        inputSchema: {
          properties: {
            message: { type: 'string' },
            count: { type: 'integer', default: 2 },
            enabled: { type: 'boolean', default: true },
          },
          required: ['message'],
        },
        unresolved: ['runtimeSchema'],
      },
    });
    expect(items[1].definition.uriTemplate).toBe('sample://items/{item}');
    expect(diagnostics).toMatchObject([{ line: 15, code: 'MCP_DYNAMIC_REGISTRATION' }]);
    expect(scanPythonMcp('routes.py', 'class A:\n @ordinary.tool()\n def unrelated(): pass', 'demo', [])).toEqual(
      [],
    );
  });

  it.each([
    ['go', 'package x\nimport "github.com/modelcontextprotocol/go-sdk/mcp"\nfunc x(){server.AddTool("echo", fn)}'],
    [
      'go',
      'package x\nimport "github.com/modelcontextprotocol/go-sdk/mcp"\nfunc x(){mcp.AddTool(service, &mcp.Tool{Name:"echo", Description:"Repeat"}, fn)}',
    ],
    ['rb', 'require "mcp/server"\nserver = MCP::Server.new\nserver.register_tool("echo", fn)'],
    ['rb', 'class Echo < MCP::Tool\n tool_name "echo"\nend'],
    ['java', 'import io.modelcontextprotocol.server.McpServer; class X { void m(){server.addTool("echo", fn);}}'],
    [
      'java',
      'import org.springframework.ai.mcp.*; class X { @McpTool(name="echo") String run(String value){return value;} }',
    ],
    ['cs', 'using ModelContextProtocol.Server; class X { void M(){server.AddTool("echo", fn);}}'],
    [
      'cs',
      'using ModelContextProtocol.Server; class X { [McpServerTool(Name = "echo")] string Run(string value)=>value; }',
    ],
    ['rs', 'use rmcp::tool; #[tool(name = "echo")] fn run() {}'],
    ['php', '<?php #[McpTool(name: "echo")] function run() {}'],
  ])('locates a literal registration in %s', async (extension, source) => {
    expect(await scanMcpLanguage('server.' + extension, source, 'demo', [])).toMatchObject([
      { name: 'echo', definition: { type: 'tool' } },
    ]);
  });

  it.each([
    'go',
    'rs',
    'java',
    'kt',
    'cs',
    'c',
    'cc',
    'swift',
    'rb',
    'php',
    'scala',
    'dart',
    'sh',
    'lua',
    'ex',
    'ml',
    'fs',
    'ps1',
    'cmd',
    'r',
    'jl',
    'erl',
    'hs',
    'pl',
  ])('locates protocol evidence in %s', async (extension) => {
    const samples: Record<string, string> = {
      go: 'package x\nvar operation = "tools/list"',
      rs: 'const OP: &str = "tools/list";',
      java: 'class X {String op = "tools/list";}',
      kt: 'val operation = "tools/list"',
      cs: 'class X { string op = "tools/list"; }',
      c: 'char *op = "tools/list";',
      cc: 'const char *op = "tools/list";',
      swift: 'let op = "tools/list"',
      rb: 'op = "tools/list"',
      php: '<?php $op = "tools/list";',
      scala: 'val op = "tools/list"',
      dart: 'const op = "tools/list";',
      sh: 'op="tools/list"',
      lua: 'local op = "tools/list"',
      ex: 'op = "tools/list"',
      ml: 'let op = "tools/list"',
    };
    expect(
      await scanMcpLanguage('sample.' + extension, samples[extension] ?? 'op = "tools/list"', 'demo', []),
    ).toMatchObject([{ name: 'tools/list', definition: { type: 'source-hint' } }]);
  });

  it('reads JSONC, YAML and TOML service configurations', () => {
    for (const [path, source] of [
      ['.vscode/mcp.json', '{ // local\n "servers": {"sample":{"command":"python",}},}'],
      ['.mcp.yml', 'mcpServers:\n  sample:\n    command: python\n'],
      ['.codex/config.toml', '[mcp_servers.sample]\ncommand = "python"'],
    ]) {
      expect(parseMcpConfig(path, mcpConfigDocument(path, source), [])).toMatchObject([
        { name: 'sample', path, definition: { transport: 'stdio' } },
      ]);
    }
  });
});
