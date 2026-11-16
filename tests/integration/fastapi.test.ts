import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fixture, ifg } from '../support/fixture.js';

const python = process.env.IFG_TEST_PYTHON;
it.skipIf(!python)('executes a real FastAPI request and imports its generated OpenAPI', async () => {
  const { root, write, destroy } = fixture('fastapi');
  const child = spawn(
    python!,
    ['-m', 'uvicorn', 'main:app', '--app-dir', join(root, 'service'), '--host', '127.0.0.1', '--port', '0'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('FastAPI did not start: ' + output)), 10000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error('FastAPI exited: ' + code + '\n' + output));
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    const scan = await ifg(root, 'scan', '--require-complete');
    expect(scan.exit).toBe(0);
    const imported = await ifg(root, 'api', 'import', '--url', url + '/openapi.json', '--service', 'inventory');
    expect(imported.exit).toBe(0);
    const result = await ifg(
      root,
      'api',
      'send',
      '--file',
      write('request.json', { method: 'GET', url: url + '/inventory/12' }),
    );
    expect(result.exit).toBe(0);
    expect(result.result.data.steps[0].result.json).toEqual({ id: 12, count: 3 });
  } finally {
    child.kill();
    await closed;
    destroy();
  }
});
