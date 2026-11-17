import { expect, it } from 'vitest';
import { compare } from '../../src/app/api.js';
import { bindMcpAction, resolveMcpTarget } from '../../src/protocols/mcp.js';
import { prepareSandbox, sandboxLaunchIssues } from '../../src/protocols/mcp-sandbox.js';
import { Bindings, type McpProfile } from '../../src/protocols/variables.js';
import { resourceTemplate } from '../../src/protocols/mcp-template.js';
import { validate } from '../../src/schemas/index.js';

it('checks Windows launchers, missing files and committed plugin-relative directories', () => {
  const paths = ['integrations/codex/.mcp.json', 'integrations/codex/scripts/launch_mcp.ps1', 'server.mjs'];
  const source = { commit: 'test', paths, has: (file: string) => paths.includes(file), read: () => '' };
  expect(
    sandboxLaunchIssues('powershell.exe', ['-File', './scripts/launch_mcp.ps1'], '.', source, paths[0]),
  ).toEqual({
    cwd: 'integrations/codex',
    directory: '/workspace/integrations/codex',
    issues: [{ code: 'windows-launcher', path: 'powershell.exe' }],
  });
  expect(sandboxLaunchIssues('node', ['server.mjs'], '.', source, paths[0]).issues).toEqual([]);
  expect(sandboxLaunchIssues('node', ['server.mjs'], 'missing', source).issues.map((item) => item.code)).toEqual([
    'missing-directory',
    'missing-entry',
  ]);
});

it.each<{ mcp: McpProfile; reason: RegExp }>([
  { mcp: { transport: 'streamableHttp', url: 'https://example.test/mcp' }, reason: /launch command/ },
  { mcp: { transport: 'streamableHttp', url: 'http://example.test/mcp', command: 'node' }, reason: /loopback/ },
  { mcp: { transport: 'stdio', command: 'node', cwd: '../outside' }, reason: /inside the Git snapshot/ },
])('rejects unsafe launch settings before contacting Docker', async ({ mcp, reason }) => {
  const project = { root: '', config: '', data: '', database: '' };
  await expect(prepareSandbox(project, { schemaVersion: 1, id: 'test', name: 'Test', mcp })).rejects.toMatchObject(
    {
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(reason),
    },
  );
});

it('expands an MCP URI template with encoded path data and optional query variables', () => {
  const uriTemplate = 'task://server/{id}{?filter}';
  expect(resourceTemplate(uriTemplate).variables).toEqual([
    { name: 'id', required: true },
    { name: 'filter', required: false },
  ]);
  expect(resolveMcpTarget({ type: 'template', uriTemplate, arguments: { id: 'a/b 中文' } })).toEqual({
    type: 'read',
    uri: 'task://server/a%2Fb%20%E4%B8%AD%E6%96%87',
  });
  expect(resourceTemplate(uriTemplate).expand({ id: '42', filter: 'mine today' })).toBe(
    'task://server/42?filter=mine%20today',
  );
  expect(() => resolveMcpTarget({ type: 'template', uriTemplate, arguments: {} })).toThrow(
    /Missing URI template variable/,
  );
});

it('binds the value of an MCP argument named env as a named parameter', () => {
  const bindings = new Bindings(undefined, { environment: 'sandbox' });
  expect(bindMcpAction({ type: 'call', tool: 'demo', arguments: { env: '{{environment}}' } }, bindings)).toEqual({
    type: 'call',
    tool: 'demo',
    arguments: { env: 'sandbox' },
  });
});

it('compares text at the selected MCP result path and reports actual and expected values', () => {
  const assertion = { type: 'textContains' as const, pointer: '/messages/0/content/text', text: 'task 42' };
  expect(compare(assertion, { messages: [{ content: { text: 'Summarize task 42' } }] })).toMatchObject({
    passed: true,
    actual: 'Summarize task 42',
    expected: 'task 42',
  });
  expect(compare(assertion, { messages: [{ content: { text: 42 } }] })?.passed).toBe(false);
  expect(compare(assertion, {})?.passed).toBe(false);
});

it('validates resource, template and prompt cases alongside existing tool cases', () => {
  const sample = { schemaVersion: 1, kind: 'mcp', id: 'sample', name: 'Sample', profile: 'demo' };
  for (const request of [
    { tool: 'echo', arguments: { value: 'hello' } },
    { type: 'call', tool: 'echo', arguments: { value: 'hello' } },
    { type: 'read', uri: 'task://42' },
    { type: 'template', uriTemplate: 'task://{id}', arguments: { id: '42' } },
    { type: 'prompt', name: 'task-summary', arguments: { title: { env: 'TASK_TITLE' } } },
  ]) {
    expect(validate('case', { ...sample, request })).toMatchObject({ request });
  }
  expect(() =>
    validate('case', { ...sample, request: { type: 'prompt', name: 'task', arguments: { title: [] } } }),
  ).toThrow();
});
