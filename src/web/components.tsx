import { Alert, Button, Card, Empty, Input, Select, Skeleton, Space, Tag, Typography } from 'antd';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Run } from '../app/runs.js';
import type { SandboxPlan } from '../protocols/mcp-sandbox.js';
import type { Profile } from '../protocols/variables.js';
import { type command, copyText, download, WebError } from './client.js';
import { type Key, type Language, translator, translatedKey } from './i18n.js';

export interface Project {
  root: string;
  branch: string;
  data: string;
  snapshot?: string;
  locale?: Language;
}
export type Listed<T> = { items: T[]; total: number; limit: number; offset: number };
export interface Context {
  command: typeof command;
  projectId?: string;
  lang: Language;
  t: ReturnType<typeof translator>;
  project: Project;
  revision: number;
  refresh: () => void;
  setLocale: (locale: Language) => Promise<void>;
  notify: (text: string) => void;
  showSource: (path: string, line?: number, ref?: string) => void;
}
export const Workspace = createContext<Context>(null!);
export const useWorkspace = () => useContext(Workspace);

export function useLoad<T>(load: () => Promise<T>, dependencies: readonly unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void load()
      .then((value) => {
        if (active) setData(value);
      })
      .catch((error) => {
        if (active) setError(error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, dependencies);
  return { data, error, loading };
}

export function ErrorView({ error }: { error: unknown }) {
  const { t, lang, notify } = useWorkspace();
  if (!error) return null;
  const code = error instanceof WebError ? error.code : 'INVALID_ARGUMENT';
  const message = translatedKey(code) ? t(code) : t('error', { code });
  const details =
    error instanceof WebError ? { code, message: error.message, details: error.details } : String(error);
  const startup =
    error instanceof WebError && error.details && typeof error.details === 'object'
      ? (error.details as {
          exitCode?: number;
          dockerError?: string;
          commandError?: string;
          startupOutput?: string;
        })
      : undefined;
  const reason = startup?.dockerError || startup?.commandError || startup?.startupOutput;
  const exitLabel =
    code === 'MCP_NATIVE_FAILED'
      ? t('processExitCode')
      : code === 'MCP_SANDBOX_START' || code === 'MCP_SANDBOX_CLEANUP'
        ? t('containerExitCode')
        : t('exitCode');
  return (
    <Alert
      type="error"
      showIcon
      title={message}
      description={
        <div className="stack">
          {typeof startup?.exitCode === 'number' && (
            <Typography.Text strong>
              {exitLabel} {startup.exitCode}
            </Typography.Text>
          )}
          {typeof reason === 'string' && reason.trim() && <Code value={reason.trim().slice(0, 500)} />}
          <details>
            <summary>{t('details')}</summary>
            <Code value={details} />
            <Button
              size="small"
              onClick={() => {
                void copyText(typeof details === 'string' ? details : JSON.stringify(details, null, 2)).then(
                  () => notify(t('copied')),
                  () => notify(lang === 'zh-CN' ? '复制失败' : 'Could not copy'),
                );
              }}
            >
              {lang === 'zh-CN' ? '复制错误详情' : 'Copy error details'}
            </Button>
          </details>
        </div>
      }
    />
  );
}

export function SandboxIssues({
  issues,
}: {
  issues: (SandboxPlan['issues'][number] | { code: 'native-platform'; path: string })[];
}) {
  const { lang } = useWorkspace();
  if (!issues.length) return null;
  const text =
    lang === 'zh-CN'
      ? {
          'windows-launcher': '此启动器需要 Windows，当前隔离环境使用 Linux',
          'missing-directory': '所选提交中缺少工作目录',
          'missing-entry': '所选提交中缺少启动文件',
          'image-os': '所选镜像需要支持 Linux',
          'native-platform': '本机缺少兼容的运行方式，请选择适用的可执行文件和脚本解释器',
        }
      : {
          'windows-launcher': 'This launcher requires Windows. The sandbox runs Linux.',
          'missing-directory': 'The working directory is missing from the selected commit.',
          'missing-entry': 'The launch file is missing from the selected commit.',
          'image-os': 'The selected image needs to support Linux.',
          'native-platform': 'Choose a compatible executable and script interpreter for this host.',
        };
  return (
    <Alert
      type="warning"
      showIcon
      title={lang === 'zh-CN' ? '启动配置与运行环境不兼容' : 'The launch configuration is incompatible'}
      description={
        <ul>
          {issues.map(({ code, path }) => (
            <li key={code + path}>
              {text[code]} <code>{path}</code>
            </li>
          ))}
        </ul>
      }
    />
  );
}

export function Code({ value }: { value: unknown }) {
  return <pre className="code">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function Markdown({
  children,
  wikiLink,
  wikiSections,
}: {
  children: string;
  wikiLink?: (href: string) => (() => void) | undefined;
  wikiSections?: ReadonlyMap<string, string>;
}) {
  const prefix = 'md-' + useId() + '-';
  const { lang } = useWorkspace();
  const components = useMemo<Components>(
    () => ({
      a: ({ children, href, id, ...props }) => {
        const openPage = href ? wikiLink?.(href) : undefined;
        const section = href ? wikiSections?.get(href) : undefined;
        if (openPage) {
          return (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                openPage();
              }}
            >
              {children}
            </a>
          );
        }
        const anchor = section ? prefix + section : href?.slice(1);
        return section || href?.startsWith('#' + prefix) ? (
          <a
            href={'#' + anchor}
            id={id}
            data-wiki-section={section || undefined}
            aria-label={props['aria-label']}
            onClick={(event) => {
              event.preventDefault();
              const target = anchor ? document.getElementById(anchor) : null;
              target?.scrollIntoView({ block: 'nearest' });
              target?.focus({ preventScroll: true });
            }}
          >
            {children}
          </a>
        ) : (
          <span title={href}>{children}</span>
        );
      },
      h2: ({ children }) => {
        const slug = typeof children === 'string' ? children.toLowerCase().replaceAll(' ', '-') : '';
        const heading = wikiSections?.get('#' + encodeURI(slug));
        return (
          <h2 id={heading ? prefix + heading : undefined} tabIndex={heading ? -1 : undefined}>
            {children}
          </h2>
        );
      },
      img: ({ alt }) => <span>{alt}</span>,
      table: ({ children }) => (
        <div className="markdown-table" tabIndex={0}>
          <table>{children}</table>
        </div>
      ),
      li: ({ node: _node, ...props }) => (
        <li {...props} tabIndex={props.id?.startsWith(prefix) ? -1 : undefined} />
      ),
    }),
    [prefix, wikiLink, wikiSections],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: lang === 'zh-CN' ? '脚注' : 'Footnotes' }}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function JsonField({
  label,
  value,
  change,
  rows = 4,
}: {
  label: string;
  value: string;
  change: (value: string) => void;
  rows?: number;
}) {
  return (
    <Field label={label}>
      <Input.TextArea
        aria-label={label}
        rows={rows}
        value={value}
        onChange={(event) => change(event.target.value)}
        spellCheck={false}
      />
    </Field>
  );
}
export const json = (value: unknown) => JSON.stringify(value, null, 2);
export const parse = (value: string) => JSON.parse(value) as unknown;

export function EmptyView({ select }: { select?: boolean }) {
  const { t } = useWorkspace();
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(select ? 'selectItem' : 'noItems')} />;
}
export function Loading() {
  return <Skeleton active paragraph={{ rows: 3 }} />;
}

