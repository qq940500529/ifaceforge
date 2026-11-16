import { Ajv } from 'ajv';
import { invalid } from '../app/errors.js';
import { mcpVersions } from '../protocols/mcp-versions.js';

const text = { type: 'string', minLength: 1 };
const id = { ...text, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$' };
const locale = { enum: ['en', 'zh-CN'] };
const version = { const: 1 };

function object(properties: Record<string, object>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function array(items: object) {
  return { type: 'array', items };
}

function map(values: object) {
  return { type: 'object', additionalProperties: values };
}

function document(properties: Record<string, object>, required: string[]) {
  return object({ schemaVersion: version, ...properties }, ['schemaVersion', ...required]);
}

const scalar = { type: ['string', 'number', 'boolean', 'null'] };
const env = object({ env: { ...text, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } }, ['env']);
const secretHeader =
  '^(authorization|proxy-authorization|cookie|set-cookie|.*[-_](token|secret|api[-_]key|apikey)|x-api-key|apikey|api-key)$';
const pair = {
  ...object({ name: text, value: { anyOf: [scalar, env] }, enabled: { type: 'boolean' } }, ['name', 'value']),
  then: { properties: { value: { anyOf: [env, { type: 'string', pattern: '\\{\\{[\\w.-]+\\}\\}' }] } } },
};
// JSON Schema regexes have no inline flag support.
const headers = array({
  ...pair,
  if: {
    properties: {
      name: { pattern: secretHeader.replace(/[a-z]/g, (letter) => '[' + letter + letter.toUpperCase() + ']') },
    },
  },
});
const scan = {
  sources: array(
    object(
      {
        id,
        roots: array(text),
        adapters: array({ enum: ['express', 'fastapi', 'mcp-typescript'] }),
        openapi: array(text),
        mcpConfigs: array(text),
      },
      ['id'],
    ),
  ),
  exclude: array(text),
  includeUntracked: { type: 'boolean' },
};
const pointer = { type: 'string', pattern: '^(?:/(?:[^~]|~[01])*)*$' };
const extract = map(pointer);
const request = {
  ...object(
    {
      method: { enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'] },
      url: text,
      path: text,
      query: array(object(pair.properties, pair.required)),
      headers,
      body: object({ type: { enum: ['json', 'text', 'form'] }, content: {} }, ['type', 'content']),
      timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
      operationId: text,
      inputs: map({}),
    },
    ['method'],
  ),
  oneOf: [{ required: ['url'] }, { required: ['path'] }],
};
const promptArg = { anyOf: [{ type: 'string' }, env] };
const mcpActions = {
  discover: {},
  call: { tool: text, arguments: map({}) },
  read: { uri: text },
  template: { uriTemplate: text, arguments: map({}) },
  prompt: { name: text, arguments: map(promptArg) },
};
const mcpRequest = {
  oneOf: [
    object({ tool: text, arguments: map({}) }, ['tool', 'arguments']),
    ...Object.entries(mcpActions).map(([type, params]) =>
      object({ type: { const: type }, ...params }, ['type', ...Object.keys(params)]),
    ),
  ],
};
const assertion = {
  oneOf: [
    object({ type: { const: 'status' }, equals: { type: 'integer', minimum: 100, maximum: 599 } }, [
      'type',
      'equals',
    ]),
    object({ type: { const: 'jsonExists' }, pointer }, ['type', 'pointer']),
    object({ type: { const: 'jsonEquals' }, pointer, equals: {} }, ['type', 'pointer', 'equals']),
    object({ type: { const: 'textContains' }, pointer, text }, ['type', 'pointer', 'text']),
    object({ type: { const: 'responseSchema' } }, ['type']),
    object({ type: { const: 'toolDiscovered' }, name: text }, ['type', 'name']),
    object({ type: { const: 'toolError' }, equals: { type: 'boolean' } }, ['type', 'equals']),
    object({ type: { const: 'fileExists' }, path: text }, ['type', 'path']),
  ],
};

export const schemas: Record<string, object> = {
  config: document({ sources: scan.sources, exclude: scan.exclude }, []),
  settings: document({ locale, scan: object(scan) }, []),
  profile: document(
    {
      id,
      name: text,
      variables: map({ anyOf: [scalar, env] }),
      http: object({
        baseUrl: text,
        headers,
        auth: {
          oneOf: [
            object({ type: { const: 'basic' }, username: env, password: env }, ['type', 'username', 'password']),
            object({ type: { const: 'bearer' }, token: env }, ['type', 'token']),
            object({ type: { const: 'apiKey' }, name: text, key: env }, ['type', 'name', 'key']),
          ],
        },
      }),
      mcp: {
        oneOf: [
          object(
            {
              transport: { const: 'stdio' },
              command: text,
              args: array(text),
              cwd: text,
              env: map(env),
              protocolVersion: { enum: mcpVersions },
            },
            ['transport', 'command'],
          ),
          object(
            {
              transport: { enum: ['streamableHttp', 'sse'] },
              url: text,
              headers,
              protocolVersion: { enum: mcpVersions },
            },
            ['transport', 'url'],
          ),
        ],
      },
    },
    ['id', 'name'],
  ),
  request,
  assertions: array(assertion),
  'mcp-batch': document(
    {
      steps: {
        ...array({
          oneOf: Object.entries(mcpActions).map(([type, params]) =>
            object({ id, type: { const: type }, extract, assertions: array(assertion), ...params }, [
              'id',
              'type',
              ...Object.keys(params),
            ]),
          ),
        }),
        minItems: 1,
      },
    },
    ['steps'],
  ),
  case: {
    oneOf: ['http', 'mcp'].map((kind) =>
      document(
        {
          id,
          name: text,
          kind: { const: kind },
          profile: id,
          request: kind === 'http' ? request : mcpRequest,
          assertions: array(assertion),
          extract,
        },
        ['id', 'name', 'kind', 'request'],
      ),
    ),
  },
  suite: document(
    {
      id,
      name: text,
      caseIds: { ...array(id), minItems: 1 },
      continueOnFailure: { type: 'boolean' },
      outputs: map(map(text)),
    },
    ['id', 'name', 'caseIds'],
  ),
  catalog: document(
    {
      snapshot: text,
      locale,
      items: array(
        object(
          {
            id: text,
            kind: { enum: ['api', 'mcp', 'skill'] },
            name: text,
            summary: { type: 'string' },
            sources: array(text),
            page: text,
            definition: text,
          },
          ['id', 'kind', 'name', 'summary', 'sources', 'page'],
        ),
      ),
    },
    ['snapshot', 'locale', 'items'],
  ),
  result: document(
    {
      ok: { type: 'boolean' },
      command: { type: 'string' },
      data: {},
      error: {
        anyOf: [
          { type: 'null' },
          object({ code: text, message: text, details: {} }, ['code', 'message', 'details']),
        ],
      },
    },
    ['ok', 'command', 'data', 'error'],
  ),
};

const validator = new Ajv({ allErrors: true, strict: false, ownProperties: true });

export function validate<T>(name: string, value: unknown): T {
  const schema = Object.hasOwn(schemas, name) ? schemas[name] : undefined;
  if (!schema) invalid('Unknown schema', { name });
  const check = validator.compile(schema);
  if (!check(value)) invalid('Input does not match ' + name + ' schema', check.errors);
  return value as T;
}
