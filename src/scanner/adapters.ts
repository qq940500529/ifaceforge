import { basename, dirname, posix } from 'node:path';
import { existsSync } from 'node:fs';
import { parse as jsonc } from 'jsonc-parser';
import { parse as toml } from 'smol-toml';
import { digest, projectFile, protectedSource, type ScanSource } from '../app/files.js';
import type { Adapter, SourceConfig } from '../app/config.js';
import { apiId, mcpId, type Diagnostic, type Observation } from './model.js';
import { scanMcpSource } from './mcp-discovery.js';
import { scanExpressSource } from './express.js';
import { scanPythonHttp } from './python-http.js';
import type { pythonConstants } from './python-constants.js';
import { scanPythonMcp } from './mcp-python.js';
import { mcpLanguageFile, scanMcpLanguage } from './mcp-languages.js';
import { mapping, yamlDocument } from './openapi.js';

export function parseSkill(
  root: string,
  path: string,
  text: string,
  diagnostics: Diagnostic[],
  historical?: ScanSource,
): Observation {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  let metadata: Record<string, unknown> = {};
  if (match) {
    try {
      metadata = mapping(yamlDocument(match[1]).value);
    } catch (error) {
      diagnostics.push({ path, code: 'SKILL_METADATA', message: String(error) });
    }
  }
  const name = typeof metadata.name === 'string' ? metadata.name : basename(dirname(path));
  if (
    typeof metadata.name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    name.length > 64 ||
    name !== basename(dirname(path)) ||
    typeof metadata.description !== 'string' ||
    !metadata.description.trim()
  ) {
    diagnostics.push({ path, code: 'SKILL_METADATA', message: 'Name or description is missing or invalid' });
  }
  const body = match ? text.slice(match[0].length) : text;
  const references = new Map<string, { path: string; status: string }>();
  const markdown = body.replace(/^[ \t]*(\x60\x60\x60|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*\r?$/gm, (fence) =>
    fence.replace(/[^\r\n]/g, ' '),
  );
  let line = 1 + (match?.[0].match(/\n/g)?.length ?? 0);
  let offset = 0;
  for (const link of markdown.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
    line += markdown.slice(offset, link.index).match(/\n/g)?.length ?? 0;
    offset = link.index;
    const href = link[1] ?? link[2];
    if (href.startsWith('#')) continue;
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(href)) {
      references.set(href, { path: href, status: 'external' });
      continue;
    }
    let pathToReference = href;
    try {
      pathToReference = posix.normalize(
        posix.join(posix.dirname(path), decodeURIComponent(href.split(/[?#]/, 1)[0])),
      );
      if (
        /^(?:\.\.?(?:\/|$)|\/)/.test(pathToReference) ||
        pathToReference.includes('\\') ||
        protectedSource.test(pathToReference)
      )
        throw Error('Outside source viewer');
      const available = historical
        ? historical.has(pathToReference)
        : existsSync(projectFile(root, pathToReference, false));
      if (!available && !references.has(href)) {
        diagnostics.push({
          path,
          line,
          severity: 'warning',
          code: 'SKILL_REFERENCE_MISSING',
          message: 'Skill reference does not exist in this revision',
          details: { target: pathToReference },
        });
      }
      references.set(href, { path: pathToReference, status: available ? 'available' : 'missing' });
    } catch {
      references.set(href, { path: pathToReference, status: 'outside' });
    }
  }
  return {
    id: 'skill:' + digest(path + '\0' + name).slice(0, 24),
    kind: 'skill',
    service: 'skills',
    name,
    summary: String(metadata.description ?? ''),
    origin: 'declaration',
    path,
    line: 1,
    definition: {
      format: 'Agent Skills',
      version: mapping(metadata.metadata).version,
      metadata,
      body,
      references: [...references.values()],
    },
  };
}

export function parseMcpConfig(
  path: string,
  value: unknown,
  diagnostics: Diagnostic[],
  service?: string,
): Observation[] {
  const document = mapping(value);
  const servers = mapping(document.mcpServers ?? document.servers ?? document.mcp_servers);
  return Object.entries(servers).flatMap(([name, raw]) => {
    const entry = mapping(raw);
    const launch = Object.values(mapping(entry.launch))
      .map(mapping)
      .find((target) => typeof target.command === 'string');
    const transport =
      typeof entry.url === 'string'
        ? entry.type === 'sse' || entry.transport === 'sse'
          ? 'sse'
          : 'streamableHttp'
        : typeof entry.command === 'string' || launch
          ? 'stdio'
          : null;
    if (!transport) {
      diagnostics.push({ path, code: 'MCP_CONFIG', message: 'Missing URL or command for ' + name });
      return [];
    }
    return [
      {
        id: mcpId(service ?? name, 'server', name),
        service: service ?? name,
        kind: 'mcp',
        name,
        origin: 'declaration',
        summary: '',
        path,
        definition: { type: 'server', transport, template: entry },
      },
    ];
  });
}

export const mcpConfigName =
  /(?:^|\/)(?:\.mcp\.(?:jsonc?|toml|ya?ml)|mcp\.(?:jsonc?|toml|ya?ml)|\.codex\/config\.toml)$/i;

export function mcpConfigDocument(path: string, text: string) {
  if (/\.toml$/i.test(path)) return toml(text);
  if (/\.ya?ml$/i.test(path)) return yamlDocument(text).value;
  const errors: Parameters<typeof jsonc>[1] = [];
  const value: unknown = jsonc(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length) throw Error('Invalid MCP configuration at offset ' + errors[0].offset);
  return value;
}

const extensions = /\.(?:[cm]?[jt]sx?)$/i;
const pythonPattern = /^\s*@[\w.]+\.(get|post|put|patch|delete|options|head|trace)\s*\(\s*(['"])([^'"\r\n]+)\2/;

function pythonSource(
  path: string,
  text: string,
  service: string,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
  constants?: ReturnType<typeof pythonConstants>,
) {
  const observations = scanPythonHttp(path, text, service, diagnostics, checkpoint, constants);
  const lines = text.split(/\r?\n/);
  if (!/^\s*(?:from\s+fastapi(?:\.\w+)*\s+import\b|import\s+fastapi\b)/m.test(text)) return observations;
  for (const [index, line] of lines.entries()) {
    if (index % 256 === 0) checkpoint?.();
    const match = pythonPattern.exec(line);
    if (!match) {
      if (/^\s*@\w+\.(?:get|post|put|patch|delete)\(/.test(line))
        diagnostics.push({
          path,
          line: index + 1,
          code: 'DYNAMIC_ROUTE',
          message: 'FastAPI registration has a non-literal or multiline path',
        });
      continue;
    }
    const [, method, , route] = match;
    if (route.startsWith('/'))
      observations.push({
        id: apiId(service, method, route),
        kind: 'api',
        service,
        name: method.toUpperCase() + ' ' + route,
        summary: '',
        origin: 'source',
        path,
        line: index + 1,
        definition: { method, path: route, adapter: 'fastapi' },
      });
  }
  return observations;
}

export async function scanSource(
  path: string,
  text: string,
  adapters: Adapter[],
  service: string,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
  rules?: SourceConfig['mcpRules'],
  constants?: ReturnType<typeof pythonConstants>,
) {
  const observations: Observation[] = [];
  if (/\.py$/i.test(path)) {
    if (adapters.includes('fastapi'))
      observations.push(...pythonSource(path, text, service, diagnostics, checkpoint, constants));
    if (adapters.includes('mcp-source'))
      observations.push(...scanPythonMcp(path, text, service, diagnostics, checkpoint));
  }
  if (extensions.test(path)) {
    if (adapters.includes('express'))
      observations.push(...scanExpressSource(path, text, service, diagnostics, checkpoint));
    if (adapters.includes('mcp-typescript') || adapters.includes('mcp-source'))
      observations.push(...scanMcpSource(path, text, service, diagnostics, checkpoint));
  }
  if (adapters.includes('mcp-source') && (mcpLanguageFile(path) || rules?.length))
    observations.push(...(await scanMcpLanguage(path, text, service, diagnostics, checkpoint, rules)));
  return observations;
}
