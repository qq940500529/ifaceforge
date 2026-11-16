import { stringify as yaml } from 'yaml';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError, invalid } from './errors.js';
import { sourceText, stableJson } from './files.js';
import { getEntity, saveRuntime } from './catalog.js';
import { jsonPointer } from './pointer.js';
import type { ProjectPaths } from './project.js';
import type { Repository } from '../storage/repository.js';
import { mapping, parseOpenApi } from '../scanner/openapi.js';
import type { Diagnostic, Entity } from '../scanner/model.js';
import { prepareHttp, sendHttp, type HttpRequest, type HttpResult } from '../protocols/http.js';
import { Bindings, type Profile } from '../protocols/variables.js';

const ajvOptions = { strict: false, allErrors: true, ownProperties: true };
const v30 = new Ajv(ajvOptions);
const v31 = new Ajv2020(ajvOptions);
(formats as unknown as (ajv: Ajv | Ajv2020) => void)(v30);
(formats as unknown as (ajv: Ajv | Ajv2020) => void)(v31);

export type Assertion =
  | { type: 'status'; equals: number }
  | { type: 'jsonExists'; pointer: string }
  | { type: 'jsonEquals'; pointer: string; equals: unknown }
  | { type: 'textContains'; pointer: string; text: string }
  | { type: 'responseSchema' }
  | { type: 'toolDiscovered'; name: string }
  | { type: 'toolError'; equals: boolean }
  | { type: 'fileExists'; path: string };

export interface Check {
  type: string;
  passed: boolean;
  actual?: unknown;
  expected?: unknown;
  details?: unknown;
}

export function compare(assertion: Assertion, body: unknown): Check | undefined {
  if (assertion.type !== 'jsonExists' && assertion.type !== 'jsonEquals' && assertion.type !== 'textContains')
    return;
  const actual = jsonPointer(body, assertion.pointer);
  const expected =
    assertion.type === 'textContains'
      ? assertion.text
      : assertion.type === 'jsonEquals'
        ? assertion.equals
        : 'present';
  return {
    type: assertion.type,
    passed:
      actual !== undefined &&
      (assertion.type === 'textContains'
        ? typeof actual === 'string' && actual.includes(assertion.text)
        : assertion.type === 'jsonExists' || stableJson(actual) === stableJson(expected)),
    actual,
    expected,
    details: { pointer: assertion.pointer },
  };
}

function definition(entity: Entity, profile?: Profile) {
  return (
    entity.observations.find(
      (item) => item.origin === 'runtime' && item.profile === profile?.id && item.definition.operation,
    )?.definition ??
    entity.observations.find((item) => item.origin === 'declaration' && item.definition.operation)?.definition ??
    entity.observations.find((item) => item.definition.operation)?.definition
  );
}

function normalizeSchema(schema: unknown, legacy: boolean): unknown {
  if (Array.isArray(schema)) return schema.map((item) => normalizeSchema(item, legacy));
  if (!schema || typeof schema !== 'object') return schema;
  const result = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, normalizeSchema(value, legacy)]),
  );
  delete result.$id;
  if (legacy) {
    for (const keyword of ['exclusiveMinimum', 'exclusiveMaximum']) {
      if (result[keyword] === true) {
        const bound = keyword === 'exclusiveMinimum' ? 'minimum' : 'maximum';
        result[keyword] = result[bound];
        delete result[bound];
      } else if (result[keyword] === false) delete result[keyword];
    }
  }
  return result;
}

export function schemaCheck(result: HttpResult, contract?: Record<string, unknown>): Check {
  const type = 'responseSchema';
  const responses = mapping(mapping(contract?.operation).responses);
  const status = String(result.status);
  const content = mapping(mapping(responses[status] ?? responses[status[0] + 'XX'] ?? responses.default).content);
  const [major] = result.mediaType.split('/');
  const schema = mapping(content[result.mediaType] ?? content[major + '/*'] ?? content['*/*']).schema;
  const noDefinition = (details: string) => ({
    type,
    passed: false,
    expected: 'available response schema',
    details,
  });
  if (schema === undefined) return noDefinition('No definition for this status and media type');
  if (
    result.truncated ||
    result.malformedJson ||
    result.bodyType === 'binary' ||
    (result.bodyType === 'json' && result.json === undefined)
  ) {
    return noDefinition('Response could not be read in full as a supported value');
  }
  const legacy = String(contract?.openapi).startsWith('3.0.');
  try {
    const validator = (legacy ? v30 : v31).compile(normalizeSchema(schema, legacy) as object | boolean);
    const value = result.bodyType === 'json' ? result.json : result.text;
    return {
      type,
      passed: validator(value),
      expected: 'response schema',
      actual: value,
      details: validator.errors,
    };
  } catch (error) {
    return noDefinition('Unsupported response schema: ' + (error as Error).message);
  }
}

