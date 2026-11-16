import { readFileSync } from 'node:fs';
import type { Locale } from './config.js';
import type { Snapshot } from '../scanner/model.js';

const files = { en: 'developer-guide.en.md', 'zh-CN': 'developer-guide.md' } as const;
const guideFile = (name: string) => readFileSync(new URL('../../docs/' + name, import.meta.url), 'utf8');
export const cliGuide = () => guideFile('cli-agent.md');
export const guideRules = {
  SKILL_METADATA: {
    severity: 'error',
    category: 'specification',
    fix: 'Declare a valid name matching the directory and a description in SKILL.md.',
  },
  UNRESOLVED_REF: {
    severity: 'error',
    category: 'specification',
    fix: 'Point the reference to an existing document and target in the same revision.',
  },
  SWAGGER_RESOURCE: {
    severity: 'error',
    category: 'specification',
    fix: 'Include the referenced Swagger resource declaration in the repository.',
  },
  API_SPEC_VERSION: {
    severity: 'warning',
    category: 'compatibility',
    fix: 'Check the declared OpenAPI or Swagger version. The original record is available.',
  },
  MCP_DYNAMIC_REGISTRATION: {
    severity: 'warning',
    category: 'recommendation',
    fix: 'Publish an offline capability manifest or confirm the definition through MCP discovery.',
  },
  MCP_DYNAMIC_FIELDS: {
    severity: 'warning',
    category: 'recommendation',
    fix: 'Declare the dynamic fields in a capability manifest or confirm them at runtime.',
  },
  MCP_MANIFEST: {
    severity: 'error',
    category: 'manifest',
    fix: 'Provide arrays of named capabilities with URIs for resources and templates.',
  },
  MCP_MANIFEST_VERSION: {
    severity: 'warning',
    category: 'compatibility',
    fix: 'Use a documented manifest schema version.',
  },
} as const;

export function guide(locale: Locale = 'en') {
  const language = locale === 'zh-CN' ? locale : 'en';
  return {
    language,
    markdown: guideFile(files[language]),
    rules: guideRules,
    compatibility: JSON.parse(guideFile('compatibility.json')) as unknown,
  };
}

export function guideDiagnostics(snapshot: Snapshot) {
  return {
    snapshot: snapshot.id,
    commit: snapshot.commit,
    complete: snapshot.complete,
    issues: snapshot.diagnostics.map((issue) => ({
      ...issue,
      rule: issue.code,
      line: issue.line ?? (Number(/\bline (\d+)/.exec(issue.message)?.[1]) || null),
      ...guideRules[issue.code as keyof typeof guideRules],
      severity: guideRules[issue.code as keyof typeof guideRules]?.severity ?? 'warning',
    })),
  };
}
