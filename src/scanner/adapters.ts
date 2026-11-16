import { basename, dirname, posix } from 'node:path';
import { existsSync } from 'node:fs';
import { digest, projectFile, protectedSource, type ScanSource } from '../app/files.js';
import type { Adapter } from '../app/config.js';
import { apiId, mcpId, type Diagnostic, type Observation } from './model.js';
import { scanMcpSource } from './mcp-discovery.js';
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
  const markdown = body.replace(/^[ \t]*(\x60\x60\x60|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');
  for (const link of markdown.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
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
  return Object.entries(mapping(mapping(value).mcpServers)).flatMap(([name, raw]) => {
    const entry = mapping(raw);
    const transport =
      typeof entry.url === 'string'
        ? entry.type === 'sse' || entry.transport === 'sse'
          ? 'sse'
          : 'streamableHttp'
        : typeof entry.command === 'string'
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

const extensions = /\.(?:[cm]?[jt]sx?)$/i;
const javascriptPattern =
  /\b[\w$.]+\.(get|post|put|patch|delete|options|head|all|use)\s*\(\s*(['"])([^'"\r\n]+)\2/;
const pythonPattern = /^\s*@[\w.]+\.(get|post|put|patch|delete|options|head|trace)\s*\(\s*(['"])([^'"\r\n]+)\2/;

export function scanSource(
  path: string,
  text: string,
  adapters: Adapter[],
  service: string,
  diagnostics: Diagnostic[],
  checkpoint?: () => void,
) {
  const observations: Observation[] = [];
  const javascript = extensions.test(path);
  const python = /\.py$/i.test(path);
  const supported = [
    javascript && adapters.includes('express') && { pattern: javascriptPattern, name: 'express' },
    python && adapters.includes('fastapi') && { pattern: pythonPattern, name: 'fastapi' },
  ].filter((entry) => entry !== false);
  let inComment = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (index % 256 === 0) checkpoint?.();
    const trimmed = line.trimStart();
    if (javascript && trimmed.startsWith('/*')) inComment = !trimmed.includes('*/');
    if (inComment || /^(?:\/\/|#|\/\*)/.test(trimmed)) {
      if (inComment && trimmed.includes('*/')) inComment = false;
      continue;
    }
    for (const { pattern, name: adapter } of supported) {
      const match = pattern.exec(line);
      if (!match) {
        if (
          (adapter === 'fastapi' && /^@\w+\.(?:get|post|put|patch|delete)\(/.test(trimmed)) ||
          (adapter === 'express' && /\b(?:app|router)\.(?:get|post|put|patch|delete)\(/.test(trimmed))
        ) {
          diagnostics.push({
            path,
            code: 'DYNAMIC_ROUTE',
            message: adapter + ' dynamic or multiline registration at ' + (index + 1),
          });
        }
        continue;
      }
      const [, method, , value] = match;
      if (value.startsWith('/') && method !== 'use' && method !== 'all') {
        const route = value.replace(/:([\w]+)/g, '{$1}');
        observations.push({
          id: apiId(service, method, route),
          kind: 'api',
          service,
          name: method.toUpperCase() + ' ' + route,
          summary: '',
          origin: 'source',
          path,
          line: index + 1,
          definition: { method, path: route, adapter },
        });
      }
    }
  }
  if (javascript && adapters.includes('mcp-typescript'))
    observations.push(...scanMcpSource(path, text, service, diagnostics, checkpoint));
  return observations;
}
