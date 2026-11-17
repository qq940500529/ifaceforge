import type { ScanTask } from '../desktop/protocol.js';
import type { Diagnostic } from '../scanner/model.js';

export function scanDiagnostics(record: Pick<ScanTask, 'result' | 'issues' | 'error'>): Diagnostic[] {
  const issues = record.result?.diagnostics ?? record.issues ?? [];
  return record.error ? [{ ...record.error, severity: 'error' }, ...issues] : issues;
}

export const diagnosticLocation = (issue: Diagnostic) =>
  issue.path && (issue.line ? `${issue.path}:${issue.line}` : issue.path);
export const diagnosticDetails = (issue: Diagnostic) =>
  issue.details == null ? '' : JSON.stringify(issue.details, null, 2);

export function diagnosticText(issue: Diagnostic) {
  return [
    `[${(issue.severity ?? 'warning').toUpperCase()}] ${issue.code}`,
    diagnosticLocation(issue),
    issue.message,
    diagnosticDetails(issue),
  ]
    .filter(Boolean)
    .join('\n');
}
