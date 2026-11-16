import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { AppError, invalid } from '../app/errors.js';
import { Bindings, headerPairs, httpUrl, type Pair, type Profile } from './variables.js';

export interface HttpRequest {
  method: string;
  url?: string;
  path?: string;
  query?: Pair[];
  headers?: Pair[];
  body?: { type: 'text' | 'json' | 'form'; content: unknown };
  inputs?: Record<string, unknown>;
  operationId?: string;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  durationMs: number;
  headers: [string, string][];
  mediaType: string;
  bodyType: 'json' | 'text' | 'binary';
  text: string;
  json?: unknown;
  malformedJson: boolean;
  truncated: boolean;
  target: string;
}

export function prepareHttp(
  template: HttpRequest,
  profile: Profile | undefined,
  bindings: Bindings,
  omitAuth = false,
) {
  let url: URL;
  if (template.url) {
    url = httpUrl(String(bindings.resolve(template.url)));
  } else {
    if (!profile?.http?.baseUrl) invalid('A relative path requires an HTTP profile with baseUrl');
    const base = httpUrl(String(bindings.resolve(profile.http.baseUrl)));
    const path = String(bindings.resolve(template.path, encodeURIComponent));
    if (!path.startsWith('/') || /^(?:\/\/|\/\\)/.test(path) || path.includes('\\') || /[?#]/.test(path)) {
      invalid('Path must start with a single slash. Supply query items separately.');
    }
    base.pathname = base.pathname.replace(/\/$/, '') + path;
    url = base;
  }
  url.hash = '';
  for (const pair of template.query ?? []) {
    if (pair.enabled === false) continue;
    const value = bindings.resolve(pair.value);
    if (value !== null && typeof value === 'object') invalid('Expected a scalar query value', { name: pair.name });
    url.searchParams.append(pair.name, String(value ?? ''));
  }

  const headers = headerPairs(profile?.http?.headers, bindings, omitAuth);
  const requestHeaders = headerPairs(template.headers, bindings, omitAuth);
  const overrides = new Set(requestHeaders.map(([name]) => name.toLowerCase()));
  const selected = headers.filter(([name]) => !overrides.has(name.toLowerCase())).concat(requestHeaders);
  const auth = profile?.http?.auth;
  if (auth && !omitAuth) {
    if (auth.type === 'basic') {
      const basic = Buffer.from(
        bindings.environment(auth.username.env) + ':' + bindings.environment(auth.password.env),
      ).toString('base64');
      bindings.hide(basic);
      selected.push(['Authorization', 'Basic ' + basic]);
    } else if (auth.type === 'bearer')
      selected.push(['Authorization', 'Bearer ' + bindings.environment(auth.token.env)]);
    else selected.push([auth.name, bindings.environment(auth.key.env)]);
  }

  let body: string | undefined;
  if (template.body) {
    if (template.method === 'HEAD' || template.method === 'GET') invalid('GET and HEAD do not accept a body');
    const { type, content } = template.body;
    const value = bindings.resolve(content);
    let mime: string;
    if (type === 'json') {
      body = JSON.stringify(value);
      mime = 'application/json';
    } else if (type === 'form') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Form content must be an object');
      const form = new URLSearchParams();
      for (const [key, field] of Object.entries(value)) {
        for (const value of Array.isArray(field) ? field : [field]) {
          if (value !== null && typeof value === 'object')
            invalid('Form values must be scalars or arrays of scalars');
          form.append(key, String(value ?? ''));
        }
      }
      body = form.toString();
      mime = 'application/x-www-form-urlencoded';
    } else {
      if (typeof value !== 'string') invalid('Text body must be a string');
      body = value;
      mime = 'text/plain; charset=utf-8';
    }
    if (!selected.some(([name]) => name.toLowerCase() === 'content-type')) selected.push(['Content-Type', mime]);
  }
  for (const [name, value] of selected) {
    if (/^(?:host|content-length|transfer-encoding|connection|upgrade)$/i.test(name))
      invalid('Header is managed by the HTTP client', { name });
    try {
      http.validateHeaderName(name);
      http.validateHeaderValue(name, value);
    } catch {
      invalid('Invalid HTTP header', { name });
    }
  }
  return { method: template.method, url, headers: selected, body, timeoutMs: template.timeoutMs ?? 30_000 };
}

export function curl(template: HttpRequest, profile?: Profile) {
  const bindings = new Bindings(profile, template.inputs);
  const { method, url, headers, body } = prepareHttp(template, profile, bindings, true);
  const quote = (value: string) => "'" + bindings.redact(value).replaceAll("'", "'\"'\"'") + "'";
  return [
    'curl',
    '-X',
    method,
    quote(url.href),
    ...headers.flatMap(([key, value]) => ['-H', quote(key + ': ' + value)]),
    ...(body === undefined ? [] : ['--data-binary', quote(body)]),
  ].join(' ');
}

const responseLimit = 1024 * 1024;

export async function sendHttp(
  request: ReturnType<typeof prepareHttp>,
  signal?: AbortSignal,
  limit = responseLimit,
): Promise<HttpResult> {
  const start = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new AppError('HTTP_TIMEOUT', 'HTTP request timed out')),
    request.timeoutMs,
  );
  try {
    return await new Promise<HttpResult>((resolve, reject) => {
      const transport = request.url.protocol === 'https:' ? https : http;
      const outgoing = transport.request(
        request.url,
        {
          method: request.method,
          signal: controller.signal,
          headers: [
            'Host',
            request.url.host,
            ...request.headers.flat(),
            ...(request.body === undefined ? [] : ['Content-Length', String(Buffer.byteLength(request.body))]),
          ],
        },
        (incoming) => {
          const buffers: Buffer[] = [];
          let length = 0;
          let finished = false;
          const complete = (truncated: boolean) => {
            finished = true;
            const headers: [string, string][] = [];
            for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
              headers.push([incoming.rawHeaders[index], incoming.rawHeaders[index + 1]]);
            }
            const mediaType = (incoming.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            const isJson = /[+/]json$/.test(mediaType);
            const bodyType = isJson
              ? 'json'
              : /^(?:text\/|application\/(?:xml|x-www-form-urlencoded))/.test(mediaType) || !mediaType
                ? 'text'
                : 'binary';
            const text = bodyType === 'binary' ? '' : Buffer.concat(buffers).toString('utf8');
            let json: unknown;
            let malformedJson = false;
            if (isJson && !truncated && text) {
              try {
                json = JSON.parse(text) as unknown;
              } catch {
                malformedJson = true;
              }
            }
            resolve({
              status: incoming.statusCode!,
              durationMs: Math.round(performance.now() - start),
              headers,
              mediaType,
              bodyType,
              text,
              json,
              malformedJson,
              truncated,
              target: request.url.href,
            });
          };
          incoming.on('data', (chunk: Buffer) => {
            const remaining = limit - length;
            buffers.push(chunk.subarray(0, remaining));
            length += Math.min(chunk.length, remaining);
            if (chunk.length > remaining) {
              complete(true);
              incoming.destroy();
            }
          });
          incoming.once('end', () => {
            if (!finished) complete(false);
          });
          incoming.once('error', reject);
        },
      );
      outgoing.once('error', reject);
      outgoing.end(request.body);
    });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof AppError) throw error;
    throw new AppError('HTTP_NETWORK', 'HTTP target could not be reached', 3, {
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
