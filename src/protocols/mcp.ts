import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  isInputRequiredResult,
  type RequestOptions,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Ajv } from 'ajv';
import { AppError, invalid } from '../app/errors.js';
import { projectFile } from '../app/files.js';
import { version } from '../app/platform.js';
import { Bindings, headerPairs, httpUrl, type Profile } from './variables.js';
import { resourceTemplate } from './mcp-template.js';

export type McpAction =
  | { type: 'discover' }
  | { type: 'call'; tool: string; arguments: Record<string, unknown> }
  | { type: 'read'; uri: string }
  | { type: 'template'; uriTemplate: string; arguments: Record<string, unknown> }
  | { type: 'prompt'; name: string; arguments: Record<string, string> };

export function bindMcpAction(action: McpAction, bindings: Bindings) {
  if (!('arguments' in action)) return bindings.resolve(action) as McpAction;
  return {
    ...(bindings.resolve({ ...action, arguments: undefined }) as McpAction),
    arguments: Object.fromEntries(
      Object.entries(action.arguments).map(([key, value]) => [key, bindings.resolve(value)]),
    ),
  } as McpAction;
}

export function resolveMcpTarget(action: McpAction) {
  if (action.type !== 'template') return action;
  try {
    return { type: 'read' as const, uri: resourceTemplate(action.uriTemplate).expand(action.arguments) };
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Invalid resource template');
  }
}

interface DiscoveryGroup {
  type: 'tool' | 'resource' | 'template' | 'prompt';
  state: 'found' | 'empty' | 'notPublished' | 'permissionDenied' | 'unreachable' | 'fault';
  items: Record<string, unknown>[];
  error?: unknown;
}

export async function paginate<T>(load: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>) {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 500)) {
      throw new AppError('MCP_CURSOR', 'MCP pagination did not complete', 3, { items });
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}

function protocolDetails(error: unknown) {
  const entry = error as { code?: unknown; status?: unknown; message?: string; data?: unknown } | null;
  return {
    protocolCode: entry?.code,
    status: entry?.status,
    reason: entry?.message ?? String(error),
    data: entry?.data,
  };
}

export function mcpError(error: unknown, sent: boolean, closed: boolean) {
  if (error instanceof AppError) return error;
  const details = protocolDetails(error);
  const reason = details.reason;
  const code = String(details.protocolCode);
  const disconnected =
    closed ||
    /connection closed|not connected|closed connection|ECONNRESET|fetch failed|broken pipe/i.test(reason);
  const timedOut = /timeout|timed out/i.test(reason);
  if (sent && (disconnected || timedOut || /abort|cancel/i.test(reason))) {
    return new AppError('MCP_RESULT_UNKNOWN', 'The request was sent and the result could not be confirmed', 4, {
      ...details,
      reasonCode: disconnected ? 'MCP_DISCONNECTED' : timedOut ? 'MCP_TIMEOUT' : 'CANCELED',
    });
  }
  if (disconnected) return new AppError('MCP_DISCONNECTED', 'MCP connection ended', 3, details);
  if (timedOut) return new AppError('MCP_TIMEOUT', 'MCP request timed out', 3, details);
  if (
    String(details.status) === '401' ||
    String(details.status) === '403' ||
    /unauthorized|forbidden|\b40[13]\b/i.test(reason)
  ) {
    return new AppError('MCP_PERMISSION', 'MCP server denied access', 3, details);
  }
  if (code === '-32601' || /not support|method not found/i.test(reason)) {
    return new AppError('MCP_NOT_PUBLISHED', 'MCP server does not publish this method', 3, details);
  }
  return new AppError('MCP_RPC_ERROR', 'MCP request failed', 3, details);
}

// The SDK probes in place for transport subclasses. One user connection starts one child.
class WorkbenchStdio extends StdioClientTransport {}

export function needsFreshLegacyProcess(error: unknown) {
  if (!(error instanceof AppError) || error.code !== 'MCP_CONNECT_FAILED') return false;
  const details = error.details as { cause?: string; details?: { protocolCode?: string; reason?: string } };
  return (
    details.cause === 'MCP_DISCONNECTED' &&
    details.details?.protocolCode === 'ERA_NEGOTIATION_FAILED' &&
    /closed during (?:the )?(?:server\/discover|version negotiation) probe/i.test(details.details.reason ?? '')
  );
}