export function Label({ value }: { value: string }) {
  const { t } = useWorkspace();
  const [base, extra] = value.split(':', 2);
  return (
    <Tag
      color={
        base === 'passed' || base === 'connected'
          ? 'green'
          : base === 'failed' || base === 'unknown'
            ? 'orange'
            : 'blue'
      }
    >
      {translatedKey(base) ? t(base) : base}
      {extra && ' · ' + extra}
    </Tag>
  );
}

export function useProfiles() {
  const { revision, command } = useWorkspace();
  return useLoad(() => command<Listed<Profile>>('profile list', { limit: 500 }), [revision]);
}

export function ProfilePicker({
  profiles,
  value,
  change,
  disabled,
}: {
  profiles: Profile[];
  value?: string;
  change: (id?: string) => void;
  disabled?: boolean;
}) {
  const { t } = useWorkspace();
  return (
    <Select
      virtual={false}
      aria-label={t('profile')}
      placeholder={t('selectProfile')}
      allowClear
      disabled={disabled}
      value={value}
      onChange={change}
      options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
      style={{ minWidth: 160 }}
    />
  );
}

export function useRun() {
  const { refresh, command } = useWorkspace();
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (run?.status !== 'running') return;
    let active = true;
    const id = run.id;
    const timer = setInterval(() => {
      void command<Run>('run show', { id })
        .then((next) => {
          if (!active) return;
          setRun(next);
          if (next.status !== 'running') refresh();
        })
        .catch((error) => {
          if (active) setError(error);
        });
    }, 300);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.status]);
  async function start(operation: () => Promise<Run>) {
    setError(undefined);
    setPending(true);
    try {
      setRun(await operation());
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  }
  async function cancel() {
    if (!run) return;
    try {
      setRun(await command<Run>('run cancel', { id: run.id }));
    } catch (error) {
      setError(error);
    }
  }
  return { run, setRun, error, pending: pending || run?.status === 'running', start, cancel };
}

