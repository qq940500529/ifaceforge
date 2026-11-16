import { Alert, Button, Card, Empty, Input, Select, Skeleton, Space, Tag, Typography } from 'antd';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Run } from '../app/runs.js';
import type { Profile } from '../protocols/variables.js';
import { type command, download, WebError } from './client.js';
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
  const { t } = useWorkspace();
  if (!error) return null;
  const code = error instanceof WebError ? error.code : 'INVALID_ARGUMENT';
  const message = translatedKey(code) ? t(code) : t('error', { code });
  return (
    <Alert
      type="error"
      showIcon
      title={message}
      description={
        <details>
          <summary>{t('details')}</summary>
          <Code
            value={error instanceof WebError ? { message: error.message, details: error.details } : String(error)}
          />
        </details>
      }
    />
  );
}

export function Code({ value }: { value: unknown }) {
  return <pre className="code">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ children, href }) => <span title={href}>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
        }}
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
  const { t } = useWorkspace();
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
}: {
  items: T[];
  name: (item: T) => ReactNode;
  id: (item: T) => string;
  selected?: string;
  choose: (item: T) => void;
}) {
  if (!items.length) return <EmptyView />;
  return (
    <div>
      {items.map((item) => (
        <Button
          key={id(item)}
          className="list-button"
          type={selected === id(item) ? 'primary' : 'text'}
          onClick={() => choose(item)}
        >
          {name(item)}
        </Button>
      ))}
    </div>
  );
}

export function titleKey(key: string): Key {
  return translatedKey(key) ? key : 'details';
}