export class McpSession {
  private closed = false;
  private readonly inputSchemas = new Map<string, object>();
  private readonly validator = new Ajv({ strict: false, allErrors: true, ownProperties: true });

  private constructor(private readonly client: Client) {
    client.onclose = () => {
      this.closed = true;
    };
  }

  static async connect(
    profile: Profile,
    root: string,
    bindings: Bindings,
    signal?: AbortSignal,
    boundary?: {
      stdio?: { command: string; args: string[] };
      transport?: Transport;
      legacy?: boolean;
      connectTimeout?: number;
      probeTimeout?: number;
      fetch?: typeof fetch;
      onStderr?: (chunk: Buffer) => void;
    },
  ) {
    const config = profile.mcp;
    if (!config) invalid('Selected profile does not contain an MCP connection');
    const pin = config.protocolVersion;
    if (config.transport === 'sse' && pin === '2026-07-28')
      invalid('2026-07-28 does not use the legacy SSE transport');
    const client = new Client(
      { name: 'IfaceForge', version },
      {
        supportedProtocolVersions: pin ? [pin] : undefined,
        versionNegotiation: {
          mode:
            pin === '2026-07-28'
              ? { pin }
              : boundary?.legacy || pin || config.transport === 'sse'
                ? 'legacy'
                : 'auto',
          probe: { timeoutMs: boundary?.probeTimeout ?? 6000 },
        },
      },
    );
    const session = new McpSession(client);
    const transport =
      boundary?.transport ??
      (config.transport === 'stdio'
        ? new WorkbenchStdio({
            ...(boundary?.stdio ?? {
              command: config.command,
              args: config.args?.map((arg) => String(bindings.resolve(arg))),
              cwd: projectFile(root, config.cwd ?? '.'),
              env: Object.fromEntries(
                Object.entries(config.env ?? {}).map(([key, ref]) => [key, bindings.environment(ref.env)]),
              ),
            }),
            stderr: boundary?.onStderr ? 'pipe' : 'ignore',
            maxBufferSize: 2 * 1024 * 1024,
          })
        : new (config.transport === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport)(
            httpUrl(String(bindings.resolve(config.url))),
            {
              requestInit: { headers: new Headers(headerPairs(config.headers, bindings)), redirect: 'error' },
              fetch: boundary?.fetch,
            },
          ));
    if (transport instanceof WorkbenchStdio && boundary?.onStderr) transport.stderr?.on('data', boundary.onStderr);
    const abort = () => {
      void session.close().catch(() => undefined);
    };
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await client.connect(transport, { timeout: boundary?.connectTimeout ?? 15_000, signal });
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      if (signal?.aborted) throw signal.reason;
      const normalized = mcpError(error, false, false);
      throw new AppError('MCP_CONNECT_FAILED', 'Could not connect to MCP server', 3, {
        cause: normalized.code,
        details: normalized.details,
      });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  get connected() {
    return !this.closed;
  }

  info() {
    return {
      connected: this.connected,
      server: this.client.getServerVersion(),
      protocolVersion: this.client.getNegotiatedProtocolVersion(),
      instructions: this.client.getInstructions(),
      capabilities: this.client.getServerCapabilities(),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }

  validate(action: McpAction) {
    if (action.type !== 'call') return;
    const schema = this.inputSchemas.get(action.tool);
    if (!schema) return;
    let check;
    try {
      check = this.validator.compile(schema);
    } catch {
      // The server validates schemas outside the local validator's dialect.
      return;
    }
    if (!check(action.arguments)) invalid('Tool arguments do not match the discovered schema', check.errors);
  }

  async execute(
    action: Exclude<McpAction, { type: 'template' }>,
    signal?: AbortSignal,
    onProgress?: RequestOptions['onprogress'],
    onGroup?: (group: Pick<DiscoveryGroup, 'type' | 'state'> & { count: number }) => void,
  ): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    if (this.closed) throw new AppError('MCP_DISCONNECTED', 'MCP connection ended');
    const options: RequestOptions = { signal, timeout: 30_000, onprogress: onProgress };
    let sent = false;
    try {
      if (action.type === 'discover') return await this.inventory(options, onGroup);
      if (action.type === 'read') {
        const result = await this.client.readResource({ uri: action.uri }, options);
        if (isInputRequiredResult(result)) {
          throw new AppError(
            'MCP_INPUT_UNSUPPORTED',
            'The MCP server requested an unsupported client interaction',
            3,
            result,
          );
        }
        return result;
      }
      sent = true;
      const result =
        action.type === 'call'
          ? await this.client.callTool({ name: action.tool, arguments: action.arguments }, options)
          : await this.client.getPrompt({ name: action.name, arguments: action.arguments }, options);
      if (isInputRequiredResult(result)) {
        throw new AppError(
          'MCP_INPUT_UNSUPPORTED',
          'The MCP server requested an unsupported client interaction',
          3,
          result,
        );
      }
      return result;
    } catch (error) {
      if (signal?.aborted && sent) {
        throw new AppError('MCP_RESULT_UNKNOWN', 'The request was canceled after being sent', 4, {
          reasonCode: 'CANCELED',
        });
      }
      if (signal?.aborted) throw signal.reason;
      throw mcpError(error, sent, this.closed);
    }
  }

  private async inventory(
    options: RequestOptions,
    onGroup?: (group: Pick<DiscoveryGroup, 'type' | 'state'> & { count: number }) => void,
  ) {
    const groups: DiscoveryGroup[] = [];
    const advertised = this.client.getServerCapabilities();
    const capabilities = {
      tool: 'tools',
      resource: 'resources',
      template: 'resources',
      prompt: 'prompts',
    } as const;
    async function discover(
      type: DiscoveryGroup['type'],
      load: (cursor?: string) => Promise<{ items: object[]; nextCursor?: string }>,
    ) {
      if (!advertised?.[capabilities[type]]) {
        groups.push({ type, state: 'notPublished', items: [] });
        onGroup?.({ type, state: 'notPublished', count: 0 });
        return;
      }
      const partial: Record<string, unknown>[] = [];
      try {
        const items = (await paginate(async (cursor) => {
          const page = await load(cursor);
          if (partial.length + page.items.length > 20_000)
            throw new AppError('MCP_INVENTORY_LIMIT', 'The MCP list exceeds 20,000 entries');
          partial.push(...(page.items as Record<string, unknown>[]));
          return page;
        })) as Record<string, unknown>[];
        groups.push({ type, state: items.length ? 'found' : 'empty', items });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        const normalized = mcpError(error, false, false);
        const state =
          normalized.code === 'MCP_NOT_PUBLISHED' && !partial.length
            ? 'notPublished'
            : normalized.code === 'MCP_PERMISSION'
              ? 'permissionDenied'
              : normalized.code === 'MCP_DISCONNECTED' || normalized.code === 'MCP_TIMEOUT'
                ? 'unreachable'
                : 'fault';
        groups.push({
          type,
          state,
          items: partial,
          error: { code: normalized.code, details: normalized.details },
        });
      }
      const { state, items } = groups.at(-1)!;
      onGroup?.({ type, state, count: items.length });
    }
    // Pass an explicit cursor property so the SDK does not aggregate pages itself.
    await discover('tool', async (cursor) => {
      const result = await this.client.listTools({ cursor }, options);
      return { items: result.tools, nextCursor: result.nextCursor };
    });
    if (['found', 'empty'].includes(groups[0].state)) {
      this.inputSchemas.clear();
      for (const item of groups[0].items) {
        if (typeof item.name === 'string' && item.inputSchema && typeof item.inputSchema === 'object') {
          this.inputSchemas.set(item.name, item.inputSchema);
        }
      }
    }
    await discover('resource', async (cursor) => {
      const result = await this.client.listResources({ cursor }, options);
      return { items: result.resources, nextCursor: result.nextCursor };
    });
    await discover('template', async (cursor) => {
      const result = await this.client.listResourceTemplates({ cursor }, options);
      return { items: result.resourceTemplates, nextCursor: result.nextCursor };
    });
    await discover('prompt', async (cursor) => {
      const result = await this.client.listPrompts({ cursor }, options);
      return { items: result.prompts, nextCursor: result.nextCursor };
    });
    return { ...this.info(), groups };
  }
}

export type Discovery = ReturnType<McpSession['info']> & { groups: DiscoveryGroup[] };
