import { existsSync } from 'node:fs';
import type { ProjectPaths } from './project.js';
import { projectFile, readJson } from './files.js';
import { invalid } from './errors.js';
import type { Repository } from '../storage/repository.js';
import { validate } from '../schemas/index.js';

export type Adapter = 'express' | 'fastapi' | 'mcp-typescript' | 'mcp-source';
export type Locale = 'en' | 'zh-CN';
export interface SourceConfig {
  id: string;
  roots?: string[];
  adapters?: Adapter[];
  openapi?: string[];
  mcpConfigs?: string[];
  mcpRules?: { extension: string; method: string; capability: 'tool' | 'resource' | 'template' | 'prompt' }[];
}
export interface ScanConfig {
  sources?: SourceConfig[];
  exclude?: string[];
  includeUntracked?: boolean;
}
export interface Settings {
  schemaVersion: 1;
  locale?: Locale;
  scan?: ScanConfig;
}

function checkPaths(project: ProjectPaths, scan: ScanConfig) {
  const seen = new Set<string>();
  for (const source of scan.sources ?? []) {
    if (seen.has(source.id)) invalid('Duplicate source ID', { id: source.id });
    seen.add(source.id);
    for (const path of [...(source.roots ?? []), ...(source.openapi ?? []), ...(source.mcpConfigs ?? [])]) {
      projectFile(project.root, path, false);
    }
  }
}

export function checkConfig(project: ProjectPaths, value: unknown, type?: 'config' | 'settings') {
  const name =
    type ?? (value && typeof value === 'object' && ('scan' in value || 'locale' in value) ? 'settings' : 'config');
  const checked = validate<Settings & ScanConfig>(name, value);
  checkPaths(project, name === 'settings' ? (checked.scan ?? {}) : checked);
  return { name, value: checked };
}

export function effectiveConfig(project: ProjectPaths, repository: Repository) {
  const settings = repository.setting<Settings>('config') ?? {
    schemaVersion: 1 as const,
    locale: repository.setting<Locale>('locale'),
  };
  if (settings.scan !== undefined) return { settings, scan: settings.scan, source: 'local' };
  if (!existsSync(project.config)) return { settings, scan: {} as ScanConfig, source: 'default' };
  const { value } = checkConfig(project, readJson(projectFile(project.root, '.ifaceforge.json')), 'config');
  const { sources, exclude, includeUntracked } = value;
  return { settings, scan: { sources, exclude, includeUntracked }, source: 'project' };
}