export function RunView({
  run,
  cancel,
  renderResult,
}: {
  run?: Run;
  cancel: () => void;
  renderResult?: (result: unknown) => ReactNode;
}) {
  const { lang, t } = useWorkspace();
  const zh = lang === 'zh-CN';
  if (!run) return <EmptyView select />;
  return (
    <div className="stack">
      <Space wrap>
        <Label value={run.status} />
        <Typography.Text copyable>{run.id}</Typography.Text>
        {run.status === 'running' ? (
          <Button onClick={cancel}>{t('cancel')}</Button>
        ) : (
          <Button onClick={() => download('run-' + run.id + '.json', run)}>{t('export')}</Button>
        )}
      </Space>
      {run.sandboxes?.map((sandbox) => (
        <Alert
          key={sandbox.instance}
          type={sandbox.cleanup.state === 'removed' ? 'success' : 'error'}
          showIcon
          title={
            sandbox.cleanup.state === 'removed'
              ? zh
                ? '隔离实例已回收'
                : 'Sandbox removed'
              : zh
                ? '隔离实例清理失败'
                : 'Sandbox cleanup needs attention'
          }
          description={sandbox.cleanup.message ?? sandbox.commit.slice(0, 12)}
        />
      ))}
      {run.steps.map((step, index) => {
        const response = step.result as
          | {
              status?: number;
              text?: string;
              truncated?: boolean;
              durationMs?: number;
              structuredContent?: unknown;
              contents?: unknown;
              messages?: unknown;
              content?: unknown;
              isError?: boolean;
            }
          | undefined;
        const protocolPreview =
          response?.structuredContent ?? response?.contents ?? response?.messages ?? response?.content;
        return (
          <Card key={index} size="small" title={step.id} extra={<Label value={step.status} />}>
            <div className="stack">
              {response?.status !== undefined && (
                <Space wrap>
                  <Tag>
                    {t('status')} {response.status}
                  </Tag>
                  <Tag>
                    {t('elapsed')} {response.durationMs} ms
                  </Tag>
                  {response.truncated && <Tag color="orange">{t('truncated')}</Tag>}
                </Space>
              )}
              {renderResult && step.durationMs !== undefined && (
                <Typography.Text type="secondary">
                  {t('elapsed')} {step.durationMs} ms
                </Typography.Text>
              )}
              {renderResult && step.result !== undefined ? (
                renderResult(step.result)
              ) : (
                <>
                  {response?.text !== undefined && <Code value={response.text} />}
                  {protocolPreview !== undefined && <Code value={protocolPreview} />}
                </>
              )}
              {step.checks?.map((check, index) => (
                <div key={index} className="stack">
                  <Space>
                    <Label value={check.passed ? 'passed' : 'failed'} />
                    {check.type}
                  </Space>
                  {!check.passed && <Code value={check} />}
                </div>
              ))}
              {step.error && (
                <ErrorView error={new WebError(step.error.code, step.error.message, step.error.details)} />
              )}
              {(step.result !== undefined || step.request !== undefined) && (
                <details>
                  <summary>{t('details')}</summary>
                  <Code value={step} />
                </details>
              )}
              {step.progress !== undefined && <Code value={step.progress} />}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function RunPanel({ action }: { action: ReturnType<typeof useRun> }) {
  return (
    <div className="stack">
      <ErrorView error={action.error} />
      <RunView run={action.run} cancel={() => void action.cancel()} />
    </div>
  );
}

export function TextButtonList<T>({
  items,
  name,
  id,
  selected,
  choose,
  label,
}: {
  items: T[];
  name: (item: T) => ReactNode;
  id: (item: T) => string;
  selected?: string;
  choose: (item: T) => void;
  label?: string;
}) {
  if (!items.length) return <EmptyView />;
  return (
    <div
      className="scroll-list"
      role={label ? 'region' : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
    >
      {items.map((item) => (
        <Button
          key={id(item)}
          className="list-button"
          type={selected === id(item) ? 'primary' : 'text'}
          aria-pressed={selected === id(item)}
          onClick={() => choose(item)}
        >
          {name(item)}
        </Button>
      ))}
    </div>
  );
}

export function useSplitView() {
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const reveal = useCallback((target?: HTMLElement | null) => {
    const detail = detailRef.current;
    if (!detail) return;
    detail.scrollTop = 0;
    if (getComputedStyle(detail).position !== 'sticky') {
      (target ?? detail).scrollIntoView({ block: 'start' });
      detail.focus({ preventScroll: true });
    }
  }, []);
  return {
    listRef,
    detailRef,
    reveal,
    back() {
      const list = listRef.current;
      list?.scrollIntoView({ block: 'start' });
      (list?.querySelector<HTMLButtonElement>('.list-button[aria-pressed="true"]') ?? list)?.focus({
        preventScroll: true,
      });
    },
  };
}

export function BackToList({ onClick }: { onClick: () => void }) {
  const { lang } = useWorkspace();
  return (
    <Button className="back-to-list" onClick={onClick}>
      ← {lang === 'zh-CN' ? '返回列表' : 'Back to list'}
    </Button>
  );
}

export function titleKey(key: string): Key {
  return translatedKey(key) ? key : 'details';
}