export function httpChecks(
  assertions: Assertion[],
  result: HttpResult,
  contract?: Record<string, unknown>,
): Check[] {
  return assertions.map((assertion) => {
    if (assertion.type === 'status')
      return {
        type: assertion.type,
        passed: result.status === assertion.equals,
        actual: result.status,
        expected: assertion.equals,
      };
    if (assertion.type === 'responseSchema') return schemaCheck(result, contract);
    return (
      compare(assertion, result.json) ?? {
        type: assertion.type,
        passed: false,
        details: 'Unsupported HTTP assertion',
      }
    );
  });
}

export function apiContract(repository: Repository, request: HttpRequest, profile?: Profile) {
  return request.operationId ? definition(getEntity(repository, request.operationId), profile) : undefined;
}

export function apiFragment(entity: Entity, format = 'json') {
  if (format !== 'json' && format !== 'yaml') invalid('Expected json or yaml format');
  const selected = definition(entity);
  if (!selected) throw new AppError('NO_DEFINITION', 'No OpenAPI contract is available');
  const fragment = {
    openapi: selected.openapi,
    info: { title: entity.service, version: '1.0.0' },
    paths: { [String(selected.path)]: { [String(selected.method)]: selected.operation } },
    components: selected.securitySchemes ? { securitySchemes: selected.securitySchemes } : undefined,
  };
  const safe = new Bindings().redact(fragment);
  return { format, fragment: safe, text: format === 'yaml' ? yaml(safe) : JSON.stringify(safe, null, 2) };
}

export function requestDraft(entity: Entity): HttpRequest {
  const selected = definition(entity) ?? entity.observations[0].definition;
  if (typeof selected.method !== 'string' || typeof selected.path !== 'string')
    throw new AppError('NO_DEFINITION', 'No supported HTTP operation is available');
  const operation = mapping(selected.operation);
  const parameters = Array.isArray(operation.parameters) ? operation.parameters.map(mapping) : [];
  const inputs: Record<string, unknown> = {};
  const path = String(selected.path).replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    inputs[key] = '';
    return '{{' + key + '}}';
  });
  const pairs = (location: string) =>
    parameters
      .filter((p) => p.in === location && typeof p.name === 'string')
      .map((p) => ({
        name: String(p.name),
        value: '',
        enabled: p.required === true,
      }));
  return {
    operationId: entity.id,
    method: String(selected.method).toUpperCase(),
    path,
    inputs,
    query: pairs('query'),
    headers: pairs('header'),
  };
}

export async function importApi(
  project: ProjectPaths,
  repository: Repository,
  options: {
    file?: string;
    url?: string;
    profile?: Profile;
    service?: string;
  },
) {
  if (Boolean(options.file) === Boolean(options.url)) invalid('Select a file or URL');
  const service = options.service ?? 'default';
  const profile = options.profile?.id ?? (options.url ? 'imported-url' : 'imported-file');
  const diagnostics: Diagnostic[] = [];
  const bindings = new Bindings(options.profile);
  let text: string;
  let path: string | undefined;
  if (options.file) {
    path = options.file.replaceAll('\\', '/');
    text = sourceText(project.root, path);
  } else {
    const result = await sendHttp(
      prepareHttp({ method: 'GET', url: options.url }, options.profile, bindings),
      undefined,
      8 * 1024 * 1024,
    );
    if (result.status < 200 || result.status >= 300 || result.truncated || result.bodyType === 'binary') {
      throw new AppError('IMPORT_FAILED', 'Could not read an OpenAPI document', 3, {
        status: result.status,
        truncated: result.truncated,
      });
    }
    text = result.text;
  }
  const observations = parseOpenApi(
    text,
    { root: project.root, path, service, profile: options.url ? profile : undefined },
    diagnostics,
  );
  return saveRuntime(
    repository,
    bindings.redact({
      id: 'api:' + service + ':' + profile,
      profile,
      service,
      kind: 'api',
      complete: true,
      observations,
      diagnostics,
    }),
  );
}
