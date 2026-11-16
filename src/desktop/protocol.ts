import type { CommandInput } from '../app/workbench.js';
import type { ScanProgress } from '../app/catalog.js';
import type { Snapshot } from '../scanner/model.js';
import type { RegisteredProject } from '../storage/projects.js';
import type { Locale } from '../app/config.js';
import type { BrowseVersion, VersionReport } from '../app/version-compare.js';

export type ErrorInfo = { code: string; message: string; details?: unknown; exitCode?: number };
export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorInfo };
export type ScanSummary = Omit<Snapshot, 'entities'> & {
  count: number;
  changes?: { added: number; changed: number; removed: number };
};
export interface ScanTask extends ScanProgress {
  id: string;
  project: string;
  started: number;
  finished?: number;
  state: 'running' | 'cancelling' | 'complete' | 'cancelled' | 'failed';
  result?: ScanSummary;
  error?: ErrorInfo;
}
export interface VersionTask extends Omit<ScanTask, 'result'> {
  operation: 'compare' | 'git browse';
  result?: BrowseVersion | VersionReport;
}
export interface WorkspaceState {
  projects: RegisteredProject[];
  selected?: string;
  locale?: Locale;
}
export type EngineRequest =
  | { method: 'inspect'; path: string }
  | { method: 'state' | 'tasks' }
  | { method: 'close'; force?: boolean }
  | { method: 'locale'; locale: Locale }
  | { method: 'add'; path: string }
  | { method: 'select' | 'hide' | 'delete'; project: string }
  | { method: 'relocate'; project: string; path: string }
  | {
      method: 'command';
      project: string;
      name: string;
      input: CommandInput;
      wait?: boolean;
      environment?: Record<string, string | null>;
    }
  | { method: 'task show' | 'task cancel'; task: string; project?: string }
  | { method: 'task history' }
  | { method: 'scan cancel'; project: string; task: string };
export type FileKind = 'wiki' | 'backup' | 'restore' | 'openapi';
export type TaskList = {
  scans: ScanTask[];
  versions?: Omit<VersionTask, 'result'>[];
  runs: { project: string; id: string; kind: string; started: string }[];
};
export interface DesktopBridge {
  state(): Promise<Result<WorkspaceState>>;
  select(project: string): Promise<Result<WorkspaceState>>;
  chooseProject(): Promise<Result<{ token: string; selected: string; root: string } | null>>;
  register(token: string, project?: string): Promise<Result<WorkspaceState>>;
  remove(project: string, erase: boolean): Promise<Result<WorkspaceState>>;
  locale(locale: Locale): Promise<Result<WorkspaceState>>;
  tasks(): Promise<Result<TaskList>>;
  cancelScan(project: string, task: string): Promise<Result<ScanTask>>;
  command(project: string, name: string, input: CommandInput): Promise<Result<unknown>>;
  chooseFile(project: string, kind: FileKind): Promise<Result<{ path: string; token: string } | null>>;
  download(name: string, text: string): Promise<Result<boolean>>;
  copy(text: string): Promise<Result<boolean>>;
  releases(): Promise<Result<boolean>>;
}

declare global {
  interface Window {
    ifaceforge?: DesktopBridge;
  }
}
