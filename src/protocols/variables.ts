import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError, invalid } from '../app/errors.js';
import type { mcpVersions } from './mcp-versions.js';

export type Scalar = string | number | boolean | null;
export type EnvRef = { env: string };
export type Value = Scalar | EnvRef;
export interface Pair {
  name: string;
  value: Value;
  enabled?: boolean;
}
export interface HttpProfile {
  baseUrl?: string;
  headers?: Pair[];
  auth?:
    | { type: 'basic'; username: EnvRef; password: EnvRef }
    | { type: 'bearer'; token: EnvRef }
    | { type: 'apiKey'; name: string; key: EnvRef };
}
export type McpProfile = (
  | { transport: 'stdio'; command: string; args?: string[]; cwd?: string; env?: Record<string, EnvRef> }
  | { transport: 'streamableHttp' | 'sse'; url: string; headers?: Pair[] }
) & { protocolVersion?: (typeof mcpVersions)[number] };
export interface Profile {
  schemaVersion: 1;
  id: string;
  name: string;
  variables?: Record<string, Value>;
  http?: HttpProfile;
  mcp?: McpProfile;
}

const token = /\{\{([\w.-]+)\}\}/g;
const wholeToken = /^\{\{([\w.-]+)\}\}$/;
export const secretHeader =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|.*[-_](?:token|secret|api[-_]key|apikey)|x-api-key|apikey|api-key)$/i;
export const secretName = /(?:password|secret|token|auth|cookie|credential|api[_-]?key)/i;
const mask = '[REDACTED]';
export const bindingEnvironment = new AsyncLocalStorage<Record<string, string | null>>();

export function referencedEnvironment(input: unknown) {
  const names = new Set<string>();
  const pending = [input];
  while (pending.length) {
    const entry = pending.pop();
    if (envReference(entry)) names.add(entry.env);
    else if (typeof entry === 'string') for (const item of entry.matchAll(token)) names.add(item[1]);
    else if (entry && typeof entry === 'object') pending.push(...Object.values(entry));
  }
  return Object.fromEntries(
    [...names].map((name) => [name, Object.hasOwn(process.env, name) ? (process.env[name] ?? null) : null]),
  );
}

function envReference(value: unknown): value is EnvRef {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'env') &&
    typeof (value as EnvRef).env === 'string'
  );
}

export class Bindings {
  readonly secrets = new Set<string>();
  private readonly values: Record<string, unknown>;

  constructor(profile?: Profile, inputs?: Record<string, unknown>, outputs?: Record<string, unknown>) {
    this.values = { ...profile?.variables, ...inputs, ...outputs };
  }

  environment(name: string) {
    const overrides = bindingEnvironment.getStore();
    const value =
      overrides && Object.hasOwn(overrides, name)
        ? (overrides[name] ?? undefined)
        : Object.hasOwn(process.env, name)
          ? process.env[name]
          : undefined;
    if (value === undefined)
      throw new AppError('MISSING_VARIABLE', 'Environment variable is missing', 3, { name });
    this.hide(value);
    return value;
  }

  hide(value: unknown) {
    if (typeof value === 'string' && value) this.secrets.add(value);
  }

  private lookup(name: string) {
    const stored = Object.hasOwn(this.values, name) ? this.values[name] : undefined;
    const value = envReference(stored)
      ? this.environment(stored.env)
      : stored === undefined
        ? this.environment(name)
        : stored;
    if (secretName.test(name)) this.hide(value);
    return value;
  }

  resolve(value: unknown, encode?: (value: string) => string): unknown {
    if (envReference(value)) return this.environment(value.env);
    if (typeof value === 'string') {
      const exact = !encode && value.match(wholeToken);
      if (exact) return this.lookup(exact[1]);
      return value.replace(token, (_match, name: string) => {
        const resolved = this.lookup(name);
        if (resolved && typeof resolved === 'object')
          invalid('Only scalar variables can be interpolated', { name });
        const text = String(resolved ?? '');
        return encode ? encode(text) : text;
      });
    }
    if (Array.isArray(value)) return value.map((item) => this.resolve(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolve(item)]));
    return value;
  }

  redact<T>(value: T): T {
    const strings = [...new Set([...this.secrets].flatMap((secret) => [secret, encodeURIComponent(secret)]))].sort(
      (a, b) => b.length - a.length,
    );
    const pattern = strings.length
      ? new RegExp(strings.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
      : undefined;
    function clean(input: unknown): unknown {
      if (typeof input === 'string') return pattern ? input.replace(pattern, mask) : input;
      if (Array.isArray(input)) return input.map(clean);
      if (!input || typeof input !== 'object') return input;
      const entry = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(entry).map(([key, content]) => [
          key,
          secretHeader.test(key) ||
          (key === 'value' && typeof entry.name === 'string' && secretHeader.test(entry.name))
            ? mask
            : key === 'headers' && Array.isArray(content)
              ? content
                  .filter(
                    (item) => !(Array.isArray(item) && typeof item[0] === 'string' && secretHeader.test(item[0])),
                  )
                  .map(clean)
              : clean(content),
        ]),
      );
    }
    return clean(value) as T;
  }
}

export function headerPairs(
  pairs: Pair[] | undefined,
  bindings: Bindings,
  omitSecrets = false,
): [string, string][] {
  return (pairs ?? []).flatMap(({ name, value, enabled }) => {
    if (enabled === false || (omitSecrets && (secretHeader.test(name) || envReference(value)))) return [];
    const bound = bindings.resolve(value);
    if (bound !== null && typeof bound === 'object') invalid('Expected a scalar header', { name });
    if (secretHeader.test(name)) bindings.hide(bound);
    return [[name, String(bound ?? '')]];
  });
}

export function httpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid('Expected an absolute HTTP URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    invalid('Only HTTP(S) URLs without user information are supported');
  }
  return url;
}
