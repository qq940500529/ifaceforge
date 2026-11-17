import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { commitFixture, fixture, ifg, ifgStdin } from '../support/fixture.js';
import type { NativePlan } from '../../src/protocols/mcp-native.js';
import type { Run } from '../../src/app/runs.js';

const server = `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio:'ignore', windowsHide:true});
const wire = createInterface({ input: process.stdin });
wire.on('line', line => {
  const { method, id, params } = JSON.parse(line);
  if (method === 'server/discover') process.exit(0);
  if (id === undefined) return;
  const result = {
    initialize: { protocolVersion: params?.protocolVersion, serverInfo:{name:'native-' + process.pid + '-' + worker.pid,version:'1'}, capabilities:{tools:{},resources:{},prompts:{}}},
    'tools/list': {tools:[{name:'echo',inputSchema:{type:'object'}}]},
    'tools/call': { content:[{type:'text', text: String(params?.arguments?.value)}] },
    'resources/list': {resources:[{name:'note',uri:'demo://note'}]},
    'resources/templates/list': {resourceTemplates:[{name:'note',uriTemplate:'demo://note/{id}'}]},
    'prompts/list': {prompts:[]},
  }[method];
  const message = result ? { result } : { error: { code: -32601, message: 'Unsupported method' }};
  console.log(JSON.stringify({jsonrpc:'2.0',id,...message}));
});
wire.on('close', () => process.exit(0));
`;

it('reviews native launch, retries a legacy stdio server, verifies cleanup and binds test arguments', async () => {
  const sample = fixture('mcp-isolation');
  try {
    sample.write('.mcp.json', { mcpServers: { native: { command: process.execPath, args: ['server.mjs'] } } });
    const entry = join(sample.root, 'server.mjs');
    writeFileSync(entry, server);
    commitFixture(sample.root);
    expect((await ifg(sample.root, 'scan')).exit).toBe(0);
    const { items } = (await ifg(sample.root, 'mcp', 'targets')).result.data;
    const args = [
      '--service',
      items.find((item: { name: string }) => item.name === 'native').id,
      '--mode',
      'native',
    ];
    const plan = async () => (await ifg<NativePlan>(sample.root, 'mcp', 'plan', ...args)).result.data;
    const old = await plan();
    expect(old).toMatchObject({ mode: 'native', source: 'worktree', issues: [] });
    writeFileSync(entry, server + '\n// changes the approved worktree\n');
    const rejected = await ifg(sample.root, 'mcp', 'probe', ...args, '--approve', old.fingerprint);
    expect(rejected.result.error?.code).toBe('MCP_SANDBOX_APPROVAL');
    const ready = await plan();
    const { result } = await ifg<Run>(sample.root, 'mcp', 'probe', ...args, '--approve', ready.fingerprint);
    expect(result.data).toMatchObject({
      status: 'passed',
      sandboxes: [{ mode: 'native', cleanup: { state: 'removed' } }],
      steps: [
        {
          result: {
            groups: [
              { type: 'tool', state: 'found' },
              { type: 'resource', state: 'found' },
              { type: 'template', state: 'found' },
              { type: 'prompt', state: 'empty' },
            ],
          },
        },
      ],
    });
    const found = result.data.steps[0].result as { server: { name: string } };
    const pids = found.server.name.split('-').slice(1).map(Number);
    await vi.waitFor(() => {
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    });
    expect((await ifg<Run>(sample.root, 'mcp', 'inventory', ...args)).result.data.id).toBe(result.data.id);
    const file = sample.write('batch.json', {
      schemaVersion: 1,
      steps: [{ id: 'call', type: 'call', tool: 'echo', arguments: { value: 'hello' } }],
    });
    const testPlan = await ifg<NativePlan>(
      sample.root,
      'mcp',
      'plan',
      ...args,
      '--file',
      file,
      '--protocol',
      '2024-10-07',
    );
    const wrong = ifgStdin(
      sample.root,
      { schemaVersion: 1, steps: [{ id: 'call', type: 'call', tool: 'echo', arguments: { value: 'changed' } }] },
      'mcp',
      'batch',
      ...args,
      '--file',
      '-',
      '--protocol',
      '2024-10-07',
      '--approve',
      testPlan.result.data.fingerprint,
    );
    expect(wrong.result.error?.code).toBe('MCP_SANDBOX_APPROVAL');
    const tested = await ifg<Run>(
      sample.root,
      'mcp',
      'batch',
      ...args,
      '--file',
      file,
      '--protocol',
      '2024-10-07',
      '--approve',
      testPlan.result.data.fingerprint,
    );
    expect(tested.result.data).toMatchObject({
      status: 'passed',
      steps: [{ result: { content: [{ text: 'hello' }] } }],
    });
  } finally {
    sample.destroy();
  }
}, 100_000);

it('uses an approved native loopback endpoint and closes the HTTP process', async () => {
  const sample = fixture('mcp-isolation');
  const reservation = createServer().listen(0, '127.0.0.1');
  try {
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw Error('Expected a TCP address');
    const origin = 'http://127.0.0.1:' + address.port;
    sample.write('.mcp.json', {
      mcpServers: {
        http: {
          command: process.execPath,
          args: ['http.mjs'],
          url: origin + '/mcp',
          protocolVersion: '2025-11-25',
        },
      },
    });
    writeFileSync(
      join(sample.root, 'http.mjs'),
      `
import { createServer } from 'node:http';
createServer(async (req,res)=>{
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body=''; for await (const part of req) body+=part;
  const { id, method, params }=JSON.parse(body);
  if (id === undefined) { res.writeHead(202).end(); return; }
  const result = method === 'initialize'
    ? { protocolVersion:params.protocolVersion, serverInfo:{ name:'native http', version:'1' }, capabilities:{tools:{}} }
    : { tools:[{ name:'echo', inputSchema:{ type:'object' } }] };
  res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id,result}));
}).listen(${address.port}, '127.0.0.1');
`,
    );
    commitFixture(sample.root);
    expect((await ifg(sample.root, 'scan')).exit).toBe(0);
    const { items } = (await ifg(sample.root, 'mcp', 'targets')).result.data;
    const args = ['--service', items[0].id, '--mode', 'native', '--ref', 'HEAD'];
    const plan = (await ifg<NativePlan>(sample.root, 'mcp', 'plan', ...args)).result.data;
    expect(plan).toMatchObject({ source: 'git', transport: 'streamableHttp', url: origin + '/mcp', issues: [] });
    const conflict = await ifg<Run>(sample.root, 'mcp', 'probe', ...args, '--approve', plan.fingerprint);
    const error = conflict.result.data.steps[0].error;
    expect(error?.details, JSON.stringify(error)).toMatchObject({ cause: { code: 'MCP_PORT_IN_USE' } });
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const { result } = await ifg<Run>(sample.root, 'mcp', 'probe', ...args, '--approve', plan.fingerprint);
    expect(result.data).toMatchObject({
      status: 'passed',
      sandboxes: [{ mode: 'native', cleanup: { state: 'removed' } }],
      steps: [
        {
          result: {
            protocolVersion: '2025-11-25',
            groups: expect.arrayContaining([{ type: 'tool', state: 'found', items: expect.any(Array) }]),
          },
        },
      ],
    });
    reservation.listen(address.port, '127.0.0.1');
    await once(reservation, 'listening');
  } finally {
    if (reservation.listening) await new Promise<void>((resolve) => reservation.close(() => resolve()));
    sample.destroy();
  }
}, 90_000);
