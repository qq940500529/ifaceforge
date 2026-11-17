export type Kind = 'api' | 'mcp' | 'skill';
export type Origin = 'declaration' | 'source' | 'runtime' | 'call-site';
export interface Observation {
  id: string;
  kind: Kind;
  service: string;
  name: string;
  summary: string;
  origin: Origin;
  profile?: string;
  path?: string;
  line?: number;
  definition: Record<string, unknown>;
}
export interface Diagnostic {
  path?: string;
  line?: number;
  severity?: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  details?: unknown;
}
export interface Entity {
  id: string;
  kind: Kind;
  service: string;
  name: string;
  summary: string;
  version: string;
  observations: Observation[];
  differences: string[];
}
export interface Snapshot {
  id: string;
  created: string;
  commit: string | null;
  source?: 'git' | 'worktree';
  scannerVersion?: number;
  worktree: string;
  scope: string;
  complete: boolean;
  diagnostics: Diagnostic[];
  entities: Entity[];
}

export function apiId(service: string, method: string, path: string) {
  return 'api:' + service + ':' + method.toLowerCase() + ':' + path.replace(/\{[^{}]+\}/g, '{}');
}

export function mcpId(service: string, type: string, name: string) {
  return ['mcp', encodeURIComponent(service), type, encodeURIComponent(name)].join(':');
}
