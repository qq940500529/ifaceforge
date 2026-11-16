import { expect, it } from 'vitest';
import { Bindings } from '../../src/protocols/variables.js';
import { curl, prepareHttp, type HttpResult } from '../../src/protocols/http.js';
import { httpChecks } from '../../src/app/api.js';
import { mcpError, paginate } from '../../src/protocols/mcp.js';

it('encodes path values and repeats enabled query keys, and removes credentials from cURL', () => {
  const profile = {
    schemaVersion: 1 as const,
    id: 'demo',
    name: 'Demo',
    http: { baseUrl: 'http://localhost/base' },
  };
  const template = {
    method: 'GET',
    path: '/items/{{id}}',
    query: [
      { name: 'key', value: 'one' },
      { name: 'key', value: 'two' },
      { name: 'skip', value: '1', enabled: false },
    ],
    headers: [{ name: 'Authorization', value: 'Bearer {{token}}' }],
    inputs: { id: 'a/b 汉', token: 'secret-value' },
  };
  const bindings = new Bindings(profile, template.inputs);
  const request = prepareHttp(template, profile, bindings);
  expect(request.url.href).toBe('http://localhost/base/items/a%2Fb%20%E6%B1%89?key=one&key=two');
  expect(bindings.redact('echo secret-value')).toBe('echo [REDACTED]');
  expect(curl(template, profile)).not.toMatch(/Authorization|secret-value/);
});

it('matches range responses and rejects truncated schema input', () => {
  const response: HttpResult = {
    status: 404,
    bodyType: 'json',
    durationMs: 1,
    headers: [],
    mediaType: 'application/json',
    text: '{"reason":"missing"}',
    json: { reason: 'missing' },
    malformedJson: false,
    truncated: false,
    target: 'http://localhost/',
  };
  const contract = {
    openapi: '3.1.0',
    operation: {
      responses: {
        '4XX': {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } },
            },
          },
        },
      },
    },
  };
  expect(
    httpChecks([{ type: 'status', equals: 404 }, { type: 'responseSchema' }], response, contract).every(
      (check) => check.passed,
    ),
  ).toBe(true);
  expect(httpChecks([{ type: 'responseSchema' }], { ...response, truncated: true }, contract)[0].passed).toBe(
    false,
  );
});

it('retains MCP pages on a repeated cursor and treats a lost sent call as unknown', async () => {
  await expect(
    paginate(async (cursor) => ({ items: [cursor ?? 'first'], nextCursor: 'next' })),
  ).rejects.toMatchObject({
    code: 'MCP_CURSOR',
    details: { items: ['first', 'next'] },
  });
  expect(mcpError(Error('Connection closed'), true, true)).toMatchObject({
    code: 'MCP_RESULT_UNKNOWN',
    exitCode: 4,
  });
  expect(mcpError(Error('Connection closed'), false, true)).toMatchObject({
    code: 'MCP_DISCONNECTED',
    exitCode: 3,
  });
});
